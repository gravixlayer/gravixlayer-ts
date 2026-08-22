/**
 * Optional OpenTelemetry instrumentation.
 *
 * The SDK has no runtime dependencies. Tracing activates only when the host
 * application has `@opentelemetry/api` installed and `GRAVIXLAYER_ENABLE_TELEMETRY`
 * is truthy; otherwise every function here is an inexpensive no-op.
 *
 * Following the convention for instrumented libraries on Node, the SDK emits
 * spans against whichever tracer provider the application registered and never
 * configures an exporter itself. Wire up `@opentelemetry/sdk-node` (or your
 * platform's equivalent) in the application and these spans join those traces.
 *
 * @example Turn on tracing
 * ```ts
 * import { enableTelemetry } from 'gravixlayer';
 * await enableTelemetry();
 * ```
 */

import { readEnvFlagOrUndefined } from './env.js';
import { VERSION } from '../version.js';

/**
 * Minimal structural types for the pieces of the OpenTelemetry API used here.
 * Declaring them locally keeps `@opentelemetry/api` out of the SDK's public
 * type surface, so consumers without it installed still typecheck.
 */
interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(error: unknown): unknown;
  end(): void;
}

interface TracerLike {
  startSpan(name: string, options?: { kind?: number; attributes?: Attributes }): SpanLike;
}

interface OtelApi {
  trace: {
    getTracer(name: string, version?: string): TracerLike;
    setSpan(context: unknown, span: SpanLike): unknown;
  };
  context: { active(): unknown; with<T>(ctx: unknown, fn: () => T): T };
  propagation: { inject(context: unknown, carrier: Record<string, string>): void };
  SpanKind: { CLIENT: number; INTERNAL: number };
  SpanStatusCode: { OK: number; ERROR: number };
}

/** Attributes attachable to a span. */
export type Attributes = Record<string, string | number | boolean>;

const TRACER_NAME = 'gravixlayer';
const ENABLE_FLAG = 'GRAVIXLAYER_ENABLE_TELEMETRY';

let api: OtelApi | null = null;
let tracer: TracerLike | null = null;
let loading: Promise<boolean> | null = null;
let optedIn = false;

/**
 * True when SDK tracing is on.
 *
 * `GRAVIXLAYER_ENABLE_TELEMETRY` decides when it is set, either way; otherwise
 * tracing is on only when {@link enableTelemetry} was called. An explicit
 * `GRAVIXLAYER_ENABLE_TELEMETRY=false` therefore keeps a library that calls
 * `enableTelemetry()` from turning tracing on behind the operator's back.
 */
export function telemetryEnabled(): boolean {
  return readEnvFlagOrUndefined(ENABLE_FLAG) ?? optedIn;
}

/**
 * Load `@opentelemetry/api` and start emitting spans.
 *
 * Safe to call repeatedly: the import happens once and later calls reuse it.
 * Resolves `false` when the package is not installed, or when the environment
 * has turned telemetry off; neither is an error.
 *
 * @returns whether tracing is now active.
 */
export function enableTelemetry(): Promise<boolean> {
  if (readEnvFlagOrUndefined(ENABLE_FLAG) === false) return Promise.resolve(false);

  optedIn = true;
  if (loading) return loading;

  loading = (async () => {
    try {
      // Resolved at runtime so bundlers keep it optional. The package is an
      // optional peer dependency; absence is expected and non-fatal.
      const mod = (await import(/* @vite-ignore */ '@opentelemetry/api')) as unknown as
        OtelApi | { default: OtelApi };
      api = 'trace' in mod ? mod : mod.default;
      tracer = api.trace.getTracer(TRACER_NAME, VERSION);
      return true;
    } catch {
      api = null;
      tracer = null;
      return false;
    }
  })();

  return loading;
}

/**
 * Start loading the tracer when the environment opts in.
 *
 * Called from the client constructor. Deliberately does not block
 * construction; requests issued before the import settles are simply untraced.
 */
