/**
 * One thread per HTTP/2 lane.
 *
 * Node runs a TLS handshake on the thread that reads the socket. Four lanes
 * on the main thread therefore finish one after another, even when every
 * server flight is already sitting in the kernel — the later lanes wait on
 * the earlier lanes' certificate checks. Each lane here owns a thread, so
 * those checks run together. A dial is a post to that thread, not a place in
 * a queue, and a request does not take a lock to use its lane. A buffered
 * body travels with its headers, so the thread finishes that stream before
 * it returns to the event loop.
 *
 * The thread is started while this module loads, in parallel with the rest
 * of the SDK's startup, so the first burst does not pay for creating it.
 * `node:*` is reached through `process.getBuiltinModule` — this file has no
 * static Node import, and runtimes without the modules keep the in-process
 * handshake in `node-http`.
 */

const PREWARM = 4;
const MAX_THREADS = 8;

/** Same marker `node-http` uses to recognise a failure before any request. */
const H2_HANDSHAKE = 'h2handshake';

/**
 * Lane thread source.
 *
 * Evaluated inside `worker_threads` as its own module. It cannot close over
 * this file: everything it needs is imported there. The main thread primes
 * OpenSSL for itself; this thread has its own, so it primes too, before it
 * reads a dial.
 */
const LANE_SOURCE = `
import { parentPort, threadId, workerData } from 'node:worker_threads';
import tls from 'node:tls';
import http2 from 'node:http2';
import { performance } from 'node:perf_hooks';

const port = parentPort;
if (!port) throw new Error('HTTP/2 lane has no parent port');

const epoch = () => performance.timeOrigin + performance.now();
const secureContext = tls.createSecureContext();
for (let i = 0; i < 2; i += 1) {
  try {
    const primer = tls.connect({
      host: '127.0.0.1',
      port: 1,
      servername: 'localhost',
      rejectUnauthorized: false,
      noDelay: true,
      ALPNProtocols: ['h2', 'http/1.1'],
      secureContext,
    });
    primer.once('error', () => {});
    primer.unref();
    primer.destroy();
  } catch {
    break;
  }
}

let gen = 0;
let closing = false;
let socket;
let session;
let up = false;
const streams = new Map();

function shutdown(genAt) {
  if (closing) return;
  closing = true;
  up = false;
  for (const req of streams.values()) {
    try {
      req.destroy();
    } catch {
      // Already gone.
    }
  }
  streams.clear();
  const currentSession = session;
  session = undefined;
  const currentSocket = socket;
  socket = undefined;
  try {
    currentSession?.destroy();
  } catch {
    // Already gone.
  }
  try {
    currentSocket?.destroy();
  } catch {
    // Already gone.
  }
  port.postMessage({ t: 'idle', gen: genAt });
}

function failConnect(genAt, message, code) {
  if (closing) return;
  // Fail before idle. Idle returns the thread to the pool; if it arrived
  // first, the next dial could take the thread before this one had rejected.
  port.postMessage({ t: 'fail', gen: genAt, message, code: code || 'ERR_HTTP2' });
  shutdown(genAt);
}

port.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'dial') {
    gen = msg.gen;
    closing = false;
    up = false;
    const myGen = gen;
    const mark = { tDial: epoch(), tTcp: 0, localPort: 0, remote: '' };
    let settled = false;
    const giveUp = (message, code) => {
      if (settled || closing || gen !== myGen) return;
      settled = true;
      failConnect(myGen, message, code);
    };
    try {
      socket = tls.connect({
        host: msg.host,
        port: msg.port,
        ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized: msg.rejectUnauthorized !== false,
        noDelay: true,
        secureContext,
        ...(msg.servername ? { servername: msg.servername } : {}),
      });
    } catch (error) {
      giveUp(error instanceof Error ? error.message : String(error), 'ERR_HTTP2');
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
    socket.once('connect', () => {
      if (gen !== myGen || !socket) return;
      mark.tTcp = epoch();
      mark.localPort = socket.localPort ?? 0;
      mark.remote = socket.remoteAddress ?? '';
    });
    socket.setTimeout(msg.timeoutMs, () => {
      socket?.destroy();
      giveUp('HTTP/2 connect timed out', 'ETIMEDOUT');
    });
    socket.once('error', (error) => {
      giveUp(error instanceof Error ? error.message : String(error), error?.code);
    });
    socket.once('close', () => {
      giveUp('HTTP/2 connect closed', 'ERR_HTTP2');
    });
    socket.once('secureConnect', () => {
      if (settled || closing || gen !== myGen || !socket) return;
      socket.setTimeout(0);
      if (socket.alpnProtocol !== 'h2') {
        socket.destroy();
        giveUp('ALPN did not negotiate HTTP/2', 'ERR_HTTP2_NOT_NEGOTIATED');
        return;
      }
      const tSecure = epoch();
      const connected = socket;
      try {
        session = http2.connect(msg.origin, {
          createConnection: () => connected,
          settings: { enablePush: false, maxConcurrentStreams: 100 },
        });
      } catch (error) {
        giveUp(error instanceof Error ? error.message : String(error), 'ERR_HTTP2');
        return;
      }
      const timer = setTimeout(() => {
        giveUp('HTTP/2 session timed out', 'ERR_HTTP2');
      }, msg.timeoutMs);
      timer.unref();
      session.once('error', (error) => {
        clearTimeout(timer);
        giveUp(error instanceof Error ? error.message : String(error), error?.code || 'ERR_HTTP2');
      });
      session.once('connect', () => {
        if (settled || closing || gen !== myGen || !session || !socket) return;
        settled = true;
        up = true;
        clearTimeout(timer);
        try {
          session.setTimeout(0);
        } catch {
          // Optional on this Node version.
        }
        try {
          session.unref();
        } catch {
          // Already gone.
        }
        try {
          socket.unref();
        } catch {
          // Already gone.
        }
        port.postMessage({
          t: 'up',
          gen: myGen,
          tDial: mark.tDial,
          tTcp: mark.tTcp || tSecure,
          tSecure,
          localPort: mark.localPort || socket.localPort || 0,
          remote: mark.remote || socket.remoteAddress || '',
          alpn: socket.alpnProtocol || '',
          protocol: typeof socket.getProtocol === 'function' ? socket.getProtocol() || '' : '',
          reused: Boolean(socket.isSessionReused?.()),
          threadId,
        });
      });
      session.once('close', () => {
        if (closing || gen !== myGen || !up) return;
        up = false;
        port.postMessage({
          t: 'down',
          gen: myGen,
          message: 'HTTP/2 session closed',
          code: 'ERR_HTTP2',
        });
        shutdown(myGen);
      });
    });
    return;
  }
  if (msg.gen !== gen) return;
  if (msg.t === 'hangup') {
    shutdown(gen);
    return;
  }
  if (msg.t === 'ping') {
    if (!session || session.destroyed || session.closed) {
      port.postMessage({ t: 'pong', gen, id: msg.id, error: 'session closed' });
      return;
    }
    session.ping((error) => {
      port.postMessage({
        t: 'pong',
        gen,
        id: msg.id,
        error: error ? String(error.message || error) : '',
      });
    });
    return;
  }
  if (msg.t === 'timeout') {
    try {
      session?.setTimeout(msg.ms);
    } catch {
      // Already gone.
    }
    try {
      socket?.setTimeout(msg.ms);
    } catch {
      // Already gone.
    }
    return;
  }
  if (msg.t === 'pause') {
    streams.get(msg.id)?.pause();
    return;
  }
  if (msg.t === 'resume') {
    streams.get(msg.id)?.resume();
    return;
  }
  if (msg.t === 'cancel') {
    const req = streams.get(msg.id);
    if (!req || req.destroyed || req.closed) return;
    try {
      req.close(typeof msg.code === 'number' ? msg.code : 8);
    } catch {
      // Already gone.
    }
    return;
  }
  if (msg.t === 'write') {
    const req = streams.get(msg.id);
    if (!req || req.destroyed || req.closed || req.writableEnded) {
      port.postMessage({ t: 'wrote', gen, id: msg.id });
      return;
    }
    const chunk = msg.chunk;
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const ok = req.write(buf);
    if (ok) port.postMessage({ t: 'wrote', gen, id: msg.id });
    else req.once('drain', () => port.postMessage({ t: 'wrote', gen, id: msg.id }));
    return;
  }
  if (msg.t === 'finish') {
    const req = streams.get(msg.id);
    if (!req || req.destroyed || req.writableEnded) return;
    req.end();
    return;
  }
  if (msg.t !== 'request' || !session || session.destroyed || session.closed) {
    if (msg.t === 'request') {
      port.postMessage({
        t: 'error',
        gen,
        id: msg.id,
        message: 'HTTP/2 session is closed',
        code: 'ERR_HTTP2',
      });
      port.postMessage({ t: 'close', gen, id: msg.id });
    }
    return;
  }
  let req;
  const hasBody = msg.body && msg.body.byteLength > 0;
  try {
    req = session.request(msg.headers, { endStream: msg.endStream === true && !hasBody });
  } catch (error) {
    port.postMessage({
      t: 'error',
      gen,
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
      code: 'ERR_HTTP2',
    });
    port.postMessage({ t: 'close', gen, id: msg.id });
    return;
  }
  streams.set(msg.id, req);
  req.on('response', (headers) => {
    const plain = {};
    for (const key of Object.keys(headers)) {
      const value = headers[key];
      if (value !== undefined) plain[key] = value;
    }
    port.postMessage({ t: 'response', gen, id: msg.id, headers: plain });
  });
  req.on('data', (chunk) => {
    // The chunk aliases the session read buffer. Transferring that buffer
    // detaches bytes the session still reads, so the slice is copied into a
    // buffer this message owns. One copy; the receiver does not copy it again.
    const view = new Uint8Array(chunk.byteLength);
    view.set(chunk);
    port.postMessage({ t: 'data', gen, id: msg.id, chunk: view }, [view.buffer]);
  });
  req.on('end', () => port.postMessage({ t: 'end', gen, id: msg.id }));
  req.on('error', (error) => {
    port.postMessage({
      t: 'error',
      gen,
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
      code: error?.code || 'ERR_HTTP2',
    });
  });
  req.on('close', () => {
    streams.delete(msg.id);
    port.postMessage({ t: 'close', gen, id: msg.id });
  });
  if (hasBody) {
    const view = msg.body;
    // View of the transferred buffer, not a second copy. end() reads it
    // before this turn yields, so the server gets the body and END_STREAM
    // without a trip back to the main thread.
    const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    try {
      req.end(buf);
    } catch (error) {
      req.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
});
if (workerData && workerData.ready) {
  const view = new Int32Array(workerData.ready);
  Atomics.store(view, workerData.slot, 1);
  Atomics.notify(view, workerData.slot);
}
port.postMessage({ t: 'primed' });
`;

