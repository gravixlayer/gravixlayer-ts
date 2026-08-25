/**
 * Native HTTP dispatcher for Node.
 *
 * Node's global `fetch` speaks HTTP/1.1 with a ~4-second keep-alive. Create
 * then exec can each open a new TCP+TLS session, and concurrent work queues
 * behind a handful of sockets.
 *
 * On Node the SDK uses undici with an HTTP/1.1 keep-alive pool (same default
 * as the Python client). HTTP/2 is opt-in. HTTP/3 stays on the CloudFront
 * viewer path. Bun, Deno, and edge runtimes keep their native `fetch`. A
 * caller-supplied `fetch` always wins.
 */

import { createNativeNodeFetch } from './node-http.js';

/** A `fetch`-compatible function. */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Where the SDK is running, as far as the HTTP stack is concerned. */
export type HostRuntime = 'node' | 'bun' | 'deno' | 'other';

/** A fetch implementation plus the hooks that own its connection pool. */
export interface PooledFetch {
  fetch: FetchLike;
  /** Best-effort: load native bindings so the first request does not. */
  preconnect(): Promise<void>;
  /** Drain and close pooled sockets. Safe to call more than once. */
  close(): Promise<void>;
}

/** Options for {@link createPooledFetch}. */
export interface PooledFetchOptions {
  /** Enable HTTP/2 on Node HTTPS origins. Defaults to false (HTTP/1.1 pool). */
  http2?: boolean;
  /**
   * TLS verification. Tests against a self-signed server set this false.
   * Not part of the public client.
   */
  rejectUnauthorized?: boolean;
}

interface NodeProcess {
  versions?: { node?: string; bun?: string; deno?: string };
}

/** Identify the host without importing any `node:*` module at load time. */
export function hostRuntime(): HostRuntime {
  const g = globalThis as {
    process?: NodeProcess;
    Deno?: unknown;
    Bun?: unknown;
  };
  if (typeof g.Bun !== 'undefined' || g.process?.versions?.bun) return 'bun';
  if (typeof g.Deno !== 'undefined' || g.process?.versions?.deno) return 'deno';
  if (g.process?.versions?.node) return 'node';
  return 'other';
}

/**
 * Bind a fetch that, on Node, rides a pooled HTTP/1.1 keep-alive agent.
 *
 * Everywhere else this is `globalThis.fetch`. Construction does not touch
 * the network; sockets open on the first request (or {@link PooledFetch.preconnect}).
 */
export function createPooledFetch(options: PooledFetchOptions = {}): PooledFetch {
  if (hostRuntime() !== 'node') {
    const fallback = bindGlobalFetch();
    return { fetch: fallback, preconnect: async () => undefined, close: async () => undefined };
  }

  const native = createNativeNodeFetch({
    http2: options.http2,
    rejectUnauthorized: options.rejectUnauthorized,
  });

  // Load undici in the background so the first real request does not.
  void native.preconnect();

  return {
    fetch: native.fetch,
    preconnect: () => native.preconnect(),
    close: () => native.close(),
  };
}

/** The runtime's `fetch`, bound so a detached call does not throw. */
function bindGlobalFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') {
    return () => {
      throw new Error(
        'This runtime has no global fetch. Use Node 20 or newer, or pass a `fetch` implementation.',
      );
    };
  }
  return globalThis.fetch.bind(globalThis) as FetchLike;
}
