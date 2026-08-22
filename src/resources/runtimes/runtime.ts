/**
 * A handle to one runtime.
 *
 * `client.runtimes.create()` and `client.runtimes.get()` return this instead of
 * a plain object, so every operation is available without repeating the
 * runtime id: `runtime.runCode(...)`, `runtime.files.write(...)`,
 * `runtime.kill()`.
 */

import type { BinaryLike } from '../../core/binary.js';
import { GravixLayerInvalidArgumentError } from '../../core/errors.js';
import type { RequestOptions } from '../../core/transport.js';
import type { FileMode } from '../../core/uploads.js';
import {
  Execution,
  type ChangeOwnerResponse,
  type CodeContext,
  type CodeContextDeleteResponse,
  type DirectoryCreateResponse,
  type FileCopyResponse,
  type FileDeleteResponse,
  type FileFindResponse,
  type FileGetInfoResponse,
  type FileListResponse,
  type FileMoveResponse,
  type FileReadResponse,
  type FileReplaceResponse,
  type FileUploadResponse,
  type FileWriteResponse,
  type GitOperationResult,
  type PtyInputResponse,
  type PtySession,
  type RuntimeInfo,
  type RuntimeMetrics,
  type RuntimeTimeoutResponse,
  type RuntimeWebService,
  type SetPermissionsResponse,
  type SSHInfo,
  type SSHStatus,
  type WatchEvent,
  type WriteFilesResponse,
  type WriteResult,
} from '../../types/runtime.js';
import type {
  ChownOptions,
  CopyOptions,
  CreateDirectoryOptions,
  FindOptions,
  MoveOptions,
  ReplaceOptions,
  UploadOptions,
  WatchOptions,
  WriteEntry,
} from './files.js';
import type {
  BranchScope,
  GitCloneOptions,
  GitCommitOptions,
  GitFetchOptions,
  GitPushOptions,
} from './git.js';
import type { CreatePtyOptions, PtyHandle, PtyStreamEvent } from './pty.js';
import type {
  CodeCallbacks,
  CodeStreamEvent,
  CommandCallbacks,
  CommandStreamEvent,
  CreateContextOptions,
  RunCodeOptions,
  RunCommandOptions,
  Runtimes,
} from './runtimes.js';
import type { PublishOptions, ServiceHandle } from './services.js';

/** Status reported by a runtime that is up and accepting work. */
const RUNNING = 'running';

/** The well-known symbol used to look up an async disposer. */
const REGISTERED_ASYNC_DISPOSE: symbol = Symbol.for('Symbol.asyncDispose');

/**
 * The key an async disposer is stored under.
 *
 * `Symbol.asyncDispose` only exists on newer runtimes. Where it does not, the
 * registered symbol is what downlevel-compiled `await using` looks for, so the
 * disposer is declared under whichever of the two is available.
 */
const ASYNC_DISPOSE: typeof Symbol.asyncDispose =
  (Symbol as { asyncDispose?: typeof Symbol.asyncDispose }).asyncDispose ??
  (REGISTERED_ASYNC_DISPOSE as typeof Symbol.asyncDispose);

/**
 * Resolves the runtime id, throwing if the runtime has been terminated.
 *
 * Bound sub-resources hold this rather than the id itself, so an operation
 * attempted after `kill()` fails with a clear message instead of a 404.
 */
type ResolveId = () => string;

/**
 * A runtime you can act on directly.
 *
 * The handle caches the state it was built from. Call {@link refresh} to pull
 * the latest, or read {@link info} for the cached snapshot.
 */
export class Runtime {
  /** Nested filesystem API, already bound to this runtime. */
  readonly files: BoundFiles;
  /** Nested terminal API, already bound to this runtime. */
  readonly pty: BoundPty;
  /** Nested git API, already bound to this runtime. */
  readonly git: BoundGit;
  /** Nested published-port API, already bound to this runtime. */
  readonly services: BoundServices;

  private state: RuntimeInfo;
  private killed = false;
  private killing: Promise<void> | undefined;

