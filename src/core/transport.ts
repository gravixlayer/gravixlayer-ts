/**
 * The HTTP engine shared by every resource.
 *
 * API calls go through {@link Dispatch}, a byte-level contract any runtime can
 * satisfy, so the same code runs on Node 20+, Deno, Bun, Cloudflare Workers,
 * and Vercel Edge without a platform adapter.
 */

import { utf8Decode } from './binary.js';
import {
  GravixLayerAbortError,
  GravixLayerConnectionError,
  GravixLayerError,
  GravixLayerInvalidArgumentError,
  GravixLayerTimeoutError,
  errorFromStatus,
  formatErrorMessage,
} from './errors.js';
import { sleep } from './time.js';
import { buildUrl, isAbsoluteUrl, withQuery, type QueryValue } from './url.js';
import { endSpan, failSpan, injectContext, startClientSpan } from './telemetry.js';
import type { Dispatch, HeaderSource, WireRequest } from './wire.js';

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

/**
 * Methods safe to send again after a lost response. POST and PATCH are not:
 * the server may already have created the resource.
 */
const REPLAYABLE_METHOD: ReadonlySet<string> = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

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
  /**
   * Send an API request. Returns status, headers, and the body as bytes or a
   * stream, without building WHATWG `Response` objects.
   */
  dispatch: Dispatch;
  /**
   * `fetch` for calls that bypass the control plane, such as a request to a
   * published service, which still needs the standard response shape.
   */
  fetch: FetchLike;
  /** Drain pooled sockets. Absent when the client uses a caller-supplied fetch. */
  close?: () => Promise<void>;
  /**
   * Warm the connection to an origin — on Node this opens the pooled HTTP/2
   * session or resolves DNS — so the first request does not pay for it.
   */
  preconnect?: (origin?: string) => Promise<void>;
}

const DEFAULT_SERVICE = 'v1/inference';

/**
 * One attempt's response. The body stays under the attempt's timeout and abort
 * signal until it is read or discarded, so a stalled body cannot outlive them.
 */
interface Reply {
  status: number;
  statusText: string;
  headers: HeaderSource;
  /** The live body of a streamed response; `null` otherwise. */
  stream: ReadableStream<Uint8Array> | null;
  /** Read the body in full, then release the attempt. */
  read(): Promise<Uint8Array>;
  /** Drop the body unread and release the attempt. */
  discard(): void;
}

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
export function parseRetryAfter(headers: HeaderSource): number | null {
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
function headersToObject(headers: HeaderSource): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Wrap a stream so `onDone` runs exactly once when it completes or is cancelled,
 * and a failure mid-stream surfaces as an SDK error.
 */
function withStreamCleanup(
  stream: ReadableStream<Uint8Array>,
  onDone: () => void,
  failure: (error: unknown) => GravixLayerError,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };

  // highWaterMark of 1 forwards each chunk as soon as it arrives, so SSE
  // stdout is not held in this wrapper while the consumer is ready.
  return new ReadableStream<Uint8Array>(
    {
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
          controller.error(failure(error));
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 1 },
  );
}

/** Issues authenticated requests with retries, timeouts, and tracing. */
export class Transport {
  /** Origin of the API base URL, resolved on first use. */
  private baseOrigin: string | undefined;

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

  /**
   * Warm the connection to the API so the next request does not pay for it.
   *
   * Does not send an application request. Credential checks stay on `connect()`.
   */
  async preconnect(): Promise<void> {
    let origin: string | undefined;
    try {
      origin = new URL(this.config.baseUrl).origin;
    } catch {
      origin = undefined;
    }
    await this.config.preconnect?.(origin);
  }

  /** Drain pooled sockets. Safe to call more than once. No-op without a pool. */
  async close(): Promise<void> {
    await this.config.close?.();
  }

