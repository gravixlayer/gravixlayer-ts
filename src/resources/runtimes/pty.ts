/**
 * Interactive pseudo-terminal sessions.
 *
 * A PTY session runs a real shell inside the runtime, so programs that expect
 * a terminal — REPLs, `top`, editors, anything that prompts — behave normally.
 * Output arrives over a server-sent event stream; input, resize, and signals
 * are separate requests against the same session.
 */

import { concatBytes, fromBase64, toBase64, utf8Decode } from '../../core/binary.js';
import { GravixLayerInvalidArgumentError, GravixLayerTimeoutError } from '../../core/errors.js';
import { asRecord, bool, num, parseList, str } from '../../core/parse.js';
import { iterSSEJson } from '../../core/sse.js';
import { sleep } from '../../core/time.js';
import type { RequestOptions } from '../../core/transport.js';
import { pathSegment, SERVICES } from '../../core/url.js';
import { assertNonEmpty, assertPositiveInt, assertRuntimeId } from '../../core/validate.js';
import { parsePtySession, type PtyInputResponse, type PtySession } from '../../types/runtime.js';
import { APIResource } from '../resource.js';

/** How often a detached handle polls for the session's final state. */
const POLL_INTERVAL_MS = 500;

/** Lifecycle state of a session whose shell is still up. */
const PTY_STATUS_RUNNING = 'running';

/** Lifecycle state of a session whose shell has terminated. */
const PTY_STATUS_EXITED = 'exited';

/** Bytes of terminal output a handle retains. Older output is discarded. */
export const PTY_BUFFER_LIMIT_BYTES = 1_048_576;

/** Options for {@link RuntimePty.create}. */
export interface CreatePtyOptions extends RequestOptions {
  /** Shell to launch. Defaults to `/bin/bash`. */
  shell?: string;
  /** Arguments passed to the shell. */
  args?: string[];
  /** Starting directory. */
  workingDir?: string;
  /** Environment variables for the session. */
  environment?: Record<string, string>;
  /** Terminal width in columns. Defaults to 80. */
  cols?: number;
  /** Terminal height in rows. Defaults to 24. */
  rows?: number;
}

/** An event from a PTY output stream. */
export type PtyStreamEvent =
  | { type: 'data'; data: Uint8Array }
  | { type: 'exit'; exitCode: number; status: string }
  | { type: 'error'; message: string };

/** Split request options away from operation-specific fields. */
function requestOptions(options: RequestOptions): RequestOptions {
  const out: RequestOptions = {};
  if (options.signal) out.signal = options.signal;
  if (options.timeout !== undefined) out.timeout = options.timeout;
  if (options.maxRetries !== undefined) out.maxRetries = options.maxRetries;
  if (options.headers) out.headers = options.headers;
  return out;
}

/**
 * Encode terminal input.
 *
 * A string is sent as-is; raw bytes are base64-encoded so control sequences
 * and non-UTF-8 data survive the JSON round trip intact.
 */
function inputPayload(data: string | Uint8Array): Record<string, string> {
  if (typeof data === 'string') return { data };
  if (data instanceof Uint8Array) return { data_base64: toBase64(data) };
  throw new GravixLayerInvalidArgumentError('PTY input must be a string or a Uint8Array.');
}

