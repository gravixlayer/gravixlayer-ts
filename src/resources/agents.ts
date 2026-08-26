/**
 * Agents: long-running services built from your source and given a public URL.
 *
 * A runtime is ephemeral and you drive it. An agent is deployed once and then
 * serves requests on its own hostname, with health checks, DNS, and optional
 * agent-to-agent and tool protocols in front of it.
 */

import { GravixLayerError, GravixLayerInvalidArgumentError } from '../core/errors.js';
import { readProjectDirectory } from '../core/fs.js';
import { asRecord, str } from '../core/parse.js';
import { iterSSEJson } from '../core/sse.js';
import { createTarGz, type TarEntry } from '../core/tar.js';
import { AGENT_BUILD_PHASE_LABELS, BuildProgress, stderrIsTty } from '../core/progress.js';
import { sleep } from '../core/time.js';
import type { RequestOptions } from '../core/transport.js';
import { buildListEndpoint, pathSegment, SERVICES, type QueryValue } from '../core/url.js';
import { assertNonEmpty } from '../core/validate.js';
import {
  isTerminalAgentBuildStatus,
  normalizeFramework,
  parseAgentBuildResponse,
  parseAgentBuildStatus,
  parseAgentDeployResponse,
  parseAgentEndpoint,
  serializeAgentBuildConfig,
  serializeAgentDeploy,
  serializeAgentInvoke,
  AgentBuildStatus as AgentBuildState,
  type AgentBuildConfig,
  type AgentBuildResponse,
  type AgentBuildStatusResponse,
  type AgentDeployConfig,
  type AgentDeployResponse,
  type AgentDestroyResponse,
  type AgentEndpoint,
  type AgentInvokeParams,
} from '../types/agents.js';
import { parseTemplateListResponse, type TemplateListResponse } from '../types/templates.js';
import {
  autoserveEntrypoint,
  inferAgentSource,
  loadProjectEnv,
  normalizePorts,
  resolveHttpPort,
} from './agent-source.js';
import { APIResource } from './resource.js';

/** How often {@link Agents.waitForBuild} polls, in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** How long {@link Agents.waitForBuild} waits before giving up, in milliseconds. */
const DEFAULT_BUILD_TIMEOUT_MS = 600_000;

/** Filename the archive is uploaded under. */
const ARCHIVE_FILENAME = 'project.tar.gz';

/** An agent build finished, but not successfully. */
export class AgentBuildError extends GravixLayerError {
  constructor(
    readonly buildId: string,
    message: string,
    /** The final status, which carries the phase the build stopped in. */
    readonly buildStatus?: AgentBuildStatusResponse,
  ) {
    super(`Agent build ${buildId} failed: ${message}`);
  }
}

/** An agent build did not reach a terminal state within the allotted time. */
export class AgentBuildTimeoutError extends AgentBuildError {
  constructor(
    buildId: string,
    readonly timeoutMs: number,
    buildStatus?: AgentBuildStatusResponse,
  ) {
    super(buildId, `The build did not finish within ${Math.round(timeoutMs / 1000)}s`, buildStatus);
  }
}

/**
 * The project to build.
 *
 * Give a directory path when you are on a runtime with a filesystem, or an
 * explicit list of files when you are not — building from a browser, an edge
 * function, or from content generated in memory.
 */
export type AgentSource = string | { files: readonly TarEntry[] };

/** Options for {@link Agents.build}. */
export interface BuildAgentOptions extends AgentBuildConfig, RequestOptions {
  /** Import path of the object the host should serve. */
  target?: string;
}

/** Options for {@link Agents.waitForBuild}. */
export interface WaitForBuildOptions extends RequestOptions {
  /** Milliseconds between status polls. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Milliseconds to wait before giving up. Defaults to 600000. */
  timeoutMs?: number;
  /**
   * Invoked when the build enters a new API phase, not on every poll.
   *
   * Supplying this disables the built-in BUILDING / VERIFYING timer on stderr.
   */
  onPhase?: (status: AgentBuildStatusResponse) => void;
}

