/**
 * Types returned by the runtime API: runtimes themselves, code and command
 * execution, the guest filesystem, PTY sessions, git, SSH, and web services.
 */

import {
  asRecord,
  bool,
  firstStr,
  jsonMap,
  num,
  optBool,
  optNum,
  optStr,
  parseList,
  str,
  strArray,
} from '../core/parse.js';

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** A runtime: an isolated virtual machine that runs code on demand. */
export interface RuntimeInfo {
  /** Unique identifier (UUID). */
  runtimeId: string;
  /** Lifecycle state, for example `running` or `paused`. */
  status: string;
  /** Template name the runtime was created from. */
  template?: string;
  /** Template identifier the runtime was created from. */
  templateId?: string;
  /** Cloud the runtime is placed on. */
  cloud?: string;
  /** Region the runtime is placed in. */
  region?: string;
  /** ISO-8601 timestamp of when the runtime started. */
  startedAt?: string;
  /** ISO-8601 timestamp of when the runtime will expire. */
  timeoutAt?: string;
  /** ISO-8601 timestamp of when the runtime stopped. */
  endedAt?: string;
  /** Number of virtual CPUs. */
  cpuCount?: number;
  /** Memory in mebibytes. */
  memoryMb?: number;
  /** Disk size in mebibytes. */
  diskSizeMb?: number;
  /** Caller-supplied labels attached at creation. */
  metadata?: Record<string, unknown>;
  /** Private address of the runtime inside its network. */
  ipAddress?: string;
  /** Whether SSH access is currently enabled. */
  sshEnabled?: boolean;
}

/**
 * Parse a runtime payload.
 *
 * Tolerates the older field names still returned by some endpoints: `id` for
 * the identifier, `provider` or `compute_provider` for the cloud,
 * `compute_region` for the region, and `tags` for metadata.
 */
export function parseRuntimeInfo(data: Record<string, unknown>): RuntimeInfo {
  const info: RuntimeInfo = {
    runtimeId: firstStr(data, ['runtime_id', 'id']) ?? '',
    status: str(data, 'status'),
  };

  const template = optStr(data, 'template');
  if (template !== undefined) info.template = template;

  const templateId = optStr(data, 'template_id');
  if (templateId !== undefined) info.templateId = templateId;

  const cloud = firstStr(data, ['cloud', 'compute_provider', 'provider']);
  if (cloud !== undefined) info.cloud = cloud;

  const region = firstStr(data, ['region', 'compute_region']);
  if (region !== undefined) info.region = region;

  const startedAt = optStr(data, 'started_at');
  if (startedAt !== undefined) info.startedAt = startedAt;

  const timeoutAt = optStr(data, 'timeout_at');
  if (timeoutAt !== undefined) info.timeoutAt = timeoutAt;

  const endedAt = optStr(data, 'ended_at');
  if (endedAt !== undefined) info.endedAt = endedAt;

  const cpuCount = optNum(data, 'cpu_count');
  if (cpuCount !== undefined) info.cpuCount = cpuCount;

  const memoryMb = optNum(data, 'memory_mb');
  if (memoryMb !== undefined) info.memoryMb = memoryMb;

  const diskSizeMb = optNum(data, 'disk_size_mb');
  if (diskSizeMb !== undefined) info.diskSizeMb = diskSizeMb;

  const metadata = jsonMap(data, 'metadata') ?? jsonMap(data, 'tags');
  if (metadata !== undefined) info.metadata = metadata;

  const ipAddress = optStr(data, 'ip_address');
  if (ipAddress !== undefined) info.ipAddress = ipAddress;

  const sshEnabled = optBool(data, 'ssh_enabled');
  if (sshEnabled !== undefined) info.sshEnabled = sshEnabled;

  return info;
}

/** One page of runtimes. */
export interface RuntimeList {
  runtimes: RuntimeInfo[];
  /** Total number of runtimes matching the query, across all pages. */
  total: number;
}

