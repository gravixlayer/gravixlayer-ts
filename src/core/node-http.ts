/**
 * Node HTTP client.
 *
 * HTTPS defaults to HTTP/2 with a small pool of sessions per origin (IPv4,
 * hostname SNI): sequential callers reuse the first session while a burst
 * spreads over several lanes, each pinned to another resolved address so its
 * handshake and its requests do not queue behind a single connection. When
 * ALPN does not offer `h2` the transport falls back to HTTP/1.1 keep-alive;
 * pass `http2: false` to select the HTTP/1.1 pool outright. HTTP/2 sessions
 * and DNS answers are shared by every pooled client in the process, so a
 * second client never pays a second handshake.
 *
 * Hostnames resolve through c-ares (`dns.resolve4`), one A query to the
 * resolver in `resolv.conf`. `dns.lookup` / `getaddrinfo` is only the fallback
 * for names that exist in the hosts file: it walks nsswitch (mDNS, resolved
 * over D-Bus, search domains) on the libuv thread pool, and that cold walk
 * costs tens of milliseconds even when the resolver itself is under a
 * millisecond away.
 *
 * The wire layer returns status, headers, and body bytes without building
 * WHATWG `Response`/`Headers` objects; the public `fetch` facade adds them
 * only for callers that want the standard shape.
 *
 * Keep-alive sockets and HTTP/2 sessions are unref'd when idle so they do not
 * hold the process open. `close()` still destroys them immediately — graceful
 * GOAWAY is not waited on.
 *
 * `node:*` modules load through `process.getBuiltinModule`, which resolves
 * synchronously without a dynamic import, and the load is kicked while this
 * module evaluates so the first client never waits on it. On runtimes that
 * predate it the client falls back to `import()`, which resolves in the
 * background all the same.
 */

import { utf8Encode } from './binary.js';
import { GravixLayerInvalidArgumentError } from './errors.js';
import {
  readAll,
  type Dispatch,
  type HeaderSource,
  type WireRequest,
  type WireResponse,
} from './wire.js';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Callback-style lookup matching `node:dns.lookup` / `net.connect`. */
export type DnsLookupCallback = (err: Error | null, address: unknown, family?: number) => void;

export type DnsLookup = (hostname: string, options: unknown, callback?: DnsLookupCallback) => void;

export interface NativeNodeFetchOptions {
  /**
   * Negotiate HTTP/2 on HTTPS. Defaults to true; `false` selects the HTTP/1.1
   * keep-alive pool.
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
  /**
   * Origin to resolve while the transport loads. The lookup overlaps module
   * initialization; it never opens a socket. Not part of the public client.
   */
  origin?: string;
}

export interface NativeNodeFetch {
  /** `fetch`-shaped call for callers that need a WHATWG `Response`. */
  fetch: FetchLike;
  /** Wire call: status, headers, and body bytes with no WHATWG objects. */
  dispatch: Dispatch;
  /**
   * Warm the transport. With an origin (and `http2`), this opens the HTTP/2
   * session: DNS, TLS, and the session handshake all complete before the next
   * request. Without an origin it only makes sure the machinery is loaded.
   */
  preconnect(origin?: string): Promise<void>;
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

/**
 * HTTP/2 sessions an origin may hold.
 *
 * One session multiplexes every request a client makes, but a burst then
 * rides a single connection: the peer's per-connection work — reading frames,
 * authenticating, writing responses — serialises there, so queue depth grows
 * with the burst. Extra lanes spread a burst over several connections, and
 * where DNS answers with several addresses each lane pins a different one so
 * lanes land on different endpoints as well.
 *
 * The client constructor opens all of them in one turn, and their SYNs go
 * out together — a lane must not wait for the previous lane's `tls.connect`
 * to return. Without an origin, the pool stays at one session until a burst
 * is proven (every live lane already carrying {@link H2_LANE_DEPTH} requests)
 * and then fills out the same way, in one turn.
 */
const H2_LANES = 4;

/** In-flight depth at which dispatch treats the origin as bursting. */
const H2_LANE_DEPTH = 4;

/** TCP/TLS/HTTP/2 connect deadline. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Throwaway `tls.connect` calls while the module loads.
 *
 * The first call in a process initializes OpenSSL and costs several
 * milliseconds; the second still costs a couple. A later call is a fraction
 * of a millisecond. Paying the first two here, against a closed local port,
 * keeps a burst's lanes from starting one after another.
 */
const TLS_PRIME_CONNECTS = 2;

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

type RawHeaders = NodeJS.Dict<string | string[] | number | undefined>;

interface HttpIncomingMessage {
  statusCode?: number;
  statusMessage?: string;
  headers: RawHeaders;
  resume(): void;
  destroy(error?: Error): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  once(event: 'end', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: () => void): void;
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
  end(chunk?: string | Uint8Array): void;
  destroy(error?: Error): void;
  once(event: 'drain' | 'close', listener: () => void): void;
  off(event: 'drain' | 'close', listener: () => void): void;
}

interface HttpClientRequest {
  writableEnded: boolean;
  destroyed: boolean;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'socket', listener: (socket: NetSocket) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'drain' | 'close', listener: () => void): void;
  off(event: 'drain' | 'close', listener: () => void): void;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
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
  once(event: 'close', listener: () => void): TlsSocket;
}

interface TlsLib {
  connect(options: Record<string, unknown>): TlsSocket;
  createSecureContext(options?: Record<string, unknown>): unknown;
}

interface Http2Stream {
  writableEnded: boolean;
  destroyed: boolean;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
  destroy(error?: Error): void;
  close(code?: number): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'end', listener: () => void): void;
  once(event: 'response', listener: (headers: RawHeaders) => void): void;
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
  resolve4?(hostname: string, callback: (err: Error | null, addresses: string[]) => void): void;
}

/**
 * c-ares misses that may still be answered from the hosts file or a search
 * domain. Anything else (a timeout, a refused resolver) must not fall through
 * into `getaddrinfo`, which would add its own stall on top.
 */
const CAARES_MISS: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