interface LaneWorker {
  postMessage(message: object, transfer?: ArrayBuffer[]): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  ref(): void;
  unref(): void;
}

interface WorkerConstructor {
  new (
    source: string,
    options: {
      eval: boolean;
      execArgv: string[];
      env: Record<string, string>;
      workerData?: { ready: SharedArrayBuffer; slot: number };
    },
  ): LaneWorker;
}

type HeaderValue = string | string[] | number;

interface StreamRecord {
  method: string;
  path: string;
  tReq: number;
  tHeaders: number;
  tEnd: number;
  status: number;
  bytes: number;
  localPort: number;
  inflight: number;
  body: string;
}

interface BenchTrace {
  tls: object[];
  streams: StreamRecord[];
}

function benchTrace(): BenchTrace | undefined {
  const trace = (globalThis as { __glTrace?: Partial<BenchTrace> }).__glTrace;
  if (!trace || !Array.isArray(trace.tls) || !Array.isArray(trace.streams)) return undefined;
  return trace as BenchTrace;
}

function epochMs(): number {
  return performance.timeOrigin + performance.now();
}

function handshakeError(message: string, code = 'ERR_HTTP2'): Error {
  return Object.assign(new Error(message), { code, [H2_HANDSHAKE]: true });
}

function isNodeProcess(): boolean {
  const versions = (globalThis as { process?: { versions?: { node?: string; bun?: string } } })
    .process?.versions;
  return typeof versions?.node === 'string' && versions.bun === undefined;
}