/** Resource usage sampled from a running runtime. */
export interface RuntimeMetrics {
  /** ISO-8601 timestamp of the sample. */
  timestamp: string;
  /** CPU utilisation as a percentage. */
  cpuUsage: number;
  /** Memory in use, in bytes. */
  memoryUsage: number;
  /** Memory available to the runtime, in bytes. */
  memoryTotal: number;
  /** Bytes read from disk since boot. */
  diskRead: number;
  /** Bytes written to disk since boot. */
  diskWrite: number;
  /** Bytes received on the network since boot. */
  networkRx: number;
  /** Bytes transmitted on the network since boot. */
  networkTx: number;
}

export function parseRuntimeMetrics(data: Record<string, unknown>): RuntimeMetrics {
  return {
    timestamp: str(data, 'timestamp'),
    cpuUsage: num(data, 'cpu_usage'),
    memoryUsage: num(data, 'memory_usage'),
    memoryTotal: num(data, 'memory_total'),
    diskRead: num(data, 'disk_read'),
    diskWrite: num(data, 'disk_write'),
    networkRx: num(data, 'network_rx'),
    networkTx: num(data, 'network_tx'),
  };
}

/** Result of extending or setting a runtime's expiry. */
export interface RuntimeTimeoutResponse {
  message: string;
  /** New timeout in seconds. */
  timeout?: number;
  /** ISO-8601 timestamp when the runtime will now expire. */
  timeoutAt?: string;
}

export function parseRuntimeTimeoutResponse(data: Record<string, unknown>): RuntimeTimeoutResponse {
  const out: RuntimeTimeoutResponse = { message: str(data, 'message') };
  const timeout = optNum(data, 'timeout');
  if (timeout !== undefined) out.timeout = timeout;
  const timeoutAt = optStr(data, 'timeout_at');
  if (timeoutAt !== undefined) out.timeoutAt = timeoutAt;
  return out;
}