function errnoCode(error: Error | null): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Resolve one hostname to its IPv4 addresses.
 *
 * `resolve4` talks to the configured resolver directly and does not occupy a
 * libuv thread. Names it cannot see fall back to `dns.lookup`, which is what
 * reads `/etc/hosts`.
 */
export function queryIpv4(dns: DnsLib, hostname: string, callback: DnsLookupCallback): void {
  if (typeof dns.resolve4 !== 'function') {
    dns.lookup(hostname, { family: 4, all: true }, callback);
    return;
  }
  dns.resolve4(hostname, (err, addresses) => {
    if (!err && addresses?.length > 0) {
      callback(null, addresses);
      return;
    }
    const code = errnoCode(err);
    if (!err || (code !== undefined && CAARES_MISS.has(code))) {
      dns.lookup(hostname, { family: 4, all: true }, callback);
      return;
    }
    callback(err, undefined);
  });
}

type Http2Headers = Record<string, string | string[] | number | undefined>;

interface NodeLibs {
  http: HttpLib;
  https: HttpLib;
  http2: Http2Lib;
  tls: TlsLib;
  dns: DnsLib;
  toWeb: (readable: object) => ReadableStream<Uint8Array>;
}

interface H2Session {
  session: Http2Session;
  socket: TlsSocket;
  ping: ReturnType<typeof setInterval> | undefined;
  /** The loaded `node:*` modules, kept so dispatch does not re-resolve them. */
  node: NodeLibs;
}

/** A session that is either connecting or ready. */
interface SessionEntry {
  ready: Promise<H2Session>;
  /**
   * The resolved session, set once `ready` settles. A dispatch that finds it
   * skips the whole `await` chain — bursts measure per-request cost, and
   * resolved-promise hops are where that cost hides.
   */
  handle?: H2Session;
  /** Requests currently dispatched on this lane — the spread signal. */
  inflight: number;
}

/** The lanes an origin holds and the index the next lane's address pins. */
interface SessionLanes {
  entries: SessionEntry[];
  /**
   * Lanes opened so far. Pinned into the resolved address list, so a lane
   * replacing a dead one lands on a different endpoint rather than retrying
   * the address that just failed.
   */
  opened: number;
}

/** A lane whose SYN waits on the single in-flight lookup for its host. */
interface ParkedDial {
  url: URL;
  node: NodeLibs;
  rejectUnauthorized: boolean;
  addrIndex: number;
  resolve: (handle: H2Session) => void;
  reject: (error: unknown) => void;
}

/**
 * Connection state shared by every pooled client in the process.
 *
 * HTTP/2 sessions, DNS answers, and sockets still completing their handshake
 * live here so a second client to the same origin reuses them. `users` counts
 * the clients holding the pool; the last `close()` drains it. A client built
 * with a custom `lookup` gets a private pool so test DNS never leaks into
 * shared state.
 */
interface SessionPool {
  /** Reference count of live clients. */
  users: number;
  /** Shared-pool registry key (`rejectUnauthorized`), or none when private. */
  key: boolean | undefined;
  /** Drained; no new sessions may be created. */
  closed: boolean;
  addresses: AddressBook;
  sessions: Map<string, SessionLanes>;
  /** Origins whose server did not negotiate HTTP/2; they stay on HTTP/1.1. */
  h1Only: Set<string>;
  /** TLS sockets still handshaking, so `close()` can drop them. */
  connectingSockets: Set<TlsSocket>;
  /**
   * Lanes waiting on one DNS answer. The answer's callback dials every one
   * of them before it returns, so they do not take turns through `await`.
   */
  parked: Map<string, ParkedDial[]>;
}

interface NodeH1Agents {
  httpAgent: DestroyableAgent;
  httpsAgent: DestroyableAgent;
}

/** A hostname's IPv4 addresses, the one in use first. */
interface ResolvedHost {
  addresses: string[];
  expiresAt: number;
}