/**
 * Options for {@link Agents.deploy}.
 *
 * `name` is required when building from `source` and unused when deploying an
 * existing `templateId`, so it is optional here and checked at the call.
 */
export interface DeployAgentOptions
  extends Omit<AgentBuildConfig, 'name'>, AgentDeployConfig, WaitForBuildOptions {
  /** Name of the agent. Required when `source` is given. */
  name?: string;
  /** Project to build and deploy. Mutually exclusive with `templateId`. */
  source?: AgentSource;
  /** Already-built image to deploy. Mutually exclusive with `source`. */
  templateId?: string;
  /** Import path of the object the host should serve. */
  target?: string;
  /**
   * Environment variables for the deployed agent.
   *
   * Takes precedence over the build-time `environment` and over anything
   * found in the project's `.env`.
   */
  deployEnvironment?: Record<string, string>;
}

/** Options for {@link Agents.listTemplates}. */
export interface ListAgentTemplatesOptions extends RequestOptions {
  /** Maximum number of templates to return. Defaults to 100. */
  limit?: number;
  /** Number of templates to skip. Defaults to 0. */
  offset?: number;
  /** Project to scope the listing to. */
  projectId?: string;
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

/** Build, deploy, and invoke agents. */
export class Agents extends APIResource {
  /**
   * Build an agent image from source, returning as soon as the build starts.
   *
   * The project is packaged and uploaded, then built on the platform. Use
   * {@link waitForBuild} to follow it, or {@link deploy} to build and deploy
   * in one call.
   */
  async build(source: AgentSource, options: BuildAgentOptions): Promise<AgentBuildResponse> {
    assertNonEmpty(options.name, 'name');

    const resolved = await this.resolveBuildConfig(source, options);
    return this.uploadBuild(resolved.files, resolved.config, requestOptions(options));
  }