function builtinModule(): ((id: string) => unknown) | undefined {
  const current = globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } };
  const get = current.process?.getBuiltinModule;
  if (typeof get !== 'function') return undefined;
  return get.bind(current.process);
}

function workerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const source = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (!source) return env;
  for (const key of Object.keys(source)) {
    if (key === 'NODE_OPTIONS') continue;
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

interface DuplexLike {
  writableEnded: boolean;
  destroyed: boolean;
  write(chunk: Uint8Array, encoding?: string, cb?: (error?: Error | null) => void): boolean;
  end(chunk?: string | Uint8Array): void;
  destroy(error?: Error): void;
  push(chunk: Uint8Array | null): boolean;
  emit(event: 'response', headers: Record<string, HeaderValue>): void;
  once(event: 'drain', listener: () => void): void;
  off(event: 'drain' | 'close', listener: () => void): void;
  close?(code?: number): void;
}

interface DuplexConstructor {
  new (options: Record<string, unknown>): DuplexLike;
}

let duplexCtor: DuplexConstructor | undefined;

function loadDuplex(): DuplexConstructor {
  if (duplexCtor) return duplexCtor;
  const stream = builtinModule()?.('node:stream') as { Duplex?: DuplexConstructor } | undefined;
  if (!stream?.Duplex) throw new Error('node:stream is unavailable');
  duplexCtor = stream.Duplex;
  return duplexCtor;
}

interface SessionEmitter {
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: () => void): void;
  once(event: 'connect', listener: () => void): void;
  emit(event: 'error', error: Error): boolean;
  emit(event: 'close'): boolean;
  removeAllListeners(): void;
}

