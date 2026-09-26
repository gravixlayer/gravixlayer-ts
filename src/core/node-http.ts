/**
 * Node HTTP client.
 *
 * HTTPS defaults to an HTTP/1.1 keep-alive pool (IPv4, hostname SNI, enough
 * sockets for concurrent create+exec). Pass `http2: true` to multiplex on one
 * HTTP/2 session per origin instead, with HTTP/1.1 fallback if ALPN is not
 * `h2`.
 *
 * Keep-alive sockets and HTTP/2 sessions are unref'd when idle so they do not
 * hold the process open. `close()` still destroys them immediately — graceful
 * GOAWAY is not waited on.
 *
 * `node:*` modules are imported dynamically so Bun, Deno, and edge bundles
 * never evaluate them.
 */

import { utf8Encode } from './binary.js';
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
 * Keeps the session up so the next create/exec does not handshake again.
 */
const H2_PING_MS = 25_000;

/** TCP/TLS/HTTP/2 connect deadline. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long a hostname's addresses are reused before being looked up again.
 *
 * Load balancer addresses rotate, so an address pinned forever eventually
 * points at a node that no longer serves the host.
 */
const DNS_TTL_MS = 30_000;

/** Socket errors that mean the address itself is unreachable. */
const CONNECT_FAILURES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
]);

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
  on?(event: 'free', listener: (socket: NetSocket) => void): void;
  sockets?: NodeJS.Dict<NetSocket[]>;
  freeSockets?: NodeJS.Dict<NetSocket[]>;
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
  destroy(): void;
  ref(): void;
  unref(): void;
}

/** The writable side of an outgoing request, shared by HTTP/1.1 and HTTP/2. */
interface BodySink {
  writableEnded: boolean;
  destroyed: boolean;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string | Buffer): void;
  destroy(error?: Error): void;
  once(event: 'drain' | 'close', listener: () => void): void;
  off(event: 'drain' | 'close', listener: () => void): void;
}

interface HttpClientRequest {
  writableEnded: boolean;
  destroyed: boolean;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'socket', listener: (socket: NetSocket) => void): void;
  once(event: 'drain' | 'close', listener: () => void): void;
  off(event: 'drain' | 'close', listener: () => void): void;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string | Buffer): void;
  destroy(error?: Error): void;
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
  ref(): void;
  unref(): void;
  once(event: 'error', listener: (error: Error) => void): TlsSocket;
  once(event: 'secureConnect', listener: () => void): TlsSocket;
}

interface TlsLib {
  connect(options: Record<string, unknown>): TlsSocket;
}

interface Http2Stream {
  writableEnded: boolean;
  destroyed: boolean;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string | Buffer): void;
  destroy(error?: Error): void;
  close(code?: number): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'end', listener: () => void): void;
  once(event: 'response', listener: (headers: Http2Headers) => void): void;
  once(event: 'drain' | 'close', listener: () => void): void;
  off(event: 'drain' | 'close', listener: () => void): void;
}

interface Http2Session {
  closed: boolean;
  destroyed: boolean;
  request(headers: Http2Headers, options?: { endStream?: boolean }): Http2Stream;
  ping(callback: (error: Error | null) => void): boolean;
  close(): void;
  destroy(): void;
  unref(): void;
  setTimeout(ms: number, callback?: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: () => void): void;
  once(event: 'connect', listener: () => void): void;
}

interface Http2Lib {
  connect(
    authority: string,
    options?: {
      createConnection?: () => TlsSocket;
      settings?: { enablePush?: boolean; maxConcurrentStreams?: number };
    },
  ): Http2Session;
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
  socket: TlsSocket;
  ping: ReturnType<typeof setInterval> | undefined;
}

/** A hostname's IPv4 addresses, the one in use first. */
interface ResolvedHost {
  addresses: string[];
  expiresAt: number;
}

/** Address resolution shared by the HTTP/1.1 pool and HTTP/2 sessions. */
export interface AddressBook {
  resolveIpv4(hostname: string): Promise<string>;
  /** Move an address that failed to connect to the back of its host's list. */
  demote(hostname: string, address: string): void;
  clear(): void;
}

/** A `FormData` body laid out for streaming, with its exact length known up front. */
interface MultipartBody {
  contentType: string;
  length: number;
  parts: ReadonlyArray<Uint8Array | Blob>;
}