  /** Send a request and parse the JSON response. */
  async request<T>(spec: RequestSpec): Promise<T> {
    const reply = await this.send(spec, false);
    return parseJson<T>(reply.status, reply.headers, await reply.read()) as T;
  }

  /** Send a request and discard the response body. */
  async requestVoid(spec: RequestSpec): Promise<void> {
    const reply = await this.send(spec, false);
    await reply.read().catch(() => undefined);
  }

  /** Send a request and return the response body as bytes. */
  async requestBytes(spec: RequestSpec): Promise<Uint8Array> {
    const reply = await this.send(spec, false);
    return reply.read();
  }

  /**
   * Send a request and return the raw body stream.
   *
   * The request timeout applies only until response headers arrive; a stream
   * may then stay open indefinitely. An `AbortSignal` still cancels it at any
   * point.
   */
  async requestStream(spec: RequestSpec): Promise<ReadableStream<Uint8Array>> {
    const reply = await this.send(spec, true);
    if (!reply.stream) {
      reply.discard();
      throw new GravixLayerError('The server returned an empty streaming response.', {
        status: reply.status,
        headers: headersToObject(reply.headers),
      });
    }
    return reply.stream;
  }

  /** True when an absolute URL points anywhere other than the API's origin. */
  private isForeign(url: string, parsed?: URL): boolean {
    try {
      this.baseOrigin ??= new URL(this.config.baseUrl).origin;
      return (parsed ?? new URL(url)).origin !== this.baseOrigin;
    } catch {
      return true;
    }
  }

  /** Run the retry loop and return the successful attempt. */
  private async send(spec: RequestSpec, stream: boolean): Promise<Reply> {
    const { method, options = {} } = spec;
    const service = spec.service ?? DEFAULT_SERVICE;
    const path = spec.query ? withQuery(spec.path, spec.query) : spec.path;
    const url = buildUrl(path, service, this.config.baseUrl);
    // Parsed once here: `isForeign` needs the origin and dispatch needs the
    // parts — parsing inside each of them would repeat the work per request.
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = new URL(url);
    } catch {
      // A malformed URL surfaces inside dispatch with the same error either way.
    }

    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    const timeout = options.timeout ?? this.config.timeout;
    const userSignal = options.signal;

    const headers: Record<string, string> = { ...this.config.defaultHeaders };
    // The API key belongs to the API. A call to another origin that needs a
    // credential passes its own `authorization` header on the request.
    if (isAbsoluteUrl(path) && this.isForeign(url, parsedUrl)) delete headers['authorization'];
    if (spec.body !== undefined && !spec.form) headers['content-type'] = 'application/json';
    if (stream) {
      // Gzip (the default Accept-Encoding on Node fetch) can hold SSE frames
      // until a window fills, which is what makes console output look lagged.
      // identity + event-stream matches the API's streaming contract.
      headers['accept'] = 'text/event-stream';
      headers['accept-encoding'] = 'identity';
      headers['cache-control'] = 'no-cache';
    }
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    // The multipart boundary is chosen where the body is encoded.
    if (spec.form) delete headers['content-type'];

    const body = spec.body !== undefined && !spec.form ? JSON.stringify(spec.body) : undefined;

    const span = startClientSpan(method, url);
    if (span) injectContext(headers);

