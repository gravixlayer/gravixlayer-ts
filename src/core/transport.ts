/**
 * The HTTP engine shared by every resource.
 *
 * Built on the global `fetch`, so the same code runs on Node 18+, Deno, Bun,
 * Cloudflare Workers, and Vercel Edge without a platform adapter.
 */

import {
  GravixLayerAbortError,
  GravixLayerConnectionError,
  GravixLayerError,
  GravixLayerTimeoutError,
  errorFromStatus,
} from './errors.js';
import { sleep } from './time.js';
import { buildUrl, withQuery, type QueryValue } from './url.js';
import { endSpan, failSpan, injectContext, startClientSpan } from './telemetry.js';

/** Status codes treated as success. Mirrors the API's documented responses. */
export const SUCCESS_STATUS: ReadonlySet<number> = new Set([200, 201, 202, 204, 207]);

/**
 * Status codes retried automatically.
 *
 * 500 is deliberately excluded: it signals a request the server could not
 * process rather than transient unavailability, so replaying it rarely helps
 * and can duplicate side effects.
 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Longest delay honoured from a `Retry-After` header, in milliseconds. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Per-request overrides accepted by every SDK method. */
export interface RequestOptions {
  /** Abort the request. Aborting raises {@link GravixLayerAbortError}. */
  signal?: AbortSignal;
  /** Timeout in milliseconds, overriding the client default. `0` disables it. */
  timeout?: number;
  /** Retry budget for this request, overriding the client default. */
  maxRetries?: number;
  /** Extra headers merged over the client defaults. */
  headers?: Record<string, string>;
}

/** Internal description of one API call. */
export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Endpoint relative to the service, or an absolute URL. */
  path: string;
  /** Service prefix, e.g. `v1/agents`. Defaults to `v1/inference`. */
  service?: string;
  /** Query parameters appended to the path. `undefined` values are dropped. */
  query?: Record<string, QueryValue>;
  /** JSON request body. */
  body?: unknown;
  /** Multipart body. Mutually exclusive with `body`. */
  form?: FormData;
  /** Per-request overrides. */
  options?: RequestOptions;
}

/** A `fetch`-compatible function. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Construction parameters for {@link Transport}. */
export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  timeout: number;
  maxRetries: number;
  defaultHeaders: Record<string, string>;
  fetch: FetchLike;
}

const DEFAULT_SERVICE = 'v1/inference';

/** Wait out a backoff, reporting an abort the way a request would. */
async function backoffSleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, signal);
  } catch (cause) {
    throw new GravixLayerAbortError('Request aborted.', { cause });
  }
}

/**
 * Interpret a `Retry-After` header.
 *
 * Accepts delay-seconds and an HTTP-date, per RFC 9110, plus the `retry-after-ms`
 * extension. The result is clamped so a misbehaving upstream cannot stall a
 * client for an unbounded time.
 */
export function parseRetryAfter(headers: Headers): number | null {
  const ms = headers.get('retry-after-ms');
  if (ms) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, MAX_RETRY_AFTER_MS);
  }

  const value = headers.get('retry-after');
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }

  return null;
}

/**
 * Delay before the next attempt: exponential backoff with full-second jitter.
 *
 * Attempt 0 waits 1–2s, attempt 1 waits 2–3s, attempt 2 waits 4–5s. Jitter
 * keeps a fleet of clients from retrying in lockstep after a shared outage.
 */
export function backoffMs(attempt: number): number {
  return 2 ** attempt * 1000 + Math.random() * 1000;
}

/** Collect response headers into a plain lower-cased object. */
function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Derive a human-readable message from an error response body.
 *
 * The API returns JSON envelopes such as `{"error": "..."}`; surfacing that
 * string reads far better than the raw payload, which is still available on
 * `error.body`.
 */
function messageFromBody(text: string, parsed: unknown): string {
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail', 'msg'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
      // Some handlers nest the description one level deeper.
      if (value && typeof value === 'object') {
        const nested = (value as Record<string, unknown>)['message'];
        if (typeof nested === 'string' && nested.trim() !== '') return nested;
      }
    }
  }
  return text.trim() === '' ? 'Request failed.' : text;
}

