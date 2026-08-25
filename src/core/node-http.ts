/**
 * Node HTTP client.
 *
 * Default HTTP/1.1 uses Node `http.Agent` / `https.Agent` with `family: 4`.
 * That option is passed through to `net.connect` / `tls.connect` — the same
 * path axios, got, and node-fetch v2 use. undici's `connect.family` did not
 * stop Happy Eyeballs on CloudFront AAAA (0.1.7–0.1.8 still ~250ms/create
 * while Python, same CloudFront → ALB, is ~80ms).
 *
 * HTTP/2 stays opt-in on undici. Loaded only on Node. `node:*` and `undici`
 * are imported dynamically so Bun, Deno, and edge bundles never evaluate them.
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

interface DestroyableAgent {
  destroy(): void;
}

interface NodeH1Pool {
  fetch: FetchLike;
  close(): void;
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
  let h1Pool: NodeH1Pool | undefined;
  const h2FailedOrigins = new Set<string>();
  const h2ConfirmedOrigins = new Set<string>();
  let h1Ready: Promise<NodeH1Pool | undefined> | undefined;
  let h2Ready: Promise<UndiciModule | null> | undefined;
  let ipv4Lookup: DnsLookup | undefined;

  const ensureH1 = (): Promise<NodeH1Pool | undefined> => {
    h1Ready ??= (async () => {
      if (closed) return undefined;
      await applyIpv4Prefs();
      ipv4Lookup = wrapIpv4Lookup(options.lookup ?? (await defaultDnsLookup()));
      if (closed) return undefined;
      h1Pool = await createNodeH1Pool({ rejectUnauthorized, lookup: ipv4Lookup });
      return h1Pool;
    })();
    return h1Ready;
  };

  const ensureH2 = (): Promise<UndiciModule | null> => {
    h2Ready ??= (async () => {
      if (closed) return null;
      const [loaded] = await Promise.all([loadUndici(), applyIpv4Prefs()]);
      if (!loaded || closed) return null;
      ipv4Lookup = wrapIpv4Lookup(options.lookup ?? (await defaultDnsLookup()));
      h2Agent = createUndiciAgent(loaded, { http2: true, rejectUnauthorized, lookup: ipv4Lookup });
      return loaded;
    })();
    return h2Ready;
  };

  const fetch: FetchLike = async (input, init = {}) => {
    if (closed) {
      throw new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
    }

    const origin = originOf(input);
    const tryH2 = http2Wanted && !h2FailedOrigins.has(origin) && isHttpsOrigin(origin);
    if (tryH2) {
      const loaded = await ensureH2();
      if (closed) {
        throw new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
      }
      if (loaded && h2Agent) {
        try {
          const response = await loaded.fetch(input, { ...init, dispatcher: h2Agent });
          h2ConfirmedOrigins.add(origin);
          return response;
        } catch (error) {
          if (closed) throw error;
          if (
            !h2ConfirmedOrigins.has(origin) &&
            isHttp2HandshakeFailure(error) &&
            isReplayableBody(init.body)
          ) {
            h2FailedOrigins.add(origin);
          } else {
            throw error;
          }
        }
      }
    }

    const pool = await ensureH1();
    if (closed) {
      throw new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
    }
    if (!pool) {
      throw new GravixLayerInvalidArgumentError(
        'The GravixLayer client could not create an HTTP dispatcher.',
      );
    }
    return pool.fetch(input, init);
  };

  return {
    fetch,
    async preconnect() {
      if (http2Wanted) await ensureH2();
      else await ensureH1();
    },
    async close() {
      closed = true;
      const h2 = h2Agent;
      const h1 = h1Pool;
      h2Agent = undefined;
      h1Pool = undefined;
      h2FailedOrigins.clear();
      h2ConfirmedOrigins.clear();
      if (h2) {
        try {
          await h2.close();
        } catch {
          h2.destroy?.();
        }
      }
      h1?.close();
    },
  };
}

let ipv4Prefs: Promise<void> | undefined;
let cachedDnsLookup: DnsLookup | undefined;

/**
 * Match Python/glibc getaddrinfo order. Node's default `verbatim` lookup
 * returns CloudFront AAAA first. Process-wide, once.
 */