export function maybeEnableFromEnv(): void {
  if (!telemetryEnabled()) return;
  void enableTelemetry();
}

/** Reset tracing state. Exported for tests. */
export function resetTelemetry(): void {
  api = null;
  tracer = null;
  loading = null;
  optedIn = false;
}

/** True when spans are actively being recorded. */
export function isTracing(): boolean {
  return tracer !== null && telemetryEnabled();
}

/** Begin a CLIENT span for an outbound HTTP request, or `null` when inactive. */
export function startClientSpan(method: string, url: string): SpanLike | null {
  if (!isTracing() || !api || !tracer) return null;

  let path = url;
  try {
    path = new URL(url).pathname || url;
  } catch {
    // A non-absolute URL should not break span naming.
  }

  return tracer.startSpan(`${method} ${path}`, {
    kind: api.SpanKind.CLIENT,
    attributes: {
      'http.request.method': method,
      'url.full': url,
      'url.path': path,
    },
  });
}

/**
 * Inject W3C trace context into outgoing request headers so the API's spans
 * become children of the caller's span.
 */
export function injectContext(headers: Record<string, string>): void {
  if (!isTracing() || !api) return;
  try {
    api.propagation.inject(api.context.active(), headers);
  } catch {
    // Propagation must never break a request.
  }
}

/** Mark a span as failed and attach the error. */
export function failSpan(span: SpanLike | null, error: unknown): void {
  if (!span || !api) return;
  try {
    span.recordException(error);
    span.setStatus({
      code: api.SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Never let instrumentation surface an error of its own.
  }
}

/** End a span, tolerating a null span and any provider-side failure. */
export function endSpan(span: SpanLike | null): void {
  try {
    span?.end();
  } catch {
    // Ignored.
  }
}

/** Options for {@link trace} and {@link traced}. */
export interface TraceOptions {
  /** Attributes attached to the span at creation. */
  attributes?: Attributes;
}

/**
 * Run a function inside a span.
 *
 * The span is ended whether the function resolves or throws, and a thrown
 * error is recorded before it propagates. With tracing off, this costs one
 * boolean check.
 *
 * @example
 * ```ts
 * const result = await trace('prepare-dataset', async () => transform(rows));
 * ```
 */
export async function trace<T>(
  name: string,
  fn: () => T | Promise<T>,
  options: TraceOptions = {},
): Promise<T> {
  if (!isTracing() || !api || !tracer) return await fn();

  const span = tracer.startSpan(name, {
    kind: api.SpanKind.INTERNAL,
    ...(options.attributes ? { attributes: options.attributes } : {}),
  });
  const ctx = api.trace.setSpan(api.context.active(), span);

  try {
    const result = await api.context.with(ctx, () => fn());
    span.setStatus({ code: api.SpanStatusCode.OK });
    return result;
  } catch (error) {
    failSpan(span, error);
    throw error;
  } finally {
    endSpan(span);
  }
}

/**
 * Wrap a function so every call is traced.
 *
 * @example
 * ```ts
 * const summarize = traced(async (text: string) => callModel(text), { name: 'summarize' });
 * ```
 */
export function traced<Args extends unknown[], R>(
  fn: (...args: Args) => R | Promise<R>,
  options: TraceOptions & { name?: string } = {},
): (...args: Args) => Promise<R> {
  // An inline arrow has an empty `name`, so fall through on any empty value.
  const name = options.name || fn.name || 'anonymous';
  return (...args: Args) => trace(name, () => fn(...args), options);
}

/** Run a function inside a span tagged with the runtime it operates on. */
export function runtimeSpan<T>(
  operation: string,
  runtimeId: string,
  fn: () => T | Promise<T>,
  options: TraceOptions = {},
): Promise<T> {
  return trace(`runtime.${operation}`, fn, {
    attributes: {
      'gravixlayer.runtime.id': runtimeId,
      'gravixlayer.operation': operation,
      ...options.attributes,
    },
  });
}