type OutgoingBody = string | Buffer | MultipartBody | undefined;

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

  const loaded = loadMods();
  void loaded;

  const addresses = createAddressBook((hostname, callback) => {
    if (lookup) {
      lookup(hostname, { family: 4, all: true }, callback);
      return;
    }
    void loaded.then((node) => {
      if (!node) {
        callback(new Error('The GravixLayer client could not load Node HTTP modules.'), undefined);
        return;
      }
      node.dns.lookup(hostname, { family: 4, all: true }, callback);
    });
  });

  const ensureH1 = (): Promise<NodeH1Pool | undefined> => {
    h1Ready ??= (async () => {
      if (closed) return undefined;
      const node = await loaded;
      if (!node || closed) return undefined;
      h1Pool = createNodeH1Pool(node, { rejectUnauthorized, addresses });
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
      addresses,
      connectingSockets,
    }).then(({ session, socket }) => {
      if (closed) {
        dropH2(session, socket);
        throw new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
      }
      const ping = setInterval(() => {
        if (session.destroyed || session.closed) return;
        session.ping((error) => {
          if (error) dropH2(session, socket);
        });
      }, H2_PING_MS);
      ping.unref();
      // Idle sessions must not keep a CLI alive after the last request.
      silenceHandle(session);
      silenceHandle(socket);
      const handle: H2Session = { session, socket, ping };
      h2Live.set(origin, handle);
      session.once('close', () => {
        clearInterval(ping);
        h2Sessions.delete(origin);
        h2Live.delete(origin);
      });
      session.once('error', () => {
        dropH2(session, socket);
      });
      return handle;
    });
    void pending.catch((error: unknown) => {
      h2Sessions.delete(origin);
      h2Live.delete(origin);
      // Only a server that does not offer HTTP/2 moves the origin to HTTP/1.1
      // for good. A network failure tries HTTP/2 again on the next request.
      if (isHttp2Unsupported(error)) h2FailedOrigins.add(origin);
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
          if (closed || !isHttp2HandshakeFailure(error) || !isReplayableBody(init.body)) {
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
      h2FailedOrigins.clear();
      addresses.clear();
      for (const socket of connectingSockets) {
        dropSocket(socket);
      }
      connectingSockets.clear();
      const pending = [...h2Sessions.values()];
      h2Sessions.clear();
      const live = [...h2Live.values()];
      h2Live.clear();
      for (const handle of live) closeH2(handle);
      for (const ready of pending) {
        void ready.then(
          (handle) => closeH2(handle),
          () => undefined,
        );
      }
      const h1 = h1Pool;
      h1Pool = undefined;
      h1Ready = undefined;
      h1?.close();
    },
  };
}

/**
 * IPv4 resolution with a short cache.
 *
 * Each hostname is looked up at most once at a time. An answer is reused for
 * {@link DNS_TTL_MS}; after that, requests keep using it while a refresh runs
 * in the background, so a lookup never sits in front of a request that
 * already has a working address.
 *
 * @param lookup resolves every IPv4 address for a hostname
 */
export function createAddressBook(
  lookup: (hostname: string, callback: DnsLookupCallback) => void,
): AddressBook {
  const hosts = new Map<string, ResolvedHost>();
  const lookups = new Map<string, Promise<string[]>>();

  const lookupHost = (hostname: string): Promise<string[]> => {
    const inflight = lookups.get(hostname);
    if (inflight) return inflight;
    const pending = new Promise<string[]>((resolve, reject) => {
      lookup(hostname, (err, answer) => {
        if (err) {
          reject(err);
          return;
        }
        const addresses = ipv4List(answer);
        if (addresses.length === 0) {
          reject(new Error(`Could not resolve ${hostname} to an IPv4 address.`));
          return;
        }
        resolve(addresses);
      });
    }).then(
      (addresses) => {
        lookups.delete(hostname);
        // Keep the address in use first while DNS still publishes it, so a
        // refresh does not move traffic off warm pooled connections.
        const current = hosts.get(hostname)?.addresses[0];
        const ordered =
          current !== undefined && addresses.includes(current)
            ? [current, ...addresses.filter((address) => address !== current)]
            : addresses;
        hosts.set(hostname, { addresses: ordered, expiresAt: Date.now() + DNS_TTL_MS });
        return ordered;
      },
      (error: unknown) => {
        lookups.delete(hostname);
        throw error;
      },
    );
    lookups.set(hostname, pending);
    return pending;
  };

  return {
    async resolveIpv4(hostname) {
      if (IPV4_LITERAL.test(hostname)) return hostname;
      const known = hosts.get(hostname);
      if (!known) return (await lookupHost(hostname))[0] as string;
      if (known.expiresAt <= Date.now() && !lookups.has(hostname)) {
        // A failed refresh keeps the last good answer for another TTL.
        void lookupHost(hostname).catch(() => {
          known.expiresAt = Date.now() + DNS_TTL_MS;
        });
      }
      return known.addresses[0] as string;
    },
    demote(hostname, address) {
      const known = hosts.get(hostname);
      if (known?.addresses[0] !== address) return;
      known.addresses.push(known.addresses.shift() as string);
      known.expiresAt = 0;
    },
    clear() {
      hosts.clear();
      lookups.clear();
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

/** Addresses from a lookup answer, which is one address or a list of them. */
function ipv4List(answer: unknown): string[] {
  if (typeof answer === 'string') return answer === '' ? [] : [answer];
  if (!Array.isArray(answer)) return [];
  const addresses: string[] = [];
  for (const entry of answer as unknown[]) {
    const address = typeof entry === 'string' ? entry : (entry as { address?: unknown })?.address;
    if (typeof address === 'string' && address !== '') addresses.push(address);
  }
  return addresses;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && CONNECT_FAILURES.has(code);
}

function closeH2(handle: H2Session): void {
  if (handle.ping) {
    clearInterval(handle.ping);
    handle.ping = undefined;
  }
  dropH2(handle.session, handle.socket);
}

/** Tear down an HTTP/2 session without waiting for GOAWAY. */
function dropH2(session: Http2Session, socket: TlsSocket): void {
  try {
    session.setTimeout(0);
  } catch {
    // Already gone.
  }
  try {
    session.destroy();
  } catch {
    // Already gone.
  }
  dropSocket(socket);
  silenceHandle(session);
}

function dropSocket(socket: { destroy(): void; unref?: () => void }): void {
  try {
    socket.destroy();
  } catch {
    // Already gone.
  }
  silenceHandle(socket);
}

function silenceHandle(handle: { unref?: () => void }): void {
  try {
    handle.unref?.();
  } catch {
    // Already gone.
  }
}

function destroyAgent(agent: DestroyableAgent): void {
  for (const bucket of [agent.sockets, agent.freeSockets]) {
    if (!bucket) continue;
    for (const list of Object.values(bucket)) {
      if (!list) continue;
      for (const socket of [...list]) dropSocket(socket);
    }
  }
  agent.destroy();
}

function releaseIdleSockets(agent: DestroyableAgent): void {
  agent.on?.('free', (socket) => {
    silenceHandle(socket);
  });
}

async function connectH2(
  node: NodeHttpMods,
  url: URL,
  opts: {
    rejectUnauthorized: boolean;
    addresses: AddressBook;
    connectingSockets: Set<TlsSocket>;
  },
): Promise<{ session: Http2Session; socket: TlsSocket }> {
  const address = await opts.addresses.resolveIpv4(url.hostname);
  const port = Number(url.port) || 443;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      opts.connectingSockets.delete(socket);
      dropSocket(socket);
      reject(error);
    };
    const ok = (session: Http2Session) => {
      if (settled) return;
      settled = true;
      opts.connectingSockets.delete(socket);
      resolve({ session, socket });
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
      opts.addresses.demote(url.hostname, address);
      fail(handshakeError('HTTP/2 connect timed out'));
    });
    socket.once('error', (error) => {
      if (isConnectFailure(error)) opts.addresses.demote(url.hostname, address);
      fail(markHandshake(error));
    });
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      if (socket.alpnProtocol !== 'h2') {
        socket.destroy();
        fail(handshakeError('ALPN did not negotiate HTTP/2', H2_NOT_NEGOTIATED));
        return;
      }
      const session = node.http2.connect(url.origin, {
        createConnection: () => socket,
        settings: { enablePush: false, maxConcurrentStreams: 100 },
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
        try {
          session.setTimeout(0);
        } catch {
          // Optional on this Node version.
        }
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
        const reason = signal?.reason ?? new Error('aborted');
        req.close(node.http2.constants.NGHTTP2_CANCEL);
        req.destroy(reason);
        reject(reason);
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
          // The signal stays wired until the stream closes, so an abort after
          // the headers still cancels the stream and fails the body.
          req.once('close', () => signal?.removeEventListener('abort', onAbort));
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
      sendBody(req, body);
    });
  })();
}

