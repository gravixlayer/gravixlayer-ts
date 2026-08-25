/**
 * Template types and the fluent builder used to describe an image.
 *
 * A template is a prebuilt filesystem and boot configuration. Runtimes start
 * from a template, so anything installed at build time is already present when
 * a runtime starts rather than being installed on every run.
 */

import { toBase64, utf8Encode, type BinaryLike } from '../core/binary.js';
import { GravixLayerInvalidArgumentError } from '../core/errors.js';
import { bool, num, optNum, optStr, parseList, str } from '../core/parse.js';
import { formatMode, type FileMode } from '../core/uploads.js';

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

/** The kinds of step that can run while a template image is built. */
export const BuildStepType = {
  Run: 'run',
  PipInstall: 'pip_install',
  NpmInstall: 'npm_install',
  AptInstall: 'apt_install',
  BunInstall: 'bun_install',
  CopyFile: 'copy_file',
  GitClone: 'git_clone',
  Mkdir: 'mkdir',
} as const;

export type BuildStepType = (typeof BuildStepType)[keyof typeof BuildStepType];

/** A single step in a template build, in the shape the API expects. */
export interface BuildStep {
  type: BuildStepType;
  args: string[];
  /** Base64-encoded file contents, for `copy_file`. */
  content?: string;
  /** Step-specific settings such as `mode`, `user`, `branch`, or `depth`. */
  options?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Build status
// ---------------------------------------------------------------------------

/** Lifecycle states of a template build. */
export const TemplateBuildState = {
  Pending: 'pending',
  Started: 'started',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type TemplateBuildState = (typeof TemplateBuildState)[keyof typeof TemplateBuildState];

/** Reported phases within a template build. */
export const TemplateBuildPhase = {
  Building: 'building',
  Uploading: 'uploading',
  Completed: 'completed',
  Initializing: 'initializing',
  Preparing: 'preparing',
  Finalizing: 'finalizing',
  Distributing: 'distributing',
} as const;

export type TemplateBuildPhase = (typeof TemplateBuildPhase)[keyof typeof TemplateBuildPhase];

/** States after which a build no longer changes. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  TemplateBuildState.Completed,
  TemplateBuildState.Failed,
]);

/** True when a build has reached a state it will not leave. */
export function isTerminalBuildState(status: string): boolean {
  return TERMINAL_STATES.has(status);
}

/** True when a build finished and produced a usable template. */
export function isSuccessfulBuildState(status: string): boolean {
  return status === TemplateBuildState.Completed;
}

/** Acknowledgement that a build was accepted and queued. */
export interface TemplateBuildResponse {
  buildId: string;
  templateId: string;
  status: string;
  message: string;
}

export function parseTemplateBuildResponse(data: Record<string, unknown>): TemplateBuildResponse {
  return {
    buildId: str(data, 'build_id'),
    templateId: str(data, 'template_id'),
    status: str(data, 'status'),
    message: str(data, 'message'),
  };
}

/** Progress of an in-flight or finished template build. */
export interface TemplateBuildStatus {
  buildId: string;
  templateId: string;
  /** One of {@link TemplateBuildState}. */
  status: string;
  /** One of {@link TemplateBuildPhase}. */
  phase: string;
  /** Completion estimate from 0 to 100. */
  progressPercent: number;
  /** Failure reason, set when `status` is `failed`. */
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export function parseTemplateBuildStatus(data: Record<string, unknown>): TemplateBuildStatus {
  const status: TemplateBuildStatus = {
    buildId: str(data, 'build_id'),
    templateId: str(data, 'template_id'),
    status: str(data, 'status'),
    phase: str(data, 'phase'),
    progressPercent: num(data, 'progress_percent'),
  };
  const error = optStr(data, 'error');
  if (error !== undefined) status.error = error;
  const startedAt = optStr(data, 'started_at');
  if (startedAt !== undefined) status.startedAt = startedAt;
  const completedAt = optStr(data, 'completed_at');
  if (completedAt !== undefined) status.completedAt = completedAt;
  return status;
}

/** A progress message emitted while waiting for a build. */
export interface BuildLogEntry {
  timestamp?: string;
  /** `info`, `warn`, or `error`. */
  level: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Template metadata
// ---------------------------------------------------------------------------

/** A built template. */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  /** Virtual CPUs allocated to runtimes started from this template. */
  vcpuCount: number;
  /** Memory in mebibytes. */
  memoryMb: number;
  /** Disk size in mebibytes. */
  diskSizeMb: number;
  /** `private` or `public`. */
  visibility: string;
  createdAt: string;
  updatedAt: string;
  cloud?: string;
  region?: string;
  /** `sandbox` for runtime templates, `agent` for deployable agents. */
  kind?: string;
}

export function parseTemplateInfo(data: Record<string, unknown>): TemplateInfo {
  const info: TemplateInfo = {
    id: str(data, 'id'),
    name: str(data, 'name'),
    description: str(data, 'description'),
    vcpuCount: num(data, 'vcpu_count'),
    memoryMb: num(data, 'memory_mb'),
    diskSizeMb: num(data, 'disk_size_mb'),
    visibility: str(data, 'visibility', 'private'),
    createdAt: str(data, 'created_at'),
    updatedAt: str(data, 'updated_at'),
  };
  const cloud = optStr(data, 'cloud') ?? optStr(data, 'provider');
  if (cloud !== undefined) info.cloud = cloud;
  const region = optStr(data, 'region');
  if (region !== undefined) info.region = region;
  const kind = optStr(data, 'kind');
  if (kind !== undefined) info.kind = kind;
  return info;
}

/** One page of templates. */
export interface TemplateListResponse {
  templates: TemplateInfo[];
  limit: number;
  offset: number;
}

export function parseTemplateListResponse(
  data: Record<string, unknown>,
  defaults: { limit: number; offset: number },
): TemplateListResponse {
  return {
    templates: parseList(data, 'templates', parseTemplateInfo),
    limit: num(data, 'limit', defaults.limit),
    offset: num(data, 'offset', defaults.offset),
  };
}

/** Details of the memory snapshot captured for a template. */
export interface TemplateSnapshot {
  templateId: string;
  name: string;
  description: string;
  /** True once a snapshot exists and runtimes can resume from it. */
  hasSnapshot: boolean;
  vcpuCount: number;
  memoryMb: number;
  createdAt: string;
  /** Version of the in-guest agent captured in the snapshot. */
  guestAgentVersion?: string;
  /** Size of the stored snapshot in bytes. */
  snapshotSizeBytes?: number;
}

export function parseTemplateSnapshot(data: Record<string, unknown>): TemplateSnapshot {
  const snapshot: TemplateSnapshot = {
    templateId: str(data, 'template_id'),
    name: str(data, 'name'),
    description: str(data, 'description'),
    hasSnapshot: bool(data, 'has_snapshot'),
    vcpuCount: num(data, 'vcpu_count'),
    memoryMb: num(data, 'memory_mb'),
    createdAt: str(data, 'created_at'),
  };
  const agentVersion = optStr(data, 'guest_agent_version');
  if (agentVersion !== undefined) snapshot.guestAgentVersion = agentVersion;
  const size = optNum(data, 'snapshot_size_bytes');
  if (size !== undefined) snapshot.snapshotSizeBytes = size;
  return snapshot;
}

/** Result of deleting a template. */
export interface TemplateDeleteResponse {
  templateId: string;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Options accepted when adding a file to a template image. */
export interface AddFileOptions {
  /** Permission bits, for example `'0755'` or `0o755`. */
  mode?: FileMode;
  /** Owning user inside the image. */
  user?: string;
}

/** Options accepted by {@link TemplateBuilder.gitClone}. */
export interface TemplateGitCloneOptions {
  /** Directory to clone into. Defaults to the repository name. */
  destination?: string;
  /** Branch, tag, or commit to check out. */
  branch?: string;
  /** Truncate history to this many commits, which speeds up large clones. */
  depth?: number;
  /** Token for a private repository. */
  authToken?: string;
}

/** One entry for {@link TemplateBuilder.addFiles}. */
export interface TemplateFileEntry extends AddFileOptions {
  /** Absolute destination path inside the image. */
  path: string;
  /** File contents. */
  content: BinaryLike;
}

/**
 * Host-side TCP readiness check for a published port.
 *
 * Serialized as `ready_port` so the platform probes the port from the host.
 * The process must listen on `0.0.0.0`, not loopback-only.
 */
export class TcpPortCheck {
  readonly port: number;

  constructor(port: number) {
    const p = Math.trunc(port);
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      throw new GravixLayerInvalidArgumentError('Port must be between 1 and 65535.');
    }
    this.port = p;
  }
}

/**
 * Default `ready_timeout_secs` sent with a ready check. Values below this
 * are raised to this minimum.
 */
export const DEFAULT_READY_TIMEOUT_SECS = 300;

/**
 * Describes a template image with a fluent API.
 *
 * Every method returns the builder, so steps chain. Steps run in the order
 * they are added, which lets you install system packages before the language
 * packages that depend on them.
 *
 * @example
 * ```ts
 * const template = new TemplateBuilder('data-science')
 *   .fromImage('python:3.12-slim')
 *   .vcpu(2)
 *   .memory(2048)
 *   .aptInstall('git', 'curl')
 *   .pipInstall('pandas', 'matplotlib')
 *   .readyCmd(TemplateBuilder.waitForFile('/opt/ready'));
 *
 * await client.templates.buildAndWait(template);
 * ```
 */
export class TemplateBuilder {
  private readonly _name: string;
  private _description: string;
  private _templateId?: string;
  private _dockerImage?: string;
  private _dockerfile?: string;
  private _vcpuCount = 2;
  private _memoryMb = 1024;
  private _diskMb = 4096;
  private _startCmd?: string;
  private _readyCmd?: string;
  private _readyPort?: number;
  private _readyTimeoutSeconds = DEFAULT_READY_TIMEOUT_SECS;
  private readonly _environment: Record<string, string> = {};
  private readonly _tags: Record<string, string> = {};
  private readonly _buildSteps: BuildStep[] = [];

  constructor(name: string, description = '') {
    if (!name || name.trim() === '') {
      throw new GravixLayerInvalidArgumentError('Template name is required.');
    }
    this._name = name;
    this._description = description;
  }

  /** The template name. */
  get name(): string {
    return this._name;
  }

  /** Start from a published container image. */
  fromImage(image: string): this {
    this._dockerImage = image;
    return this;
  }

  /** Build from an inline Dockerfile. Mutually exclusive with {@link fromImage}. */
  dockerfile(content: string): this {
    this._dockerfile = content;
    return this;
  }

  /** Rebuild an existing template in place instead of creating a new one. */
  templateId(templateId: string): this {
    this._templateId = templateId;
    return this;
  }

  /** Set the description. */
  description(text: string): this {
    this._description = text;
    return this;
  }

  /** Number of virtual CPUs. Minimum 1. */
  vcpu(count: number): this {
    this._vcpuCount = Math.max(1, Math.trunc(count));
    return this;
  }

  /** Memory in mebibytes. Minimum 1. */
  memory(mb: number): this {
    this._memoryMb = Math.max(1, Math.trunc(mb));
    return this;
  }

  /** Disk size in mebibytes. Minimum 1. */
  disk(mb: number): this {
    this._diskMb = Math.max(1, Math.trunc(mb));
    return this;
  }

  /** Command run when a runtime starts from this template. */
  startCmd(command: string): this {
    this._startCmd = command;
    return this;
  }

  /**
   * Snapshot-phase ready check.
   *
   * Pass a shell command that must exit zero, or
   * {@link TemplateBuilder.waitForPort} for a host-side TCP probe.
   * Timeouts below 300 seconds are raised to 300.
   */
  readyCmd(command: string | TcpPortCheck, timeoutSeconds = DEFAULT_READY_TIMEOUT_SECS): this {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) {
      throw new GravixLayerInvalidArgumentError('Ready timeout must be at least 1 second.');
    }
    if (command instanceof TcpPortCheck) {
      this._readyPort = command.port;
      this._readyCmd = undefined;
    } else {
      this._readyCmd = command;
      this._readyPort = undefined;
    }
    this._readyTimeoutSeconds = timeoutSeconds;
    return this;
  }

  /** Set one environment variable, available at build time and at run time. */
  env(key: string, value: string): this {
    this._environment[key] = value;
    return this;
  }

  /** Merge several environment variables. */
  envs(values: Record<string, string>): this {
    Object.assign(this._environment, values);
    return this;
  }

  /** Merge labels used to organize templates. */
  tags(values: Record<string, string>): this {
    Object.assign(this._tags, values);
    return this;
  }

  /** Run a shell command during the build. */
  run(command: string): this {
    this._buildSteps.push({ type: BuildStepType.Run, args: [command] });
    return this;
  }

  /** Install Python packages with pip. */
  pipInstall(...packages: string[]): this {
    this._buildSteps.push({ type: BuildStepType.PipInstall, args: packages });
    return this;
  }

  /** Install Node packages with npm. */
  npmInstall(...packages: string[]): this {
    this._buildSteps.push({ type: BuildStepType.NpmInstall, args: packages });
    return this;
  }

  /** Install system packages with apt. */
  aptInstall(...packages: string[]): this {
    this._buildSteps.push({ type: BuildStepType.AptInstall, args: packages });
    return this;
  }

  /** Install packages with bun. */
  bunInstall(...packages: string[]): this {
    this._buildSteps.push({ type: BuildStepType.BunInstall, args: packages });
    return this;
  }

  /**
   * Write a file into the image.
   *
   * The contents are supplied directly rather than read from disk, so the same
   * code works on every runtime. In Node, read the file first:
   *
   * @example
   * ```ts
   * import { readFile } from 'node:fs/promises';
   * builder.addFile('/app/server.js', await readFile('./server.js'));
   * ```
   */
  addFile(destination: string, content: BinaryLike, options: AddFileOptions = {}): this {
    const step: BuildStep = {
      type: BuildStepType.CopyFile,
      args: [destination],
      content: toBase64(typeof content === 'string' ? utf8Encode(content) : asBytesSync(content)),
    };
    const stepOptions: Record<string, string> = {};
    if (options.mode !== undefined) stepOptions['mode'] = formatMode(options.mode);
    if (options.user !== undefined) stepOptions['user'] = options.user;
    if (Object.keys(stepOptions).length > 0) step.options = stepOptions;

    this._buildSteps.push(step);
    return this;
  }

  /** Write several files into the image. */
  addFiles(entries: readonly TemplateFileEntry[]): this {
    for (const entry of entries) {
      const options: AddFileOptions = {};
      if (entry.mode !== undefined) options.mode = entry.mode;
      if (entry.user !== undefined) options.user = entry.user;
      this.addFile(entry.path, entry.content, options);
    }
    return this;
  }

  /** Clone a git repository into the image. */
  gitClone(url: string, options: TemplateGitCloneOptions = {}): this {
    const args = options.destination ? [url, options.destination] : [url];
    const step: BuildStep = { type: BuildStepType.GitClone, args };

    const stepOptions: Record<string, string> = {};
    if (options.branch !== undefined) stepOptions['branch'] = options.branch;
    if (options.depth !== undefined) stepOptions['depth'] = String(options.depth);
    if (options.authToken !== undefined) stepOptions['auth_token'] = options.authToken;
    if (Object.keys(stepOptions).length > 0) step.options = stepOptions;

    this._buildSteps.push(step);
    return this;
  }

  /** Create a directory, including any missing parents. */
  mkdir(path: string, mode?: FileMode): this {
    const step: BuildStep = { type: BuildStepType.Mkdir, args: [path] };
    if (mode !== undefined) step.options = { mode: formatMode(mode) };
    this._buildSteps.push(step);
    return this;
  }

  /**
   * Wait until a published TCP port accepts connections.
   *
   * The platform probes the port from the host. Bind the process to `0.0.0.0`,
   * not `127.0.0.1`.
   */
  static waitForPort(port: number): TcpPortCheck {
    return new TcpPortCheck(port);
  }

  /** A readiness check that waits for a URL to return an expected status. */
  static waitForUrl(url: string, expectedStatus = 200): string {
    return `curl -s -o /dev/null -w '%{http_code}' ${url} | grep -q ${expectedStatus}`;
  }

  /** A readiness check that waits for a file to appear. */
  static waitForFile(path: string): string {
    return `test -f ${path}`;
  }

  /** A readiness check that waits for a named process to start. */
  static waitForProcess(name: string): string {
    return `pgrep ${name} > /dev/null`;
  }

  /** Serialize to the API request body. */
  toJSON(): Record<string, unknown> {
    if (this._dockerImage && this._dockerfile) {
      throw new GravixLayerInvalidArgumentError(
        'A template cannot set both a base image and a Dockerfile. ' +
          'Use fromImage() for a published image or dockerfile() for a custom build.',
      );
    }

    const data: Record<string, unknown> = { name: this._name };

    if (this._description) data['description'] = this._description;
    if (this._templateId) data['template_id'] = this._templateId;
    if (this._dockerImage) data['docker_image'] = this._dockerImage;
    if (this._dockerfile) data['dockerfile'] = this._dockerfile;

    data['vcpu_count'] = this._vcpuCount;
    data['memory_mb'] = this._memoryMb;
    data['disk_mb'] = this._diskMb;

    if (this._startCmd) data['start_cmd'] = this._startCmd;
    if (this._readyPort !== undefined) data['ready_port'] = this._readyPort;
    if (this._readyCmd) data['ready_cmd'] = this._readyCmd;
    if (this._readyCmd || this._readyPort !== undefined) {
      data['ready_timeout_secs'] = Math.max(DEFAULT_READY_TIMEOUT_SECS, this._readyTimeoutSeconds);
    }
    if (Object.keys(this._environment).length > 0) data['environment'] = this._environment;
    if (this._buildSteps.length > 0) data['build_steps'] = this._buildSteps;
    if (Object.keys(this._tags).length > 0) data['tags'] = this._tags;

    return data;
  }
}

/**
 * Synchronous byte conversion for builder inputs.
 *
 * The builder is deliberately synchronous so it can be chained, which rules
 * out `Blob`; callers pass a string or a typed array instead.
 */
function asBytesSync(content: BinaryLike): Uint8Array {
  if (typeof content === 'string') return utf8Encode(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  throw new GravixLayerInvalidArgumentError(
    'Template file contents must be a string, Uint8Array, ArrayBuffer, or typed array. ' +
      'Read a Blob with `await blob.arrayBuffer()` first.',
  );
}