/** Result of terminating a runtime. */
export interface RuntimeKillResponse {
  message: string;
  runtimeId?: string;
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

/** Connection details returned when SSH is enabled on a runtime. */
export interface SSHInfo {
  runtimeId: string;
  enabled: boolean;
  /** Port to connect to. */
  port: number;
  /** Login user. */
  username: string;
  /** A ready-to-paste `ssh` command. */
  connectCmd: string;
  /** Generated private key, returned only when keys are created or rotated. */
  privateKey?: string;
  /** Matching public key. */
  publicKey?: string;
  /** A ready-to-paste `~/.ssh/config` stanza. */
  sshConfig?: string;
  message?: string;
}

export function parseSSHInfo(data: Record<string, unknown>): SSHInfo {
  const info: SSHInfo = {
    runtimeId: str(data, 'runtime_id'),
    enabled: bool(data, 'enabled'),
    port: num(data, 'port'),
    username: str(data, 'username'),
    connectCmd: str(data, 'connect_cmd'),
  };
  const privateKey = optStr(data, 'private_key');
  if (privateKey !== undefined) info.privateKey = privateKey;
  const publicKey = optStr(data, 'public_key');
  if (publicKey !== undefined) info.publicKey = publicKey;
  const sshConfig = optStr(data, 'ssh_config');
  if (sshConfig !== undefined) info.sshConfig = sshConfig;
  const message = optStr(data, 'message');
  if (message !== undefined) info.message = message;
  return info;
}

/** Current SSH state of a runtime. */
export interface SSHStatus {
  runtimeId: string;
  enabled: boolean;
  port: number;
  username: string;
  /** Whether the SSH daemon is currently accepting connections. */
  daemonRunning: boolean;
}

export function parseSSHStatus(data: Record<string, unknown>): SSHStatus {
  return {
    runtimeId: str(data, 'runtime_id'),
    enabled: bool(data, 'enabled'),
    port: num(data, 'port'),
    username: str(data, 'username'),
    daemonRunning: bool(data, 'daemon_running'),
  };
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** Contents of a file read from the guest. */
export interface FileReadResponse {
  content: string;
  path?: string;
  /** Size in bytes. Computed from the content when the API omits it. */
  size?: number;
}

/** Result of writing a file. */
export interface FileWriteResponse {
  message: string;
  path?: string;
  bytesWritten?: number;
}

/** Result of deleting a file. */
export interface FileDeleteResponse {
  message: string;
  path?: string;
}

/** A directory entry. */
export interface FileInfo {
  name: string;
  /** Size in bytes. */
  size: number;
  isDir: boolean;
  /** ISO-8601 timestamp of the last modification. */
  modifiedAt: string;
  /** Permission bits as an octal string. */
  mode?: string;
  /** Absolute path, when the API reports it. */
  path?: string;
  /** Human-readable permissions, for example `rwxr-xr-x`. */
  permissions?: string;
}

export function parseFileInfo(data: Record<string, unknown>): FileInfo {
  const info: FileInfo = {
    name: str(data, 'name'),
    size: num(data, 'size'),
    isDir: bool(data, 'is_dir'),
    modifiedAt: str(data, 'modified_at'),
  };
  const mode = optStr(data, 'mode');
  if (mode !== undefined) info.mode = mode;
  const path = optStr(data, 'path');
  if (path !== undefined) info.path = path;
  const permissions = optStr(data, 'permissions');
  if (permissions !== undefined) info.permissions = permissions;
  return info;
}

/** Directory listing. */
export interface FileListResponse {
  files: FileInfo[];
}

/** Result of creating a directory. */
export interface DirectoryCreateResponse {
  message: string;
  path?: string;
  success?: boolean;
}

/** Metadata for a path, which may not exist. */
export interface FileGetInfoResponse {
  exists: boolean;
  info?: FileInfo;
}

/** Result of a chmod. */
export interface SetPermissionsResponse {
  message: string;
  success: boolean;
}

/** Result of a move or rename. */
export interface FileMoveResponse {
  success: boolean;
  source: string;
  destination: string;
  /** Metadata for the moved entry, when reported. */
  entry?: FileInfo;
}

/** Result of a copy. */
export interface FileCopyResponse {
  success: boolean;
  source: string;
  destination: string;
  entry?: FileInfo;
}

/** Result of a chown. */
export interface ChangeOwnerResponse {
  success: boolean;
  path: string;
  message: string;
}

/** A filesystem change reported by a watch stream. */
export interface WatchEvent {
  /** `start`, `create`, `write`, `remove`, `rename`, `chmod`, or `error`. */
  type: string;
  /** Entry name that changed. */
  name: string;
  /** Path that changed. */
  path: string;
  /** Destination path, for rename events. */
  newPath?: string;
  /** Identifier of the watcher that produced the event. */
  watcherId?: string;
  /** Event time, in milliseconds since the Unix epoch. */
  timestamp?: number;
}

export function parseWatchEvent(data: Record<string, unknown>): WatchEvent {
  const event: WatchEvent = {
    type: str(data, 'type'),
    name: str(data, 'name'),
    path: str(data, 'path'),
  };
  const newPath = optStr(data, 'new_path');
  if (newPath !== undefined) event.newPath = newPath;
  const watcherId = optStr(data, 'watcher_id');
  if (watcherId !== undefined) event.watcherId = watcherId;
  const timestamp = optNum(data, 'timestamp');
  if (timestamp !== undefined) event.timestamp = timestamp;
  return event;
}

/** One match from a content or filename search. */
export interface FileSearchMatch {
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** 1-based column of the match. */
  column: number;
  /** The matching line. */
  content: string;
}

export function parseFileSearchMatch(data: Record<string, unknown>): FileSearchMatch {
  return {
    path: str(data, 'path'),
    line: num(data, 'line'),
    column: num(data, 'column'),
    content: str(data, 'content'),
  };
}

/** Results of a search. */
export interface FileFindResponse {
  success: boolean;
  matches: FileSearchMatch[];
  /** True when the result limit cut the search short. */
  truncated: boolean;
  filesScanned: number;
}

export function parseFileFindResponse(data: Record<string, unknown>): FileFindResponse {
  return {
    success: bool(data, 'success', true),
    matches: parseList(data, 'matches', parseFileSearchMatch),
    truncated: bool(data, 'truncated'),
    filesScanned: num(data, 'files_scanned'),
  };
}

/** Per-file outcome of a find-and-replace. */
export interface FileReplaceEntry {
  path: string;
  replacements: number;
}

/** Results of a find-and-replace. */
export interface FileReplaceResponse {
  success: boolean;
  files: FileReplaceEntry[];
  totalReplacements: number;
  filesScanned: number;
  /** True when the request only previewed the change. */
  dryRun: boolean;
}

export function parseFileReplaceResponse(data: Record<string, unknown>): FileReplaceResponse {
  return {
    success: bool(data, 'success', true),
    files: parseList(data, 'files', (entry) => ({
      path: str(entry, 'path'),
      replacements: num(entry, 'replacements'),
    })),
    totalReplacements: num(data, 'total_replacements'),
    filesScanned: num(data, 'files_scanned'),
    dryRun: bool(data, 'dry_run'),
  };
}

/** One file in a batch upload. */
export interface WriteResult {
  path: string;
  name: string;
  /** `file` or `directory`. */
  type: string;
  size?: number;
  /** Present when this individual entry failed. */
  error?: string;
}

export function parseWriteResult(data: Record<string, unknown>): WriteResult {
  const result: WriteResult = {
    path: str(data, 'path'),
    name: str(data, 'name'),
    type: str(data, 'type', 'file'),
  };
  const size = optNum(data, 'size');
  if (size !== undefined) result.size = size;
  const error = optStr(data, 'error');
  if (error !== undefined) result.error = error;
  return result;
}

/** Result of uploading several files at once. */
export interface WriteFilesResponse {
  files: WriteResult[];
  /** True when some files were written and others failed (HTTP 207). */
  partialFailure: boolean;
}

/** Result of the legacy single-file upload endpoint. */
export interface FileUploadResponse {
  message: string;
  path?: string;
  size?: number;
}

// ---------------------------------------------------------------------------
// Command and code execution
// ---------------------------------------------------------------------------

/** Result of running a shell command. */
export interface CommandRunResponse {
  stdout: string;
  stderr: string;
  /** Process exit status. `0` means success. */
  exitCode: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  success: boolean;
  /** Transport-level error, distinct from a non-zero exit code. */
  error?: string;
}

export function parseCommandRunResponse(data: Record<string, unknown>): CommandRunResponse {
  const response: CommandRunResponse = {
    stdout: str(data, 'stdout'),
    stderr: str(data, 'stderr'),
    exitCode: num(data, 'exit_code'),
    durationMs: num(data, 'duration_ms'),
    success: bool(data, 'success', num(data, 'exit_code') === 0),
  };
  const error = optStr(data, 'error');
  if (error !== undefined) response.error = error;
  return response;
}

/**
 * One rendered output from a code execution.
 *
 * Rich formats are populated when the code produces them, so a plot arrives as
 * base64 `png` and a DataFrame as `html`, alongside the plain-text `text`.
 */
export interface ExecutionResult {
  /** Plain-text representation. */
  text: string;
  /** HTML representation. */
  html: string;
  /** Structured JSON representation. */
  json?: unknown;
  /** Base64-encoded PNG. */
  png: string;
  /** Base64-encoded JPEG. */
  jpeg: string;
  /** SVG markup. */
  svg: string;
  /** Markdown representation. */
  markdown: string;
  /** Structured chart description, when the code produced a plot. */
  chart?: Record<string, unknown>;
}

/** An exception raised by executed code. */
export interface ExecutionError {
  /** Exception class name. */
  name: string;
  /** Exception message. */
  value: string;
  /** Formatted traceback. */
  traceback: string;
}

/** Output streams captured during a code execution. */
export interface ExecutionLogs {
  stdout: string[];
  stderr: string[];
}

/** Result of running code in a runtime. */
export interface CodeRunResponse {
  results: ExecutionResult[];
  logs: ExecutionLogs;
  error?: ExecutionError;
}

export function parseExecutionResult(data: Record<string, unknown>): ExecutionResult {
  const result: ExecutionResult = {
    text: str(data, 'text'),
    html: str(data, 'html'),
    png: str(data, 'png'),
    jpeg: str(data, 'jpeg'),
    svg: str(data, 'svg'),
    markdown: str(data, 'markdown'),
  };
  if (data['json'] !== undefined && data['json'] !== null) result.json = data['json'];
  const chart = jsonMap(data, 'chart');
  if (chart !== undefined) result.chart = chart;
  return result;
}

/** Normalize the `error` field, which may be an object or a bare string. */
export function parseExecutionError(value: unknown): ExecutionError | undefined {
  if (typeof value === 'string' && value !== '') {
    return { name: '', value, traceback: '' };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      name: str(record, 'name'),
      value: str(record, 'value'),
      traceback: str(record, 'traceback'),
    };
  }
  return undefined;
}

export function parseCodeRunResponse(data: Record<string, unknown>): CodeRunResponse {
  const rawLogs = asRecord(data['logs']);
  const response: CodeRunResponse = {
    results: parseList(data, 'results', parseExecutionResult),
    logs: {
      stdout: strArray(rawLogs, 'stdout'),
      stderr: strArray(rawLogs, 'stderr'),
    },
  };
  const error = parseExecutionError(data['error']);
  if (error !== undefined) response.error = error;
  return response;
}

/** A persistent interpreter session that keeps variables between executions. */
export interface CodeContext {
  contextId: string;
  language: string;
  /** Working directory of the interpreter. */
  cwd: string;
}

/** Result of deleting a code context. */
export interface CodeContextDeleteResponse {
  message: string;
  contextId?: string;
}

/**
 * A unified view over a code or command execution.
 *
 * `runCode` and `runCmd` return different payloads; this presents both through
 * one shape so callers can log `execution.stdout` without branching.
 */
export class Execution {
  /** The underlying response, if you need a field this view does not expose. */
  readonly raw: CodeRunResponse | CommandRunResponse;