  /** Package the files and start the build. */
  private async uploadBuild(
    files: readonly TarEntry[],
    config: AgentBuildConfig,
    options: RequestOptions,
  ): Promise<AgentBuildResponse> {
    const archive = await createTarGz(files);

    const form = new FormData();
    form.append('metadata', JSON.stringify(serializeAgentBuildConfig(config)));
    form.append(
      'archive',
      new Blob([archive as BlobPart], { type: 'application/gzip' }),
      ARCHIVE_FILENAME,
    );

    return parseAgentBuildResponse(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: 'template/build-agent',
          service: SERVICES.agents,
          form,
          options,
        }),
      ),
    );
  }

  /** Check on a running agent build. */
  async getBuildStatus(
    buildId: string,
    options: RequestOptions = {},
  ): Promise<AgentBuildStatusResponse> {
    const build = pathSegment(buildId, 'buildId');

    return parseAgentBuildStatus(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `template/builds/${build}/status`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /**
   * Wait for a build to finish.
   *
   * On a TTY, prints BUILDING and VERIFYING with elapsed times (no percents).
   * Pass {@link WaitForBuildOptions.onPhase} to handle updates yourself.
   *
   * Resolves with the final status on success, throws {@link AgentBuildError}
   * when the build fails, and {@link AgentBuildTimeoutError} when it runs past
   * the timeout.
   */
  async waitForBuild(
    buildId: string,
    options: WaitForBuildOptions = {},
  ): Promise<AgentBuildStatusResponse> {
    assertNonEmpty(buildId, 'buildId');

    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const transport = requestOptions(options);
    const deadline = Date.now() + timeoutMs;
    const progress = new BuildProgress(options.onPhase === undefined && stderrIsTty());

    let lastPhase = '';
    let lastStatus: AgentBuildStatusResponse | undefined;

    try {
      for (;;) {
        if (Date.now() > deadline) {
          progress.stop();
          throw new AgentBuildTimeoutError(buildId, timeoutMs, lastStatus);
        }

        const status = await this.getBuildStatus(buildId, transport);
        lastStatus = status;

        if (status.phase !== lastPhase) {
          lastPhase = status.phase;
          options.onPhase?.(status);
        }

        if (isTerminalAgentBuildStatus(status.status)) {
          if (status.status === AgentBuildState.Completed) {
            progress.succeed('Deployment successful');
            return status;
          }
          const errorMsg = status.error || 'The build failed.';
          progress.fail(errorMsg);
          throw new AgentBuildError(buildId, errorMsg, status);
        }

        progress.noteStage(status.phase, AGENT_BUILD_PHASE_LABELS);
        await sleep(pollIntervalMs, options.signal);
      }
    } finally {
      progress.stop();
    }
  }

  /**
   * Deploy an agent, building it first when given source.
   *
   * Provide exactly one of `source` or `templateId`.
   *
   * @example
   * ```ts
   * const agent = await client.agents.deploy({
   *   source: './my-agent',
   *   name: 'my-agent',
   *   isPublic: true,
   * });
   * console.log(agent.endpoint);
   * ```
   */
  async deploy(options: DeployAgentOptions): Promise<AgentDeployResponse> {
    const { source, templateId } = options;

    if (source !== undefined && templateId !== undefined) {
      throw new GravixLayerInvalidArgumentError(
        'Provide either `source` to build and deploy, or `templateId` to deploy an existing image, but not both.',
      );
    }
    if (source === undefined && templateId === undefined) {
      throw new GravixLayerInvalidArgumentError(
        'Provide `source` to build and deploy, or `templateId` to deploy an existing image.',
      );
    }

    const transport = requestOptions(options);
    let resolvedTemplateId = templateId ?? '';
    let framework = options.framework ? normalizeFramework(options.framework) : '';
    let entryPoint = options.entryPoint ?? '';
    let httpPort = options.httpPort ?? 0;
    let environment = options.environment;

    if (source !== undefined) {
      const name = assertNonEmpty(options.name ?? '', 'name');

      // Resolved once and reused, so a directory is read and packaged a single
      // time even though both the build and the deploy need its details.
      const resolved = await this.resolveBuildConfig(source, { ...options, name });
      framework = resolved.config.framework ?? '';
      httpPort = resolveHttpPort(options.httpPort, resolved.config.ports ?? []);
      environment = resolved.config.environment;

      const started = await this.uploadBuild(resolved.files, resolved.config, transport);
      const finished = await this.waitForBuild(started.buildId, options);

      resolvedTemplateId = finished.templateId;
      if (!entryPoint && resolved.config.entrypoint) entryPoint = resolved.config.entrypoint;
    }

    const deployConfig: AgentDeployConfig = {
      framework,
      entryPoint,
      httpPort,
      environment: options.deployEnvironment ?? environment,
    };
    if (options.a2aPort !== undefined) deployConfig.a2aPort = options.a2aPort;
    if (options.mcpPort !== undefined) deployConfig.mcpPort = options.mcpPort;
    if (options.protocols !== undefined) deployConfig.protocols = options.protocols;
    if (options.isPublic !== undefined) deployConfig.isPublic = options.isPublic;
    if (options.timeoutSeconds !== undefined) deployConfig.timeoutSeconds = options.timeoutSeconds;
    if (options.agentCard !== undefined) deployConfig.agentCard = options.agentCard;

    return parseAgentDeployResponse(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: 'deploy',
          service: SERVICES.agents,
          body: serializeAgentDeploy(resolvedTemplateId, deployConfig),
          options: transport,
        }),
      ),
    );
  }

  /** List the agent images that have been built. */
  async listTemplates(options: ListAgentTemplatesOptions = {}): Promise<TemplateListResponse> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const extra: Record<string, QueryValue> = { kind: 'agent' };
    if (options.projectId) extra['project_id'] = options.projectId;

    return parseTemplateListResponse(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: buildListEndpoint('template', { limit, offset, extra }),
          service: SERVICES.agents,
          options: requestOptions(options),
        }),
      ),
      { limit, offset },
    );
  }

  /** Fetch a deployed agent's URLs, health, and DNS state. */
  async get(agentId: string, options: RequestOptions = {}): Promise<AgentEndpoint> {
    const agent = pathSegment(agentId, 'agentId');

    return parseAgentEndpoint(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `${agent}/endpoint`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /** Tear down a deployed agent, releasing its hostname and runtime. */
  async destroy(agentId: string, options: RequestOptions = {}): Promise<AgentDestroyResponse> {
    const agent = pathSegment(agentId, 'agentId');

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: agent,
        service: SERVICES.agents,
        options,
      }),
    );

    return {
      agentId: str(data, 'agent_id') || agentId,
      status: str(data, 'status', 'deleted'),
    };
  }

  /**
   * Call a deployed agent and wait for its full response.
   *
   * The request goes straight to the agent's own URL rather than through the
   * control plane, so there is no extra hop.
   */
  async invoke<T = unknown>(
    agentId: string,
    params: AgentInvokeParams = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const endpoint = await this.get(agentId, options);

    return (await this.http.request<T>({
      method: 'POST',
      path: `${trimTrailingSlash(endpoint.endpoint)}/invoke`,
      service: '',
      body: serializeAgentInvoke(params),
      options,
    })) as T;
  }

  /**
   * Call a deployed agent and iterate its response as it is produced.
   *
   * @example
   * ```ts
   * for await (const event of client.agents.stream(agentId, { input: { prompt: 'hi' } })) {
   *   console.log(event);
   * }
   * ```
   */
  async *stream<T = unknown>(
    agentId: string,
    params: AgentInvokeParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<T, void, undefined> {
    const endpoint = await this.get(agentId, options);

    const stream = await this.http.requestStream({
      method: 'POST',
      path: `${trimTrailingSlash(endpoint.endpoint)}/stream`,
      service: '',
      body: serializeAgentInvoke(params),
      options,
    });

    yield* iterSSEJson<T>(stream);
  }

  /**
   * Package the project and fill in whatever the caller did not specify.
   *
   * Reading a directory also surfaces its framework, interpreter version, and
   * `.env`, so a build from a well-formed project needs only a name.
   */
  private async resolveBuildConfig(
    source: AgentSource,
    options: BuildAgentOptions & { protocols?: string[]; target?: string },
  ): Promise<{ files: readonly TarEntry[]; config: AgentBuildConfig }> {
    const fromDisk = typeof source === 'string';

    const files = fromDisk ? await readProjectDirectory(source) : source.files;
    if (files.length === 0) {
      throw new GravixLayerInvalidArgumentError(
        'The agent source is empty. Check the path, or pass at least one file.',
      );
    }

    const inferred = fromDisk
      ? await inferAgentSource(source)
      : { framework: '', pythonVersion: '', ports: [], target: '' };

    const framework = normalizeFramework(options.framework || inferred.framework);
    const ports = normalizePorts(options.ports?.length ? options.ports : inferred.ports);
    const target = options.target || inferred.target;
    const entrypoint =
      options.entrypoint || autoserveEntrypoint(framework, ports, target, options.protocols ?? []);

    // Values passed in code win over anything the project's `.env` declares.
    const environment = fromDisk
      ? { ...(await loadProjectEnv(source)), ...(options.environment ?? {}) }
      : (options.environment ?? {});

    const config: AgentBuildConfig = {
      name: options.name,
      framework,
      ports,
      pythonVersion: options.pythonVersion || inferred.pythonVersion,
      entrypoint,
      environment,
    };
    if (options.description !== undefined) config.description = options.description;
    if (options.vcpuCount !== undefined) config.vcpuCount = options.vcpuCount;
    if (options.memoryMb !== undefined) config.memoryMb = options.memoryMb;
    if (options.diskMb !== undefined) config.diskMb = options.diskMb;
    if (options.startCmd !== undefined) config.startCmd = options.startCmd;
    if (options.readyCmd !== undefined) config.readyCmd = options.readyCmd;
    if (options.readyTimeoutSeconds !== undefined) {
      config.readyTimeoutSeconds = options.readyTimeoutSeconds;
    }
    if (options.tags !== undefined) config.tags = options.tags;

    return { files, config };
  }
}

/** Remove a trailing slash so a path can be appended cleanly. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
