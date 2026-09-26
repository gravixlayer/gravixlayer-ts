/**
 * Runtimes: isolated virtual machines that start in milliseconds and run
 * whatever you give them.
 *
 * This is the largest surface in the SDK. Lifecycle, code and command
 * execution, and code contexts live here directly; the filesystem, terminals,
 * git, and published ports live on the nested resources.
 */

import { GravixLayerConnectionError, GravixLayerInvalidArgumentError } from '../../core/errors.js';
import { asRecord, bool, num, optNum, optStr, parseList, str } from '../../core/parse.js';
import { monotonicMs } from '../../core/progress.js';
import { iterSSEJson } from '../../core/sse.js';
import { timeoutForGuestDeadline } from '../../core/time.js';
import type { RequestOptions } from '../../core/transport.js';
import { buildListEndpoint, pathSegment, SERVICES } from '../../core/url.js';
import { assertNonEmpty, assertPositiveInt, assertRuntimeId } from '../../core/validate.js';
import {
  parseCodeRunResponse,
  parseCommandInfo,
  parseCommandRunResponse,
  parseExecutionError,
  parseExecutionResult,
  parseRuntimeInfo,
  parseRuntimeMetrics,
  parseRuntimeTimeoutResponse,
  parseSSHInfo,
  parseSSHStatus,
  type CodeContext,
  type CodeContextDeleteResponse,
  type CodeRunResponse,
  type CommandInfo,
  type CommandRunResponse,
  type ExecutionError,
  type ExecutionLogs,
  type ExecutionResult,
  type RuntimeInfo,
  type RuntimeKillResponse,
  type RuntimeList,
  type RuntimeMetrics,
  type RuntimeTimeoutResponse,
  type SSHInfo,
  type SSHStatus,
} from '../../types/runtime.js';
import { parseTemplateInfo, type TemplateListResponse } from '../../types/templates.js';
import { APIResource, type ClientContext } from '../resource.js';
import { RuntimeFile } from './files.js';
import { RuntimeGit } from './git.js';
import { RuntimePty } from './pty.js';
import { Runtime } from './runtime.js';
import { RuntimeService } from './services.js';

/**
 * Restoring from a snapshot boots a full guest, which takes longer than the
 * default request budget allows.
 */
const SNAPSHOT_RESTORE_TIMEOUT_MS = 180_000;

/** Template used when none is given. */
const DEFAULT_TEMPLATE = 'base-small';

/** Options for {@link Runtimes.create}. */
export interface CreateRuntimeOptions extends RequestOptions {
  /** Template to boot from. Defaults to `base-small`. */
  template?: string;
  /**
   * Snapshot to restore instead of booting a template.
   *
   * Mutually exclusive with a non-default `template`.
   */
  snapshot?: string;
  /** Cloud to place the runtime on. Defaults to the client's cloud. */
  cloud?: string;
  /** Region to place the runtime in. Defaults to the client's region. */
  region?: string;
  /** Seconds before the runtime is automatically stopped. */
  timeoutSeconds?: number;
  /** Environment variables available to every process in the guest. */
  envVars?: Record<string, string>;
  /** Labels attached to the runtime, returned on every read. */
  metadata?: Record<string, unknown>;
  /** Whether the guest may reach the internet. Defaults to the account policy. */
  internetAccess?: boolean;
  /** Agent to associate the runtime with. */
  agentId?: string;
  /**
   * Secret providers to attach.
   *
   * Their secrets are injected into the guest environment at boot and are
   * never written to disk by the platform.
   */
  providers?: string[];
  /** Network policies to attach. The account default is always applied. */
  networkPolicyIds?: string[];
}

/** Options for {@link Runtimes.list}. */
export interface ListRuntimesOptions extends RequestOptions {
  /** Maximum number of runtimes to return. Defaults to 100. */
  limit?: number;
  /** Number of runtimes to skip. Defaults to 0. */
  offset?: number;
}

/** Callbacks that stream a command's output as it runs. */
export interface CommandCallbacks {
  /** Invoked with each chunk written to standard output. */
  onStdout?: (chunk: string) => void;
  /** Invoked with each chunk written to standard error. */
  onStderr?: (chunk: string) => void;
  /** Invoked once with the process exit status. */
  onExit?: (exitCode: number) => void;
}

/** Options for {@link CommandHandle.follow}. */
export interface CommandFollowOptions extends RequestOptions, CommandCallbacks {
  /** Invoked if following the output fails. The command itself keeps running. */
  onError?: (error: Error) => void;
}

