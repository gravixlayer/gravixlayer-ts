/**
 * Node HTTP client.
 *
 * HTTPS defaults to HTTP/1.1: IPv4 resolved once, TLS pinned to that address
 * with hostname SNI, and a keep-alive pool with enough sockets for parallel
 * create+exec. HTTP/2 is opt-in (`http2: true`): one session per origin,
 * concurrent calls as streams, HTTP/1.1 fallback if ALPN is not `h2`.
 *
 * `node:*` modules are imported dynamically so Bun, Deno, and edge bundles
 * never evaluate them.
 */

import { GravixLayerInvalidArgumentError } from './errors.js';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Callback-style lookup matching `node:dns.lookup` / `net.connect`. */
export type DnsLookupCallback = (err: Error | null, address: unknown, family?: number) => void;

export type DnsLookup = (hostname: string, options: unknown, callback?: DnsLookupCallback) => void;

export interface NativeNodeFetchOptions {
  /**
   * Negotiate HTTP/2 on HTTPS. Defaults to false (HTTP/1.1 keep-alive).
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
 * HTTP/1.1 sockets per origin.
 *
 * Must stay well above 1. Concurrent create+exec needs one socket per
 * in-flight request. A single-connection pool serializes them.
 */
const H1_CONNECTIONS = 16;

/** First TCP keep-alive probe. */
const TCP_KEEPALIVE_DELAY_MS = 15_000;

/**
 * HTTP/2 PING interval.
 *
 * Keeps an opt-in session up so the next create/exec does not handshake again.
 */
const H2_PING_MS = 25_000;

/** TCP/TLS/HTTP/2 connect deadline. */
const CONNECT_TIMEOUT_MS = 10_000;

const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Hostnames that must not be sent as TLS SNI (Node rejects IP servername). */
function isIpLiteral(host: string): boolean {
  return IPV4_LITERAL.test(host) || host.includes(':');
}

function tlsServername(hostname: string): string | undefined {
  return isIpLiteral(hostname) ? undefined : hostname;
}

const H2_FORBIDDEN = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host',
]);

interface DestroyableAgent {
  destroy(): void;
}

interface HttpIncomingMessage {
  statusCode?: number;
  statusMessage?: string;
  headers: NodeJS.Dict<string | string[] | undefined>;
  resume(): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  once(event: 'end', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
}

interface NetSocket {
  setNoDelay(noDelay?: boolean): void;
}

interface HttpClientRequest {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'socket', listener: (socket: NetSocket) => void): void;
  end(chunk?: string | Buffer): void;
}

interface HttpLib {
  Agent: new (options?: Record<string, unknown>) => DestroyableAgent;
  request(
    options: Record<string, unknown>,
    callback: (res: HttpIncomingMessage) => void,
  ): HttpClientRequest;
}

interface TlsSocket {
  alpnProtocol: string | false | null;
  setTimeout(ms: number, callback?: () => void): TlsSocket;
  setKeepAlive(enable: boolean, initialDelay?: number): TlsSocket;
  setNoDelay(noDelay?: boolean): TlsSocket;
  destroy(): void;
  once(event: 'error', listener: (error: Error) => void): TlsSocket;
  once(event: 'secureConnect', listener: () => void): TlsSocket;
}

interface TlsLib {
  connect(options: Record<string, unknown>): TlsSocket;
}

interface Http2Stream {
  writableEnded: boolean;
  end(chunk?: string | Buffer): void;
  close(code?: number): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'end', listener: () => void): void;
  once(event: 'response', listener: (headers: Http2Headers) => void): void;
}

interface Http2Session {
  closed: boolean;
  destroyed: boolean;
  request(headers: Http2Headers, options?: { endStream?: boolean }): Http2Stream;
  ping(callback: (error: Error | null) => void): boolean;
  close(): void;
  destroy(): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: () => void): void;
  once(event: 'connect', listener: () => void): void;
}

interface Http2Lib {
  connect(authority: string, options?: { createConnection?: () => TlsSocket }): Http2Session;
  constants: { NGHTTP2_CANCEL: number };
}

interface DnsLib {
  lookup(hostname: string, options: unknown, callback: DnsLookupCallback): void;
}

type Http2Headers = Record<string, string | string[] | number | undefined>;

interface NodeHttpMods {
  http: HttpLib;
  https: HttpLib;
  http2: Http2Lib;
  tls: TlsLib;
  dns: DnsLib;
  toWeb: (readable: object) => ReadableStream<Uint8Array>;
}

interface NodeH1Pool {
  fetch: FetchLike;
  close(): void;
}

interface H2Session {
  session: Http2Session;
  ping: ReturnType<typeof setInterval> | undefined;
}