  private readonly isCommand: boolean;

  constructor(response: CodeRunResponse | CommandRunResponse) {
    this.raw = response;
    this.isCommand = 'exitCode' in response;
  }

  /** Everything written to standard output. */
  get stdout(): string {
    return this.isCommand
      ? (this.raw as CommandRunResponse).stdout
      : (this.raw as CodeRunResponse).logs.stdout.join('');
  }

  /** Everything written to standard error. */
  get stderr(): string {
    return this.isCommand
      ? (this.raw as CommandRunResponse).stderr
      : (this.raw as CodeRunResponse).logs.stderr.join('');
  }

  /**
   * The primary textual result.
   *
   * For a command this is its standard output. For code it is the last
   * expression's text representation, falling back to standard output when the
   * code printed instead of returning a value.
   */
  get text(): string {
    if (this.isCommand) return (this.raw as CommandRunResponse).stdout;

    const results = (this.raw as CodeRunResponse).results;
    for (let i = results.length - 1; i >= 0; i -= 1) {
      const text = results[i]?.text;
      if (text) return text;
    }
    return this.stdout;
  }

  /** Process exit status. Always `0` for code executions, which have none. */
  get exitCode(): number {
    return this.isCommand ? (this.raw as CommandRunResponse).exitCode : 0;
  }