  constructor(
    private readonly runtimes: Runtimes,
    info: RuntimeInfo,
  ) {
    this.state = info;

    const resolve: ResolveId = () => this.requireAlive();
    this.files = new BoundFiles(runtimes, resolve);
    this.pty = new BoundPty(runtimes, resolve);
    this.git = new BoundGit(runtimes, resolve);
    this.services = new BoundServices(runtimes, resolve);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** The runtime's unique identifier. */
  get runtimeId(): string {
    return this.state.runtimeId;
  }

  /** Lifecycle state as of the last read. */
  get status(): string {
    return this.state.status;
  }

  /** Template the runtime booted from. */
  get template(): string | undefined {
    return this.state.template;
  }

  /** Cloud the runtime is placed on. */
  get cloud(): string | undefined {
    return this.state.cloud;
  }

  /** Region the runtime is placed in. */
  get region(): string | undefined {
    return this.state.region;
  }

  /** Number of virtual CPUs. */
  get cpuCount(): number | undefined {
    return this.state.cpuCount;
  }

  /** Memory in mebibytes. */
  get memoryMb(): number | undefined {
    return this.state.memoryMb;
  }

  /** Disk size in mebibytes. */
  get diskSizeMb(): number | undefined {
    return this.state.diskSizeMb;
  }

  /** ISO-8601 timestamp of when the runtime started. */
  get startedAt(): string | undefined {
    return this.state.startedAt;
  }

  /** ISO-8601 timestamp of when the runtime will expire. */
  get timeoutAt(): string | undefined {
    return this.state.timeoutAt;
  }

  /** Labels attached at creation. */
  get metadata(): Record<string, unknown> | undefined {
    return this.state.metadata;
  }

  /** The full cached snapshot of the runtime's state. */
  get info(): RuntimeInfo {
    return this.state;
  }

  /** Re-read the runtime's state from the API. */
  async refresh(options: RequestOptions = {}): Promise<this> {
    this.state = await this.runtimes.retrieve(this.state.runtimeId, options);
    return this;
  }

  /**
   * Whether the runtime is still running.
   *
   * Returns `false` rather than throwing when the runtime is gone, so this is
   * safe to poll.
   */
  async isAlive(options: RequestOptions = {}): Promise<boolean> {
    if (this.killed) return false;
    try {
      await this.refresh(options);
      return this.state.status === RUNNING;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Stop the runtime and release its resources.
   *
   * Safe to call more than once: once it has succeeded, later calls do
   * nothing, and concurrent calls share the one request rather than racing.
   * A failed attempt leaves the handle usable so it can be retried.
   */
  async kill(options: RequestOptions = {}): Promise<void> {
    if (this.killed) return;

    this.killing ??= this.runtimes
      .kill(this.state.runtimeId, options)
      .then(() => {
        this.killed = true;
        this.state = { ...this.state, status: 'terminated' };
      })
      .finally(() => {
        this.killing = undefined;
      });

    await this.killing;
  }

  /**
   * Stop the runtime when an `await using` block exits, however it exits.
   *
   * @example
   * ```ts
   * {
   *   await using runtime = await client.runtimes.create();
   *   await runtime.runCmd('npm test');
   * } // stopped here, even if the command threw
   * ```
   */
  async [ASYNC_DISPOSE](): Promise<void> {
    await this.kill();
  }

  /** Suspend the runtime, freezing its memory and stopping the clock. */
  async pause(options: RequestOptions = {}): Promise<void> {
    await this.runtimes.pause(this.requireAlive(), options);
  }

  /** Wake the runtime, restoring it exactly as it was. */
  async resume(options: RequestOptions = {}): Promise<void> {
    await this.runtimes.resume(this.requireAlive(), options);
  }

  /** Change how long the runtime may keep running. */
  async setTimeout(
    timeoutSeconds: number,
    options: RequestOptions = {},
  ): Promise<RuntimeTimeoutResponse> {
    return this.runtimes.setTimeout(this.requireAlive(), timeoutSeconds, options);
  }

  /** Sample current CPU, memory, disk, and network usage. */
  async getMetrics(options: RequestOptions = {}): Promise<RuntimeMetrics> {
    return this.runtimes.getMetrics(this.requireAlive(), options);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Run code in the runtime's interpreter.
   *
   * @example
   * ```ts
   * const result = await runtime.runCode('print("hello")');
   * console.log(result.stdout);
   * ```
   */
  async runCode(code: string, options: RunCodeOptions = {}): Promise<Execution> {
    return new Execution(await this.runtimes.runCode(this.requireAlive(), code, options));
  }

  /**
   * Run a shell command.
   *
   * @example
   * ```ts
   * const result = await runtime.runCmd('node -v');
   * console.log(result.stdout.trim());
   * ```
   */
  async runCmd(command: string, options: RunCommandOptions = {}): Promise<Execution> {
    return new Execution(await this.runtimes.runCmd(this.requireAlive(), command, options));
  }

  /** Run code and iterate its output as it happens. */
  async *streamCode(
    code: string,
    options: Omit<RunCodeOptions, keyof CodeCallbacks> = {},
  ): AsyncGenerator<CodeStreamEvent, void, undefined> {
    yield* this.runtimes.streamCode(this.requireAlive(), code, options);
  }

  /** Run a shell command and iterate its output as it happens. */
  async *streamCmd(
    command: string,
    options: Omit<RunCommandOptions, keyof CommandCallbacks> = {},
  ): AsyncGenerator<CommandStreamEvent, void, undefined> {
    yield* this.runtimes.streamCmd(this.requireAlive(), command, options);
  }

  /** Create a persistent interpreter session. */
  async createContext(options: CreateContextOptions = {}): Promise<CodeContext> {
    return this.runtimes.createContext(this.requireAlive(), options);
  }

  /** Fetch a context's metadata. */
  async getContext(contextId: string, options: RequestOptions = {}): Promise<CodeContext> {
    return this.runtimes.getContext(this.requireAlive(), contextId, options);
  }

  /** Delete a context and free the interpreter behind it. */
  async deleteContext(
    contextId: string,
    options: RequestOptions = {},
  ): Promise<CodeContextDeleteResponse> {
    return this.runtimes.deleteContext(this.requireAlive(), contextId, options);
  }

  // -------------------------------------------------------------------------
  // SSH
  // -------------------------------------------------------------------------

  /** Turn on SSH access and return connection details. */
  async enableSsh(options: RequestOptions & { regenerateKeys?: boolean } = {}): Promise<SSHInfo> {
    return this.runtimes.enableSsh(this.requireAlive(), options);
  }

  /** Turn off SSH access. */
  async disableSsh(options: RequestOptions = {}): Promise<void> {
    return this.runtimes.disableSsh(this.requireAlive(), options);
  }

  /** Report whether SSH is enabled and accepting connections. */
  async sshStatus(options: RequestOptions = {}): Promise<SSHStatus> {
    return this.runtimes.sshStatus(this.requireAlive(), options);
  }

  // -------------------------------------------------------------------------
  // Web services
  // -------------------------------------------------------------------------

  /**
   * Publish a guest port and return a client bound to its public URL.
   *
   * Shorthand for `runtime.services.connect(port)`.
   */
  async service(port: number, options: PublishOptions = {}): Promise<ServiceHandle> {
    return this.services.connect(port, options);
  }

  /** Guard every operation that needs a live runtime. */
  private requireAlive(): string {
    if (this.killed) {
      throw new GravixLayerInvalidArgumentError(
        `Runtime ${this.state.runtimeId} has been terminated.`,
      );
    }
    return this.state.runtimeId;
  }
}

/**
 * `runtime.files`: the filesystem API with the runtime id already applied.
 *
 * Every method mirrors `client.runtimes.files`, minus the first argument.
 */
export class BoundFiles {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  /** Read a text file. */
  async read(path: string, options?: RequestOptions): Promise<FileReadResponse> {
    return this.runtimes.files.read(this.id(), path, options);
  }

  /** Write a text file, creating or replacing it. */
  async write(path: string, content: string, options?: RequestOptions): Promise<FileWriteResponse> {
    return this.runtimes.files.write(this.id(), path, content, options);
  }

  /** Delete a file or directory. */
  async delete(path: string, options?: RequestOptions): Promise<FileDeleteResponse> {
    return this.runtimes.files.delete(this.id(), path, options);
  }

  /** List the entries in a directory. */
  async list(path?: string, options?: RequestOptions): Promise<FileListResponse> {
    return this.runtimes.files.list(this.id(), path, options);
  }

  /** Upload binary or text content to a path. */
  async upload(path: string, data: BinaryLike, options?: UploadOptions): Promise<WriteResult> {
    return this.runtimes.files.upload(this.id(), path, data, options);
  }

  /** Upload several files in one request. */
  async writeMany(
    entries: readonly WriteEntry[],
    options?: UploadOptions,
  ): Promise<WriteFilesResponse> {
    return this.runtimes.files.writeMany(this.id(), entries, options);
  }

  /** Create a directory. */
  async createDirectory(
    path: string,
    options?: CreateDirectoryOptions,
  ): Promise<DirectoryCreateResponse> {
    return this.runtimes.files.createDirectory(this.id(), path, options);
  }

  /** Look up metadata for a path. */
  async getInfo(path: string, options?: RequestOptions): Promise<FileGetInfoResponse> {
    return this.runtimes.files.getInfo(this.id(), path, options);
  }

  /** Change a path's permission bits. */
  async setPermissions(
    path: string,
    mode: FileMode,
    options?: RequestOptions,
  ): Promise<SetPermissionsResponse> {
    return this.runtimes.files.setPermissions(this.id(), path, mode, options);
  }

  /** Move or rename a path. */
  async move(
    source: string,
    destination: string,
    options?: MoveOptions,
  ): Promise<FileMoveResponse> {
    return this.runtimes.files.move(this.id(), source, destination, options);
  }

  /** Copy a path. */
  async copy(
    source: string,
    destination: string,
    options?: CopyOptions,
  ): Promise<FileCopyResponse> {
    return this.runtimes.files.copy(this.id(), source, destination, options);
  }

  /** Change a path's owner, group, or both. */
  async chown(path: string, options?: ChownOptions): Promise<ChangeOwnerResponse> {
    return this.runtimes.files.chown(this.id(), path, options);
  }

  /** Watch a path for changes. */
  async *watch(path: string, options?: WatchOptions): AsyncGenerator<WatchEvent, void, undefined> {
    yield* this.runtimes.files.watch(this.id(), path, options);
  }

  /** Search for files by name or content. */
  async find(path: string, options?: FindOptions): Promise<FileFindResponse> {
    return this.runtimes.files.find(this.id(), path, options);
  }

  /** Replace text across files under a path. */
  async replace(
    path: string,
    pattern: string,
    replacement: string,
    options?: ReplaceOptions,
  ): Promise<FileReplaceResponse> {
    return this.runtimes.files.replace(this.id(), path, pattern, replacement, options);
  }

  /** Upload through the legacy single-file endpoint. */
  async uploadFile(
    data: BinaryLike,
    path?: string,
    options?: RequestOptions,
  ): Promise<FileUploadResponse> {
    return this.runtimes.files.uploadFile(this.id(), data, path, options);
  }

  /** Download a file's raw bytes. */
  async download(path: string, options?: RequestOptions): Promise<Uint8Array> {
    return this.runtimes.files.download(this.id(), path, options);
  }

  /** Download a file and decode it as UTF-8 text. */
  async downloadText(path: string, options?: RequestOptions): Promise<string> {
    return this.runtimes.files.downloadText(this.id(), path, options);
  }
}

/** `runtime.pty`: terminal sessions with the runtime id already applied. */
export class BoundPty {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  /** Start a new terminal session. */
  async create(options?: CreatePtyOptions): Promise<PtySession> {
    return this.runtimes.pty.create(this.id(), options);
  }

  /** List the runtime's terminal sessions. */
  async list(options?: RequestOptions): Promise<PtySession[]> {
    return this.runtimes.pty.list(this.id(), options);
  }

  /** Fetch one session's current state. */
  async get(sessionId: string, options?: RequestOptions): Promise<PtySession> {
    return this.runtimes.pty.get(this.id(), sessionId, options);
  }

  /** Send input to the terminal. */
  async sendInput(
    sessionId: string,
    data: string | Uint8Array,
    options?: RequestOptions,
  ): Promise<PtyInputResponse> {
    return this.runtimes.pty.sendInput(this.id(), sessionId, data, options);
  }

  /** Resize the terminal. */
  async resize(
    sessionId: string,
    cols: number,
    rows: number,
    options?: RequestOptions,
  ): Promise<boolean> {
    return this.runtimes.pty.resize(this.id(), sessionId, cols, rows, options);
  }

  /** Signal the foreground process. */
  async sendSignal(sessionId: string, signal: string, options?: RequestOptions): Promise<boolean> {
    return this.runtimes.pty.sendSignal(this.id(), sessionId, signal, options);
  }

  /** Terminate a session. */
  async kill(sessionId: string, options?: RequestOptions): Promise<boolean> {
    return this.runtimes.pty.kill(this.id(), sessionId, options);
  }

  /** Stream terminal output. */
  async *stream(
    sessionId: string,
    options?: RequestOptions,
  ): AsyncGenerator<PtyStreamEvent, void, undefined> {
    yield* this.runtimes.pty.stream(this.id(), sessionId, options);
  }

  /** Get a stateful handle that buffers output and tracks the exit code. */
  handle(sessionId: string): PtyHandle {
    return this.runtimes.pty.handle(this.id(), sessionId);
  }

  /** Start a session and immediately attach to its output. */
  async open(options?: CreatePtyOptions): Promise<PtyHandle> {
    const session = await this.create(options);
    return this.handle(session.sessionId).connect();
  }
}

/** `runtime.git`: git operations with the runtime id already applied. */
export class BoundGit {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  /** Clone a repository into the guest. */
  async clone(url: string, path: string, options?: GitCloneOptions): Promise<GitOperationResult> {
    return this.runtimes.git.clone(this.id(), url, path, options);
  }

  /** Report the working tree status. */
  async status(repositoryPath: string, options?: RequestOptions): Promise<GitOperationResult> {
    return this.runtimes.git.status(this.id(), repositoryPath, options);
  }

  /** List branches. */
  async branchList(
    repositoryPath: string,
    scope?: BranchScope,
    options?: RequestOptions,
  ): Promise<GitOperationResult> {
    return this.runtimes.git.branchList(this.id(), repositoryPath, scope, options);
  }

  /** Check out a branch, tag, or commit. */
  async checkout(
    repositoryPath: string,
    ref: string,
    options?: RequestOptions,
  ): Promise<GitOperationResult> {
    return this.runtimes.git.checkout(this.id(), repositoryPath, ref, options);
  }

  /** Fetch and merge from a remote. */
  async pull(repositoryPath: string, options?: GitFetchOptions): Promise<GitOperationResult> {
    return this.runtimes.git.pull(this.id(), repositoryPath, options);
  }

  /** Fetch from a remote without merging. */
  async fetch(repositoryPath: string, options?: GitFetchOptions): Promise<GitOperationResult> {
    return this.runtimes.git.fetch(this.id(), repositoryPath, options);
  }

  /** Push to a remote. */
  async push(repositoryPath: string, options?: GitPushOptions): Promise<GitOperationResult> {
    return this.runtimes.git.push(this.id(), repositoryPath, options);
  }

  /** Stage paths. Omit `paths` to stage everything. */
  async add(
    repositoryPath: string,
    paths?: readonly string[],
    options?: RequestOptions,
  ): Promise<GitOperationResult> {
    return this.runtimes.git.add(this.id(), repositoryPath, paths, options);
  }

  /** Commit staged changes. */
  async commit(
    repositoryPath: string,
    message: string,
    options?: GitCommitOptions,
  ): Promise<GitOperationResult> {
    return this.runtimes.git.commit(this.id(), repositoryPath, message, options);
  }

  /** Create a branch. */
  async createBranch(
    repositoryPath: string,
    branchName: string,
    startPoint?: string,
    options?: RequestOptions,
  ): Promise<GitOperationResult> {
    return this.runtimes.git.createBranch(
      this.id(),
      repositoryPath,
      branchName,
      startPoint,
      options,
    );
  }

  /** Delete a branch. */
  async deleteBranch(
    repositoryPath: string,
    branchName: string,
    force?: boolean,
    options?: RequestOptions,
  ): Promise<GitOperationResult> {
    return this.runtimes.git.deleteBranch(this.id(), repositoryPath, branchName, force, options);
  }
}

/** `runtime.services`: published ports with the runtime id already applied. */
export class BoundServices {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  /** Publish a guest port and return its URL. */
  async publish(port: number, options?: PublishOptions): Promise<RuntimeWebService> {
    return this.runtimes.services.publish(this.id(), port, options);
  }

  /** Publish a port and return a client bound to its URL. */
  async connect(port: number, options?: PublishOptions): Promise<ServiceHandle> {
    return this.runtimes.services.connect(this.id(), port, options);
  }

  /** List the runtime's published services. */
  async list(options?: RequestOptions): Promise<RuntimeWebService[]> {
    return this.runtimes.services.list(this.id(), options);
  }

  /** Stop publishing a port. */
  async revoke(port: number, options?: RequestOptions): Promise<void> {
    return this.runtimes.services.revoke(this.id(), port, options);
  }
}

// Where the native symbol exists, an alias under the registered symbol keeps
// `await using` working for callers whose compiler targets an older runtime.
if (ASYNC_DISPOSE !== REGISTERED_ASYNC_DISPOSE) {
  Object.defineProperty(Runtime.prototype, REGISTERED_ASYNC_DISPOSE, {
    value: Runtime.prototype[ASYNC_DISPOSE],
    configurable: true,
    writable: true,
  });
}