/** Options for {@link Runtimes.runCmd}. `onError` applies with `background`. */
export interface RunCommandOptions extends CommandFollowOptions {
  /** Arguments appended to the command. */
  args?: string[];
  /** Directory to run in. Defaults to the guest's working directory. */
  workingDir?: string;
  /** Environment variables for this command only. */
  environment?: Record<string, string>;
  /**
   * Seconds before the command is killed. `0` uses the server default: 300
   * seconds in the foreground, and no deadline in the background.
   */
  timeoutSeconds?: number;
  /** Start the command and return as soon as it is running. */
  background?: boolean;
}

/** Callbacks that stream a code execution's output as it runs. */
export interface CodeCallbacks {
  /** Invoked with each chunk written to standard output. */
  onStdout?: (chunk: string) => void;
  /** Invoked with each chunk written to standard error. */
  onStderr?: (chunk: string) => void;
  /** Invoked with each rich result the code produces. */
  onResult?: (result: ExecutionResult) => void;
  /** Invoked if the code raises. */
  onError?: (error: ExecutionError) => void;
}

/** Options for {@link Runtimes.runCode}. */
export interface RunCodeOptions extends RequestOptions, CodeCallbacks {
  /** Language to execute. Defaults to `python`. */
  language?: string;
  /** Context to run in, which keeps variables alive between executions. */
  contextId?: string;
  /** Environment variables for this execution only. */
  environment?: Record<string, string>;
  /** Seconds before the execution is killed. */
  timeoutSeconds?: number;
}

/** An event from a streaming command execution. */
export type CommandStreamEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'end'; exitCode: number; durationMs?: number; timedOut?: boolean; error?: string }
  | { type: 'error'; message: string };

/** An event from a streaming code execution. */
export type CodeStreamEvent =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'result'; result: ExecutionResult }
  | { type: 'error'; error: ExecutionError }
  | { type: 'end' };

/** Options for {@link Runtimes.createContext}. */
export interface CreateContextOptions extends RequestOptions {
  /** Language of the interpreter. Defaults to `python`. */
  language?: string;
  /** Working directory of the interpreter. */
  cwd?: string;
}

/** Strip operation-specific fields, leaving only per-request transport options. */
function requestOptions(options: RequestOptions): RequestOptions {
  const out: RequestOptions = {};
  if (options.signal) out.signal = options.signal;
  if (options.timeout !== undefined) out.timeout = options.timeout;
  if (options.maxRetries !== undefined) out.maxRetries = options.maxRetries;
  if (options.headers) out.headers = options.headers;
  return out;
}

/** A command deadline may be zero. Zero is the server's default, not "invalid". */
function nonNegativeInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new GravixLayerInvalidArgumentError(`${label} must be a non-negative integer.`);
  }
  return value;
}

/**
 * Transport options for a guest command or code execution.
 *
 * When the caller sets a guest deadline but not an HTTP timeout, the request
 * is kept open for that deadline plus a round-trip margin so the transport
 * cannot kill a command the server is still running.
 */
function executionOptions(options: RequestOptions & { timeoutSeconds?: number }): RequestOptions {
  const out = requestOptions(options);
  const timeout = timeoutForGuestDeadline(options.timeoutSeconds, out.timeout);
  if (timeout !== undefined) out.timeout = timeout;
  return out;
}

/**
 * Normalize command SSE frames. Ends after the terminal `end` or `error`.
 *
 * The server always sends one of them, so a stream that closes first was cut
 * off and is thrown rather than passed off as a finished command.
 */
async function* commandFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CommandStreamEvent, void, undefined> {
  for await (const payload of iterSSEJson<Record<string, unknown>>(stream)) {
    const record = asRecord(payload);
    switch (str(record, 'type')) {
      case 'stdout':
        yield { type: 'stdout', data: str(record, 'data') };
        break;
      case 'stderr':
        yield { type: 'stderr', data: str(record, 'data') };
        break;
      case 'end': {
        const end: Extract<CommandStreamEvent, { type: 'end' }> = {
          type: 'end',
          exitCode: num(record, 'exit_code'),
        };
        const durationMs = optNum(record, 'duration_ms');
        if (durationMs !== undefined) end.durationMs = durationMs;
        if (record['timed_out'] !== undefined) end.timedOut = bool(record, 'timed_out');
        const error = optStr(record, 'error');
        if (error !== undefined) end.error = error;
        yield end;
        return;
      }
      case 'error':
        yield { type: 'error', message: str(record, 'message') };
        return;
      default:
        break;
    }
  }
  throw new GravixLayerConnectionError('command stream ended before the command finished');
}

