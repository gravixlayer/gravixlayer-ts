/**
 * Error hierarchy for the GravixLayer SDK.
 *
 * Every failure raised by the SDK extends {@link GravixLayerError}, so a single
 * `catch (err) { if (err instanceof GravixLayerError) ... }` covers the whole
 * surface. Errors produced from an HTTP response also carry the status code,
 * response headers, and the parsed body so callers can react without
 * re-reading the network.
 */

/** Extra context attached to an error raised from an HTTP response. */
export interface GravixLayerErrorContext {
  /** HTTP status code, when the failure came from a response. */
  status?: number;
  /** Response headers, lower-cased, when the failure came from a response. */
  headers?: Record<string, string>;
  /** Parsed JSON body, or the raw text when the body was not JSON. */
  body?: unknown;
  /** Machine-readable API `code`, when the body supplied one. */
  code?: string;
  /** The underlying error, for connection and abort failures. */
  cause?: unknown;
}

const MESSAGE_KEYS = ['message', 'error', 'detail', 'msg'] as const;

/** Pick the shortest useful product line from an API error body. */
export function formatErrorMessage(text: string, parsed: unknown): string {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      const found = stringField(record[key]);
      if (found !== undefined) return found;
    }
  }
  const trimmed = text.trim();
  return trimmed === '' ? 'Request failed.' : trimmed;
}

/** Read `code` from an API error body. Non-string values are ignored. */
export function codeFromBody(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const code = (parsed as Record<string, unknown>).code;
  if (typeof code !== 'string') return undefined;
  const trimmed = code.trim();
  return trimmed === '' ? undefined : trimmed;
}

function stringField(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>).message;
    if (typeof nested === 'string') {
      const trimmed = nested.trim();
      return trimmed === '' ? undefined : trimmed;
    }
  }
  return undefined;
}

/** Base class for every error the SDK raises. */
export class GravixLayerError extends Error {
  /** HTTP status code, or `undefined` for connection/abort/validation errors. */
  readonly status: number | undefined;
  /** Lower-cased response headers, when the error came from an HTTP response. */
  readonly headers: Record<string, string> | undefined;
  /** Parsed JSON body, or raw text when the response was not JSON. */
  readonly body: unknown;
  /** API `code` (for example `quota_exceeded`), when the body supplied one. */
  readonly code: string | undefined;
  /**
   * Server-side request identifier, when the API supplies one. Include this
   * when reporting a problem. May be `undefined`.
   */
  readonly requestId: string | undefined;

  constructor(message: string, context: GravixLayerErrorContext = {}) {
    super(message, context.cause !== undefined ? { cause: context.cause } : undefined);
    this.name = new.target.name;
    this.status = context.status;
    this.headers = context.headers;
    this.body = context.body;
    this.code = context.code ?? codeFromBody(context.body);
    this.requestId = context.headers
      ? (context.headers['x-request-id'] ?? context.headers['x-correlation-id'])
      : undefined;

    // Keeps `instanceof` working when the package is downleveled by a bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Same as Python `str(exc)`: the product line only, no class prefix. */
  override toString(): string {
    return this.message;
  }
}

/** The API key is missing, malformed, or not authorized (HTTP 401). */
export class GravixLayerAuthenticationError extends GravixLayerError {}

/** The account exceeded its rate limit (HTTP 429) and retries were exhausted. */
export class GravixLayerRateLimitError extends GravixLayerError {
  /**
   * How long the API asked the caller to wait, in seconds.
   *
   * Read from `Retry-After`, which may carry either a delay or a date, and
   * `undefined` when the response supplied neither. The SDK has already retried
   * and backed off by the time this surfaces, so treat it as guidance for
   * scheduling the next attempt rather than for retrying straight away.
   */
  get retryAfterSeconds(): number | undefined {
    const value = this.headers?.['retry-after'];
    if (!value) return undefined;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;

    const date = Date.parse(value);
    if (Number.isNaN(date)) return undefined;
    return Math.max(0, Math.round((date - Date.now()) / 1000));
  }
}

/** The API returned a 5xx response. */
export class GravixLayerServerError extends GravixLayerError {}

/** The request was rejected as invalid (HTTP 4xx other than 401 and 429). */
export class GravixLayerBadRequestError extends GravixLayerError {}

/** The request never produced a response: DNS, TCP, TLS, or socket failure. */
export class GravixLayerConnectionError extends GravixLayerError {}

/** The request exceeded its timeout. A specialization of a connection failure. */
export class GravixLayerTimeoutError extends GravixLayerConnectionError {}

/** The caller aborted the request through an `AbortSignal`. */
export class GravixLayerAbortError extends GravixLayerError {}

/**
 * Arguments failed validation before any request was sent.
 *
 * Extends `TypeError` semantics in spirit but stays inside the SDK hierarchy so
 * one `catch` covers everything.
 */
export class GravixLayerInvalidArgumentError extends GravixLayerError {}

/**
 * Map an HTTP status code to the matching error class and construct it.
 *
 * 401 always reports a fixed message rather than echoing the response body,
 * which can contain diagnostic detail that is unhelpful to surface directly.
 */
export function errorFromStatus(
  status: number,
  message: string,
  context: Omit<GravixLayerErrorContext, 'status'> = {},
): GravixLayerError {
  const ctx: GravixLayerErrorContext = { ...context, status };

  if (status === 401) return new GravixLayerAuthenticationError('Authentication failed.', ctx);
  if (status === 429) return new GravixLayerRateLimitError(message, ctx);
  if (status >= 500) return new GravixLayerServerError(message, ctx);
  if (status >= 400) return new GravixLayerBadRequestError(message, ctx);

  return new GravixLayerError(message, ctx);
}