function loadEmitter(): SessionEmitter {
  const events = builtinModule()?.('node:events') as
    { EventEmitter?: new () => SessionEmitter } | undefined;
  if (!events?.EventEmitter) throw new Error('node:events is unavailable');
  return new events.EventEmitter();
}

/** Socket `close()` can drop while it is still handshaking. */
export interface LaneSocket {
  destroy(): void;
  ref(): void;
  unref(): void;
  localPort: number;
}

/**
 * HTTP/2 session owned by a lane thread.
 *
 * Dispatch talks to it the way it talks to a session on the main thread.
 * A buffered body is posted with the headers. A streamed body still crosses
 * as writes, and those wait for acknowledgement so a large upload applies
 * backpressure. Response slices are copied once: they alias the session's
 * read buffer, and moving that buffer detaches memory the session still reads.
 */
export interface LaneSession {
  closed: boolean;
  destroyed: boolean;
  request(
    headers: Record<string, HeaderValue | undefined>,
    options?: { endStream?: boolean },
  ): DuplexLike;
  /**
   * Open a stream and, when `body` is present, end it in the same turn the
   * headers are sent. `undefined` ends the stream with no body.
   */
  requestWithBody(
    headers: Record<string, HeaderValue | undefined>,
    body: Uint8Array | undefined,
  ): DuplexLike;
  ping(callback: (error: Error | null) => void): boolean;
  close(): void;
  destroy(): void;
  unref(): void;
  setTimeout(ms: number, callback?: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: () => void): void;
  once(event: 'connect', listener: () => void): void;
}

export interface OpenedLane {
  session: LaneSession;
  socket: LaneSocket;
}

interface DialOptions {
  host: string;
  port: number;
  origin: string;
  servername: string | undefined;
  rejectUnauthorized: boolean;
  timeoutMs: number;
}

interface OpenStream {
  id: number;
  writes: Array<(error?: Error | null) => void>;
  fail(error: Error): void;
  finishClean(): void;
  onResponse(message: ResponseMessage): void;
  onData(message: DataMessage): void;
  onClose(): void;
  onWrote(): void;
}

let enabled = true;
let broken = false;
let readyView: Int32Array | undefined;
let nextSlot = 0;

/** One flag per thread. Created on Node only; some runtimes have no shared memory. */
function laneReadyView(): Int32Array | undefined {
  if (readyView) return readyView;
  if (typeof SharedArrayBuffer !== 'function') return undefined;
  try {
    readyView = new Int32Array(new SharedArrayBuffer(64 * 4));
  } catch {
    return undefined;
  }
  return readyView;
}
let dialWatch: string[] | undefined;
const handshakeThreads = new Set<number>();
const freeThreads: LaneThread[] = [];
const booting: LaneThread[] = [];
const liveThreads: LaneThread[] = [];

/**
 * Record each dial as it is posted.
 *
 * The post is synchronous, so a caller can assert that every lane started
 * before the constructor returned. Production never sets this.
 */
export function watchLaneDials(dials: string[]): () => void {
  dialWatch = dials;
  return () => {
    if (dialWatch === dials) dialWatch = undefined;
  };
}

/** Threads that have completed a lane handshake. Empty when lanes run in-process. */
export function laneHandshakeThreads(): readonly number[] {
  return [...handshakeThreads];
}

/**
 * Turn lane threads on or off for the next dial.
 *
 * The in-process handshake remains for runtimes that cannot start a thread
 * and for tests of that path. A burst on Node leaves this on.
 */
export function useLaneThreads(on: boolean): void {
  enabled = on;
}

/**
 * A buffer this message can take.
 *
 * A view that covers its whole `ArrayBuffer` is moved to the lane thread.
 * Anything else is a slice of a buffer something else still reads — the
 * session pool, or a caller — so those bytes are copied first.
 */
function exclusiveBytes(chunk: Uint8Array): Uint8Array {
  if (
    chunk.byteOffset === 0 &&
    chunk.byteLength === chunk.buffer.byteLength &&
    chunk.buffer instanceof ArrayBuffer
  ) {
    return chunk;
  }
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy;
}

class LaneThread {
  readonly worker: LaneWorker;
  readonly slot: number;
  private gen = 0;
  private listed = false;
  private hung = false;
  private dead = false;
  private claimed = false;
  private reffed = false;
  private dialHeld = false;
  private streamCount = 0;
  private nextId = 1;
  private localPort = 0;
  private resolveDial: ((opened: OpenedLane) => void) | undefined;
  private rejectDial: ((error: Error) => void) | undefined;
  private readonly streams = new Map<number, OpenStream>();
  private readonly pings = new Map<number, (error: Error | null) => void>();
  private readonly socket: LaneSocket;
  private session: LaneBound | undefined;