  /** Whether the execution completed without an error. */
  get success(): boolean {
    return this.isCommand
      ? (this.raw as CommandRunResponse).success
      : (this.raw as CodeRunResponse).error === undefined;
  }

  /** The failure, when there was one. */
  get error(): ExecutionError | string | undefined {
    return this.isCommand
      ? (this.raw as CommandRunResponse).error
      : (this.raw as CodeRunResponse).error;
  }

  /** Rich outputs. Always empty for command executions. */
  get results(): ExecutionResult[] {
    return this.isCommand ? [] : (this.raw as CodeRunResponse).results;
  }

  /** Wall-clock duration in milliseconds. `0` when the API did not report one. */
  get durationMs(): number {
    return this.isCommand ? (this.raw as CommandRunResponse).durationMs : 0;
  }

  /** Captured streams, split into chunks as they arrived. */
  get logs(): ExecutionLogs {
    return this.isCommand
      ? {
          stdout: [(this.raw as CommandRunResponse).stdout],
          stderr: [(this.raw as CommandRunResponse).stderr],
        }
      : (this.raw as CodeRunResponse).logs;
  }
}

// ---------------------------------------------------------------------------
// PTY
// ---------------------------------------------------------------------------

/** An interactive pseudo-terminal session running inside a runtime. */
export interface PtySession {
  sessionId: string;
  runtimeId: string;
  /** Process id of the shell inside the guest. */
  pid: number;
  /** Shell executable, for example `/bin/bash`. */
  shell: string;
  /** Arguments passed to the shell. */
  args: string[];
  workingDir: string;
  /** Terminal width in columns. */
  cols: number;
  /** Terminal height in rows. */
  rows: number;
  /** `running` or `exited`. */
  status: string;
  /** Exit status once the shell has terminated. */
  exitCode: number;
  createdAt?: string;
}

export function parsePtySession(data: Record<string, unknown>): PtySession {
  const session: PtySession = {
    sessionId: str(data, 'session_id'),
    runtimeId: str(data, 'runtime_id'),
    pid: num(data, 'pid'),
    shell: str(data, 'shell'),
    args: strArray(data, 'args'),
    workingDir: str(data, 'working_dir'),
    cols: num(data, 'cols'),
    rows: num(data, 'rows'),
    status: str(data, 'status'),
    exitCode: num(data, 'exit_code'),
  };
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) session.createdAt = createdAt;
  return session;
}