/** Wrap a stream so `onDone` runs exactly once when it completes or is cancelled. */
function withStreamCleanup(
  stream: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Issues authenticated requests with retries, timeouts, and tracing. */
export class Transport {
  constructor(private readonly config: TransportConfig) {}

  /** The API base URL, without a trailing slash. */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * The `fetch` the client was configured with.
   *
   * Exposed so calls that bypass the control plane, such as requests to a
   * published service, still go through the caller's own `fetch`.
   */
  get fetch(): FetchLike {
    return this.config.fetch;
  }

  /** Send a request and parse the JSON response. */
  async request<T>(spec: RequestSpec): Promise<T> {
    const response = await this.send(spec, false);
    return (await this.readJson<T>(response)) as T;
  }

  /** Send a request and discard the response body. */
  async requestVoid(spec: RequestSpec): Promise<void> {
    const response = await this.send(spec, false);
    await response.text().catch(() => undefined);
  }

  /** Send a request and return the response body as bytes. */
  async requestBytes(spec: RequestSpec): Promise<Uint8Array> {
    const response = await this.send(spec, false);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Send a request and return the raw body stream.
   *
   * The request timeout applies only until response headers arrive; a stream
   * may then stay open indefinitely. An `AbortSignal` still cancels it at any
   * point.
   */
  async requestStream(spec: RequestSpec): Promise<ReadableStream<Uint8Array>> {
    const response = await this.send(spec, true);
    if (!response.body) {
      throw new GravixLayerError('The server returned an empty streaming response.', {
        status: response.status,
        headers: headersToObject(response.headers),
      });
    }
    return response.body;
  }

  /** Parse a JSON body, tolerating `204` and other empty responses. */
  private async readJson<T>(response: Response): Promise<T | undefined> {
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GravixLayerError('The server returned a malformed JSON response.', {
        status: response.status,
        headers: headersToObject(response.headers),
        body: text,
      });
    }
  }

  /** Run the retry loop and return the successful response. */
  private async send(spec: RequestSpec, stream: boolean): Promise<Response> {
    const { method, options = {} } = spec;
    const service = spec.service ?? DEFAULT_SERVICE;
    const path = spec.query ? withQuery(spec.path, spec.query) : spec.path;
    const url = buildUrl(path, service, this.config.baseUrl);

    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    const timeout = options.timeout ?? this.config.timeout;
    const userSignal = options.signal;

    const headers: Record<string, string> = { ...this.config.defaultHeaders };
    if (spec.body !== undefined && !spec.form) headers['content-type'] = 'application/json';
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    // `fetch` must choose the multipart boundary itself.
    if (spec.form) delete headers['content-type'];

    const body: BodyInit | undefined = spec.form
      ? spec.form
      : spec.body !== undefined
        ? JSON.stringify(spec.body)
        : undefined;

    const span = startClientSpan(method, url);
    if (span) injectContext(headers);

    try {
      const response = await this.attemptLoop({
        url,
        method,
        headers,
        body,
        stream,
        timeout,
        maxRetries,
        userSignal,
      });
      span?.setAttribute('http.response.status_code', response.status);
      return response;
    } catch (error) {
      failSpan(span, error);
      throw error;
    } finally {
      endSpan(span);
    }
  }

  private async attemptLoop(args: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: BodyInit | undefined;
    stream: boolean;
    timeout: number;
    maxRetries: number;
    userSignal: AbortSignal | undefined;
  }): Promise<Response> {
    const { url, method, headers, body, stream, timeout, maxRetries, userSignal } = args;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (userSignal?.aborted) {
        throw new GravixLayerAbortError('Request aborted.', { cause: userSignal.reason });
      }

      let response: Response;
      try {
        response = await this.fetchOnce({
          url,
          method,
          headers,
          body,
          stream,
          timeout,
          userSignal,
        });
      } catch (error) {
        // A caller-initiated abort is final; a timeout or socket failure is not.
        if (error instanceof GravixLayerAbortError) throw error;
        lastError = error;
        if (attempt < maxRetries) {
          await backoffSleep(backoffMs(attempt), userSignal);
          continue;
        }
        throw error;
      }

      if (SUCCESS_STATUS.has(response.status)) return response;

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(response.headers);
        // Release the connection without blocking the backoff on it.
        void response.body?.cancel().catch(() => undefined);
        await backoffSleep(retryAfter ?? backoffMs(attempt), userSignal);
        continue;
      }

      throw await this.errorFromResponse(response);
    }

    throw new GravixLayerError('Failed to complete request.', { cause: lastError });
  }

  /** One attempt, including timeout wiring and error normalization. */
  private async fetchOnce(args: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: BodyInit | undefined;
    stream: boolean;
    timeout: number;
    userSignal: AbortSignal | undefined;
  }): Promise<Response> {
    const { url, method, headers, body, stream, timeout, userSignal } = args;

    const controller = new AbortController();
    let timedOut = false;
    let released = false;

    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeout)
        : undefined;

    const onUserAbort = () => controller.abort();
    userSignal?.addEventListener('abort', onUserAbort, { once: true });

    const release = () => {
      if (released) return;
      released = true;
      if (timer !== undefined) clearTimeout(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
    };

    try {
      const response = await this.config.fetch(url, {
        method,
        headers,
        body: body ?? null,
        signal: controller.signal,
        // Streaming responses must not be buffered by an intermediate cache.
        ...(stream ? { cache: 'no-store' as RequestCache } : {}),
      });

      if (stream && SUCCESS_STATUS.has(response.status) && response.body) {
        // Headers arrived, so the timeout has done its job. Teardown is
        // deferred until the body is drained or cancelled, which keeps the
        // caller's abort signal wired to the live stream.
        if (timer !== undefined) clearTimeout(timer);
        const wrapped = withStreamCleanup(response.body, release);
        return new Response(wrapped, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      release();
      return response;
    } catch (error) {
      release();

      if (userSignal?.aborted) {
        throw new GravixLayerAbortError('Request aborted.', { cause: userSignal.reason });
      }
      if (timedOut) {
        throw new GravixLayerTimeoutError(`Request timed out after ${timeout}ms.`, {
          cause: error,
        });
      }
      throw new GravixLayerConnectionError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
  }

  /** Build the error for a non-success response, consuming its body. */
  private async errorFromResponse(response: Response) {
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    return errorFromStatus(response.status, messageFromBody(text, parsed), {
      headers: headersToObject(response.headers),
      body: parsed ?? text,
    });
  }
}