  constructor() {
    const builtin = builtinModule();
    const workerThreads = builtin?.('node:worker_threads') as
      { Worker?: WorkerConstructor } | undefined;
    if (!workerThreads?.Worker) throw new Error('worker_threads is unavailable');
    this.slot = nextSlot;
    nextSlot += 1;
    const view = laneReadyView();
    this.worker = new workerThreads.Worker(LANE_SOURCE, {
      eval: true,
      execArgv: [],
      env: workerEnv(),
      ...(view !== undefined && this.slot < view.length
        ? { workerData: { ready: view.buffer as SharedArrayBuffer, slot: this.slot } }
        : {}),
    });
    this.socket = {
      localPort: 0,
      destroy: () => this.drop(),
      ref: () => this.holdDial(),
      unref: () => this.releaseDial(),
    };
    this.worker.on('message', (message) => this.onMessage(message));
    this.worker.on('error', (error) => this.onDead(error));
    this.worker.on('exit', (code) => {
      if (code !== 0) this.onDead(handshakeError('HTTP/2 lane stopped'));
    });
    // Listeners can re-arm the worker's ref. Drop it after they are attached.
    // libuv's flag is not a counter — `retouch` turns it on only while a dial
    // or a request is outstanding, so an idle lane does not hold the process.
    this.worker.unref();
  }

  claimBoot(): void {
    this.claimed = true;
  }

  primeFree(): void {
    if (!this.reffed) this.worker.unref();
    const index = booting.indexOf(this);
    if (index >= 0) booting.splice(index, 1);
    if (this.claimed || this.dead || this.listed) return;
    this.listed = true;
    freeThreads.push(this);
  }

  /**
   * Start the handshake. The socket is handed back before this returns so
   * `close()` during the handshake can still drop it.
   */
  dial(options: DialOptions, onSocket: (socket: LaneSocket) => void): Promise<OpenedLane> {
    this.listed = false;
    this.hung = false;
    this.gen += 1;
    const gen = this.gen;
    this.holdDial();
    dialWatch?.push(options.host);
    onSocket(this.socket);
    return new Promise((resolve, reject) => {
      this.resolveDial = resolve;
      this.rejectDial = reject;
      this.post({
        t: 'dial',
        gen,
        host: options.host,
        port: options.port,
        origin: options.origin,
        servername: options.servername ?? '',
        rejectUnauthorized: options.rejectUnauthorized,
        timeoutMs: options.timeoutMs,
      });
    });
  }

  private post(message: object, transfer?: ArrayBuffer[]): void {
    if (this.dead) return;
    try {
      this.worker.postMessage(message, transfer);
    } catch {
      this.onDead(handshakeError('HTTP/2 lane stopped'));
    }
  }

  private holdDial(): void {
    if (this.dialHeld) return;
    this.dialHeld = true;
    this.retouch();
  }

  private releaseDial(): void {
    if (!this.dialHeld) return;
    this.dialHeld = false;
    this.retouch();
  }

  private retouch(): void {
    const need = this.dialHeld || this.streamCount > 0;
    if (need && !this.reffed) {
      this.reffed = true;
      this.worker.ref();
      return;
    }
    if (!need && this.reffed) {
      this.reffed = false;
      this.worker.unref();
    }
  }

  private drop(): void {
    if (this.session && !this.session.destroyed) {
      this.session.destroy();
      return;
    }
    this.hangup();
  }

  hangup(): void {
    if (this.hung) return;
    this.hung = true;
    this.failDial(handshakeError('HTTP/2 connect closed'));
    // A live request must not carry the handshake marker: that marker is what
    // makes dispatch replay the call, and a POST is not safe to send twice.
    const error = Object.assign(new Error('HTTP/2 session closed'), { code: 'ERR_HTTP2' });
    for (const stream of this.streams.values()) stream.fail(error);
    this.streams.clear();
    for (const callback of this.pings.values()) callback(error);
    this.pings.clear();
    this.streamCount = 0;
    this.releaseDial();
    this.retouch();
    this.post({ t: 'hangup', gen: this.gen });
  }

  private failDial(error: Error): void {
    const reject = this.rejectDial;
    if (!reject) return;
    this.resolveDial = undefined;
    this.rejectDial = undefined;
    reject(error);
  }