function applyIpv4Prefs(): Promise<void> {
  ipv4Prefs ??= (async () => {
    try {
      const [dns, net] = await Promise.all([import('node:dns'), import('node:net')]);
      dns.setDefaultResultOrder('ipv4first');
      const disableHe = (net as { setDefaultAutoSelectFamily?: (value: boolean) => void })
        .setDefaultAutoSelectFamily;
      disableHe?.(false);
    } catch {
      // Non-Node or restricted runtime.
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
 * Force A-record resolution. Used by Node `http.Agent` / `https.Agent`.
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

async function createNodeH1Pool(opts: {
  rejectUnauthorized: boolean;
  lookup?: DnsLookup;
}): Promise<NodeH1Pool> {
  const [httpMod, httpsMod, streamMod] = await Promise.all([
    import('node:http'),
    import('node:https'),
    import('node:stream'),
  ]);

  const shared = {
    keepAlive: true,
    keepAliveMsecs: TCP_KEEPALIVE_DELAY_MS,
    maxSockets: H1_CONNECTIONS,
    maxFreeSockets: 10,
    scheduling: 'lifo' as const,
    family: 4,
    autoSelectFamily: false,
    ...(opts.lookup ? { lookup: opts.lookup as never } : {}),
  };

  const httpAgent = new httpMod.Agent(shared as ConstructorParameters<typeof httpMod.Agent>[0]);
  const httpsAgent = new httpsMod.Agent({
    ...shared,
    rejectUnauthorized: opts.rejectUnauthorized,
  } as ConstructorParameters<typeof httpsMod.Agent>[0]);

  const toWeb = streamMod.Readable.toWeb.bind(streamMod.Readable);

  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? httpsMod : httpMod;
    const agent = isHttps ? httpsAgent : httpAgent;
    const { body, headers } = await materializeBody(init);
    const method = (init.method ?? 'GET').toUpperCase();

    return await new Promise<Response>((resolve, reject) => {
      const reqOpts = {
        method,
        headers,
        agent,
        family: 4,
        autoSelectFamily: false,
        lookup: opts.lookup,
        signal: init.signal ?? undefined,
      } as Parameters<typeof lib.request>[1];
      const req = lib.request(url, reqOpts, (res) => {
        const status = res.statusCode ?? 200;
        const empty = status === 204 || status === 205 || status === 304 || method === 'HEAD';
        let stream: ReadableStream<Uint8Array> | null = null;
        if (!empty) {
          stream = toWeb(res) as ReadableStream<Uint8Array>;
        } else {
          res.resume();
        }
        resolve(
          new Response(stream, {
            status,
            statusText: res.statusMessage ?? '',
            headers: incomingToHeaders(res.headers),
          }),
        );
      });
      req.on('error', reject);
      if (body === undefined) req.end();
      else req.end(body);
    });
  };

  return {
    fetch,
    close() {
      (httpAgent as DestroyableAgent).destroy();
      (httpsAgent as DestroyableAgent).destroy();
    },
  };
}

async function materializeBody(init: RequestInit): Promise<{
  body: string | Buffer | undefined;
  headers: Record<string, string | string[] | undefined>;
}> {
  const headers = outgoingHeaders(init.headers);
  const body = init.body;
  if (body == null) return { body: undefined, headers };
  if (typeof body === 'string') return { body, headers };
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return { body, headers };
  if (body instanceof Uint8Array) return { body: Buffer.from(body), headers };
  if (body instanceof ArrayBuffer) return { body: Buffer.from(body), headers };
  if (ArrayBuffer.isView(body)) {
    return {
      body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      headers,
    };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    if (!headerHas(headers, 'content-type')) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return { body: body.toString(), headers };
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const encoded = new Request('http://127.0.0.1/', { method: 'POST', body });
    const contentType = encoded.headers.get('content-type');
    if (contentType) headers['content-type'] = contentType;
    return { body: Buffer.from(await encoded.arrayBuffer()), headers };
  }
  throw new GravixLayerInvalidArgumentError(
    'This request body type is not supported by the Node HTTP client.',
  );
}

function outgoingHeaders(init?: HeadersInit): Record<string, string | string[] | undefined> {
  if (!init) return {};
  if (typeof Headers !== 'undefined' && init instanceof Headers) {
    const out: Record<string, string> = {};
    init.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init)) {
    const out: Record<string, string> = {};
    for (const [key, value] of init) out[key] = value;
    return out;
  }
  return { ...(init as Record<string, string>) };
}

function headerHas(headers: Record<string, string | string[] | undefined>, name: string): boolean {
  const needle = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === needle);
}

function incomingToHeaders(raw: NodeJS.Dict<string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (key === undefined || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function createUndiciAgent(
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
