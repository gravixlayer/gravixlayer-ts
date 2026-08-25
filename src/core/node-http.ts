/**
 * Node HTTP client.
 *
 * Default is HTTP/1.1 keep-alive with a multi-socket pool — the same shape as
 * the Python SDK (httpx, http2=False, max_connections=20). Create-then-exec is
 * two sequential calls; concurrent sandboxes need parallel sockets, not one
 * multiplexed session.
 *
 * HTTP/2 is opt-in. A single H2 session is only a win when ALPN actually
 * selects `h2`. If the origin speaks HTTP/1.1, `connections: 1` serializes
 * every in-flight request (the 0.1.6 TTI regression vs Python).
 *
 * Loaded only on Node. `undici` is imported dynamically so Bun, Deno, and
 * edge bundles never evaluate it.
 */

import { GravixLayerInvalidArgumentError } from './errors.js';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface NativeNodeFetchOptions {
  /**
   * Negotiate HTTP/2 on HTTPS. Defaults to false (HTTP/1.1 pool), matching
   * the Python client.
   */
  http2?: boolean;
  /**
   * TLS verification. Tests against a self-signed server set this false.
   * Not part of the public client.
   */
  rejectUnauthorized?: boolean;
}

export interface NativeNodeFetch {
  fetch: FetchLike;
  preconnect(): Promise<void>;
  close(): Promise<void>;
}

/**
 * HTTP/2 sessions per origin when HTTP/2 is requested and negotiated.
 *
 * Must stay at 1. A larger count opens that many TLS sessions and skips
 * multiplexing. Only used when `http2: true`.
 */
const H2_SESSIONS = 1;

/**
 * HTTP/1.1 sockets per origin.
 *
 * Matches the Python pool (20 max / 10 keep-alive). Concurrent create+exec
 * across sandboxes needs one socket per in-flight request.
 */
const H1_CONNECTIONS = 16;

/**
 * Idle bound in milliseconds.
 *
 * ALB's default idle timeout is 60s. Closing first avoids a reused connection
 * the balancer already reset. CloudFront viewer idle is longer; 50s is safe.
 */
const KEEP_ALIVE_MS = 50_000;

const KEEP_ALIVE_MAX_MS = 600_000;

/**
 * HTTP/2 PING interval (only when HTTP/2 is on).
 *
 * ALB and CloudFront drop idle origin connections around 60s. A PING at 25s
 * keeps the session up so the next create/exec does not handshake.
 */
const H2_PING_MS = 25_000;

/** TCP/TLS connect deadline. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * First TCP keep-alive probe. Default 60s races ALB's idle timeout; 15s
 * probes while the socket is still accepted.
 */
const TCP_KEEPALIVE_DELAY_MS = 15_000;

interface UndiciDispatcher {
  close(): Promise<void>;
  destroy?: () => void;
}

interface UndiciModule {
  Agent: new (options: Record<string, unknown>) => UndiciDispatcher;
  fetch: (
    input: string,
    init?: RequestInit & { dispatcher?: UndiciDispatcher },
  ) => Promise<Response>;
}

let undici: UndiciModule | undefined;
let loading: Promise<UndiciModule | null> | undefined;

async function loadUndici(): Promise<UndiciModule | null> {
  if (undici) return undici;
  loading ??= (async () => {
    try {
      const mod = (await import(
        /* webpackIgnore: true */ /* @vite-ignore */ 'undici'
      )) as unknown as {
        Agent?: UndiciModule['Agent'];
        fetch?: UndiciModule['fetch'];
        default?: { Agent?: UndiciModule['Agent']; fetch?: UndiciModule['fetch'] };
      };
      const Agent = mod.Agent ?? mod.default?.Agent;
      const fetchImpl = mod.fetch ?? mod.default?.fetch;
      if (typeof Agent !== 'function' || typeof fetchImpl !== 'function') return null;
      undici = { Agent, fetch: fetchImpl };
      return undici;
    } catch {
      return null;
    }
  })();
  return loading;
}