/**
 * Collect a command stream into one result, calling back as output arrives.
 *
 * `detached` commands outlive the stream, so a broken stream says nothing
 * about how they ended and is thrown. Otherwise the command stops with its
 * stream, and the failure is reported the way the command's own failure
 * would be, so callers have one path to handle.
 */
async function collectCommand(
  events: AsyncIterable<CommandStreamEvent>,
  callbacks: CommandCallbacks,
  detached: boolean,
): Promise<CommandRunResponse> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const startedAt = monotonicMs();
  const result = (
    exitCode: number,
    durationMs?: number,
    timedOut = false,
    error?: string,
  ): CommandRunResponse => {
    const response: CommandRunResponse = {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode,
      durationMs: durationMs ?? Math.round(monotonicMs() - startedAt),
      success: exitCode === 0,
      timedOut,
    };
    if (error !== undefined) response.error = error;
    return response;
  };

  for await (const event of events) {
    switch (event.type) {
      case 'stdout':
        stdout.push(event.data);
        callbacks.onStdout?.(event.data);
        break;
      case 'stderr':
        stderr.push(event.data);
        callbacks.onStderr?.(event.data);
        break;
      case 'end':
        callbacks.onExit?.(event.exitCode);
        return result(event.exitCode, event.durationMs, event.timedOut, event.error);
      case 'error':
        if (detached) throw new GravixLayerConnectionError(event.message);
        stderr.push(event.message);
        callbacks.onStderr?.(event.message);
        callbacks.onExit?.(1);
        return result(1);
    }
  }
  throw new GravixLayerConnectionError('command stream ended before the command finished');
}

/** Listing of the templates a runtime can boot from. */
export class RuntimeTemplates extends APIResource {
  /** List available runtime templates. */
  async list(options: ListRuntimesOptions = {}): Promise<TemplateListResponse> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: buildListEndpoint('template', { limit, offset, extra: { kind: 'sandbox' } }),
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );

    return {
      templates: parseList(data, 'templates', parseTemplateInfo),
      limit: num(data, 'limit', limit),
      offset: num(data, 'offset', offset),
    };
  }
}

/**
 * Create and control runtimes.
 *
 * Reached through `client.runtime`.
 */
export class Runtimes extends APIResource {
  /** Read, write, and manage files inside a runtime. */
  readonly file: RuntimeFile;
  /** Interactive terminal sessions. */
  readonly pty: RuntimePty;
  /** Git operations executed inside a runtime. */
  readonly git: RuntimeGit;
  /** Publish guest ports to public URLs. */
  readonly service: RuntimeService;
  /** Templates a runtime can boot from. */
  readonly templates: RuntimeTemplates;
  /** Background commands started with `runCmd(..., { background: true })`. */
  readonly command: RuntimeCommands;

