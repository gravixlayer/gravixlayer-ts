/**
 * The GravixLayer client.
 *
 * One object, constructed once, that owns configuration and hands every
 * resource the same transport. Create it at module scope and reuse it: each
 * instance keeps its connections warm, and building a new one per request
 * throws that away.
 */

import { isBrowser, readEnv, readEnvOr } from './core/env.js';
import { GravixLayerInvalidArgumentError } from './core/errors.js';
import { createPooledFetch } from './core/http.js';
import { maybeEnableFromEnv } from './core/telemetry.js';
import { Transport, type FetchLike, type RequestOptions } from './core/transport.js';
import { buildListEndpoint, SERVICES } from './core/url.js';
import { Agents } from './resources/agents.js';
import { Identity } from './resources/identity.js';
import { NetworkPolicies } from './resources/network-policies.js';
import type { ClientContext } from './resources/resource.js';
import { Runtimes } from './resources/runtimes/runtimes.js';
import { Snapshots } from './resources/snapshots.js';
import { Templates } from './resources/templates.js';
import { VERSION } from './version.js';

/** Where the API lives when no base URL is configured. */
const DEFAULT_BASE_URL = 'https://api.gravixlayer.ai';

/** Default cloud for runtime placement. */
const DEFAULT_CLOUD = 'aws';

/** Default region for runtime placement. */
const DEFAULT_REGION = 'us-east-1';

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default number of retries for transient failures. */
const DEFAULT_MAX_RETRIES = 3;

/** Configuration accepted by {@link GravixLayer}. */
export interface ClientOptions {
  /**
   * API key.
   *
   * Defaults to the `GRAVIXLAYER_API_KEY` environment variable.
   */
  apiKey?: string;
  /**
   * API base URL.
   *
   * Defaults to the `GRAVIXLAYER_BASE_URL` environment variable, then to the
   * public endpoint.
   */
  baseUrl?: string;
  /**
   * Cloud used when a call does not name one.
   *
   * Applied to runtime creates and template builds. Defaults to
   * `GRAVIXLAYER_CLOUD`, then `aws`.
   */
  cloud?: string;
  /**
   * Region used when a call does not name one.
   *
   * Applied to runtime creates and template builds. Defaults to
   * `GRAVIXLAYER_REGION`, then `us-east-1`.
   */
  region?: string;
  /** Request timeout in milliseconds. Defaults to 60000. `0` disables it. */
  timeout?: number;
  /**
   * How many times to retry a transient failure.
   *
   * Applies to connection errors and to 429, 502, 503, and 504 responses, with
   * exponential backoff and jitter. Defaults to 3.
   */
  maxRetries?: number;
  /** Extra headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Replacement for the global `fetch`.
   *
   * Useful for a custom agent, a proxy, or deterministic tests. When omitted
   * on Node, the SDK reuses an HTTP/1.1 keep-alive pool (or one HTTP/2 session
   * per origin when {@link ClientOptions.http2} is true). Closing the client
   * destroys those sockets immediately so the process can exit.
   */
  fetch?: FetchLike;
  /**
   * Use HTTP/2 multiplexing on Node.
   *
   * Defaults to `false` (HTTP/1.1 keep-alive). Pass `true` to open one HTTP/2
   * session per origin. Ignored when a custom `fetch` is supplied.
   */
  http2?: boolean;
  /**
   * Permit construction in a browser.
   *
   * Off by default: a browser build ships its API key to every visitor. Route
   * calls through your own backend instead, and only set this when the key is
   * genuinely not a secret.
   */
  dangerouslyAllowBrowser?: boolean;
}

/**
 * Client for the GravixLayer API.
 *
 * @example
 * ```ts
 * import { GravixLayer } from 'gravixlayer';
 *
 * const client = new GravixLayer(); // defaults to cloud="aws", region="us-east-1"
 *
 * const sandbox = await client.runtime.create(); // defaults to template="base-small"
 * const result = await sandbox.runCode('print("hello")');
 * console.log(result.stdout);
 * await sandbox.kill();
 * ```
 */
export class GravixLayer implements ClientContext {
  /** Isolated virtual machines that run code on demand. */
  readonly runtime: Runtimes;
  /** Reusable runtime images. */
  readonly templates: Templates;
  /** Saved runtime states that new runtimes can start from. */
  readonly snapshots: Snapshots;
  /** Long-running services with their own public URLs. */
  readonly agents: Agents;
  /** Secret providers, under `client.identity.providers`. */
  readonly identity: Identity;
  /** Rules governing what a runtime may reach on the network. */
  readonly networkPolicies: NetworkPolicies;