export function createNativeNodeFetch(options: NativeNodeFetchOptions = {}): NativeNodeFetch {
  const http2Wanted = options.http2 === true;
  const rejectUnauthorized = options.rejectUnauthorized !== false;

  let closed = false;
  let h2Agent: UndiciDispatcher | undefined;
  let h1Agent: UndiciDispatcher | undefined;
  const h2FailedOrigins = new Set<string>();
  const h2ConfirmedOrigins = new Set<string>();
  let ready: Promise<UndiciModule | null> | undefined;

  const ensureH1 = (loaded: UndiciModule): UndiciDispatcher | undefined => {
    h1Agent ??= createAgent(loaded.Agent, { http2: false, rejectUnauthorized });
    return h1Agent;
  };

  const ensure = (): Promise<UndiciModule | null> => {
    ready ??= (async () => {
      if (closed) return null;
      const loaded = await loadUndici();
      if (!loaded || closed) return null;
      if (http2Wanted && !h2Agent) {
        h2Agent = createAgent(loaded.Agent, { http2: true, rejectUnauthorized });
      }
      if (!http2Wanted) ensureH1(loaded);
      return loaded;
    })();
    return ready;
  };

  const fetch: FetchLike = async (input, init = {}) => {
    if (closed) {
      throw new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
    }
    const loaded = await ensure();
    if (!loaded) {
      throw new GravixLayerInvalidArgumentError(
        'The GravixLayer client could not load the Node HTTP stack.',
      );
    }

    const origin = originOf(input);
    const preferH2 =
      http2Wanted && !h2FailedOrigins.has(origin) && isHttpsOrigin(origin) && !!h2Agent;
    const primary = preferH2 ? h2Agent : ensureH1(loaded);
    if (!primary) {
      throw new GravixLayerInvalidArgumentError(
        'The GravixLayer client could not create an HTTP dispatcher.',
      );
    }

    try {
      const response = await loaded.fetch(input, { ...init, dispatcher: primary });
      if (preferH2) h2ConfirmedOrigins.add(origin);
      return response;
    } catch (error) {
      if (closed) throw error;
      if (
        preferH2 &&
        !h2ConfirmedOrigins.has(origin) &&
        isHttp2HandshakeFailure(error) &&
        isReplayableBody(init.body)
      ) {
        h2FailedOrigins.add(origin);
        const fallback = ensureH1(loaded);
        if (!fallback) throw error;
        return loaded.fetch(input, { ...init, dispatcher: fallback });
      }
      throw error;
    }
  };

  return {
    fetch,
    async preconnect() {
      await ensure();
    },
    async close() {
      closed = true;
      const agents = [h2Agent, h1Agent];
      h2Agent = undefined;
      h1Agent = undefined;
      h2FailedOrigins.clear();
      h2ConfirmedOrigins.clear();
      for (const agent of agents) {
        if (!agent) continue;
        try {
          await agent.close();
        } catch {
          agent.destroy?.();
        }
      }
    },
  };
}

function createAgent(
  Agent: UndiciModule['Agent'],
  opts: { http2: boolean; rejectUnauthorized: boolean },
): UndiciDispatcher | undefined {
  /**
   * IPv4 first. `autoSelectFamily: true` waits 250ms for a broken IPv6 AAAA
   * (CloudFront publishes both). That is the ~270ms first-create vs Python's
   * ~50ms. httpx uses getaddrinfo order and does not insert that delay.
   */
  const connect = {
    timeout: CONNECT_TIMEOUT_MS,
    family: 4,
    autoSelectFamily: false,
    rejectUnauthorized: opts.rejectUnauthorized,
    keepAlive: true,
    keepAliveInitialDelay: TCP_KEEPALIVE_DELAY_MS,
  };

  const shared = {
    pipelining: 1,
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
    // SSE / exec streams can sit quiet between frames; the SDK abort timer
    // is the real deadline. A 300s undici body timeout would kill them.
    bodyTimeout: 0,
    headersTimeout: 300_000,
    connect,
  };

  const h2 = {
    ...shared,
    connections: H2_SESSIONS,
    allowH2: true,
    maxConcurrentStreams: 128,
    pingInterval: H2_PING_MS,
    initialWindowSize: 262_144,
    connectionWindowSize: 524_288,
  };
  const h1 = {
    ...shared,
    connections: H1_CONNECTIONS,
    allowH2: false,
  };

  const variants: Record<string, unknown>[] = opts.http2
    ? [
        h2,
        {
          ...h2,
          connect: {
            timeout: CONNECT_TIMEOUT_MS,
            family: 4,
            rejectUnauthorized: opts.rejectUnauthorized,
            keepAlive: true,
          },
        },
        { allowH2: true, connections: H2_SESSIONS, keepAliveTimeout: KEEP_ALIVE_MS },
      ]
    : [
        h1,
        {
          ...h1,
          connect: {
            timeout: CONNECT_TIMEOUT_MS,
            rejectUnauthorized: opts.rejectUnauthorized,
            keepAlive: true,
          },
        },
        { allowH2: false, connections: H1_CONNECTIONS, keepAliveTimeout: KEEP_ALIVE_MS },
      ];

  for (const options of variants) {
    try {
      return new Agent(options);
    } catch {
      // Older undici rejects unknown keys.
    }
  }
  return undefined;
}

function originOf(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return input;
  }
}

function isHttpsOrigin(origin: string): boolean {
  return origin.startsWith('https:');
}

/**
 * Handshake fallback must not replay a consumed stream (FormData, fetch
 * streams). Strings and byte buffers are safe to send a second time.
 */
function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body == null) return true;
  if (typeof body === 'string') return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  return false;
}

/** Handshake / ALPN failures — safe to retry the same request on HTTP/1.1. */
function isHttp2HandshakeFailure(error: unknown): boolean {
  const err = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = `${err.code ?? ''} ${err.cause?.code ?? ''}`;
  const message = `${err.message ?? ''} ${err.cause?.message ?? ''}`.toLowerCase();
  if (
    code.includes('ERR_HTTP2') ||
    code.includes('ERR_SSL_WRONG_VERSION_NUMBER') ||
    code.includes('EPROTO') ||
    code.includes('ERR_TLS')
  ) {
    return true;
  }
  return (
    message.includes('http2') ||
    message.includes('alpn') ||
    message.includes('h2 protocol') ||
    message.includes('unknown protocol')
  );
}
