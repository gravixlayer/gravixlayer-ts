/**
 * Node HTTP client.
 *
 * Default is HTTP/1.1 keep-alive with a multi-socket pool — the same shape as
 * the Python SDK (httpx, http2=False, max_connections=20). Create-then-exec is
 * two sequential calls; concurrent sandboxes need parallel sockets, not one
 * multiplexed session. DNS is IPv4-only so CloudFront AAAA records cannot
 * trigger Node's 250ms Happy Eyeballs delay (Python getaddrinfo does not).
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

/** Callback-style lookup matching `node:dns.lookup` / `net.connect`. */
export type DnsLookupCallback = (err: Error | null, address: unknown, family?: number) => void;

export type DnsLookup = (hostname: string, options: unknown, callback?: DnsLookupCallback) => void;

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
  /**
   * Override DNS lookup. Tests inject this to assert IPv4-only resolution.
   * Not part of the public client.
   */
  lookup?: DnsLookup;
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

type UndiciConnector = (options: unknown, callback: unknown) => unknown;

interface UndiciModule {
  Agent: new (options: Record<string, unknown>) => UndiciDispatcher;
  fetch: (
    input: string,
    init?: RequestInit & { dispatcher?: UndiciDispatcher },
  ) => Promise<Response>;
  buildConnector?: (options: Record<string, unknown>) => UndiciConnector;
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
        buildConnector?: UndiciModule['buildConnector'];
        default?: {
          Agent?: UndiciModule['Agent'];
          fetch?: UndiciModule['fetch'];
          buildConnector?: UndiciModule['buildConnector'];
        };
      };
      const Agent = mod.Agent ?? mod.default?.Agent;
      const fetchImpl = mod.fetch ?? mod.default?.fetch;
      const buildConnector = mod.buildConnector ?? mod.default?.buildConnector;
      if (typeof Agent !== 'function' || typeof fetchImpl !== 'function') return null;
      undici = {
        Agent,
        fetch: fetchImpl,
        ...(typeof buildConnector === 'function' ? { buildConnector } : {}),
      };
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
  let ipv4Lookup: DnsLookup | undefined;

  const ensureH1 = (
    loaded: UndiciModule,
    lookup: DnsLookup | undefined,
  ): UndiciDispatcher | undefined => {
    h1Agent ??= createAgent(loaded, { http2: false, rejectUnauthorized, lookup });
    return h1Agent;
  };

  const ensure = (): Promise<UndiciModule | null> => {
    ready ??= (async () => {
      if (closed) return null;
      const [loaded] = await Promise.all([loadUndici(), applyIpv4Prefs()]);
      if (!loaded || closed) return null;
      ipv4Lookup = wrapIpv4Lookup(options.lookup ?? (await defaultDnsLookup()));
      if (http2Wanted && !h2Agent) {
        h2Agent = createAgent(loaded, { http2: true, rejectUnauthorized, lookup: ipv4Lookup });
      }
      if (!http2Wanted) ensureH1(loaded, ipv4Lookup);
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
    const primary = preferH2 ? h2Agent : ensureH1(loaded, ipv4Lookup);
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
        const fallback = ensureH1(loaded, ipv4Lookup);
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

let ipv4Prefs: Promise<void> | undefined;
let cachedDnsLookup: DnsLookup | undefined;

/**
 * Match Python/glibc getaddrinfo order. Node's default `verbatim` lookup
 * returns CloudFront AAAA first; Happy Eyeballs then waits 250ms on a
 * blackholed IPv6 path before trying IPv4. Same CloudFront + ALB, Python
 * never pays that delay.
 *
 * Process-wide, once. `dns.lookup` is what `net`/`tls.connect` use.
 */
function applyIpv4Prefs(): Promise<void> {
  ipv4Prefs ??= (async () => {
    try {
      const dns = await import('node:dns');
      dns.setDefaultResultOrder('ipv4first');
    } catch {
      // Non-Node or restricted runtime. The Agent still forces IPv4 below.
    }
  })();
  return ipv4Prefs;
}

async function defaultDnsLookup(): Promise<DnsLookup | undefined> {
  if (cachedDnsLookup) return cachedDnsLookup;
  try {
    const dns = await import('node:dns');
    cachedDnsLookup = dns.lookup as unknown as DnsLookup;
    return cachedDnsLookup;
  } catch {
    return undefined;
  }
}

/**
 * Force A-record resolution. `family: 4` on `tls.connect` is not enough:
 * Node 20+ Happy Eyeballs still asks `lookup` for every address when
 * `autoSelectFamily` is left at its default.
 */
export function wrapIpv4Lookup(lookup: DnsLookup | undefined): DnsLookup | undefined {
  if (!lookup) return undefined;
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      lookup(hostname, { family: 4, all: false }, options as DnsLookupCallback);
      return;
    }
    const opts =
      options && typeof options === 'object' ? { ...(options as Record<string, unknown>) } : {};
    opts.family = 4;
    opts.all = false;
    lookup(hostname, opts, callback);
  };
}

function createAgent(
  loaded: UndiciModule,
  opts: { http2: boolean; rejectUnauthorized: boolean; lookup?: DnsLookup },
): UndiciDispatcher | undefined {
  const connectObject: Record<string, unknown> = {
    timeout: CONNECT_TIMEOUT_MS,
    family: 4,
    autoSelectFamily: false,
    rejectUnauthorized: opts.rejectUnauthorized,
    keepAlive: true,
    keepAliveInitialDelay: TCP_KEEPALIVE_DELAY_MS,
    allowH2: opts.http2,
  };
  if (opts.lookup) connectObject.lookup = opts.lookup;

  const connect = buildIpv4Connector(loaded, connectObject) ?? connectObject;

  const shared = {
    pipelining: 1,
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
    // SSE / exec streams can sit quiet between frames; the SDK abort timer
    // is the real deadline. A 300s undici body timeout would kill them.
    bodyTimeout: 0,
    headersTimeout: 300_000,
    autoSelectFamily: false,
    connect,
  };

  const full: Record<string, unknown> = opts.http2
    ? {
        ...shared,
        connections: H2_SESSIONS,
        allowH2: true,
        maxConcurrentStreams: 128,
        pingInterval: H2_PING_MS,
        initialWindowSize: 262_144,
        connectionWindowSize: 524_288,
      }
    : {
        ...shared,
        connections: H1_CONNECTIONS,
        allowH2: false,
      };

  // Fallbacks drop only keys older undici rejects. IPv4 lookup/family stay.
  const variants: Record<string, unknown>[] = [
    full,
    {
      pipelining: 1,
      keepAliveTimeout: KEEP_ALIVE_MS,
      autoSelectFamily: false,
      connections: opts.http2 ? H2_SESSIONS : H1_CONNECTIONS,
      allowH2: opts.http2,
      connect: connectObject,
    },
    {
      connections: opts.http2 ? H2_SESSIONS : H1_CONNECTIONS,
      allowH2: opts.http2,
      autoSelectFamily: false,
      connect: {
        family: 4,
        autoSelectFamily: false,
        rejectUnauthorized: opts.rejectUnauthorized,
        allowH2: opts.http2,
        ...(opts.lookup ? { lookup: opts.lookup } : {}),
      },
    },
  ];

  for (const options of variants) {
    try {
      return new loaded.Agent(options);
    } catch {
      // Older undici rejects unknown keys.
    }
  }
  return undefined;
}

function buildIpv4Connector(
  loaded: UndiciModule,
  connectObject: Record<string, unknown>,
): UndiciConnector | undefined {
  if (typeof loaded.buildConnector !== 'function') return undefined;
  try {
    return loaded.buildConnector(connectObject);
  } catch {
    try {
      return loaded.buildConnector({
        timeout: CONNECT_TIMEOUT_MS,
        family: 4,
        autoSelectFamily: false,
        rejectUnauthorized: connectObject.rejectUnauthorized,
        allowH2: connectObject.allowH2,
        ...(connectObject.lookup ? { lookup: connectObject.lookup } : {}),
      });
    } catch {
      return undefined;
    }
  }
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