let mods: NodeHttpMods | undefined;
let modsLoading: Promise<NodeHttpMods | null> | undefined;

async function loadMods(): Promise<NodeHttpMods | null> {
  if (mods) return mods;
  modsLoading ??= (async () => {
    try {
      const [http, https, http2, tls, stream, dns] = await Promise.all([
        import('node:http'),
        import('node:https'),
        import('node:http2'),
        import('node:tls'),
        import('node:stream'),
        import('node:dns'),
      ]);
      const loaded: NodeHttpMods = {
        http: http as unknown as HttpLib,
        https: https as unknown as HttpLib,
        http2: http2 as unknown as Http2Lib,
        tls: tls as unknown as TlsLib,
        dns: dns as unknown as DnsLib,
        toWeb: stream.Readable.toWeb.bind(stream.Readable) as NodeHttpMods['toWeb'],
      };
      mods = loaded;
      return loaded;
    } catch {
      return null;
    }
  })();
  return modsLoading;
}

export function createNativeNodeFetch(options: NativeNodeFetchOptions = {}): NativeNodeFetch {
  const http2Wanted = options.http2 === true;
  const rejectUnauthorized = options.rejectUnauthorized !== false;
  const lookup = options.lookup;

  let closed = false;
  let h1Pool: NodeH1Pool | undefined;
  let h1Ready: Promise<NodeH1Pool | undefined> | undefined;
  const h2FailedOrigins = new Set<string>();
  const h2Sessions = new Map<string, Promise<H2Session>>();
  const h2Live = new Map<string, H2Session>();
  const connectingSockets = new Set<TlsSocket>();
  const ipv4Cache = new Map<string, Promise<string>>();

  const loaded = loadMods();
  void loaded;

  const resolveIpv4 = (hostname: string): Promise<string> => {
    if (IPV4_LITERAL.test(hostname)) return Promise.resolve(hostname);
    const cached = ipv4Cache.get(hostname);
    if (cached) return cached;
    const pending = new Promise<string>((resolve, reject) => {
      const finish: DnsLookupCallback = (err, address) => {
        if (err) {
          reject(err);
          return;
        }
        const ip = ipv4FromLookup(address);
        if (!ip) {
          reject(new Error(`Could not resolve ${hostname} to an IPv4 address.`));
          return;
        }
        resolve(ip);
      };
      if (lookup) {
        lookup(hostname, { family: 4, all: false }, finish);
        return;
      }
      void loaded.then((node) => {
        if (!node) {
          reject(new Error('The GravixLayer client could not load Node HTTP modules.'));
          return;
        }
        node.dns.lookup(hostname, { family: 4, all: false }, finish);
      });
    });
    pending.catch(() => ipv4Cache.delete(hostname));
    ipv4Cache.set(hostname, pending);
    return pending;
  };

  const ensureH1 = (): Promise<NodeH1Pool | undefined> => {
    h1Ready ??= (async () => {
      if (closed) return undefined;
      const node = await loaded;
      if (!node || closed) return undefined;
      h1Pool = createNodeH1Pool(node, { rejectUnauthorized, resolveIpv4 });
      return h1Pool;
    })();
    return h1Ready;
  };

  const sessionFor = (url: URL, node: NodeHttpMods): Promise<H2Session> => {
    const origin = url.origin;
    const existing = h2Sessions.get(origin);
    if (existing) return existing;
    const pending = connectH2(node, url, {
      rejectUnauthorized,
      resolveIpv4,
      connectingSockets,
    }).then((session) => {
      const ping = setInterval(() => {
        if (session.destroyed || session.closed) return;
        session.ping((error) => {
          if (error) session.destroy();
        });
      }, H2_PING_MS);
      ping.unref();
      const handle: H2Session = { session, ping };
      h2Live.set(origin, handle);
      session.once('close', () => {
        clearInterval(ping);
        h2Sessions.delete(origin);
        h2Live.delete(origin);
      });
      session.once('error', () => {
        session.destroy();
      });
      return handle;
    });
    void pending.catch((error: unknown) => {
      h2Sessions.delete(origin);
      h2Live.delete(origin);
      if (isHttp2HandshakeFailure(error)) h2FailedOrigins.add(origin);
    });
    h2Sessions.set(origin, pending);
    return pending;
  };

  const liveSession = async (url: URL, node: NodeHttpMods): Promise<H2Session> => {
    const handle = await sessionFor(url, node);
    if (!handle.session.closed && !handle.session.destroyed) return handle;
    h2Sessions.delete(url.origin);
    h2Live.delete(url.origin);
    return sessionFor(url, node);
  };

  const fetch: FetchLike = async (input, init = {}) => {
    if (closed) {
      throw new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
    }

    const url = new URL(input);
    const tryH2 = http2Wanted && url.protocol === 'https:' && !h2FailedOrigins.has(url.origin);
    if (tryH2) {
      const node = await loaded;
      if (closed) {
        throw new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
      }
      if (node) {
        // Only the handshake falls back to HTTP/1.1. A failure after the
        // session is up must not replay the request (POST create is not
        // idempotent).
        try {
          const handle = await liveSession(url, node);
          if (closed) {
            throw new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
          }
          return await h2Fetch(node, handle.session, url, init);
        } catch (error) {
          if (closed) throw error;
          if (isHttp2HandshakeFailure(error) && isReplayableBody(init.body)) {
            h2FailedOrigins.add(url.origin);
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
      await loaded;
      if (http2Wanted) return;
      await ensureH1();
    },
    async close() {
      closed = true;
      h2Sessions.clear();
      h2FailedOrigins.clear();
      ipv4Cache.clear();
      for (const socket of connectingSockets) {
        socket.destroy();
      }
      connectingSockets.clear();
      const live = [...h2Live.values()];
      h2Live.clear();
      for (const handle of live) closeH2(handle);
      const h1 = h1Pool;
      h1Pool = undefined;
      h1?.close();
    },
  };
}

/**
 * Force A-record resolution. Tests assert this helper; the live client pins
 * IPv4 in {@link createNativeNodeFetch} instead of wrapping every lookup.
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

function ipv4FromLookup(address: unknown): string | undefined {
  if (typeof address === 'string' && address !== '') return address;
  if (Array.isArray(address) && address.length > 0) {
    const first = address[0] as { address?: string } | string;
    if (typeof first === 'string') return first;
    if (first && typeof first.address === 'string') return first.address;
  }
  return undefined;
}

function closeH2(handle: H2Session): void {
  if (handle.ping) {
    clearInterval(handle.ping);
    handle.ping = undefined;
  }
  // destroy(), not close(): graceful GOAWAY against some origins never
  // finishes, and the session handle keeps the process alive.
  try {
    handle.session.destroy();
  } catch {
    // Already gone.
  }
}

async function connectH2(
  node: NodeHttpMods,
  url: URL,
  opts: {
    rejectUnauthorized: boolean;
    resolveIpv4: (hostname: string) => Promise<string>;
    connectingSockets: Set<TlsSocket>;
  },
): Promise<Http2Session> {
  const address = await opts.resolveIpv4(url.hostname);
  const port = Number(url.port) || 443;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      opts.connectingSockets.delete(socket);
      reject(error);
    };
    const ok = (session: Http2Session) => {
      if (settled) return;
      settled = true;
      opts.connectingSockets.delete(socket);
      resolve(session);
    };

    const servername = tlsServername(url.hostname);
    const socket = node.tls.connect({
      host: address,
      port,
      ALPNProtocols: ['h2', 'http/1.1'],
      rejectUnauthorized: opts.rejectUnauthorized,
      noDelay: true,
      ...(servername ? { servername } : {}),
    });
    opts.connectingSockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      fail(handshakeError('HTTP/2 connect timed out'));
    });
    socket.once('error', (error) => fail(markHandshake(error)));
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      if (socket.alpnProtocol !== 'h2') {
        socket.destroy();
        fail(handshakeError('ALPN did not negotiate HTTP/2'));
        return;
      }
      const session = node.http2.connect(url.origin, {
        createConnection: () => socket,
      });
      const timer = setTimeout(() => {
        session.destroy();
        fail(handshakeError('HTTP/2 session timed out'));
      }, CONNECT_TIMEOUT_MS);
      timer.unref();
      session.once('error', (error) => {
        clearTimeout(timer);
        fail(markHandshake(error));
      });
      session.once('connect', () => {
        clearTimeout(timer);
        ok(session);
      });
    });
  });
}

function h2Fetch(
  node: NodeHttpMods,
  session: Http2Session,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  return (async () => {
    const { body, headers } = await materializeBody(init);
    const method = (init.method ?? 'GET').toUpperCase();
    const h2Headers: Http2Headers = {
      ':method': method,
      ':path': `${url.pathname}${url.search}`,
      ':scheme': 'https',
      ':authority': url.host,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || H2_FORBIDDEN.has(key.toLowerCase())) continue;
      h2Headers[key] = value;
    }

    const toWeb = node.toWeb;
    const signal = init.signal ?? undefined;
    const streamBody = wantsStreamingBody(init);

    return await new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const req = session.request(h2Headers, { endStream: body === undefined });
      const onAbort = () => {
        req.close(node.http2.constants.NGHTTP2_CANCEL);
        reject(signal?.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.once('error', (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      req.once('response', (incoming) => {
        const status = Number(incoming[':status'] ?? 200);
        const empty = status === 204 || status === 205 || status === 304 || method === 'HEAD';
        const headersOut = h2ToHeaders(incoming);
        if (empty) {
          signal?.removeEventListener('abort', onAbort);
          resolve(new Response(null, { status, headers: headersOut }));
          return;
        }
        if (streamBody) {
          signal?.removeEventListener('abort', onAbort);
          resolve(
            new Response(toWeb(req) as ReadableStream<Uint8Array>, {
              status,
              headers: headersOut,
            }),
          );
          return;
        }
        void readNodeBody(req).then(
          (buf) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(new Response(new Uint8Array(buf), { status, headers: headersOut }));
          },
          (error) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
      if (body === undefined) {
        if (!req.writableEnded) req.end();
      } else {
        req.end(body);
      }
    });
  })();
}

function createNodeH1Pool(
  node: NodeHttpMods,
  opts: {
    rejectUnauthorized: boolean;
    resolveIpv4: (hostname: string) => Promise<string>;
  },
): NodeH1Pool {
  const shared = {
    keepAlive: true,
    keepAliveMsecs: TCP_KEEPALIVE_DELAY_MS,
    maxSockets: H1_CONNECTIONS,
    maxFreeSockets: 10,
    scheduling: 'lifo' as const,
  };

  const httpAgent = new node.http.Agent(shared);
  const httpsAgent = new node.https.Agent({
    ...shared,
    rejectUnauthorized: opts.rejectUnauthorized,
    maxCachedSessions: 100,
  });

  const toWeb = node.toWeb;

  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? node.https : node.http;
    const agent = isHttps ? httpsAgent : httpAgent;
    const { body, headers } = await materializeBody(init);
    const method = (init.method ?? 'GET').toUpperCase();
    const address = await opts.resolveIpv4(url.hostname);
    if (!headerHas(headers, 'host')) headers.host = url.host;
    const streamBody = wantsStreamingBody(init);

    return await new Promise<Response>((resolve, reject) => {
      const reqOpts: Record<string, unknown> = {
        protocol: url.protocol,
        hostname: address,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent,
        family: 4,
        autoSelectFamily: false,
        noDelay: true,
        signal: init.signal ?? undefined,
      };
      if (isHttps) {
        const servername = tlsServername(url.hostname);
        if (servername) reqOpts['servername'] = servername;
        reqOpts['rejectUnauthorized'] = opts.rejectUnauthorized;
      }
      const req = lib.request(reqOpts, (res) => {
        const status = res.statusCode ?? 200;
        const statusText = res.statusMessage ?? '';
        const empty = status === 204 || status === 205 || status === 304 || method === 'HEAD';
        const headersOut = incomingToHeaders(res.headers);
        if (empty) {
          res.resume();
          resolve(new Response(null, { status, statusText, headers: headersOut }));
          return;
        }
        if (streamBody) {
          resolve(
            new Response(toWeb(res) as ReadableStream<Uint8Array>, {
              status,
              statusText,
              headers: headersOut,
            }),
          );
          return;
        }
        void readNodeBody(res).then(
          (buf) =>
            resolve(new Response(new Uint8Array(buf), { status, statusText, headers: headersOut })),
          reject,
        );
      });
      req.on('error', reject);
      req.on('socket', (socket) => {
        socket.setNoDelay(true);
      });
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

function h2ToHeaders(raw: Http2Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(':') || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function wantsStreamingBody(init: RequestInit): boolean {
  const headers = outgoingHeaders(init.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'accept' || value == null) continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    if (text.toLowerCase().includes('text/event-stream')) return true;
  }
  return false;
}

function readNodeBody(stream: {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  once(event: 'end', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
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

const H2_HANDSHAKE = 'h2handshake';

function handshakeError(message: string): Error {
  return markHandshake(Object.assign(new Error(message), { code: 'ERR_HTTP2' }));
}

function markHandshake(error: Error): Error {
  (error as Error & { [H2_HANDSHAKE]?: boolean })[H2_HANDSHAKE] = true;
  return error;
}

/**
 * True only for failures before any HTTP request is sent.
 *
 * HTTP/1.1 fallback is safe here. A later stream error is not: replaying a
 * POST could create a second runtime.
 */
function isHttp2HandshakeFailure(error: unknown): boolean {
  return Boolean((error as { [H2_HANDSHAKE]?: boolean } | undefined)?.[H2_HANDSHAKE]);
}