  /** The configured HTTP engine. Shared by every resource. */
  readonly transport: Transport;
  /** API base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** Default cloud for runtime and template placement. */
  readonly cloud: string;
  /** Default region for runtime and template placement. */
  readonly region: string;
  /** Default request timeout in milliseconds. */
  readonly timeout: number;
  /** Default retry budget. */
  readonly maxRetries: number;

  constructor(options: ClientOptions = {}) {
    if (isBrowser() && !options.dangerouslyAllowBrowser) {
      throw new GravixLayerInvalidArgumentError(
        'Refusing to run in a browser, because doing so exposes your API key to every visitor. ' +
          'Call the API from your own server instead. If the key is not a secret in your ' +
          'deployment, pass `dangerouslyAllowBrowser: true`.',
      );
    }

    const apiKey = options.apiKey ?? readEnv('GRAVIXLAYER_API_KEY');
    if (!apiKey) {
      throw new GravixLayerInvalidArgumentError(
        'An API key is required. Pass `apiKey`, or set the GRAVIXLAYER_API_KEY environment variable.',
      );
    }

    const baseUrl = (options.baseUrl ?? readEnvOr('GRAVIXLAYER_BASE_URL', DEFAULT_BASE_URL))
      .trim()
      .replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new GravixLayerInvalidArgumentError(
        `The base URL must start with http:// or https://. Received ${JSON.stringify(baseUrl)}.`,
      );
    }

    this.baseUrl = baseUrl;
    this.cloud = options.cloud ?? readEnvOr('GRAVIXLAYER_CLOUD', DEFAULT_CLOUD);
    this.region = options.region ?? readEnvOr('GRAVIXLAYER_REGION', DEFAULT_REGION);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    if (this.timeout < 0) {
      throw new GravixLayerInvalidArgumentError(
        '`timeout` must be 0 or more milliseconds, where 0 disables the timeout.',
      );
    }
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new GravixLayerInvalidArgumentError('`maxRetries` must be an integer of 0 or more.');
    }

    let fetchImpl = options.fetch;
    let preconnect: (() => Promise<void>) | undefined;
    let closePool: (() => Promise<void>) | undefined;
    if (!fetchImpl) {
      if (typeof globalThis.fetch !== 'function') {
        throw new GravixLayerInvalidArgumentError(
          'This runtime has no global fetch. Use Node 20 or newer, or pass a `fetch` implementation.',
        );
      }
      const pooled = createPooledFetch({ http2: options.http2 === true });
      fetchImpl = pooled.fetch;
      preconnect = () => pooled.preconnect();
      closePool = () => pooled.close();
    }

    // Tracing stays off unless the environment asks for it, so a plain client
    // never starts an exporter on its own.
    maybeEnableFromEnv();

    this.transport = new Transport({
      baseUrl: this.baseUrl,
      apiKey,
      timeout: this.timeout,
      maxRetries: this.maxRetries,
      defaultHeaders: {
        authorization: `Bearer ${apiKey}`,
        'user-agent': `gravixlayer-ts/${VERSION}`,
        accept: 'application/json',
        ...lowercaseKeys(options.defaultHeaders ?? {}),
      },
      fetch: fetchImpl,
      preconnect,
      close: closePool,
    });

    this.runtime = new Runtimes(this);
    this.templates = new Templates(this);
    this.snapshots = new Snapshots(this);
    this.agents = new Agents(this);
    this.identity = new Identity(this);
    this.networkPolicies = new NetworkPolicies(this);
  }

  /**
   * Open a connection to the API ahead of the first real request.
   *
   * Loads native HTTP bindings, then sends one small authenticated request so
   * that TCP, TLS, and the pooled connection are already ready when latency
   * matters. Most useful right before issuing several requests at once.
   *
   * Throws the same errors any request would, which makes it a cheap way to
   * verify credentials at startup.
   */
  async warmup(options: RequestOptions = {}): Promise<void> {
    await this.transport.preconnect();
    await this.transport.requestVoid({
      method: 'GET',
      path: buildListEndpoint('runtime', { limit: 1, offset: 0 }),
      service: SERVICES.agents,
      options,
    });
  }

  /**
   * Drain pooled HTTP connections so the process can exit.
   *
   * Keep-alive sockets and HTTP/2 sessions are destroyed immediately rather
   * than waiting for a graceful shutdown, which would otherwise keep Node
   * running after the last request. Idle pooled sockets are also unref'd, so a
   * short-lived process can exit even if `close()` is skipped. Safe to call
   * more than once. After this, further requests on this instance fail. No-op
   * when a custom `fetch` was supplied.
   */
  async close(): Promise<void> {
    await this.transport.close();
  }
}

/** Lower-case header names so caller overrides replace the defaults. */
function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}