/** Address resolution shared by the HTTP/1.1 pool and HTTP/2 sessions. */
export interface AddressBook {
  resolveIpv4(hostname: string): Promise<string>;
  /** Every current IPv4 answer for a hostname, the in-use address first. */
  resolveIpv4All(hostname: string): Promise<string[]>;
  /**
   * Addresses already in hand.
   *
   * `undefined` means a lookup is still required. A lane uses this so
   * `tls.connect` runs in the turn that already knows the address — awaiting
   * a resolved lookup would queue the SYN behind other work.
   */
  cachedIpv4(hostname: string): string[] | undefined;
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

type OutgoingBody = string | Uint8Array | MultipartBody | undefined;

const EMPTY_BYTES = new Uint8Array(0);

let libs: NodeLibs | undefined;
let importing: Promise<NodeLibs> | undefined;

/**
 * `process.getBuiltinModule`, bound, where the runtime offers it.
 *
 * Resolving a built-in this way is synchronous — no promise, no loader round
 * trip — so work queued behind it never waits on `import()`.
 */
const builtinModule = (): ((id: string) => unknown) | undefined =>
  typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
    ? (process.getBuiltinModule.bind(process) as (id: string) => unknown)
    : undefined;

/**
 * Load the Node modules the transport needs.
 *
 * On runtimes without `getBuiltinModule` (older Node, Deno) the dynamic
 * import path resolves them, and a failure rejects only the request that
 * needed the modules.
 */
function loadBuiltinLibs(builtin: (id: string) => unknown): NodeLibs | undefined {
  try {
    const stream = builtin('node:stream') as {
      Readable: { toWeb(readable: object): ReadableStream<Uint8Array> };
    };
    libs = {
      http: builtin('node:http') as unknown as HttpLib,
      https: builtin('node:https') as unknown as HttpLib,
      http2: builtin('node:http2') as unknown as Http2Lib,
      tls: builtin('node:tls') as unknown as TlsLib,
      dns: builtin('node:dns') as unknown as DnsLib,
      toWeb: stream.Readable.toWeb.bind(stream.Readable) as NodeLibs['toWeb'],
    };
    return libs;
  } catch {
    // A partial node:* implementation (Bun) can throw here.
    return undefined;
  }
}

/** Node modules already loaded. No promise — a dial must not wait on one. */
function syncNodeLibs(): NodeLibs | undefined {
  if (libs) return libs;
  const builtin = builtinModule();
  if (!builtin) return undefined;
  return loadBuiltinLibs(builtin);
}

function nodeLibs(): Promise<NodeLibs> {
  const loaded = syncNodeLibs();
  if (loaded) return Promise.resolve(loaded);

  importing ??= Promise.all([
    import('node:http'),
    import('node:https'),
    import('node:http2'),
    import('node:tls'),
    import('node:stream'),
    import('node:dns'),
  ]).then(
    ([http, https, http2, tls, stream, dns]) => {
      const loaded: NodeLibs = {
        http: http as unknown as HttpLib,
        https: https as unknown as HttpLib,
        http2: http2 as unknown as Http2Lib,
        tls: tls as unknown as TlsLib,
        dns: dns as unknown as DnsLib,
        toWeb: stream.Readable.toWeb.bind(stream.Readable) as NodeLibs['toWeb'],
      };
      libs = loaded;
      return loaded;
    },
    (error: unknown) => {
      importing = undefined;
      throw new GravixLayerInvalidArgumentError(
        'The GravixLayer client could not load Node HTTP modules.',
        { cause: error },
      );
    },
  );
  return importing;
}

let dnsModule: DnsLib | undefined;
let dnsImporting: Promise<DnsLib> | undefined;

/**
 * `node:dns`, synchronously where the runtime allows it.
 *
 * A lookup fired while a client is being built must start immediately — a
 * promise hop would queue it behind the heavier {@link nodeLibs} load it is
 * meant to overlap. Returns undefined where only the dynamic import works;
 * {@link dnsLib} covers that case.
 */
function syncDns(): DnsLib | undefined {
  if (dnsModule) return dnsModule;
  if (libs?.dns) {
    dnsModule = libs.dns;
    return dnsModule;
  }
  const builtin = builtinModule();
  if (!builtin) return undefined;
  try {
    dnsModule = builtin('node:dns') as DnsLib;
    return dnsModule;
  } catch {
    return undefined;
  }
}

/** `node:dns` alone, for runtimes where {@link syncDns} cannot resolve it. */
function dnsLib(): Promise<DnsLib> {
  const loaded = syncDns();
  if (loaded) return Promise.resolve(loaded);

  dnsImporting ??= import('node:dns').then(
    (dns) => {
      dnsModule = dns as unknown as DnsLib;
      return dnsModule;
    },
    (error: unknown) => {
      dnsImporting = undefined;
      throw new GravixLayerInvalidArgumentError(
        'The GravixLayer client could not load the Node DNS module.',
        { cause: error },
      );
    },
  );
  return dnsImporting;
}

/**
 * Build the TLS trust store once per process.
 *
 * The first secure context parses every root certificate, which costs real
 * milliseconds on small machines. Doing it off the request path (or while DNS
 * is in flight) keeps that work out of the first request's critical path.
 */
let trustStoreReady = false;
/** Reused by every handshake. The first `createSecureContext` is the slow one. */
let secureContext: unknown;
function warmTrustStore(): void {
  if (trustStoreReady) return;
  const tls = libs?.tls;
  if (!tls) return;
  try {
    secureContext = tls.createSecureContext();
    trustStoreReady = true;
  } catch {
    // A broken trust store fails the real handshake instead.
  }
}

let tlsPrimed = false;

/**
 * Run the process's first `tls.connect` calls off the request path.
 *
 * They initialize OpenSSL. Measured on Node 22, the first is about 5 ms and
 * the second about 2 ms; every call after that is well under a millisecond.
 * Doing them here, then destroying the sockets, is why a four-lane burst can
 * call `tls.connect` four times in one turn instead of each lane waiting for
 * the previous lane's initialization.
 */
function primeTlsStack(): void {
  if (tlsPrimed) return;
  const tls = libs?.tls;
  if (!tls) return;
  tlsPrimed = true;
  for (let i = 0; i < TLS_PRIME_CONNECTS; i += 1) {
    try {
      const socket = tls.connect({
        // Same shape as a lane dial. A cheaper option set leaves the first
        // real connect — SNI, both ALPN protocols — paying the init itself,
        // which is what spaces the lanes out.
        host: '127.0.0.1',
        port: 1,
        servername: 'localhost',
        rejectUnauthorized: false,
        noDelay: true,
        ALPNProtocols: ['h2', 'http/1.1'],
        ...(secureContext !== undefined ? { secureContext } : {}),
      });
      socket.once('error', () => undefined);
      socket.unref();
      socket.destroy();
    } catch {
      // The real handshake still runs; it just pays the one-time init itself.
      break;
    }
  }
}

/**
 * Header lookup over the raw header map a Node response carries.
 *
 * Values join repeated entries the way `Headers.get` does. Node already
 * lower-cases HTTP/1.1 and HTTP/2 header names, so `get` only pays for the
 * caller's casing.
 */
export class NodeHeaders implements HeaderSource {
  private readonly values = new Map<string, string>();

  constructor(raw: RawHeaders) {
    for (const key of Object.keys(raw)) {
      if (key.startsWith(':')) continue;
      const value = raw[key];
      if (value === undefined) continue;
      this.values.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
  }

  get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }

