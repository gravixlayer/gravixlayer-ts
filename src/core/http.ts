/**
 * Native HTTP dispatcher for Node.
 *
 * Node's global `fetch` speaks HTTP/1.1 with a short keep-alive. Concurrent
 * create+exec would each pay a new TCP+TLS handshake.
 *
 * On Node the SDK multiplexes on one HTTP/2 session per origin (IPv4,
 * hostname SNI); origins that do not speak HTTP/2 fall back to the HTTP/1.1
 * keep-alive pool, and `http2: false` selects the pool directly. Bun, Deno,
 * and edge runtimes keep their native `fetch`. A caller-supplied `fetch`
 * always wins.
 */

import { createNativeNodeFetch, type DnsLookup } from './node-http.js';
import { fetchDispatch, type Dispatch } from './wire.js';
import type { FetchLike } from './transport.js';

/** Where the SDK is running, as far as the HTTP stack is concerned. */
export type HostRuntime = 'node' | 'bun' | 'deno' | 'other';

/** A fetch implementation plus the hooks that own its connection pool. */
export interface PooledFetch {
  fetch: FetchLike;
  /**
   * The same requests without WHATWG objects: status, headers, and body
   * bytes. The transport sends API calls through this.
   */
  dispatch: Dispatch;
  /**
   * Warm the transport so the first request does not. Given an origin, this
   * resolves DNS and, for `http2`, opens the pooled session.
   */
  preconnect(origin?: string): Promise<void>;
  /** Drain and close pooled sockets. Safe to call more than once. */
  close(): Promise<void>;
}

/** Options for {@link createPooledFetch}. */
export interface PooledFetchOptions {
  /**
   * Enable HTTP/2 on Node HTTPS origins. Defaults to true (one session per
   * origin); `false` selects the HTTP/1.1 keep-alive pool.
   */
  http2?: boolean;
  /**
   * TLS verification. Tests against a self-signed server set this false.
   * Not part of the public client.
   */
  rejectUnauthorized?: boolean;
  /**
   * Override DNS lookup. Tests inject this to assert IPv4-only resolution.
   * Not part of the public client.
   */
  lookup?: DnsLookup;
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
 * Bind a fetch that, on Node, reuses one HTTP/2 session per origin (or the
 * HTTP/1.1 keep-alive pool when `http2: false` or the origin lacks `h2`).
 *
 * Everywhere else this is `globalThis.fetch`. Construction does not touch
 * the network; sockets open on the first request (or {@link PooledFetch.preconnect}).
 */
export function createPooledFetch(options: PooledFetchOptions = {}): PooledFetch {
  if (hostRuntime() !== 'node') {
    const fallback = bindGlobalFetch();
    return {
      fetch: fallback,
      dispatch: fetchDispatch(fallback),
      preconnect: async () => undefined,
      close: async () => undefined,
    };
  }

  const native = createNativeNodeFetch({
    http2: options.http2,
    rejectUnauthorized: options.rejectUnauthorized,
    lookup: options.lookup,
  });

  // Load `node:*` modules in the background so the first real request does not.
  void native.preconnect().catch(() => undefined);

  return {
    fetch: native.fetch,
    dispatch: native.dispatch,
    preconnect: (origin) => native.preconnect(origin),
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