  private onDead(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    const message = error.message || 'HTTP/2 lane stopped';
    this.failDial(handshakeError(message));
    const streamErr = Object.assign(new Error(message), { code: 'ERR_HTTP2' });
    for (const stream of this.streams.values()) stream.fail(streamErr);
    this.streams.clear();
    this.session?.markDown(streamErr);
    this.releaseDial();
    this.streamCount = 0;
    this.retouch();
    const index = liveThreads.indexOf(this);
    if (index >= 0) liveThreads.splice(index, 1);
    const bootingAt = booting.indexOf(this);
    if (bootingAt >= 0) booting.splice(bootingAt, 1);
    const freeAt = freeThreads.indexOf(this);
    if (freeAt >= 0) freeThreads.splice(freeAt, 1);
    this.listed = true;
    if (this.gen === 0 && liveThreads.length === 0) broken = true;
  }

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null || !('t' in message)) return;
    const msg = message as { t?: unknown };
    if (msg.t === 'primed') {
      this.primeFree();
      return;
    }
    if (msg.t === 'boot-fail') {
      this.onDead(handshakeError('HTTP/2 lane failed to start'));
      return;
    }
    const inbound = message as { t: string; gen?: unknown };
    if (typeof inbound.gen !== 'number' || inbound.gen !== this.gen) return;
    switch (inbound.t) {
      case 'up':
        this.onUp(message as unknown as UpMessage);
        return;
      case 'fail':
        this.onFail(message as unknown as FailMessage);
        return;
      case 'idle':
        this.onIdle();
        return;
      case 'down':
        this.onDown(message as unknown as FailMessage);
        return;
      case 'response':
        this.streams
          .get((message as unknown as StreamMessage).id)
          ?.onResponse(message as unknown as ResponseMessage);
        return;
      case 'data':
        this.streams
          .get((message as unknown as StreamMessage).id)
          ?.onData(message as unknown as DataMessage);
        return;
      case 'end':
        this.streams.get((message as unknown as StreamMessage).id)?.finishClean();
        return;
      case 'error':
        this.streams
          .get((message as unknown as StreamMessage).id)
          ?.fail(streamError(message as unknown as FailMessage & { id: number }));
        return;
      case 'close':
        this.streams.get((message as unknown as StreamMessage).id)?.onClose();
        return;
      case 'wrote':
        this.streams.get((message as unknown as StreamMessage).id)?.onWrote();
        return;
      case 'pong':
        this.onPong(message as unknown as PongMessage);
        return;
      default:
        return;
    }
  }

  private onUp(message: UpMessage): void {
    const resolve = this.resolveDial;
    if (!resolve) return;
    this.resolveDial = undefined;
    this.rejectDial = undefined;
    this.localPort = message.localPort;
    this.socket.localPort = message.localPort;
    handshakeThreads.add(message.threadId);
    const trace = benchTrace();
    trace?.tls.push({
      t0: message.tDial,
      tTcp: message.tTcp,
      tSecure: message.tSecure,
      localPort: message.localPort,
      remote: message.remote,
      alpn: message.alpn,
      protocol: message.protocol,
      reused: message.reused,
    });
    this.session = new LaneBound(this, this.socket, loadEmitter());
    // The handshake hold ends here. A request that follows in this turn
    // takes its own hold; silenceHandle's unref is the same release again.
    this.releaseDial();
    resolve({ session: this.session, socket: this.socket });
  }

  private onFail(message: FailMessage): void {
    this.releaseDial();
    this.failDial(handshakeError(message.message || 'HTTP/2 connect failed', message.code));
  }

  private onIdle(): void {
    this.session = undefined;
    this.hung = false;
    this.releaseDial();
    if (this.dead || this.listed) return;
    this.listed = true;
    freeThreads.push(this);
  }

  private onDown(message: FailMessage): void {
    const error = Object.assign(new Error(message.message || 'HTTP/2 session closed'), {
      code: message.code || 'ERR_HTTP2',
    });
    for (const stream of this.streams.values()) stream.fail(error);
    this.streams.clear();
    this.streamCount = 0;
    this.retouch();
    this.session?.markDown(error);
  }

  private onPong(message: PongMessage): void {
    const callback = this.pings.get(message.id);
    if (!callback) return;
    this.pings.delete(message.id);
    callback(message.error ? new Error(message.error) : null);
  }

  openStream(
    headers: Record<string, HeaderValue | undefined>,
    endStream: boolean,
    body?: Uint8Array,
  ): DuplexLike {
    const id = this.nextId;
    this.nextId += 1;
    this.streamCount += 1;
    this.retouch();
    const trace = this.traceFor(headers);
    const writes: Array<(error?: Error | null) => void> = [];
    let held = false;
    let clean = false;
    let readableDone = false;
    let settled = false;
    const Duplex = loadDuplex();
    const stream = new Duplex({
      allowHalfOpen: true,
      read: () => {
        if (!held) return;
        held = false;
        this.post({ t: 'resume', gen: this.gen, id });
      },
      write: (chunk: Uint8Array, _encoding: string, cb: (error?: Error | null) => void) => {
        if (settled) {
          cb();
          return;
        }
        // Copy before the acknowledgement. The caller may reuse this buffer
        // once `cb` runs, and the chunk is often a slice of a shared one.
        const copy = new Uint8Array(chunk.byteLength);
        copy.set(chunk);
        writes.push(cb);
        this.post({ t: 'write', gen: this.gen, id, chunk: copy }, [copy.buffer]);
      },
      final: (cb: (error?: Error | null) => void) => {
        if (!endStream) this.post({ t: 'finish', gen: this.gen, id });
        cb();
      },
      destroy: (error: Error | null, cb: (error?: Error | null) => void) => {
        if (!clean) this.post({ t: 'cancel', gen: this.gen, id });
        const waiting = writes.splice(0);
        for (const write of waiting) write();
        cb(error);
      },
    });
    const opened: OpenStream = {
      id,
      writes,
      fail: (error: Error) => {
        if (settled) return;
        settled = true;
        this.streams.delete(id);
        this.streamCount = Math.max(0, this.streamCount - 1);
        this.retouch();
        const waiting = writes.splice(0);
        for (const write of waiting) write();
        if (!stream.destroyed) stream.destroy(error);
      },
      finishClean: () => {
        if (settled || readableDone) return;
        readableDone = true;
        clean = true;
        if (!stream.destroyed) stream.push(null);
      },
      onResponse: () => undefined,
      onData: () => undefined,
      onClose: () => undefined,
      onWrote: () => undefined,
    };
    opened.onResponse = (message: ResponseMessage) => {
      if (trace) {
        trace.tHeaders = epochMs();
        trace.status = Number(message.headers[':status'] ?? 0);
        trace.localPort = this.localPort;
      }
      stream.emit('response', message.headers);
    };
    opened.onData = (message: DataMessage) => {
      if (settled) return;
      if (trace) {
        trace.bytes += message.chunk.byteLength;
        if (trace.body.length < 8000) {
          trace.body += new TextDecoder().decode(message.chunk);
        }
      }
      const ok = stream.push(message.chunk);
      if (!ok && !held) {
        held = true;
        this.post({ t: 'pause', gen: this.gen, id });
      }
    };
    opened.onWrote = () => {
      const cb = writes.shift();
      cb?.();
    };
    opened.onClose = () => {
      if (this.streams.delete(id)) {
        this.streamCount = Math.max(0, this.streamCount - 1);
        this.retouch();
      }
      if (trace && trace.tEnd === 0) trace.tEnd = epochMs();
      if (settled) return;
      settled = true;
      clean = true;
      if (!stream.destroyed) {
        if (!readableDone) {
          readableDone = true;
          stream.push(null);
        }
        stream.destroy();
      }
    };
    // `close` is HTTP/2's cancel. Duplex has no such method; dispatch calls it
    // with the cancel code before destroy.
    (stream as DuplexLike).close = (code?: number) => {
      this.post({ t: 'cancel', gen: this.gen, id, code });
    };
    this.streams.set(id, opened);
    const wireHeaders: Record<string, HeaderValue> = {};
    for (const key of Object.keys(headers)) {
      const value = headers[key];
      if (value !== undefined) wireHeaders[key] = value;
    }
    const carried = body !== undefined && body.byteLength > 0 ? exclusiveBytes(body) : undefined;
    if (carried !== undefined) {
      // Headers and body in one message. The thread calls request() and end()
      // before it handles anything else, so END_STREAM is not gated on a
      // write acknowledgement coming back to this thread.
      this.post(
        { t: 'request', gen: this.gen, id, headers: wireHeaders, endStream: false, body: carried },
        [carried.buffer as ArrayBuffer],
      );
    } else {
      this.post({ t: 'request', gen: this.gen, id, headers: wireHeaders, endStream });
      if (endStream) stream.end();
    }
    return stream;
  }

  ping(callback: (error: Error | null) => void): boolean {
    if (this.dead || !this.session || this.session.destroyed) {
      callback(new Error('session closed'));
      return false;
    }
    const id = this.nextId;
    this.nextId += 1;
    this.pings.set(id, callback);
    this.post({ t: 'ping', gen: this.gen, id });
    return true;
  }

  setTimeout(ms: number): void {
    this.post({ t: 'timeout', gen: this.gen, ms });
  }

  unrefSession(): void {
    this.releaseDial();
  }

  private traceFor(headers: Record<string, HeaderValue | undefined>): StreamRecord | undefined {
    const trace = benchTrace();
    if (!trace) return undefined;
    const record: StreamRecord = {
      method: String(headers[':method'] ?? ''),
      path: String(headers[':path'] ?? ''),
      tReq: epochMs(),
      tHeaders: 0,
      tEnd: 0,
      status: 0,
      bytes: 0,
      localPort: this.localPort,
      inflight: trace.streams.filter((entry) => entry.tReq && !entry.tHeaders).length,
      body: '',
    };
    trace.streams.push(record);
    return record;
  }
}