  forEach(callback: (value: string, name: string) => void): void {
    for (const [name, value] of this.values) callback(value, name);
  }
}

/** HTTP/2 and DNS state shared by every pooled client without a custom lookup. */
const sharedPools = new Map<boolean, SessionPool>();

function createPool(opts: { rejectUnauthorized: boolean; lookup?: DnsLookup }): SessionPool {
  const lookup = opts.lookup;
  return {
    users: 0,
    key: undefined,
    closed: false,
    sessions: new Map(),
    h1Only: new Set(),
    connectingSockets: new Set(),
    parked: new Map(),
    addresses: createAddressBook((hostname, callback) => {
      if (lookup) {
        lookup(hostname, { family: 4, all: true }, callback);
        return;
      }
      // `node:dns` alone is enough here; reaching for it directly keeps a
      // lookup fired during client construction ahead of the heavier module
      // load instead of queued behind it.
      const dns = syncDns();
      if (dns) {
        queryIpv4(dns, hostname, callback);
        return;
      }
      void dnsLib().then(
        (loaded) => {
          queryIpv4(loaded, hostname, callback);
        },
        (error: unknown) =>
          callback(error instanceof Error ? error : new Error(String(error)), undefined),
      );
    }),
  };
}

function acquirePool(opts: { rejectUnauthorized: boolean; lookup?: DnsLookup }): SessionPool {
  if (opts.lookup) {
    const pool = createPool(opts);
    pool.users = 1;
    return pool;
  }
  let pool = sharedPools.get(opts.rejectUnauthorized);
  if (!pool) {
    pool = createPool(opts);
    pool.key = opts.rejectUnauthorized;
    sharedPools.set(opts.rejectUnauthorized, pool);
  }
  pool.users += 1;
  return pool;
}

function closedClientError(): GravixLayerInvalidArgumentError {
  return new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');
}

function releasePool(pool: SessionPool): void {
  pool.users -= 1;
  if (pool.users > 0) return;
  if (pool.key !== undefined && sharedPools.get(pool.key) === pool) {
    sharedPools.delete(pool.key);
  }
  pool.closed = true;
  const parked = [...pool.parked.values()];
  pool.parked.clear();
  for (const waiting of parked) {
    for (const dial of waiting) dial.reject(closedClientError());
  }
  pool.addresses.clear();
  for (const socket of pool.connectingSockets) {
    dropSocket(socket);
  }
  pool.connectingSockets.clear();
  const pending = [...pool.sessions.values()];
  pool.sessions.clear();
  for (const lanes of pending) {
    for (const entry of lanes.entries) {
      void entry.ready.then(
        (handle) => closeH2(handle),
        () => undefined,
      );
    }
  }
}

export function createNativeNodeFetch(options: NativeNodeFetchOptions = {}): NativeNodeFetch {
  const http2Wanted = options.http2 !== false;
  const rejectUnauthorized = options.rejectUnauthorized !== false;
  const pool = acquirePool({ rejectUnauthorized, lookup: options.lookup });

  // The hostname lookup needs only `node:dns`, so it starts before the
  // heavier module load and finishes inside the gap between constructing a
  // client and its first request. A failed answer is not cached: the real
  // request simply looks the host up again.
  let warmOrigin: URL | undefined;
  if (options.origin !== undefined) {
    try {
      warmOrigin = new URL(options.origin);
    } catch {
      warmOrigin = undefined;
    }
    if (warmOrigin?.hostname) {
      void pool.addresses.resolveIpv4(warmOrigin.hostname).catch(() => undefined);
    }
  }

  let closed = false;
  let h1: { agents: NodeH1Agents; node: NodeLibs } | undefined;
  let h1Init: Promise<{ agents: NodeH1Agents; node: NodeLibs }> | undefined;

  const closedError = () =>
    new GravixLayerInvalidArgumentError('The GravixLayer client has been closed.');

  const dropLane = (origin: string, entry: SessionEntry): void => {
    const lanes = pool.sessions.get(origin);
    if (lanes === undefined) return;
    const at = lanes.entries.indexOf(entry);
    if (at >= 0) lanes.entries.splice(at, 1);
    if (lanes.entries.length === 0) pool.sessions.delete(origin);
  };

  const openLane = (origin: string, url: URL): SessionEntry => {
    let lanes = pool.sessions.get(origin);
    if (lanes === undefined) {
      lanes = { entries: [], opened: 0 };
      pool.sessions.set(origin, lanes);
    }
    const created: SessionEntry = {
      inflight: 0,
      ready: connectH2(url, {
        rejectUnauthorized,
        addresses: pool.addresses,
        connectingSockets: pool.connectingSockets,
        parked: pool.parked,
        isClosed: () => pool.closed,
        addrIndex: lanes.opened,
      }).then((handle) => {
        if (pool.closed) {
          dropH2(handle.session, handle.socket);
          throw closedError();
        }
        const ping = setInterval(() => {
          if (handle.session.destroyed || handle.session.closed) return;
          handle.session.ping((error) => {
            if (error) dropH2(handle.session, handle.socket);
          });
        }, H2_PING_MS);
        ping.unref();
        // Idle sessions must not keep a CLI alive after the last request.
        silenceHandle(handle.session);
        silenceHandle(handle.socket);
        handle.ping = ping;
        // Remove only this entry: a reconnect may already have replaced it.
        handle.session.once('close', () => {
          clearInterval(ping);
          dropLane(origin, created);
        });
        handle.session.once('error', () => {
          dropH2(handle.session, handle.socket);
        });
        created.handle = handle;
        return handle;
      }),
    };
    lanes.opened += 1;
    lanes.entries.push(created);
    void created.ready.catch((error: unknown) => {
      dropLane(origin, created);
      // Only a server that does not offer HTTP/2 moves the origin to HTTP/1.1
      // for good — and only when it refused the last lane: one lane's ALPN
      // refusal must not demote an origin whose other lanes still speak h2.
      if (isHttp2Unsupported(error) && (pool.sessions.get(origin)?.entries.length ?? 0) === 0) {
        pool.h1Only.add(origin);
      }
    });
    return created;
  };

  // Every lane dials in this turn when the address is known, or from the one
  // DNS callback when it is not. The sockets are in flight before this
  // function returns, so a burst that starts on the next line is not the
  // thing that opens them and does not watch them take turns. Idle lanes are
  // unref'd and cost a quiet client nothing but a few sockets.
  if (
    warmOrigin !== undefined &&
    http2Wanted &&
    warmOrigin.protocol === 'https:' &&
    (pool.sessions.get(warmOrigin.origin)?.entries.length ?? 0) === 0
  ) {
    while ((pool.sessions.get(warmOrigin.origin)?.entries.length ?? 0) < H2_LANES) {
      openLane(warmOrigin.origin, warmOrigin);
    }
  }

  /**
   * The least-loaded live lane for an origin. Sequential callers reuse the
   * first lane forever; the first request to find every live lane at
   * {@link H2_LANE_DEPTH} in flight opens the rest of the pool at once —
   * depth proves a burst, and staggering the opens would hand the following
   * requests a fresh handshake each. Every lane pins another resolved
   * address, so a burst does not serialise on one connection's peer work.
   *
   * A lane that arrived closed is dropped and re-dialed once per call, and a
   * rejected connect removes only that lane: the others keep serving.
   */
  const sessionFor = async (
    origin: string,
    url: URL,
  ): Promise<{ entry: SessionEntry; handle: H2Session }> => {
    for (;;) {
      if (pool.closed) throw closedError();
      const lanes = pool.sessions.get(origin);
      let lane: SessionEntry | undefined;
      if (lanes !== undefined) {
        for (const entry of lanes.entries) {
          if (lane === undefined || entry.inflight < lane.inflight) lane = entry;
        }
      }
      if (lane === undefined) {
        lane = openLane(origin, url);
      } else if ((lanes?.entries.length ?? 0) < H2_LANES && lane.inflight >= H2_LANE_DEPTH) {
        // A burst once proven is kept warm for the process: opening only the
        // lane this request needs would leave the next request paying for the
        // following lane's handshake.
        lane = openLane(origin, url);
        while ((lanes?.entries.length ?? 0) < H2_LANES) {
          openLane(origin, url);
        }
      }
      lane.inflight += 1;
      let handle: H2Session;
      try {
        handle = await lane.ready;
      } catch (error) {
        lane.inflight -= 1;
        throw error;
      }
      if (!handle.session.closed && !handle.session.destroyed) return { entry: lane, handle };
      lane.inflight -= 1;
      dropLane(origin, lane);
    }
  };

  /**
   * The warm path of {@link sessionFor}: a lane whose session already
   * resolved and is still live is returned synchronously, so a dispatch
   * inside a burst never pays the `await` chain the cold path needs.
   * `null` means the pool must still grow or a lane is mid-handshake, and
   * the caller falls back to `sessionFor` — which also owns burst
   * detection, so depth-triggered growth stays in one place.
   */
  const pickReadyLane = (origin: string): { entry: SessionEntry; handle: H2Session } | null => {
    const lanes = pool.sessions.get(origin);
    if (lanes === undefined) return null;
    let lane: SessionEntry | undefined;
    for (const entry of lanes.entries) {
      const handle = entry.handle;
      if (handle === undefined || handle.session.closed || handle.session.destroyed) continue;
      if (lane === undefined || entry.inflight < lane.inflight) lane = entry;
    }
    if (lane === undefined) return null;
    // Burst depth is only honoured while the pool is full: below H2_LANES a
    // saturating request must walk the slow path so the missing lanes open.
    if (lane.inflight >= H2_LANE_DEPTH && lanes.entries.length < H2_LANES) return null;
    lane.inflight += 1;
    return { entry: lane, handle: lane.handle as H2Session };
  };

  // A burst must share one init: checking `h1` after the await would give
  // every concurrent caller its own agent pair and its own sockets.
  const h1Agents = (): Promise<{ agents: NodeH1Agents; node: NodeLibs }> => {
    if (h1) return Promise.resolve(h1);
    h1Init ??= nodeLibs().then((node) => {
      if (closed) throw closedError();
      h1 = { agents: createNodeH1Agents(node, { rejectUnauthorized }), node };
      return h1;
    });
    return h1Init;
  };

  // HTTP/1.1 sockets walk the answer list too, so its sixteen-connection pool
  // spreads across a multi-address origin the way the HTTP/2 lanes do.
  let h1Dials = 0;
  const h1Address = async (hostname: string): Promise<string> => {
    const all = await pool.addresses.resolveIpv4All(hostname);
    const address = all[h1Dials % all.length] as string;
    h1Dials += 1;
    return address;
  };

  const dispatch: Dispatch = (request) => {
    if (closed) return Promise.reject(closedError());
    const url = request.parsedUrl ?? new URL(request.url);
    if (http2Wanted && url.protocol === 'https:' && !pool.h1Only.has(url.origin)) {
      // Warm path: an already-open lane goes straight to the stream write.
      // Returning the dispatch promise rather than `await`ing it keeps the
      // resolved-promise hops a burst would otherwise pay per request.
      const picked = pickReadyLane(url.origin);
      if (picked !== null) {
        // Counted until the request's h2 stream closes, so a lane holding a
        // long-lived body (attach, logs) is not reported idle.
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          picked.entry.inflight -= 1;
        };
        if (closed) {
          release();
          return Promise.reject(closedError());
        }
        return h2Dispatch(picked.handle, url, request, release).catch((error) => {
          release();
          if (closed) throw closedError();
          throw error;
        });
      }
      return dispatchH2(url, request);
    }
    return h1Agents().then(({ agents, node }) => {
      if (closed) throw closedError();
      return h1Dispatch(
        node,
        agents,
        { resolve: h1Address, demote: pool.addresses.demote },
        { rejectUnauthorized },
        request,
      );
    });
  };