    try {
      const reply = await this.attemptLoop({
        url,
        parsedUrl,
        method,
        headers,
        body,
        form: spec.form,
        stream,
        timeout,
        maxRetries,
        userSignal,
      });
      span?.setAttribute('http.response.status_code', reply.status);
      return reply;
    } catch (error) {
      failSpan(span, error);
      throw error;
    } finally {
      endSpan(span);
    }
  }

  private async attemptLoop(args: {
    url: string;
    parsedUrl: URL | undefined;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    form: FormData | undefined;
    stream: boolean;
    timeout: number;
    maxRetries: number;
    userSignal: AbortSignal | undefined;
  }): Promise<Reply> {
    const { url, parsedUrl, method, headers, body, form, stream, timeout, maxRetries, userSignal } =
      args;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (userSignal?.aborted) {
        throw new GravixLayerAbortError('Request aborted.', { cause: userSignal.reason });
      }

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

      const failure = (error: unknown): GravixLayerError => {
        if (error instanceof GravixLayerError) return error;
        if (userSignal?.aborted) {
          return new GravixLayerAbortError('Request aborted.', { cause: userSignal.reason });
        }
        if (timedOut) {
          return new GravixLayerTimeoutError(`Request timed out after ${timeout}ms.`, {
            cause: error,
          });
        }
        return new GravixLayerConnectionError(
          error instanceof Error ? error.message : String(error),
          {
            cause: error,
          },
        );
      };

      const wire: WireRequest = {
        url,
        parsedUrl,
        method,
        headers,
        body,
        form,
        signal: controller.signal,
        stream,
      };

      let reply: Reply;
      try {
        const wireReply = await this.config.dispatch(wire);

        let liveStream: ReadableStream<Uint8Array> | null = null;
        if (stream && SUCCESS_STATUS.has(wireReply.status) && wireReply.body) {
          // Headers arrived, so the timeout has done its job. Teardown is
          // deferred until the body is drained or cancelled, which keeps the
          // caller's abort signal wired to the live stream.
          if (timer !== undefined) clearTimeout(timer);
          liveStream = withStreamCleanup(wireReply.body, release, failure);
        }

        reply = {
          status: wireReply.status,
          statusText: wireReply.statusText,
          headers: wireReply.headers,
          stream: liveStream,
          read: () =>
            wireReply.bytes().then(
              (bytes) => {
                release();
                return bytes;
              },
              (error) => {
                release();
                throw failure(error);
              },
            ),
          discard: () => {
            release();
            wireReply.cancel();
          },
        };
      } catch (error) {
        release();
        const wrapped = failure(error);
        // A caller-initiated abort is final; a timeout or socket failure is not.
        // Programmer errors (closed client, bad arguments) must not be retried.
        if (wrapped instanceof GravixLayerAbortError) throw wrapped;
        if (wrapped instanceof GravixLayerInvalidArgumentError) throw wrapped;
        lastError = wrapped;
        if (REPLAYABLE_METHOD.has(method) && attempt < maxRetries) {
          await backoffSleep(backoffMs(attempt), userSignal);
          continue;
        }
        throw wrapped;
      }

      const { status } = reply;
      if (SUCCESS_STATUS.has(status)) return reply;

      if (
        RETRYABLE_STATUS.has(status) &&
        (status === 429 || REPLAYABLE_METHOD.has(method)) &&
        attempt < maxRetries
      ) {
        const retryAfter = parseRetryAfter(reply.headers);
        // Release the connection without blocking the backoff on it.
        reply.discard();
        await backoffSleep(retryAfter ?? backoffMs(attempt), userSignal);
        continue;
      }

      throw await errorFromReply(reply);
    }

    throw new GravixLayerError('Failed to complete request.', { cause: lastError });
  }
}

/** Parse a JSON body, tolerating `204` and other empty responses. */
function parseJson<T>(status: number, headers: HeaderSource, bytes: Uint8Array): T | undefined {
  if (status === 204) return undefined;
  const text = utf8Decode(bytes);
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GravixLayerError('The server returned a malformed JSON response.', {
      status,
      headers: headersToObject(headers),
      body: text,
    });
  }
}

/** Build the error for a non-success response, consuming its body. */
async function errorFromReply(reply: Reply): Promise<GravixLayerError> {
  const bytes = await reply.read().catch(() => undefined);
  const text = bytes ? utf8Decode(bytes) : '';
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  return errorFromStatus(reply.status, formatErrorMessage(text, parsed), {
    headers: headersToObject(reply.headers),
    body: parsed ?? text,
  });
}
