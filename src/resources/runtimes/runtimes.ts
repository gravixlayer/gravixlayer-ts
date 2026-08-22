/**
 * Runtimes: isolated virtual machines that start in milliseconds and run
 * whatever you give them.
 *
 * This is the largest surface in the SDK. Lifecycle, code and command
 * execution, and code contexts live here directly; the filesystem, terminals,
 * git, and published ports live on the nested resources.
 */

import { GravixLayerInvalidArgumentError } from '../../core/errors.js';
import { asRecord, num, optStr, parseList, str } from '../../core/parse.js';
import { iterSSEJson } from '../../core/sse.js';
import type { RequestOptions } from '../../core/transport.js';
import { buildListEndpoint, pathSegment, SERVICES } from '../../core/url.js';
import { assertNonEmpty, assertPositiveInt, assertRuntimeId } from '../../core/validate.js';
import {
  parseCodeRunResponse,
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
import { RuntimeFiles } from './files.js';
import { RuntimeGit } from './git.js';
import { RuntimePty } from './pty.js';
import { Runtime } from './runtime.js';
import { RuntimeServices } from './services.js';

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

/** Options for {@link Runtimes.runCmd}. */
export interface RunCommandOptions extends RequestOptions, CommandCallbacks {
  /** Arguments appended to the command. */
  args?: string[];
  /** Directory to run in. Defaults to the guest's working directory. */
  workingDir?: string;
  /** Environment variables for this command only. */
  environment?: Record<string, string>;
  /** Seconds before the command is killed. */
  timeoutSeconds?: number;
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
  | { type: 'end'; exitCode: number }
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
 * Reached through `client.runtimes`.
 */
export class Runtimes extends APIResource {
  /** Read, write, and manage files inside a runtime. */
  readonly files: RuntimeFiles;
  /** Interactive terminal sessions. */
  readonly pty: RuntimePty;
  /** Git operations executed inside a runtime. */
  readonly git: RuntimeGit;
  /** Publish guest ports to public URLs. */
  readonly services: RuntimeServices;
  /** Templates a runtime can boot from. */
  readonly templates: RuntimeTemplates;

  constructor(context: ClientContext) {
    super(context);
    this.files = new RuntimeFiles(context);
    this.pty = new RuntimePty(context);
    this.git = new RuntimeGit(context);
    this.services = new RuntimeServices(context);
    this.templates = new RuntimeTemplates(context);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start a runtime.
   *
   * @example
   * ```ts
   * const runtime = await client.runtimes.create({ template: 'base-small' });
   * const result = await runtime.runCode('print("hello")');
   * await runtime.kill();
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
   * const result = await client.runtimes.runCmd(id, 'ls -la');
   * console.log(result.stdout);
   * ```
   */
  async runCmd(
    runtimeId: string,
    command: string,
    options: RunCommandOptions = {},
  ): Promise<CommandRunResponse> {
    assertRuntimeId(runtimeId);
    assertNonEmpty(command, 'command');

    const body = this.commandBody(command, options);
    const streaming = Boolean(options.onStdout ?? options.onStderr ?? options.onExit);

    if (!streaming) {
      return parseCommandRunResponse(
        asRecord(
          await this.http.request({
            method: 'POST',
            path: `runtime/${runtimeId}/commands/run`,
            service: SERVICES.agents,
            body,
            options: requestOptions(options),
          }),
        ),
      );
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode = 0;
    const startedAt = Date.now();

    for await (const event of this.commandEvents(runtimeId, body, requestOptions(options))) {
      if (event.type === 'stdout') {
        stdout.push(event.data);
        options.onStdout?.(event.data);
      } else if (event.type === 'stderr') {
        stderr.push(event.data);
        options.onStderr?.(event.data);
      } else if (event.type === 'end') {
        exitCode = event.exitCode;
        options.onExit?.(exitCode);
        break;
      } else {
        // A stream-level failure is surfaced the same way the command's own
        // failure would be, so callers have one path to handle.
        stderr.push(event.message);
        options.onStderr?.(event.message);
        exitCode = 1;
        options.onExit?.(exitCode);
        break;
      }
    }

    return {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode,
      durationMs: Date.now() - startedAt,
      success: exitCode === 0,
    };
  }

  /**
   * Run a shell command and iterate its output as it happens.
   *
   * Prefer this over callbacks when you want backpressure, or when the output
   * feeds another async pipeline.
   *
   * @example
   * ```ts
   * for await (const event of client.runtimes.streamCmd(id, 'npm install')) {
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
      requestOptions(options),
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
      // The command endpoint takes milliseconds.
      body['timeout'] = assertPositiveInt(options.timeoutSeconds, 'timeoutSeconds') * 1000;
    }
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

    for await (const payload of iterSSEJson<Record<string, unknown>>(stream)) {
      const record = asRecord(payload);
      switch (str(record, 'type')) {
        case 'stdout':
          yield { type: 'stdout', data: str(record, 'data') };
          break;
        case 'stderr':
          yield { type: 'stderr', data: str(record, 'data') };
          break;
        case 'end':
          yield { type: 'end', exitCode: num(record, 'exit_code') };
          return;
        case 'error':
          yield { type: 'error', message: str(record, 'message') };
          return;
        default:
          break;
      }
    }
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
   * const result = await client.runtimes.runCode(id, 'print(2 ** 10)');
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
            options: requestOptions(options),
          }),
        ),
      );
    }

    const logs: ExecutionLogs = { stdout: [], stderr: [] };
    const results: ExecutionResult[] = [];
    let error: ExecutionError | undefined;

    for await (const event of this.codeEvents(runtimeId, body, requestOptions(options))) {
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
   * for await (const event of client.runtimes.streamCode(id, longRunningCode)) {
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

    yield* this.codeEvents(runtimeId, this.codeBody(code, options), requestOptions(options));
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

  /** Consume the code SSE stream and normalize each frame. */
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