  /**
   * The lane-opening half of `dispatch`: a request that found no ready lane
   * still takes the full session path — burst growth, handshake waiting,
   * and the handshake-only HTTP/1.1 fallback all live here.
   */
  const dispatchH2 = async (url: URL, request: WireRequest): Promise<WireResponse> => {
    try {
      const { entry, handle } = await sessionFor(url.origin, url);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        entry.inflight -= 1;
      };
      try {
        if (closed) throw closedError();
        return await h2Dispatch(handle, url, request, release);
      } catch (error) {
        release();
        throw error;
      }
    } catch (error) {
      if (closed) throw closedError();
      // Only the handshake falls back to HTTP/1.1. A failure after the
      // session is up must not replay the request (POST create is not
      // idempotent).
      if (!isHttp2HandshakeFailure(error) || !isReplayableRequest(request)) {
        throw error;
      }
    }
    const { agents, node } = await h1Agents();
    if (closed) throw closedError();
    return h1Dispatch(
      node,
      agents,
      { resolve: h1Address, demote: pool.addresses.demote },
      { rejectUnauthorized },
      request,
    );
  };

  /**
   * `fetch`-shaped facade over {@link dispatch} for callers that need the
   * standard `Response` object. API calls take `dispatch` instead.
   */
  const fetch: FetchLike = async (input, init = {}) => {
    const request = requestFromInit(input, init);
    const reply = await dispatch(request);
    const headers = new Headers();
    reply.headers.forEach((value, name) => headers.append(name, value));
    if (request.stream) {
      return new Response(reply.body, {
        status: reply.status,
        statusText: reply.statusText,
        headers,
      });
    }
    const empty =
      reply.status === 204 ||
      reply.status === 205 ||
      reply.status === 304 ||
      request.method === 'HEAD';
    // The collected bytes are always backed by a real ArrayBuffer.
    const body = empty ? null : ((await reply.bytes()) as Uint8Array<ArrayBuffer>);
    return new Response(body, {
      status: reply.status,
      statusText: reply.statusText,
      headers,
    });
  };

  return {
    fetch,
    dispatch,
    async preconnect(origin) {
      let url: URL | undefined;
      if (origin !== undefined) {
        try {
          url = new URL(origin);
        } catch {
          url = undefined;
        }
      }
      // DNS is the one cost every protocol shares and needs only `node:dns`:
      // it resolves next to the module load below, not after it. The HTTP/2
      // path reuses this same in-flight lookup.
      const resolving = url === undefined ? undefined : pool.addresses.resolveIpv4(url.hostname);
      // A `closed` early return below skips `await resolving`; the guard keeps
      // a failed lookup from surfacing as an unhandled rejection.
      resolving?.catch(() => undefined);
      await nodeLibs();
      warmTrustStore();
      if (closed || url === undefined) return;
      try {
        await resolving;
        if (http2Wanted && url.protocol === 'https:' && !pool.h1Only.has(url.origin)) {
          // An explicit warm-up opens every lane at once: the handshakes run
          // in parallel and the first burst lands on warm connections instead
          // of opening lanes while it queues.
          while ((pool.sessions.get(url.origin)?.entries.length ?? 0) < H2_LANES && !pool.closed) {
            openLane(url.origin, url);
          }
          const warming = pool.sessions.get(url.origin)?.entries ?? [];
          await Promise.all(warming.map((entry) => entry.ready.then(() => undefined)));
          return;
        }
        await h1Agents();
      } catch {
        // A preconnect failure surfaces on the real request instead.
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const agents = h1?.agents;
      h1 = undefined;
      h1Init = undefined;
      if (agents) {
        destroyAgent(agents.httpAgent);
        destroyAgent(agents.httpsAgent);
      }
      releasePool(pool);
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

  const fresh = (hostname: string, known: ResolvedHost): string[] => {
    if (known.expiresAt <= Date.now() && !lookups.has(hostname)) {
      // A failed refresh keeps the last good answer for another TTL.
      void lookupHost(hostname).catch(() => {
        known.expiresAt = Date.now() + DNS_TTL_MS;
      });
    }
    return known.addresses;
  };

  const resolveAll = async (hostname: string): Promise<string[]> => {
    if (IPV4_LITERAL.test(hostname)) return [hostname];
    const known = hosts.get(hostname);
    if (!known) return await lookupHost(hostname);
    return fresh(hostname, known);
  };

  return {
    async resolveIpv4(hostname) {
      return (await resolveAll(hostname))[0] as string;
    },
    resolveIpv4All: resolveAll,
    cachedIpv4(hostname) {
      if (IPV4_LITERAL.test(hostname)) return [hostname];
      const known = hosts.get(hostname);
      if (!known) return undefined;
      return fresh(hostname, known);
    },
    demote(hostname, address) {
      const known = hosts.get(hostname);
      if (known === undefined) return;
      const at = known.addresses.indexOf(address);
      if (at < 0) return;
      if (known.addresses.length > 1) {
        known.addresses.push(known.addresses.splice(at, 1)[0] as string);
      }
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

interface ConnectH2Options {
  rejectUnauthorized: boolean;
  addresses: AddressBook;
  connectingSockets: Set<TlsSocket>;
  parked: Map<string, ParkedDial[]>;
  isClosed: () => boolean;
  /**
   * Which resolved address this lane pins. Lanes walk the answer list, so a
   * multi-address origin's burst lands on several endpoints.
   */
  addrIndex: number;
}

/**
 * Open one HTTP/2 lane.
 *
 * The socket starts in this turn when the address is already known, and in
 * the DNS callback — every parked lane, before that callback returns — when
 * it is not. Nothing here `await`s. A promise chain before `tls.connect`
 * is what left a burst sitting in `sessionFor` while lanes took turns dialing.
 */
function connectH2(url: URL, opts: ConnectH2Options): Promise<H2Session> {
  const node = syncNodeLibs();
  if (node) return dialOrPark(node, url, opts);
  return nodeLibs().then((loaded) => dialOrPark(loaded, url, opts));
}

function dialOrPark(node: NodeLibs, url: URL, opts: ConnectH2Options): Promise<H2Session> {
  if (opts.isClosed()) return Promise.reject(closedClientError());
  // The trust store is built at import. Building it while a c-ares query is
  // in flight would stall that query: `resolve4` is delivered on the event
  // loop. A runtime that could not warm at import still builds it here,
  // before any socket, and only on the first dial.
  warmTrustStore();
  const cached = opts.addresses.cachedIpv4(url.hostname);
  if (cached !== undefined && cached.length > 0) {
    return dialSocket(node, url, cached[opts.addrIndex % cached.length] as string, opts);
  }

  return new Promise((resolve, reject) => {
    const dial: ParkedDial = {
      url,
      node,
      rejectUnauthorized: opts.rejectUnauthorized,
      addrIndex: opts.addrIndex,
      resolve,
      reject,
    };
    const waiting = opts.parked.get(url.hostname);
    if (waiting !== undefined) {
      waiting.push(dial);
      return;
    }
    opts.parked.set(url.hostname, [dial]);
    // One lookup for every lane parked above. Its continuation dials them
    // all before yielding, so lane N does not wait for lane 1's handshake.
    opts.addresses.resolveIpv4All(url.hostname).then(
      (addresses) => releaseParked(url.hostname, addresses, opts),
      (error: unknown) => {
        const parked = opts.parked.get(url.hostname) ?? [];
        opts.parked.delete(url.hostname);
        for (const item of parked) item.reject(error);
      },
    );
  });
}

/** Dial every lane that was waiting on this hostname. Runs inside the lookup. */
function releaseParked(hostname: string, addresses: string[], opts: ConnectH2Options): void {
  const parked = opts.parked.get(hostname) ?? [];
  opts.parked.delete(hostname);
  for (const dial of parked) {
    if (opts.isClosed()) {
      dial.reject(closedClientError());
      continue;
    }
    const address = addresses[dial.addrIndex % addresses.length] as string;
    dialSocket(dial.node, dial.url, address, {
      ...opts,
      rejectUnauthorized: dial.rejectUnauthorized,
    }).then(dial.resolve, dial.reject);
  }
}

/**
 * Start the TCP+TLS handshake now. The returned promise settles at HTTP/2
 * session connect; `tls.connect` itself has already run.
 */
function dialSocket(
  node: NodeLibs,
  url: URL,
  address: string,
  opts: ConnectH2Options,
): Promise<H2Session> {
  const port = Number(url.port) || 443;
  return new Promise((resolve, reject) => {
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
      resolve({ session, socket, ping: undefined, node });
    };

    const servername = tlsServername(url.hostname);
    const socket = node.tls.connect({
      host: address,
      port,
      ALPNProtocols: ['h2', 'http/1.1'],
      rejectUnauthorized: opts.rejectUnauthorized,
      noDelay: true,
      ...(secureContext !== undefined ? { secureContext } : {}),
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
    socket.once('close', () => {
      fail(handshakeError('HTTP/2 connect closed'));
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

function h2Dispatch(
  handle: H2Session,
  url: URL,
  request: WireRequest,
  /**
   * Called exactly once when the request's stream fully closes — after the
   * body ends, on abort, or on failure — so the caller's in-flight count
   * tracks the stream's real lifetime rather than the headers arriving.
   */
  onDone: () => void,
): Promise<WireResponse> {
  const { session, node } = handle;
  const CANCEL = node.http2.constants.NGHTTP2_CANCEL;
  const { body, headers } = encodeRequestBody(request);
  const h2Headers: Http2Headers = {
    ':method': request.method,
    ':path': `${url.pathname}${url.search}`,
    ':scheme': 'https',
    ':authority': url.host,
  };
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value === undefined || H2_FORBIDDEN.has(key)) continue;
    h2Headers[key] = value;
  }

  const signal = request.signal;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const req = session.request(h2Headers, { endStream: body === undefined });
    req.once('close', onDone);
    const onAbort = () => {
      const reason = signal?.reason ?? new Error('aborted');
      req.close(CANCEL);
      req.destroy(reason instanceof Error ? reason : new Error(String(reason)));
      reject(reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    req.once('response', (incoming) => {
      const status = Number(incoming[':status'] ?? 200);
      const headers = new NodeHeaders(incoming);
      if (isEmptyBody(status, request.method)) {
        signal?.removeEventListener('abort', onAbort);
        resolve({
          status,
          statusText: '',
          headers,
          body: null,
          bytes: async () => EMPTY_BYTES,
          cancel: () => undefined,
        });
        return;
      }
      if (request.stream) {
        // The signal stays wired until the stream closes, so an abort after
        // the headers still cancels the stream and fails the body.
        req.once('close', () => signal?.removeEventListener('abort', onAbort));
        const body = node.toWeb(req);
        resolve({
          status,
          statusText: '',
          headers,
          body,
          bytes: () => readAll(body),
          cancel: () => {
            void body.cancel().catch(() => undefined);
          },
        });
        return;
      }
      // Read eagerly so the stream always has its error listener attached;
      // the extra catch silences a body nobody ends up reading.
      const bodyReady = readNodeBody(req);
      void bodyReady.catch(() => undefined);
      void bodyReady.then(
        () => signal?.removeEventListener('abort', onAbort),
        () => signal?.removeEventListener('abort', onAbort),
      );
      resolve({
        status,
        statusText: '',
        headers,
        body: null,
        bytes: () => bodyReady,
        cancel: () => {
          req.close(CANCEL);
          req.destroy();
        },
      });
    });
    sendBody(req, body);
  });
}

function h1Dispatch(
  node: NodeLibs,
  agents: NodeH1Agents,
  book: {
    resolve: (hostname: string) => Promise<string>;
    demote: (hostname: string, address: string) => void;
  },
  opts: { rejectUnauthorized: boolean },
  request: WireRequest,
): Promise<WireResponse> {
  return (async () => {
    const url = new URL(request.url);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? node.https : node.http;
    const agent = isHttps ? agents.httpsAgent : agents.httpAgent;
    const { body, headers } = encodeRequestBody(request);
    if (!('host' in headers)) headers.host = url.host;
    const address = await book.resolve(url.hostname);

    return await new Promise<WireResponse>((resolve, reject) => {
      const reqOpts: Record<string, unknown> = {
        protocol: url.protocol,
        hostname: address,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        agent,
        family: 4,
        autoSelectFamily: false,
        noDelay: true,
        signal: request.signal ?? undefined,
      };
      if (isHttps) {
        const servername = tlsServername(url.hostname);
        if (servername) reqOpts['servername'] = servername;
        reqOpts['rejectUnauthorized'] = opts.rejectUnauthorized;
        reqOpts['ALPNProtocols'] = ['http/1.1'];
      }
      const req = lib.request(reqOpts, (res) => {
        const status = res.statusCode ?? 200;
        const headers = new NodeHeaders(res.headers);
        if (isEmptyBody(status, request.method)) {
          res.resume();
          resolve({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            body: null,
            bytes: async () => EMPTY_BYTES,
            cancel: () => undefined,
          });
          return;
        }
        if (request.stream) {
          const body = node.toWeb(res);
          resolve({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            body,
            bytes: () => readAll(body),
            cancel: () => {
              void body.cancel().catch(() => undefined);
            },
          });
          return;
        }
        // Eager read keeps an error listener on the response between the
        // headers resolving and the caller asking for the body.
        const bodyReady = readNodeBody(res, req);
        void bodyReady.catch(() => undefined);
        resolve({
          status,
          statusText: res.statusMessage ?? '',
          headers,
          body: null,
          bytes: () => bodyReady,
          cancel: () => res.destroy(),
        });
      });
      req.on('error', (error) => {
        if (isConnectFailure(error)) book.demote(url.hostname, address);
        reject(error);
      });
      req.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.ref();
      });
      sendBody(req, body);
    });
  })();
}

function createNodeH1Agents(node: NodeLibs, opts: { rejectUnauthorized: boolean }): NodeH1Agents {
  const shared = {
    keepAlive: true,
    keepAliveMsecs: TCP_KEEPALIVE_DELAY_MS,
    maxSockets: H1_CONNECTIONS,
    maxFreeSockets: 10,
    scheduling: 'lifo' as const,
  };

  const httpAgent = new node.http.Agent(shared);
  warmTrustStore();
  const httpsAgent = new node.https.Agent({
    ...shared,
    rejectUnauthorized: opts.rejectUnauthorized,
    maxCachedSessions: 100,
    ALPNProtocols: ['http/1.1'],
    ...(secureContext !== undefined ? { secureContext } : {}),
  });
  releaseIdleSockets(httpAgent);
  releaseIdleSockets(httpsAgent);
  return { httpAgent, httpsAgent };
}

/**
 * Lay out the outgoing body and derive the headers the wire needs.
 *
 * The caller's header record is never mutated: the encoded copy is returned
 * alongside the body, so a retried request sees its original headers.
 */
function encodeRequestBody(request: WireRequest): {
  body: OutgoingBody;
  headers: Record<string, string>;
} {
  if (request.form) {
    const headers = { ...request.headers };
    const multipart = encodeMultipart(request.form);
    headers['content-type'] = multipart.contentType;
    headers['content-length'] = String(multipart.length);
    return { body: multipart, headers };
  }
  // Nothing downstream mutates the headers of a non-form request, so the
  // transport's object is carried through rather than copied per request.
  return { body: request.body, headers: request.headers };
}

/**
 * Translate `fetch` arguments into a wire request.
 *
 * Body types the wire cannot carry (raw streams) raise the same argument
 * error `fetch` would surface through the SDK.
 */
function requestFromInit(input: string, init: RequestInit): WireRequest {
  const headers: Record<string, string> = {};
  const initHeaders = init.headers;
  if (initHeaders) {
    if (typeof Headers !== 'undefined' && initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) headers[key.toLowerCase()] = value;
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        headers[key.toLowerCase()] = value;
      }
    }
  }

  const request: WireRequest = {
    url: input,
    method: (init.method ?? 'GET').toUpperCase(),
    headers,
    signal: init.signal ?? undefined,
    stream: wantsStreamingBody(headers),
  };

  const body = init.body;
  if (body == null) return request;
  if (typeof body === 'string') {
    request.body = body;
    return request;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) {
    request.body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return request;
  }
  if (body instanceof Uint8Array) {
    request.body = body;
    return request;
  }
  if (body instanceof ArrayBuffer) {
    request.body = new Uint8Array(body);
    return request;
  }
  if (ArrayBuffer.isView(body)) {
    request.body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return request;
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    if (!('content-type' in headers)) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    request.body = body.toString();
    return request;
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    request.form = body;
    return request;
  }
  throw new GravixLayerInvalidArgumentError(
    'This request body type is not supported by the Node HTTP client.',
  );
}

/**
 * Handshake fallback must not replay a body it cannot safely resend.
 * Strings and byte buffers are safe to send a second time; an already-encoded
 * multipart body is not.
 */
function isReplayableRequest(request: WireRequest): boolean {
  return request.form === undefined;
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

function wantsStreamingBody(headers: Record<string, string>): boolean {
  const accept = headers['accept'];
  return typeof accept === 'string' && accept.toLowerCase().includes('text/event-stream');
}

function isEmptyBody(status: number, method: string): boolean {
  return status === 204 || status === 205 || status === 304 || method === 'HEAD';
}

/**
 * Read a response stream to its end.
 *
 * `abortSource` is the request that owns the body: on HTTP/1.1 a dead socket
 * reports on the request, not the response, so both can settle the read.
 */
function readNodeBody(
  stream: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): void;
    once(event: 'end', listener: () => void): void;
    once(event: 'error', listener: (error: Error) => void): void;
    once(event: 'close', listener: () => void): void;
  },
  abortSource?: {
    once(event: 'error', listener: (error: Error) => void): void;
  },
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let ended = false;
    const earlyClose = () => {
      // A reset mid-body must not leave the read waiting on an 'end' that
      // never arrives.
      if (!ended) reject(new Error('The response stream closed before the body completed.'));
    };
    stream.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.once('end', () => {
      ended = true;
      if (chunks.length === 0) {
        resolve(EMPTY_BYTES);
        return;
      }
      const buffer = Buffer.concat(chunks);
      resolve(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    });
    stream.once('error', reject);
    stream.once('close', earlyClose);
    abortSource?.once('error', reject);
  });
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

// Import-time warm.
//
// The first `getBuiltinModule` call for each `node:*` module runs real
// initialization — the HTTP/2 parser, the TLS wrapper, the CA bundle — so
// the package pays it while it evaluates rather than inside the first
// request. `createSecureContext` is synchronous and, deferred through
// `.then`, lands on the same turn as the first `await` inside `create()`,
// which is inside the caller's timer. Running it here, before this module
// returns, keeps it out of that timer. Runtimes without
// `getBuiltinModule` still warm when the dynamic import settles.
if (typeof process !== 'undefined' && typeof process.versions?.node === 'string') {
  const pending = nodeLibs();
  if (libs) {
    warmTrustStore();
    primeTlsStack();
  } else {
    void pending
      .then(() => {
        warmTrustStore();
        primeTlsStack();
      })
      .catch(() => undefined);
  }
}
