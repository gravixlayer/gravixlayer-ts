/**
 * A handle to one runtime.
 *
 * `client.runtime.create()` and `client.runtime.get()` return this instead of
 * a plain object, so every operation is available without repeating the
 * runtime id: `sandbox.runCode(...)`, `sandbox.file.write(...)`,
 * `sandbox.kill()`.
 */

import type { BinaryLike } from '../../core/binary.js';
import { GravixLayerInvalidArgumentError } from '../../core/errors.js';
import type { RequestOptions } from '../../core/transport.js';
import type { FileMode } from '../../core/uploads.js';
import type { RuntimeMount, RuntimeMountList } from '../../types/storage.js';
import type { MountInput } from '../storage.js';
import {
  Execution,
  type CommandInfo,
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
  DeleteOptions,
  FindOptions,
  MoveOptions,
  ReplaceOptions,
  UploadOptions,
  WatchOptions,
  WriteEntry,
  WriteManyOptions,
} from './files.js';
import type {
  BranchScope,
  GitCloneOptions,
  GitCommitOptions,
  GitFetchOptions,
  GitPushOptions,
} from './git.js';
import type { BrowserEvent, RuntimeBrowser } from './browser.js';
import type { RuntimeDesktop } from './desktop.js';
import type { CreatePtyOptions, PtyHandle, PtyStreamEvent } from './pty.js';
import type { ForkRuntimeOptions } from './runtimes.js';
import type { ForkResponse } from '../../types/snapshots.js';
import type {
  CodeCallbacks,
  CodeStreamEvent,
  CommandCallbacks,
  CommandHandle,
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
  readonly file: BoundFile;
  /** Nested terminal API, already bound to this runtime. */
  readonly pty: BoundPty;
  /** Nested git API, already bound to this runtime. */
  readonly git: BoundGit;
  /** Desktop: screenshots, mouse, keyboard, windows, view, session. */
  readonly desktop: BoundDesktop;
  /** Browser plane: open/navigate/snapshot/actions. */
  readonly browser: BoundBrowser;
  /** Storage mounts attached to this runtime. */
  readonly mounts: BoundMounts;
  /** Background commands on this runtime. */
  readonly command: BoundCommands;

  private state: RuntimeInfo;
  private killed = false;
  private killing: Promise<void> | undefined;

  constructor(
    private readonly runtimes: Runtimes,
    info: RuntimeInfo,
  ) {
    this.state = info;

    const resolve: ResolveId = () => this.requireAlive();
    this.file = new BoundFile(runtimes, resolve);
    this.pty = new BoundPty(runtimes, resolve);
    this.git = new BoundGit(runtimes, resolve);
    this.command = new BoundCommands(runtimes, resolve);
    this.desktop = new BoundDesktop(runtimes, resolve);
    this.browser = new BoundBrowser(runtimes, resolve);
    this.mounts = new BoundMounts(runtimes, resolve);
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
   *   await using sandbox = await client.runtime.create();
   *   await sandbox.runCmd('npm test');
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

  /**
   * Fork this runtime into `count` independent children — the parent's state
   * is captured once and every child restores from it. This runtime keeps
   * running unchanged; results are per-child (`forkRuntimes`/`forkErrors`).
   */
  async fork(options: ForkRuntimeOptions = {}): Promise<ForkResponse> {
    return this.runtimes.fork(this.requireAlive(), options);
  }

  /** Change how long the runtime may keep running. */
  async setTimeout(timeout: number, options: RequestOptions = {}): Promise<RuntimeTimeoutResponse> {
    return this.runtimes.setTimeout(this.requireAlive(), timeout, options);
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
   * const result = await sandbox.runCode('print("hello")');
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
   * const result = await sandbox.runCmd('node -v');
   * console.log(result.stdout.trim());
   * ```
   */
  async runCmd(
    command: string,
    options: RunCommandOptions & { background: true },
  ): Promise<CommandHandle>;
  async runCmd(command: string, options?: RunCommandOptions): Promise<Execution>;
  async runCmd(
    command: string,
    options: RunCommandOptions = {},
  ): Promise<Execution | CommandHandle> {
    if (options.background) {
      return this.runtimes.runCmd(this.requireAlive(), command, { ...options, background: true });
    }
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
   * Matches `client.runtime.service.connect(runtimeId, port)`. List and revoke
   * stay on `client.runtime.service`.
   */
  async service(port: number, options: PublishOptions = {}): Promise<ServiceHandle> {
    return this.runtimes.service.connect(this.requireAlive(), port, options);
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
 * `sandbox.file`: the filesystem API with the runtime id already applied.
 *
 * Every method mirrors `client.runtime.file`, minus the first argument.
 */
export class BoundFile {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  /** Read a text file. */
  async read(path: string, options?: RequestOptions): Promise<FileReadResponse> {
    return this.runtimes.file.read(this.id(), path, options);
  }

  /** Write a text file, creating or replacing it. */
  async write(path: string, content: string, options?: RequestOptions): Promise<FileWriteResponse> {
    return this.runtimes.file.write(this.id(), path, content, options);
  }

  /** Delete a file or directory. */
  async delete(path: string, options?: DeleteOptions): Promise<FileDeleteResponse> {
    return this.runtimes.file.delete(this.id(), path, options);
  }

  /** List the entries in a directory. */
  async list(path?: string, options?: RequestOptions): Promise<FileListResponse> {
    return this.runtimes.file.list(this.id(), path, options);
  }

  /** Upload binary or text content to a path. */
  async upload(path: string, data: BinaryLike, options?: UploadOptions): Promise<WriteResult> {
    return this.runtimes.file.upload(this.id(), path, data, options);
  }

  /** Upload several files, each to its own destination path. */
  async writeMany(
    entries: readonly WriteEntry[],
    options?: WriteManyOptions,
  ): Promise<WriteFilesResponse> {
    return this.runtimes.file.writeMany(this.id(), entries, options);
  }

  /** Create a directory. */
  async createDirectory(
    path: string,
    options?: CreateDirectoryOptions,
  ): Promise<DirectoryCreateResponse> {
    return this.runtimes.file.createDirectory(this.id(), path, options);
  }

  /** Look up metadata for a path. */
  async getInfo(path: string, options?: RequestOptions): Promise<FileGetInfoResponse> {
    return this.runtimes.file.getInfo(this.id(), path, options);
  }

  /** Change a path's permission bits. */
  async setPermissions(
    path: string,
    mode: FileMode,
    options?: RequestOptions,
  ): Promise<SetPermissionsResponse> {
    return this.runtimes.file.setPermissions(this.id(), path, mode, options);
  }

  /** Move or rename a path. */
  async move(
    source: string,
    destination: string,
    options?: MoveOptions,
  ): Promise<FileMoveResponse> {
    return this.runtimes.file.move(this.id(), source, destination, options);
  }

  /** Copy a path. */
  async copy(
    source: string,
    destination: string,
    options?: CopyOptions,
  ): Promise<FileCopyResponse> {
    return this.runtimes.file.copy(this.id(), source, destination, options);
  }

  /** Change a path's owner, group, or both. */
  async chown(path: string, options?: ChownOptions): Promise<ChangeOwnerResponse> {
    return this.runtimes.file.chown(this.id(), path, options);
  }

  /** Watch a path for changes. */
  async *watch(path: string, options?: WatchOptions): AsyncGenerator<WatchEvent, void, undefined> {
    yield* this.runtimes.file.watch(this.id(), path, options);
  }

  /** Search for files by name or content. */
  async find(path: string, options?: FindOptions): Promise<FileFindResponse> {
    return this.runtimes.file.find(this.id(), path, options);
  }

  /** Replace text across files under a path. */
  async replace(
    path: string,
    pattern: string,
    replacement: string,
    options?: ReplaceOptions,
  ): Promise<FileReplaceResponse> {
    return this.runtimes.file.replace(this.id(), path, pattern, replacement, options);
  }

  /** Upload through the legacy single-file endpoint. */
  async uploadFile(
    data: BinaryLike,
    path?: string,
    options?: RequestOptions,
  ): Promise<FileUploadResponse> {
    return this.runtimes.file.uploadFile(this.id(), data, path, options);
  }

  /** Download a file's raw bytes. */
  async download(path: string, options?: RequestOptions): Promise<Uint8Array> {
    return this.runtimes.file.download(this.id(), path, options);
  }

  /** Download a file and decode it as UTF-8 text. */
  async downloadText(path: string, options?: RequestOptions): Promise<string> {
    return this.runtimes.file.downloadText(this.id(), path, options);
  }
}

/** `sandbox.pty`: terminal sessions with the runtime id already applied. */
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

/** `sandbox.git`: git operations with the runtime id already applied. */
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

/** Background commands, already bound to one runtime. */
class BoundCommands {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  list(options?: RequestOptions): Promise<CommandInfo[]> {
    return this.runtimes.command.list(this.id(), options);
  }

  get(pid: number, options?: RequestOptions): Promise<CommandInfo> {
    return this.runtimes.command.get(this.id(), pid, options);
  }

  connect(pid: number, options?: CommandCallbacks): Promise<Execution> {
    return this.runtimes.command
      .connect(this.id(), pid, options)
      .then((result) => new Execution(result));
  }

  kill(
    pid: number,
    signal?: 'KILL' | 'TERM' | 'INT' | 'HUP',
    options?: RequestOptions,
  ): Promise<CommandInfo> {
    return this.runtimes.command.kill(this.id(), pid, signal, options);
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

/** `sandbox.desktop`: the pixel plane with the runtime id applied. */
export class BoundDesktop {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  async enable(options?: Parameters<RuntimeDesktop['enable']>[1]) {
    return this.runtimes.desktop.enable(this.id(), options);
  }
  async disable(options?: RequestOptions) {
    return this.runtimes.desktop.disable(this.id(), options);
  }
  async status(options?: RequestOptions) {
    return this.runtimes.desktop.status(this.id(), options);
  }
  async screenshot(options?: Parameters<RuntimeDesktop['screenshot']>[1]) {
    return this.runtimes.desktop.screenshot(this.id(), options);
  }
  async click(
    x: number,
    y: number,
    button?: 'left' | 'right' | 'middle',
    options?: RequestOptions,
  ) {
    return this.runtimes.desktop.click(this.id(), x, y, button, options);
  }
  async move(x: number, y: number, options?: RequestOptions) {
    return this.runtimes.desktop.move(this.id(), x, y, options);
  }
  async scroll(dx: number, dy: number, options?: Parameters<RuntimeDesktop['scroll']>[3]) {
    return this.runtimes.desktop.scroll(this.id(), dx, dy, options);
  }
  async type(text: string, options?: Parameters<RuntimeDesktop['type']>[2]) {
    return this.runtimes.desktop.type(this.id(), text, options);
  }
  async press(key: string, options?: RequestOptions) {
    return this.runtimes.desktop.press(this.id(), key, options);
  }
  async hotkey(keys: string[], options?: RequestOptions) {
    return this.runtimes.desktop.hotkey(this.id(), keys, options);
  }
  async waitStable(stableMs?: number, timeoutMs?: number, options?: RequestOptions) {
    return this.runtimes.desktop.waitStable(this.id(), stableMs, timeoutMs, options);
  }
  async view(options?: Parameters<RuntimeDesktop['view']>[1]) {
    return this.runtimes.desktop.view(this.id(), options);
  }
  async stopView(options?: RequestOptions) {
    return this.runtimes.desktop.stopView(this.id(), options);
  }
  async info(options?: RequestOptions) {
    return this.runtimes.desktop.info(this.id(), options);
  }
  async position(options?: RequestOptions) {
    return this.runtimes.desktop.position(this.id(), options);
  }
  async keys(options?: RequestOptions) {
    return this.runtimes.desktop.keys(this.id(), options);
  }
  async down(
    x?: number,
    y?: number,
    button?: 'left' | 'right' | 'middle',
    options?: RequestOptions,
  ) {
    return this.runtimes.desktop.down(this.id(), x, y, button, options);
  }
  async up(button?: 'left' | 'right' | 'middle', options?: Parameters<RuntimeDesktop['up']>[2]) {
    return this.runtimes.desktop.up(this.id(), button, options);
  }
  async drag(
    toX: number,
    toY: number,
    button?: Parameters<RuntimeDesktop['drag']>[3],
    options?: Parameters<RuntimeDesktop['drag']>[4],
  ) {
    return this.runtimes.desktop.drag(this.id(), toX, toY, button, options);
  }
  async getClipboard(options?: RequestOptions) {
    return this.runtimes.desktop.getClipboard(this.id(), options);
  }
  async setClipboard(text: string, options?: RequestOptions) {
    return this.runtimes.desktop.setClipboard(this.id(), text, options);
  }
  async getClipboardImage(options?: RequestOptions) {
    return this.runtimes.desktop.getClipboardImage(this.id(), options);
  }
  async setClipboardImage(pngBase64: string, options?: RequestOptions) {
    return this.runtimes.desktop.setClipboardImage(this.id(), pngBase64, options);
  }
  async act(options: Parameters<RuntimeDesktop['act']>[1]) {
    return this.runtimes.desktop.act(this.id(), options);
  }
  async resize(width: number, height: number, options?: RequestOptions) {
    return this.runtimes.desktop.resize(this.id(), width, height, options);
  }
  async windows(options?: Parameters<RuntimeDesktop['windows']>[1]) {
    return this.runtimes.desktop.windows(this.id(), options);
  }
  async windowOp(
    windowId: number,
    op: Parameters<RuntimeDesktop['windowOp']>[2],
    options?: Parameters<RuntimeDesktop['windowOp']>[3],
  ) {
    return this.runtimes.desktop.windowOp(this.id(), windowId, op, options);
  }
  async apps(options?: RequestOptions) {
    return this.runtimes.desktop.apps(this.id(), options);
  }
  async launchApp(app: string, options?: Parameters<RuntimeDesktop['launchApp']>[2]) {
    return this.runtimes.desktop.launchApp(this.id(), app, options);
  }
  async open(target: string, options?: Parameters<RuntimeDesktop['open']>[2]) {
    return this.runtimes.desktop.open(this.id(), target, options);
  }

  // ── accessibility, recordings, takeover ──────────────────────────────

  async a11ySnapshot(options?: Parameters<RuntimeDesktop['a11ySnapshot']>[1]) {
    return this.runtimes.desktop.a11ySnapshot(this.id(), options);
  }
  async a11yFind(options?: Parameters<RuntimeDesktop['a11yFind']>[1]) {
    return this.runtimes.desktop.a11yFind(this.id(), options);
  }
  async a11yAction(
    op: Parameters<RuntimeDesktop['a11yAction']>[1],
    ref: string,
    options?: Parameters<RuntimeDesktop['a11yAction']>[3],
  ) {
    return this.runtimes.desktop.a11yAction(this.id(), op, ref, options);
  }
  async recordStart(options?: Parameters<RuntimeDesktop['recordStart']>[1]) {
    return this.runtimes.desktop.recordStart(this.id(), options);
  }
  async recordings(options?: RequestOptions) {
    return this.runtimes.desktop.recordings(this.id(), options);
  }
  async recording(recordingId: string, options?: RequestOptions) {
    return this.runtimes.desktop.recording(this.id(), recordingId, options);
  }
  async recordStop(recordingId: string, options?: RequestOptions) {
    return this.runtimes.desktop.recordStop(this.id(), recordingId, options);
  }
  async recordMark(recordingId: string, label: string, options?: RequestOptions) {
    return this.runtimes.desktop.recordMark(this.id(), recordingId, label, options);
  }
  async recordDelete(recordingId: string, options?: RequestOptions) {
    return this.runtimes.desktop.recordDelete(this.id(), recordingId, options);
  }
  async viewControl(mode: 'shared' | 'human' | 'agent', options?: RequestOptions) {
    return this.runtimes.desktop.viewControl(this.id(), mode, options);
  }

  // ── session plane ─────────────────────────────────────────────────────

  async components(options?: RequestOptions) {
    return this.runtimes.desktop.components(this.id(), options);
  }
  async component(name: string, op: 'start' | 'stop' | 'restart', options?: RequestOptions) {
    return this.runtimes.desktop.component(this.id(), name, op, options);
  }
  async startComponent(name: string, options?: RequestOptions) {
    return this.runtimes.desktop.startComponent(this.id(), name, options);
  }
  async stopComponent(name: string, options?: RequestOptions) {
    return this.runtimes.desktop.stopComponent(this.id(), name, options);
  }
  async restartComponent(name: string, options?: RequestOptions) {
    return this.runtimes.desktop.restartComponent(this.id(), name, options);
  }
  async logs(name: string, options?: Parameters<RuntimeDesktop['logs']>[2]) {
    return this.runtimes.desktop.logs(this.id(), name, options);
  }

  // ── simple mouse/keyboard conveniences ────────────────────────────────

  async leftClick(x?: number, y?: number, options?: RequestOptions) {
    return this.runtimes.desktop.leftClick(this.id(), x, y, options);
  }
  async doubleClick(x?: number, y?: number, options?: RequestOptions) {
    return this.runtimes.desktop.doubleClick(this.id(), x, y, options);
  }
  async rightClick(x?: number, y?: number, options?: RequestOptions) {
    return this.runtimes.desktop.rightClick(this.id(), x, y, options);
  }
  async middleClick(x?: number, y?: number, options?: RequestOptions) {
    return this.runtimes.desktop.middleClick(this.id(), x, y, options);
  }
  async mousePress(
    button?: 'left' | 'right' | 'middle',
    x?: number,
    y?: number,
    options?: RequestOptions,
  ) {
    return this.runtimes.desktop.mousePress(this.id(), button, x, y, options);
  }
  async mouseRelease(
    button?: 'left' | 'right' | 'middle',
    x?: number,
    y?: number,
    options?: RequestOptions,
  ) {
    return this.runtimes.desktop.mouseRelease(this.id(), button, x, y, options);
  }
  async moveMouse(x: number, y: number, options?: RequestOptions) {
    return this.runtimes.desktop.moveMouse(this.id(), x, y, options);
  }
  async write(text: string, delayMs?: number, options?: RequestOptions) {
    return this.runtimes.desktop.write(this.id(), text, delayMs, options);
  }
}

/** `sandbox.mounts`: storage mounts bound to this runtime. */
export class BoundMounts {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  /** Attach a bucket or git repository at a guest path. */
  async attach(mount: MountInput, options?: RequestOptions): Promise<RuntimeMount> {
    return this.runtimes.mounts.attach(this.id(), mount, options);
  }

  /** List this runtime's mounts and their states. */
  async list(options?: RequestOptions): Promise<RuntimeMountList> {
    return this.runtimes.mounts.list(this.id(), options);
  }

  /** Detach a mount by attachment id. */
  async detach(attachmentId: string, options?: RequestOptions): Promise<boolean> {
    return this.runtimes.mounts.detach(this.id(), attachmentId, options);
  }
}

/** `sandbox.browser`: the semantic plane with the runtime id applied. */
export class BoundBrowser {
  constructor(
    private readonly runtimes: Runtimes,
    private readonly id: ResolveId,
  ) {}

  async open(options?: Parameters<RuntimeBrowser['open']>[1]) {
    return this.runtimes.browser.open(this.id(), options);
  }
  async goto(url: string, options?: Parameters<RuntimeBrowser['goto']>[2]) {
    return this.runtimes.browser.goto(this.id(), url, options);
  }
  async close(browserId: string, options?: RequestOptions) {
    return this.runtimes.browser.close(this.id(), browserId, options);
  }
  async list(options?: RequestOptions) {
    return this.runtimes.browser.list(this.id(), options);
  }
  async status(browserId: string, options?: RequestOptions) {
    return this.runtimes.browser.status(this.id(), browserId, options);
  }
  async navigate(
    browserId: string,
    url: string,
    options?: Parameters<RuntimeBrowser['navigate']>[3],
  ) {
    return this.runtimes.browser.navigate(this.id(), browserId, url, options);
  }
  async command(
    browserId: string,
    verb: 'back' | 'forward' | 'reload' | 'activate',
    targetId?: string,
    options?: RequestOptions,
  ) {
    return this.runtimes.browser.command(this.id(), browserId, verb, targetId, options);
  }
  async back(browserId: string, targetId?: string, options?: RequestOptions) {
    return this.runtimes.browser.back(this.id(), browserId, targetId, options);
  }
  async forward(browserId: string, targetId?: string, options?: RequestOptions) {
    return this.runtimes.browser.forward(this.id(), browserId, targetId, options);
  }
  async reload(browserId: string, targetId?: string, options?: RequestOptions) {
    return this.runtimes.browser.reload(this.id(), browserId, targetId, options);
  }
  async activate(browserId: string, targetId: string, options?: RequestOptions) {
    return this.runtimes.browser.activate(this.id(), browserId, targetId, options);
  }
  async screenshot(browserId: string, options?: Parameters<RuntimeBrowser['screenshot']>[2]) {
    return this.runtimes.browser.screenshot(this.id(), browserId, options);
  }
  async snapshot(browserId: string, options?: Parameters<RuntimeBrowser['snapshot']>[2]) {
    return this.runtimes.browser.snapshot(this.id(), browserId, options);
  }
  async evaluate(
    browserId: string,
    expression: string,
    options?: Parameters<RuntimeBrowser['evaluate']>[3],
  ) {
    return this.runtimes.browser.evaluate(this.id(), browserId, expression, options);
  }
  async click(
    browserId: string,
    target: Parameters<RuntimeBrowser['click']>[2],
    options?: Parameters<RuntimeBrowser['click']>[3],
  ) {
    return this.runtimes.browser.click(this.id(), browserId, target, options);
  }
  async dblclick(
    browserId: string,
    target: Parameters<RuntimeBrowser['dblclick']>[2],
    options?: Parameters<RuntimeBrowser['dblclick']>[3],
  ) {
    return this.runtimes.browser.dblclick(this.id(), browserId, target, options);
  }
  async hover(
    browserId: string,
    target: Parameters<RuntimeBrowser['hover']>[2],
    options?: Parameters<RuntimeBrowser['hover']>[3],
  ) {
    return this.runtimes.browser.hover(this.id(), browserId, target, options);
  }
  async fill(
    browserId: string,
    target: Parameters<RuntimeBrowser['fill']>[2],
    options?: Parameters<RuntimeBrowser['fill']>[3],
  ) {
    return this.runtimes.browser.fill(this.id(), browserId, target, options);
  }
  async type(
    browserId: string,
    target: Parameters<RuntimeBrowser['type']>[2],
    text: string,
    options?: Parameters<RuntimeBrowser['type']>[4],
  ) {
    return this.runtimes.browser.type(this.id(), browserId, target, text, options);
  }
  async press(browserId: string, key: string, options?: Parameters<RuntimeBrowser['press']>[3]) {
    return this.runtimes.browser.press(this.id(), browserId, key, options);
  }
  async hotkey(
    browserId: string,
    keys: string[],
    options?: Parameters<RuntimeBrowser['hotkey']>[3],
  ) {
    return this.runtimes.browser.hotkey(this.id(), browserId, keys, options);
  }
  async scroll(browserId: string, options?: Parameters<RuntimeBrowser['scroll']>[2]) {
    return this.runtimes.browser.scroll(this.id(), browserId, options);
  }
  async dialog(browserId: string, options?: Parameters<RuntimeBrowser['dialog']>[2]) {
    return this.runtimes.browser.dialog(this.id(), browserId, options);
  }
  async targets(browserId: string, options?: Parameters<RuntimeBrowser['targets']>[2]) {
    return this.runtimes.browser.targets(this.id(), browserId, options);
  }
  async downloads(browserId: string, options?: Parameters<RuntimeBrowser['downloads']>[2]) {
    return this.runtimes.browser.downloads(this.id(), browserId, options);
  }
  async download(
    browserId: string,
    downloadId: string,
    options?: Parameters<RuntimeBrowser['download']>[3],
  ) {
    return this.runtimes.browser.download(this.id(), browserId, downloadId, options);
  }
  async pdf(browserId: string, targetId: string, options?: Parameters<RuntimeBrowser['pdf']>[3]) {
    return this.runtimes.browser.pdf(this.id(), browserId, targetId, options);
  }
  async view(browserId: string, options?: Parameters<RuntimeBrowser['view']>[2]) {
    return this.runtimes.browser.view(this.id(), browserId, options);
  }
  events(
    browserId: string,
    options?: Parameters<RuntimeBrowser['events']>[2],
  ): AsyncGenerator<BrowserEvent, void, undefined> {
    return this.runtimes.browser.events(this.id(), browserId, options);
  }
  async contextCreate(browserId: string, options?: Parameters<RuntimeBrowser['contextCreate']>[2]) {
    return this.runtimes.browser.contextCreate(this.id(), browserId, options);
  }
  async contexts(browserId: string, options?: RequestOptions) {
    return this.runtimes.browser.contexts(this.id(), browserId, options);
  }
  async contextDelete(browserId: string, contextId: string, options?: RequestOptions) {
    return this.runtimes.browser.contextDelete(this.id(), browserId, contextId, options);
  }
  async storageExport(browserId: string, options?: Parameters<RuntimeBrowser['storageExport']>[2]) {
    return this.runtimes.browser.storageExport(this.id(), browserId, options);
  }
  async storageImport(
    browserId: string,
    storageState: Record<string, unknown>,
    options?: Parameters<RuntimeBrowser['storageImport']>[3],
  ) {
    return this.runtimes.browser.storageImport(this.id(), browserId, storageState, options);
  }
}