function createNodeH1Pool(
  node: NodeHttpMods,
  opts: {
    rejectUnauthorized: boolean;
    addresses: AddressBook;
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
    ALPNProtocols: ['http/1.1'],
  });
  releaseIdleSockets(httpAgent);
  releaseIdleSockets(httpsAgent);

  const toWeb = node.toWeb;

  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? node.https : node.http;
    const agent = isHttps ? httpsAgent : httpAgent;
    const { body, headers } = await materializeBody(init);
    const method = (init.method ?? 'GET').toUpperCase();
    const address = await opts.addresses.resolveIpv4(url.hostname);
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
        reqOpts['ALPNProtocols'] = ['http/1.1'];
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
      req.on('error', (error) => {
        if (isConnectFailure(error)) opts.addresses.demote(url.hostname, address);
        reject(error);
      });
      req.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.ref();
      });
      sendBody(req, body);
    });
  };

  return {
    fetch,
    close() {
      destroyAgent(httpAgent);
      destroyAgent(httpsAgent);
    },
  };
}

async function materializeBody(init: RequestInit): Promise<{
  body: OutgoingBody;
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
    const multipart = encodeMultipart(body);
    headers['content-type'] = multipart.contentType;
    headers['content-length'] = String(multipart.length);
    return { body: multipart, headers };
  }
  throw new GravixLayerInvalidArgumentError(
    'This request body type is not supported by the Node HTTP client.',
  );
}