interface UpMessage {
  tDial: number;
  tTcp: number;
  tSecure: number;
  localPort: number;
  remote: string;
  alpn: string;
  protocol: string;
  reused: boolean;
  threadId: number;
}

interface FailMessage {
  message?: string;
  code?: string;
}

interface StreamMessage {
  id: number;
}

interface ResponseMessage extends StreamMessage {
  headers: Record<string, HeaderValue>;
}

interface DataMessage extends StreamMessage {
  chunk: Uint8Array;
}

interface PongMessage {
  id: number;
  error?: string;
}

function streamError(message: FailMessage): Error {
  return Object.assign(new Error(message.message || 'HTTP/2 stream failed'), {
    code: message.code || 'ERR_HTTP2',
  });
}

class LaneBound implements LaneSession {
  closed = false;
  destroyed = false;
  private readonly events: SessionEmitter;

  constructor(
    private readonly thread: LaneThread,
    readonly socket: LaneSocket,
    events: SessionEmitter,
  ) {
    this.events = events;
  }

  request(
    headers: Record<string, HeaderValue | undefined>,
    options?: { endStream?: boolean },
  ): DuplexLike {
    return this.thread.openStream(headers, options?.endStream === true);
  }

  requestWithBody(
    headers: Record<string, HeaderValue | undefined>,
    body: Uint8Array | undefined,
  ): DuplexLike {
    const endStream = body === undefined || body.byteLength === 0;
    return this.thread.openStream(headers, endStream, body);
  }