/** Acknowledgement of terminal input. */
export interface PtyInputResponse {
  success: boolean;
  bytesWritten: number;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/** Outcome of a git command run inside a runtime. */
export interface GitOperationResult {
  success: boolean;
  /** Exit status of the underlying `git` process. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Error reported by the guest agent, distinct from git's own stderr. */
  error: string;
}

export function parseGitOperationResult(data: Record<string, unknown>): GitOperationResult {
  return {
    success: bool(data, 'success'),
    exitCode: num(data, 'exit_code'),
    stdout: str(data, 'stdout'),
    stderr: str(data, 'stderr'),
    error: str(data, 'error'),
  };
}

// ---------------------------------------------------------------------------
// Web services
// ---------------------------------------------------------------------------

/** A guest port published to a public HTTPS URL. */
export interface RuntimeWebService {
  runtimeId: string;
  /** Port inside the guest that is being exposed. */
  port: number;
  /** Public URL of the service. */
  url: string;
  /** Same as {@link url}. Kept for symmetry with the API response. */
  webUrl: string;
  /** URL to open in a browser, which may include an access token. */
  browserUrl: string;
  /** Base URL for programmatic requests, always ending in a slash. */
  serviceUrl: string;
  /** ISO-8601 timestamp after which the URL stops working. */
  expiresAt: string;
  /** True when the URL requires no token. */
  isPublic: boolean;
  /** Bearer token for private services. */
  token?: string;
  /** Hostname label assigned to the service. */
  subdomain?: string;
}

export function parseRuntimeWebService(data: Record<string, unknown>): RuntimeWebService {
  const url = optStr(data, 'web_url') ?? optStr(data, 'url') ?? '';
  const service: RuntimeWebService = {
    runtimeId: str(data, 'runtime_id'),
    port: num(data, 'port'),
    url,
    webUrl: url,
    browserUrl: optStr(data, 'browser_url') ?? url,
    serviceUrl: optStr(data, 'service_url') ?? (url.endsWith('/') ? url : `${url}/`),
    expiresAt: str(data, 'expires_at'),
    isPublic: bool(data, 'is_public'),
  };
  const token = optStr(data, 'token');
  if (token !== undefined) service.token = token;
  const subdomain = optStr(data, 'subdomain');
  if (subdomain !== undefined) service.subdomain = subdomain;
  return service;
}