/** Write the request body, if any, and end the request. */
function sendBody(req: BodySink, body: OutgoingBody): void {
  if (body === undefined) {
    if (!req.writableEnded) req.end();
  } else if (typeof body === 'string' || body instanceof Uint8Array) {
    req.end(body);
  } else {
    writeParts(req, body.parts).then(
      (complete) => {
        if (complete) req.end();
      },
      (error: unknown) => req.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  }
}

const CRLF = utf8Encode('\r\n');

/**
 * Lay out a `FormData` body without reading any file into memory.
 *
 * The encoding matches what `fetch` produces for the same form, so the server
 * sees identical bytes. Files are streamed from their `Blob` as the request is
 * written.
 */
function encodeMultipart(form: FormData): MultipartBody {
  const random = crypto.getRandomValues(new Uint8Array(16));
  let boundary = '----formdata-';
  for (const byte of random) boundary += byte.toString(16).padStart(2, '0');

  const parts: Array<Uint8Array | Blob> = [];
  let length = 0;
  const push = (part: Uint8Array | Blob): void => {
    parts.push(part);
    length += part instanceof Uint8Array ? part.byteLength : part.size;
  };

  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="`;
  for (const [name, value] of form) {
    const field = escapeMultipart(normalizeLinefeeds(name));
    if (typeof value === 'string') {
      push(utf8Encode(`${prefix}${field}"\r\n\r\n${normalizeLinefeeds(value)}\r\n`));
    } else {
      const type = value.type || 'application/octet-stream';
      push(
        utf8Encode(
          `${prefix}${field}"; filename="${escapeMultipart(value.name)}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
      );
      push(value);
      push(CRLF);
    }
  }
  push(utf8Encode(`--${boundary}--\r\n`));

  return { contentType: `multipart/form-data; boundary=${boundary}`, length, parts };
}

function escapeMultipart(value: string): string {
  return value.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

function normalizeLinefeeds(value: string): string {
  return value.replace(/\r?\n|\r/g, '\r\n');
}

/**
 * Write each part in order, pausing whenever the request's buffer is full.
 *
 * Resolves false, having stopped early, once the request is torn down.
 */
async function writeParts(
  req: BodySink,
  parts: ReadonlyArray<Uint8Array | Blob>,
): Promise<boolean> {
  for (const part of parts) {
    if (part instanceof Uint8Array) {
      if (!(await write(req, part))) return false;
      continue;
    }
    const reader = part.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(await write(req, value))) {
        void reader.cancel().catch(() => undefined);
        return false;
      }
    }
  }
  return true;
}

/** Write one chunk. Resolves false once the request has been torn down. */
async function write(req: BodySink, chunk: Uint8Array): Promise<boolean> {
  if (req.destroyed) return false;
  if (req.write(chunk)) return true;
  if (req.destroyed) return false;
  return new Promise((resolve) => {
    const settle = (drained: boolean) => () => {
      req.off('drain', onDrain);
      req.off('close', onClose);
      resolve(drained);
    };
    const onDrain = settle(true);
    const onClose = settle(false);
    req.once('drain', onDrain);
    req.once('close', onClose);
  });
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

/** Code on the handshake error raised when the server does not offer HTTP/2. */
const H2_NOT_NEGOTIATED = 'ERR_HTTP2_NOT_NEGOTIATED';

function handshakeError(message: string, code = 'ERR_HTTP2'): Error {
  return markHandshake(Object.assign(new Error(message), { code }));
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

/** True when the server negotiated a protocol other than HTTP/2. */
function isHttp2Unsupported(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === H2_NOT_NEGOTIATED;
}
