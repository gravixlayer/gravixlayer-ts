/**
 * The contract between the transport and the HTTP client beneath it.
 *
 * An API call needs three things from a response: the status, a header
 * lookup, and the body bytes. Asking for exactly that, rather than a WHATWG
 * `Response`, lets the Node client hand over the bytes it received without
 * building `Response` or `Headers` objects first. A caller-supplied `fetch` is
 * adapted to the same shape by {@link fetchDispatch}.
 */

import { concatBytes } from './binary.js';
import type { FetchLike } from './transport.js';

/** Read access to response headers. A WHATWG `Headers` satisfies it. */
export interface HeaderSource {
  /** One header's value, matched case-insensitively, or `null` when absent. */
  get(name: string): string | null;
  /** Visit every header as `(value, name)`, with lower-cased names. */
  forEach(callback: (value: string, name: string) => void): void;
}

/** One HTTP request, as the transport issues it. */
export interface WireRequest {
  /** Absolute URL. */
  url: string;
  /** Upper-case method. */
  method: string;
  /**
   * Lower-cased header names. The client may add headers it derives from the
   * request, such as `host` or a multipart `content-type`.
   */
  headers: Record<string, string>;
  /** Encoded body. Mutually exclusive with `form`. */
  body?: string | Uint8Array;
  /** Multipart body, encoded by the client. */
  form?: FormData;
  /** Cancels the request and any body still being received. */
  signal?: AbortSignal;
  /** Hand over the body as a live stream instead of reading it in full. */
  stream: boolean;
}

/** One HTTP response, as the transport consumes it. */
export interface WireResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeaderSource;
  /** The live body of a streamed response. `null` when the body is buffered or empty. */
  readonly body: ReadableStream<Uint8Array> | null;
  /** The whole body. */
  bytes(): Promise<Uint8Array>;
  /** Release a body that will not be read. */
  cancel(): void;
}

/** Send one request and resolve once its response headers have arrived. */
export type Dispatch = (request: WireRequest) => Promise<WireResponse>;

/** Issue requests through a `fetch` implementation. */
export function fetchDispatch(fetch: FetchLike): Dispatch {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: (request.form ?? request.body ?? null) as BodyInit | null,
      signal: request.signal ?? null,
      // Streaming responses must not be buffered by an intermediate cache.
      ...(request.stream ? { cache: 'no-store' as RequestCache } : {}),
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      bytes: async () => new Uint8Array(await response.arrayBuffer()),
      cancel: () => {
        void response.body?.cancel().catch(() => undefined);
      },
    };
  };
}

/** Read a byte stream to its end. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(chunks);
    chunks.push(value);
  }
}