  ping(callback: (error: Error | null) => void): boolean {
    return this.thread.ping(callback);
  }

  close(): void {
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    this.events.emit('close');
    this.events.removeAllListeners();
    this.thread.hangup();
  }

  /** Session died in the thread. Dispatch's error listener drops the lane. */
  markDown(error: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    this.events.emit('error', error);
    this.events.emit('close');
    this.events.removeAllListeners();
  }

  unref(): void {
    this.thread.unrefSession();
  }

  setTimeout(ms: number): void {
    this.thread.setTimeout(ms);
  }

  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'close', listener: () => void): void;
  once(event: 'connect', listener: () => void): void;
  once(
    event: 'error' | 'close' | 'connect',
    listener: ((error: Error) => void) | (() => void),
  ): void {
    if (event === 'error') {
      this.events.once('error', listener as (error: Error) => void);
      return;
    }
    if (event === 'close') {
      this.events.once('close', listener as () => void);
      return;
    }
    this.events.once('connect', listener as () => void);
  }
}

function spawn(claimed: boolean): LaneThread | undefined {
  if (broken || liveThreads.length >= MAX_THREADS) return undefined;
  try {
    const thread = new LaneThread();
    liveThreads.push(thread);
    if (claimed) thread.claimBoot();
    else booting.push(thread);
    return thread;
  } catch {
    broken = true;
    return undefined;
  }
}

function acquire(): LaneThread | undefined {
  if (!enabled || broken || !isNodeProcess()) return undefined;
  const ready = freeThreads.pop();
  if (ready) {
    ready.claimBoot();
    return ready;
  }
  const starting = booting.pop();
  if (starting) {
    starting.claimBoot();
    return starting;
  }
  return spawn(true);
}

/**
 * Block until every lane thread has finished its one-time TLS init.
 *
 * The threads are already running. This waits out whatever is left after the
 * main thread's own init, so a request made as soon as the module finishes
 * loading finds them ready instead of queueing behind thread startup.
 */
export function waitForLaneThreads(): void {
  const view = readyView;
  if (!view) return;
  const deadline = Date.now() + 2_000;
  for (const thread of liveThreads) {
    if (thread.slot >= view.length) continue;
    if (Atomics.load(view, thread.slot) === 1) continue;
    const left = deadline - Date.now();
    if (left <= 0) return;
    try {
      Atomics.wait(view, thread.slot, 0, left);
    } catch {
      return;
    }
  }
}

function warm(): void {
  if (!isNodeProcess()) return;
  for (let i = 0; i < PREWARM; i += 1) {
    if (!spawn(false)) return;
  }
}

/**
 * Dial one lane on its own thread.
 *
 * Returns undefined when threads are off or cannot be started; the caller
 * handshakes on the main thread in that case. `onSocket` runs before this
 * returns, while the handshake is still in flight.
 */
export function dialLane(
  options: DialOptions,
  onSocket: (socket: LaneSocket) => void,
): Promise<OpenedLane> | undefined {
  const thread = acquire();
  if (!thread) return undefined;
  return thread.dial(options, onSocket);
}

warm();