/** Create, drive, and observe terminal sessions in a runtime. */
export class RuntimePty extends APIResource {
  /** Start a new terminal session. */
  async create(runtimeId: string, options: CreatePtyOptions = {}): Promise<PtySession> {
    assertRuntimeId(runtimeId);

    const body: Record<string, unknown> = {};
    if (options.shell !== undefined) body['shell'] = options.shell;
    if (options.args !== undefined) body['args'] = options.args;
    if (options.workingDir !== undefined) body['working_dir'] = options.workingDir;
    if (options.environment !== undefined) body['environment'] = options.environment;
    if (options.cols !== undefined) body['cols'] = assertPositiveInt(options.cols, 'cols');
    if (options.rows !== undefined) body['rows'] = assertPositiveInt(options.rows, 'rows');

    return parsePtySession(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/pty`,
          service: SERVICES.agents,
          body,
          options: requestOptions(options),
        }),
      ),
    );
  }

  /** List the runtime's terminal sessions. */
  async list(runtimeId: string, options: RequestOptions = {}): Promise<PtySession[]> {
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/pty`,
        service: SERVICES.agents,
        options,
      }),
    );
    return parseList(data, 'sessions', parsePtySession);
  }

  /** Fetch one session's current state. */
  async get(
    runtimeId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<PtySession> {
    assertRuntimeId(runtimeId);
    const session = pathSegment(sessionId, 'sessionId');

    return parsePtySession(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `runtime/${runtimeId}/pty/${session}`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /**
   * Send input to the terminal, exactly as if it had been typed.
   *
   * Include a trailing `\n` to submit a command.
   */
  async sendInput(
    runtimeId: string,
    sessionId: string,
    data: string | Uint8Array,
    options: RequestOptions = {},
  ): Promise<PtyInputResponse> {
    assertRuntimeId(runtimeId);
    const session = pathSegment(sessionId, 'sessionId');

    const body = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/pty/${session}/input`,
        service: SERVICES.agents,
        body: inputPayload(data),
        options,
      }),
    );

    return {
      success: bool(body, 'success', true),
      bytesWritten: num(body, 'bytes_written'),
    };
  }

  /**
   * Resize the terminal.
   *
   * Programs that redraw based on terminal size read the new dimensions after
   * this, so call it when the surrounding UI changes.
   */
  async resize(
    runtimeId: string,
    sessionId: string,
    cols: number,
    rows: number,
    options: RequestOptions = {},
  ): Promise<boolean> {
    assertRuntimeId(runtimeId);
    const session = pathSegment(sessionId, 'sessionId');
    assertPositiveInt(cols, 'cols');
    assertPositiveInt(rows, 'rows');

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/pty/${session}/resize`,
        service: SERVICES.agents,
        body: { cols, rows },
        options,
      }),
    );
    return bool(data, 'success', true);
  }

  /**
   * Send a signal to the foreground process.
   *
   * Accepts `INT`, `TERM`, `KILL`, and `HUP`, with or without a `SIG` prefix.
   * `INT` is the equivalent of pressing Ctrl-C.
   */
  async sendSignal(
    runtimeId: string,
    sessionId: string,
    signal: string,
    options: RequestOptions = {},
  ): Promise<boolean> {
    assertRuntimeId(runtimeId);
    const session = pathSegment(sessionId, 'sessionId');
    assertNonEmpty(signal, 'signal');

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/pty/${session}/signal`,
        service: SERVICES.agents,
        body: { signal: signal.trim() },
        options,
      }),
    );
    return bool(data, 'success', true);
  }

  /** Terminate a session and the shell running in it. */
  async kill(runtimeId: string, sessionId: string, options: RequestOptions = {}): Promise<boolean> {
    assertRuntimeId(runtimeId);
    const session = pathSegment(sessionId, 'sessionId');

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: `runtime/${runtimeId}/pty/${session}`,
        service: SERVICES.agents,
        options,
      }),
    );
    return bool(data, 'success', true);
  }

  /**
   * Stream terminal output.
   *
   * Yields decoded byte chunks as the shell produces them, then a final `exit`
   * event. Terminal output is not guaranteed to split on character boundaries,
   * so decode across chunks rather than one at a time.
   *
   * @example
   * ```ts
   * for await (const event of client.runtimes.pty.stream(id, sessionId)) {
   *   if (event.type === 'data') process.stdout.write(event.data);
   *   if (event.type === 'exit') break;
   * }
   * ```
   */
  async *stream(
    runtimeId: string,
    sessionId: string,
    options: RequestOptions = {},
  ): AsyncGenerator<PtyStreamEvent, void, undefined> {
    assertRuntimeId(runtimeId);
    const session = pathSegment(sessionId, 'sessionId');

    const stream = await this.http.requestStream({
      method: 'GET',
      path: `runtime/${runtimeId}/pty/${session}/stream`,
      service: SERVICES.agents,
      options,
    });

    for await (const payload of iterSSEJson<Record<string, unknown>>(stream)) {
      const record = asRecord(payload);
      const type = str(record, 'type');

      if (type === 'data') {
        yield { type: 'data', data: fromBase64(str(record, 'data')) };
      } else if (type === 'exit') {
        yield { type: 'exit', exitCode: num(record, 'exit_code'), status: str(record, 'status') };
        return;
      } else if (type === 'error') {
        yield { type: 'error', message: str(record, 'message') };
        return;
      }
    }
  }

  /**
   * Get a stateful handle for a session.
   *
   * The handle buffers output, tracks the exit code, and offers `waitForExit`,
   * which is easier than driving the raw stream when you only want the result.
   */
  handle(runtimeId: string, sessionId: string): PtyHandle {
    assertRuntimeId(runtimeId);
    assertNonEmpty(sessionId, 'sessionId');
    return new PtyHandle(this, runtimeId, sessionId);
  }
}

/** Callbacks accepted by {@link PtyHandle.connect}. */
export interface PtyHandleCallbacks {
  /** Invoked for each chunk of terminal output. */
  onData?: (data: Uint8Array) => void;
  /** Invoked once when the shell exits. */
  onExit?: (exitCode: number, status: string) => void;
  /** Invoked when the stream reports an error. */
  onError?: (message: string) => void;
}

/**
 * A connected view of one terminal session.
 *
 * Attaching starts consuming the output stream in the background and keeps a
 * bounded buffer of what has been produced, so you can inspect output at the
 * end without wiring up your own accumulation.
 */
export class PtyHandle {
  private buffer: Uint8Array[] = [];
  private bufferedBytes = 0;
  private connected = false;
  private abort: AbortController | undefined;
  private pump: Promise<void> | undefined;
  private exit: { exitCode: number; status: string } | undefined;
  private streamError: string | undefined;
  private waiters = new Set<() => void>();

  constructor(
    private readonly pty: RuntimePty,
    readonly runtimeId: string,
    readonly sessionId: string,
  ) {}

  /** Whether the output stream is currently attached. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Exit status once the shell has finished, otherwise `undefined`. */
  get exitCode(): number | undefined {
    return this.exit?.exitCode;
  }

  /** Error reported by the stream, if any. */
  get error(): string | undefined {
    return this.streamError;
  }

  /** Buffered terminal output as raw bytes. */
  get output(): Uint8Array {
    return concatBytes(this.buffer);
  }

  /** Buffered terminal output decoded as UTF-8 text. */
  get text(): string {
    return utf8Decode(this.output);
  }

  /** Attach to the output stream. Returns immediately; reading runs in the background. */
  connect(callbacks: PtyHandleCallbacks = {}): this {
    if (this.connected) return this;

    this.connected = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;

    this.pump = (async () => {
      try {
        for await (const event of this.pty.stream(this.runtimeId, this.sessionId, { signal })) {
          if (event.type === 'data') {
            this.append(event.data);
            callbacks.onData?.(event.data);
          } else if (event.type === 'exit') {
            this.exit = { exitCode: event.exitCode, status: event.status };
            callbacks.onExit?.(event.exitCode, event.status);
            this.wake();
          } else {
            this.streamError = event.message;
            callbacks.onError?.(event.message);
          }
        }
      } catch (error) {
        // Disconnecting aborts the stream; that is expected, not a failure.
        if (!signal.aborted) {
          this.streamError = error instanceof Error ? error.message : String(error);
          callbacks.onError?.(this.streamError);
        }
      } finally {
        this.connected = false;
        // A dropped stream hands the wait back to polling straight away.
        this.wake();
      }
    })();

    return this;
  }

  /** Detach from the stream. The session keeps running and can be re-attached. */
  async disconnect(): Promise<void> {
    this.abort?.abort();
    this.abort = undefined;
    await this.pump?.catch(() => undefined);
    this.pump = undefined;
    this.connected = false;
  }

  /** Send input to the terminal. */
  sendInput(data: string | Uint8Array): Promise<PtyInputResponse> {
    return this.pty.sendInput(this.runtimeId, this.sessionId, data);
  }

  /** Resize the terminal. */
  resize(cols: number, rows: number): Promise<boolean> {
    return this.pty.resize(this.runtimeId, this.sessionId, cols, rows);
  }

  /** Signal the foreground process. */
  sendSignal(signal: string): Promise<boolean> {
    return this.pty.sendSignal(this.runtimeId, this.sessionId, signal);
  }

  /** Fetch the session's current state from the API. */
  refresh(): Promise<PtySession> {
    return this.pty.get(this.runtimeId, this.sessionId);
  }

  /** Terminate the session and detach. */
  async kill(): Promise<boolean> {
    const result = await this.pty.kill(this.runtimeId, this.sessionId);
    await this.disconnect();
    return result;
  }

  /**
   * Wait for the shell to exit and return the session's final state.
   *
   * Works whether or not the handle is attached. An attached handle reacts the
   * moment the exit frame arrives and issues no requests while it waits; a
   * detached one falls back to polling.
   *
   * @param timeoutMs give up after this long. Defaults to no limit.
   */
  async waitForExit(timeoutMs?: number): Promise<PtySession> {
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

    for (;;) {
      const exit = this.exit;
      if (exit) {
        // The stream reported the outcome, so report it even if the control
        // plane has not caught up with the session's lifecycle state yet.
        return { ...(await this.refresh()), status: PTY_STATUS_EXITED, exitCode: exit.exitCode };
      }

      // An attached stream delivers the exit frame, so polling as well would be
      // pure overhead. If the stream drops, this turns false and polling
      // takes over.
      if (!this.connected) {
        const session = await this.refresh();
        if (session.status !== PTY_STATUS_RUNNING) return session;
      }

      if (deadline !== undefined && Date.now() >= deadline) {
        throw new GravixLayerTimeoutError(
          `Terminal session ${this.sessionId} was still running after ${timeoutMs}ms.`,
        );
      }

      const remaining = deadline === undefined ? POLL_INTERVAL_MS : deadline - Date.now();
      await this.settle(Math.min(POLL_INTERVAL_MS, Math.max(0, remaining)));
    }
  }

  /**
   * Pause between checks, returning early if the stream reports something.
   *
   * An attached handle learns the outcome the instant the exit frame lands, so
   * waiting out the full interval would only add latency.
   */
  private async settle(ms: number): Promise<void> {
    let notify!: () => void;
    const woken = new Promise<void>((resolve) => {
      notify = resolve;
      this.waiters.add(notify);
    });

    // The timer is cancelled once the race is decided, so an early wake never
    // leaves a pending timer holding the process open.
    const cancel = new AbortController();
    try {
      await Promise.race([woken, sleep(ms, cancel.signal).catch(() => undefined)]);
    } finally {
      cancel.abort();
      this.waiters.delete(notify);
    }
  }

  /** Release anything waiting on the stream. */
  private wake(): void {
    for (const notify of this.waiters) notify();
    this.waiters.clear();
  }

  /** Append output while keeping the buffer under its size limit. */
  private append(chunk: Uint8Array): void {
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.length;

    while (this.bufferedBytes > PTY_BUFFER_LIMIT_BYTES && this.buffer.length > 1) {
      const dropped = this.buffer.shift();
      this.bufferedBytes -= dropped?.length ?? 0;
    }
  }
}