  constructor(context: ClientContext) {
    super(context);
    this.file = new RuntimeFile(context);
    this.pty = new RuntimePty(context);
    this.git = new RuntimeGit(context);
    this.service = new RuntimeService(context);
    this.templates = new RuntimeTemplates(context);
    this.command = new RuntimeCommands(this);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start a runtime.
   *
   * @example
   * ```ts
   * const sandbox = await client.runtime.create(); // defaults to template="base-small"
   * const result = await sandbox.runCode('print("hello")');
   * await sandbox.kill();
   * ```
   */
  async create(options: CreateRuntimeOptions = {}): Promise<Runtime> {
    const cloud = options.cloud ?? this.cloud;
    const region = options.region ?? this.region;

    if (!cloud) {
      throw new GravixLayerInvalidArgumentError(
        'A cloud is required. Pass `cloud` to create(), or set it on the client.',
      );
    }
    if (!region) {
      throw new GravixLayerInvalidArgumentError(
        'A region is required. Pass `region` to create(), or set it on the client.',
      );
    }
    if (options.snapshot && options.template && options.template !== DEFAULT_TEMPLATE) {
      throw new GravixLayerInvalidArgumentError(
        '`template` and `snapshot` are mutually exclusive. A snapshot already carries its template.',
      );
    }

    const body: Record<string, unknown> = { cloud, region };
    if (options.snapshot) {
      body['snapshot'] = options.snapshot;
    } else {
      body['template'] = options.template ?? DEFAULT_TEMPLATE;
    }
    if (options.timeoutSeconds !== undefined) {
      body['timeout'] = assertPositiveInt(options.timeoutSeconds, 'timeoutSeconds');
    }
    if (options.envVars !== undefined) body['env_vars'] = options.envVars;
    if (options.metadata !== undefined) body['metadata'] = options.metadata;
    if (options.internetAccess !== undefined) body['internet_access'] = options.internetAccess;
    if (options.agentId !== undefined) body['agent_id'] = options.agentId;
    if (options.providers !== undefined) body['providers'] = options.providers;
    if (options.networkPolicyIds !== undefined) {
      body['network_policy_ids'] = options.networkPolicyIds;
    }

    // Restoring a snapshot boots a guest, which needs a longer budget than the
    // default. An explicit per-call timeout still wins.
    const transportOptions = requestOptions(options);
    if (options.snapshot && transportOptions.timeout === undefined) {
      transportOptions.timeout = SNAPSHOT_RESTORE_TIMEOUT_MS;
    }

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: 'runtime',
        service: SERVICES.agents,
        body,
        options: transportOptions,
      }),
    );

    const info = parseRuntimeInfo(data);
    if (!info.template && !options.snapshot) {
      info.template = options.template ?? DEFAULT_TEMPLATE;
    }
    return new Runtime(this, info);
  }

  /** List runtimes on the account. */
  async list(options: ListRuntimesOptions = {}): Promise<RuntimeList> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: buildListEndpoint('runtime', { limit, offset }),
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );

    const runtimes = parseList(data, 'runtimes', parseRuntimeInfo);
    return { runtimes, total: num(data, 'total', runtimes.length) };
  }

  /** Fetch a runtime's current state without binding a handle. */
  async retrieve(runtimeId: string, options: RequestOptions = {}): Promise<RuntimeInfo> {
    assertRuntimeId(runtimeId);

    return parseRuntimeInfo(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `runtime/${runtimeId}`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /** Fetch a runtime and return a handle bound to it. */
  async get(runtimeId: string, options: RequestOptions = {}): Promise<Runtime> {
    return new Runtime(this, await this.retrieve(runtimeId, options));
  }

  /**
   * Reconnect to a runtime that is already running.
   *
   * Use this to pick a runtime back up in a different process, or after
   * storing its id and returning later.
   */
  async connect(runtimeId: string, options: RequestOptions = {}): Promise<Runtime> {
    assertRuntimeId(runtimeId);

    await this.http.requestVoid({
      method: 'POST',
      path: `runtime/${runtimeId}/connect`,
      service: SERVICES.agents,
      options,
    });
    return this.get(runtimeId, options);
  }

  /** Stop a runtime immediately and release its resources. */
  async kill(runtimeId: string, options: RequestOptions = {}): Promise<RuntimeKillResponse> {
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: `runtime/${runtimeId}`,
        service: SERVICES.agents,
        options,
      }),
    );

    return { message: str(data, 'message'), runtimeId: optStr(data, 'runtime_id') ?? runtimeId };
  }

  /** Change how long a runtime may keep running before it is stopped. */
  async setTimeout(
    runtimeId: string,
    timeoutSeconds: number,
    options: RequestOptions = {},
  ): Promise<RuntimeTimeoutResponse> {
    assertRuntimeId(runtimeId);
    assertPositiveInt(timeoutSeconds, 'timeoutSeconds');

    return parseRuntimeTimeoutResponse(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/timeout`,
          service: SERVICES.agents,
          body: { timeout: timeoutSeconds },
          options,
        }),
      ),
    );
  }

  /** Sample a runtime's current CPU, memory, disk, and network usage. */
  async getMetrics(runtimeId: string, options: RequestOptions = {}): Promise<RuntimeMetrics> {
    assertRuntimeId(runtimeId);

    return parseRuntimeMetrics(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `runtime/${runtimeId}/metrics`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /** Suspend a runtime, freezing its memory and stopping the clock. */
  async pause(runtimeId: string, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);

    await this.http.requestVoid({
      method: 'POST',
      path: `runtime/${runtimeId}/pause`,
      service: SERVICES.agents,
      options,
    });
  }

  /** Wake a paused runtime, restoring it exactly as it was. */
  async resume(runtimeId: string, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);

    await this.http.requestVoid({
      method: 'POST',
      path: `runtime/${runtimeId}/resume`,
      service: SERVICES.agents,
      options,
    });
  }

  // -------------------------------------------------------------------------
  // SSH
  // -------------------------------------------------------------------------

  /**
   * Turn on SSH access and return connection details.
   *
   * The private key is returned only when it is generated, so store it if you
   * need it again. Pass `regenerateKeys` to issue a fresh pair.
   */
  async enableSsh(
    runtimeId: string,
    options: RequestOptions & { regenerateKeys?: boolean } = {},
  ): Promise<SSHInfo> {
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/ssh/enable`,
        service: SERVICES.agents,
        query: options.regenerateKeys ? { regenerate_keys: true } : undefined,
        options: requestOptions(options),
      }),
    );

    if (!data['runtime_id']) data['runtime_id'] = runtimeId;
    if (data['enabled'] === undefined) data['enabled'] = true;
    return parseSSHInfo(data);
  }

  /** Turn off SSH access. */
  async disableSsh(runtimeId: string, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);

    await this.http.requestVoid({
      method: 'POST',
      path: `runtime/${runtimeId}/ssh/disable`,
      service: SERVICES.agents,
      options,
    });
  }

  /** Report whether SSH is enabled and its daemon is accepting connections. */
  async sshStatus(runtimeId: string, options: RequestOptions = {}): Promise<SSHStatus> {
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/ssh/status`,
        service: SERVICES.agents,
        options,
      }),
    );

    if (!data['runtime_id']) data['runtime_id'] = runtimeId;
    return parseSSHStatus(data);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Run a shell command and wait for it to finish.
   *
   * Passing any of `onStdout`, `onStderr`, or `onExit` switches to streaming,
   * where output arrives as it is produced. The return value is the same
   * either way, so adding a callback never changes the rest of your code.
   *
   * A non-zero exit code is reported through `exitCode`, not thrown.
   *
   * @example
   * ```ts
   * const result = await client.runtime.runCmd(id, 'ls -la');
   * console.log(result.stdout);
   * ```
   */
  async runCmd(
    runtimeId: string,
    command: string,
    options: RunCommandOptions & { background: true },
  ): Promise<CommandHandle>;
  async runCmd(
    runtimeId: string,
    command: string,
    options?: RunCommandOptions,
  ): Promise<CommandRunResponse>;
  async runCmd(
    runtimeId: string,
    command: string,
    options: RunCommandOptions = {},
  ): Promise<CommandRunResponse | CommandHandle> {
    assertRuntimeId(runtimeId);
    assertNonEmpty(command, 'command');

    const body = this.commandBody(command, options);
    if (options.background) {
      const started = asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/commands/run`,
          service: SERVICES.agents,
          body,
          options: requestOptions(options),
        }),
      );
      const handle = backgroundHandle(this, runtimeId, command, options, started);
      if (options.onStdout || options.onStderr || options.onExit) handle.follow(options);
      return handle;
    }
    const streaming = Boolean(options.onStdout ?? options.onStderr ?? options.onExit);

    if (!streaming) {
      return parseCommandRunResponse(
        asRecord(
          await this.http.request({
            method: 'POST',
            path: `runtime/${runtimeId}/commands/run`,
            service: SERVICES.agents,
            body,
            options: executionOptions(options),
          }),
        ),
      );
    }

    return collectCommand(
      this.commandEvents(runtimeId, body, executionOptions(options)),
      options,
      false,
    );
  }

  /**
   * Run a shell command and iterate its output as it happens.
   *
   * Prefer this over callbacks when you want backpressure, or when the output
   * feeds another async pipeline.
   *
   * @example
   * ```ts
   * for await (const event of client.runtime.streamCmd(id, 'npm install')) {
   *   if (event.type === 'stdout') process.stdout.write(event.data);
   * }
   * ```
   */
  async *streamCmd(
    runtimeId: string,
    command: string,
    options: Omit<RunCommandOptions, keyof CommandCallbacks> = {},
  ): AsyncGenerator<CommandStreamEvent, void, undefined> {
    assertRuntimeId(runtimeId);
    assertNonEmpty(command, 'command');

    yield* this.commandEvents(
      runtimeId,
      this.commandBody(command, options),
      executionOptions(options),
    );
  }

  /** Build the request body shared by buffered and streaming command runs. */
  private commandBody(
    command: string,
    options: Omit<RunCommandOptions, keyof CommandCallbacks>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { command };
    if (options.args !== undefined) body['args'] = options.args;
    if (options.workingDir !== undefined) body['working_dir'] = options.workingDir;
    if (options.environment !== undefined) body['environment'] = options.environment;
    if (options.timeoutSeconds !== undefined) {
      // The command endpoint takes milliseconds. Zero is the server default.
      body['timeout'] = nonNegativeInt(options.timeoutSeconds, 'timeoutSeconds') * 1000;
    }
    if (options.background) body['background'] = true;
    return body;
  }

  /** Consume the command SSE stream and normalize each frame. */
  private async *commandEvents(
    runtimeId: string,
    body: Record<string, unknown>,
    options: RequestOptions,
  ): AsyncGenerator<CommandStreamEvent, void, undefined> {
    const stream = await this.http.requestStream({
      method: 'POST',
      path: `runtime/${runtimeId}/commands/run`,
      service: SERVICES.agents,
      query: { stream: true },
      body,
      options,
    });
    yield* commandFrames(stream);
  }

  async listCommands(runtimeId: string, options: RequestOptions = {}): Promise<CommandInfo[]> {
    assertRuntimeId(runtimeId);
    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/commands`,
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    return parseList(data, 'commands', parseCommandInfo);
  }

  async getCommand(
    runtimeId: string,
    pid: number,
    options: RequestOptions = {},
  ): Promise<CommandInfo> {
    assertRuntimeId(runtimeId);
    assertPositiveInt(pid, 'pid');
    return parseCommandInfo(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `runtime/${runtimeId}/commands/${pid}`,
          service: SERVICES.agents,
          options: requestOptions(options),
        }),
      ),
    );
  }

  async killCommand(
    runtimeId: string,
    pid: number,
    signal?: 'KILL' | 'TERM' | 'INT' | 'HUP',
    options: RequestOptions = {},
  ): Promise<CommandInfo> {
    assertRuntimeId(runtimeId);
    assertPositiveInt(pid, 'pid');
    return parseCommandInfo(
      asRecord(
        await this.http.request({
          method: 'DELETE',
          path: `runtime/${runtimeId}/commands/${pid}`,
          service: SERVICES.agents,
          query: signal ? { signal } : undefined,
          options: requestOptions(options),
        }),
      ),
    );
  }

  async waitCommand(
    runtimeId: string,
    pid: number,
    options: CommandCallbacks & RequestOptions = {},
  ): Promise<CommandRunResponse> {
    assertRuntimeId(runtimeId);
    assertPositiveInt(pid, 'pid');
    const stream = await this.http.requestStream({
      method: 'GET',
      path: `runtime/${runtimeId}/commands/${pid}/stream`,
      service: SERVICES.agents,
      options: requestOptions(options),
    });
    return collectCommand(commandFrames(stream), options, true);
  }

  // -------------------------------------------------------------------------
  // Code
  // -------------------------------------------------------------------------

  /**
   * Run code in the runtime's interpreter and wait for the result.
   *
   * Unlike a shell command, this keeps the interpreter alive, so rich outputs
   * such as plots and DataFrames come back as structured results rather than
   * printed text. Pass `contextId` to keep variables between calls.
   *
   * Passing any of the `on*` callbacks switches to streaming; the return value
   * is the same either way.
   *
   * @example
   * ```ts
   * const result = await client.runtime.runCode(id, 'print(2 ** 10)');
   * console.log(result.logs.stdout.join('\n'));
   * ```
   */
  async runCode(
    runtimeId: string,
    code: string,
    options: RunCodeOptions = {},
  ): Promise<CodeRunResponse> {
    assertRuntimeId(runtimeId);

    const body = this.codeBody(code, options);
    const streaming = Boolean(
      options.onStdout ?? options.onStderr ?? options.onResult ?? options.onError,
    );

    if (!streaming) {
      return parseCodeRunResponse(
        asRecord(
          await this.http.request({
            method: 'POST',
            path: `runtime/${runtimeId}/code/run`,
            service: SERVICES.agents,
            body,
            options: executionOptions(options),
          }),
        ),
      );
    }

    const logs: ExecutionLogs = { stdout: [], stderr: [] };
    const results: ExecutionResult[] = [];
    let error: ExecutionError | undefined;

    for await (const event of this.codeEvents(runtimeId, body, executionOptions(options))) {
      if (event.type === 'stdout') {
        logs.stdout.push(event.text);
        options.onStdout?.(event.text);
      } else if (event.type === 'stderr') {
        logs.stderr.push(event.text);
        options.onStderr?.(event.text);
      } else if (event.type === 'result') {
        results.push(event.result);
        options.onResult?.(event.result);
      } else if (event.type === 'error') {
        error = event.error;
        options.onError?.(event.error);
      } else {
        break;
      }
    }

    const response: CodeRunResponse = { results, logs };
    if (error !== undefined) response.error = error;
    return response;
  }

  /**
   * Run code and iterate its output as it happens.
   *
   * @example
   * ```ts
   * for await (const event of client.runtime.streamCode(id, longRunningCode)) {
   *   if (event.type === 'stdout') process.stdout.write(event.text);
   * }
   * ```
   */
  async *streamCode(
    runtimeId: string,
    code: string,
    options: Omit<RunCodeOptions, keyof CodeCallbacks> = {},
  ): AsyncGenerator<CodeStreamEvent, void, undefined> {
    assertRuntimeId(runtimeId);

    yield* this.codeEvents(runtimeId, this.codeBody(code, options), executionOptions(options));
  }

  /** Build the request body shared by buffered and streaming code runs. */
  private codeBody(
    code: string,
    options: Omit<RunCodeOptions, keyof CodeCallbacks>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { code, language: options.language ?? 'python' };
    if (options.contextId !== undefined) body['context_id'] = options.contextId;
    if (options.environment !== undefined) body['environment'] = options.environment;
    if (options.timeoutSeconds !== undefined) {
      // The code endpoint takes seconds.
      body['timeout'] = assertPositiveInt(options.timeoutSeconds, 'timeoutSeconds');
    }
    return body;
  }

  /**
   * Consume the code SSE stream and normalize each frame.
   *
   * The server always closes the stream with `end`, so a stream that closes
   * first was cut off and is thrown rather than returned as partial output.
   */
  private async *codeEvents(
    runtimeId: string,
    body: Record<string, unknown>,
    options: RequestOptions,
  ): AsyncGenerator<CodeStreamEvent, void, undefined> {
    const stream = await this.http.requestStream({
      method: 'POST',
      path: `runtime/${runtimeId}/code/run`,
      service: SERVICES.agents,
      query: { stream: true },
      body,
      options,
    });

    for await (const payload of iterSSEJson<Record<string, unknown>>(stream)) {
      const record = asRecord(payload);
      switch (str(record, 'type')) {
        case 'stdout':
          yield { type: 'stdout', text: str(record, 'text') };
          break;
        case 'stderr':
          yield { type: 'stderr', text: str(record, 'text') };
          break;
        case 'result':
          yield { type: 'result', result: parseExecutionResult(asRecord(record['result'])) };
          break;
        case 'error': {
          const parsed =
            parseExecutionError(record['error']) ??
            parseExecutionError(optStr(record, 'message') ?? '');
          yield {
            type: 'error',
            error: parsed ?? { name: '', value: 'Code execution failed.', traceback: '' },
          };
          break;
        }
        case 'end':
          yield { type: 'end' };
          return;
        default:
          break;
      }
    }
    throw new GravixLayerConnectionError('code stream ended before the execution finished');
  }

  // -------------------------------------------------------------------------
  // Code contexts
  // -------------------------------------------------------------------------

  /**
   * Create a persistent interpreter session.
   *
   * Variables, imports, and open handles survive between executions that pass
   * the same `contextId`, which makes a context the right shape for a notebook
   * or a multi-step agent.
   */
  async createContext(runtimeId: string, options: CreateContextOptions = {}): Promise<CodeContext> {
    assertRuntimeId(runtimeId);

    const body: Record<string, unknown> = { language: options.language ?? 'python' };
    if (options.cwd !== undefined) body['cwd'] = options.cwd;

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/code/contexts`,
        service: SERVICES.agents,
        body,
        options: requestOptions(options),
      }),
    );

    return {
      contextId: optStr(data, 'id') ?? str(data, 'context_id'),
      language: optStr(data, 'language') ?? options.language ?? 'python',
      cwd: optStr(data, 'cwd') ?? options.cwd ?? '/workspace',
    };
  }

  /** Fetch a context's metadata. */
  async getContext(
    runtimeId: string,
    contextId: string,
    options: RequestOptions = {},
  ): Promise<CodeContext> {
    assertRuntimeId(runtimeId);
    const context = pathSegment(contextId, 'contextId');

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/code/contexts/${context}`,
        service: SERVICES.agents,
        options,
      }),
    );

    return {
      contextId: optStr(data, 'id') ?? optStr(data, 'context_id') ?? contextId,
      language: optStr(data, 'language') ?? 'python',
      cwd: optStr(data, 'cwd') ?? '/workspace',
    };
  }

  /** Delete a context and free the interpreter behind it. */
  async deleteContext(
    runtimeId: string,
    contextId: string,
    options: RequestOptions = {},
  ): Promise<CodeContextDeleteResponse> {
    assertRuntimeId(runtimeId);
    const context = pathSegment(contextId, 'contextId');

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: `runtime/${runtimeId}/code/contexts/${context}`,
        service: SERVICES.agents,
        options,
      }),
    );

    const response: CodeContextDeleteResponse = { message: str(data, 'message') };
    const returned = optStr(data, 'context_id') ?? contextId;
    response.contextId = returned;
    return response;
  }
}

/** A background command. `wait` attaches to its output until it exits.
 *
 * `pid` is `null` when the command exited before it had a process id.
 * `wait`, `refresh`, and `kill` then return that result and do not call the API.
 */
export class CommandHandle {
  private readonly waits = new Set<AbortController>();
  private failure: Error | undefined;

  constructor(
    private readonly commands: Runtimes,
    readonly runtimeId: string,
    readonly pid: number | null,
    private readonly finished?: { result: CommandRunResponse; info: CommandInfo },
  ) {}

  /** What stopped the last {@link follow}, if it failed. */
  get error(): Error | undefined {
    return this.failure;
  }

  wait(options: CommandCallbacks & RequestOptions = {}): Promise<CommandRunResponse> {
    return this.finishedResult(options) ?? this.read(options, new AbortController());
  }

  /**
   * Follow the output in the background. A failure goes to `onError` and
   * {@link error}; stopping through {@link disconnect} or `signal` is not one.
   */
  follow(options: CommandFollowOptions = {}): void {
    const controller = new AbortController();
    void this.read(options, controller).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      this.failure = error instanceof Error ? error : new Error(String(error));
      options.onError?.(this.failure);
    });
  }

  kill(signal?: 'KILL' | 'TERM' | 'INT' | 'HUP'): Promise<CommandInfo> {
    if (this.finished) return Promise.resolve(this.finished.info);
    return this.commands.killCommand(this.runtimeId, this.livePid(), signal);
  }

  refresh(): Promise<CommandInfo> {
    if (this.finished) return Promise.resolve(this.finished.info);
    return this.commands.getCommand(this.runtimeId, this.livePid());
  }

  /** Stop every open `wait()` and `follow()` on this command. The command itself keeps running. */
  disconnect(): void {
    for (const controller of this.waits) controller.abort();
    this.waits.clear();
  }

  private livePid(): number {
    if (this.pid === null || !Number.isInteger(this.pid) || this.pid <= 0) {
      throw new GravixLayerConnectionError('background command finished without an exit code');
    }
    return this.pid;
  }

  private finishedResult(options: CommandCallbacks): Promise<CommandRunResponse> | undefined {
    const finished = this.finished;
    if (!finished) return undefined;
    return Promise.resolve().then(() => deliverFinished(finished.result, options));
  }

  private read(
    options: CommandCallbacks & RequestOptions,
    controller: AbortController,
  ): Promise<CommandRunResponse> {
    const finished = this.finishedResult(options);
    if (finished) return finished;
    const caller = options.signal;
    const stop = (): void => controller.abort(caller?.reason);
    if (caller?.aborted) stop();
    else caller?.addEventListener('abort', stop, { once: true });
    this.waits.add(controller);
    return this.commands
      .waitCommand(this.runtimeId, this.livePid(), { ...options, signal: controller.signal })
      .finally(() => {
        this.waits.delete(controller);
        caller?.removeEventListener('abort', stop);
      });
  }
}

function deliverFinished(
  result: CommandRunResponse,
  options: CommandCallbacks,
): CommandRunResponse {
  if (result.stdout) options.onStdout?.(result.stdout);
  if (result.stderr) options.onStderr?.(result.stderr);
  options.onExit?.(result.exitCode);
  return result;
}

function backgroundHandle(
  commands: Runtimes,
  runtimeId: string,
  command: string,
  options: RunCommandOptions,
  started: Record<string, unknown>,
): CommandHandle {
  const pid = optNum(started, 'pid');
  if (pid !== undefined && pid > 0) return new CommandHandle(commands, runtimeId, pid);
  if (started['exit_code'] === undefined) {
    throw new GravixLayerConnectionError('background command finished without an exit code');
  }
  const result = parseCommandRunResponse(started);
  const info: CommandInfo = {
    pid: null,
    command,
    args: options.args ?? [],
    workingDir: options.workingDir ? options.workingDir : '/workspace',
    background: true,
    status: result.timedOut ? 'timed_out' : 'exited',
    exitCode: result.exitCode,
    startedAt: null,
    endedAt: null,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
  return new CommandHandle(commands, runtimeId, null, { result, info });
}

/** List, inspect, attach to, and stop background commands. */
export class RuntimeCommands {
  constructor(private readonly commands: Runtimes) {}

  list(runtimeId: string, options?: RequestOptions): Promise<CommandInfo[]> {
    return this.commands.listCommands(runtimeId, options);
  }

  get(runtimeId: string, pid: number, options?: RequestOptions): Promise<CommandInfo> {
    return this.commands.getCommand(runtimeId, pid, options);
  }

  connect(runtimeId: string, pid: number, options?: CommandCallbacks): Promise<CommandRunResponse> {
    return this.commands.waitCommand(runtimeId, pid, options);
  }

  kill(
    runtimeId: string,
    pid: number,
    signal?: 'KILL' | 'TERM' | 'INT' | 'HUP',
    options?: RequestOptions,
  ): Promise<CommandInfo> {
    return this.commands.killCommand(runtimeId, pid, signal, options);
  }
}
