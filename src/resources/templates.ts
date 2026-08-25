/**
 * Templates: reusable runtime images.
 *
 * A template captures a base image plus the packages, files, and setup steps a
 * runtime should start with. Building one is a one-time cost; every runtime
 * created from it then starts from the finished image rather than repeating
 * the installation.
 */

import { GravixLayerError, GravixLayerInvalidArgumentError } from '../core/errors.js';
import { asRecord } from '../core/parse.js';
import { sleep } from '../core/time.js';
import type { RequestOptions } from '../core/transport.js';
import { buildListEndpoint, pathSegment, SERVICES, type QueryValue } from '../core/url.js';
import {
  isSuccessfulBuildState,
  isTerminalBuildState,
  parseTemplateBuildResponse,
  parseTemplateBuildStatus,
  parseTemplateInfo,
  parseTemplateListResponse,
  parseTemplateSnapshot,
  TemplateBuilder,
  type TemplateBuildResponse,
  type TemplateBuildStatus,
  type TemplateDeleteResponse,
  type TemplateInfo,
  type TemplateListResponse,
  type TemplateSnapshot,
} from '../types/templates.js';
import { APIResource } from './resource.js';

/** How often {@link Templates.buildAndWait} polls, in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** How long {@link Templates.buildAndWait} waits before giving up, in milliseconds. */
const DEFAULT_BUILD_TIMEOUT_MS = 900_000;

/** A build finished, but not successfully. */
export class TemplateBuildError extends GravixLayerError {
  constructor(
    readonly buildId: string,
    message: string,
    /** The final status, which carries the phase the build stopped in. */
    readonly buildStatus?: TemplateBuildStatus,
  ) {
    super(`Template build ${buildId} failed: ${message}`);
  }
}

/** A build did not reach a terminal state within the allotted time. */
export class TemplateBuildTimeoutError extends GravixLayerError {
  constructor(
    readonly buildId: string,
    timeoutMs: number,
    /** The last status observed before giving up. */
    readonly buildStatus?: TemplateBuildStatus,
  ) {
    super(
      `Template build ${buildId} did not finish within ${Math.round(timeoutMs / 1000)}s. ` +
        'It may still be running; poll getBuildStatus() to follow it.',
    );
  }
}

/** Options for {@link Templates.list}. */
export interface ListTemplatesOptions extends RequestOptions {
  /** Maximum number of templates to return. Defaults to 100. */
  limit?: number;
  /** Number of templates to skip. Defaults to 0. */
  offset?: number;
  /** Project to scope the listing to. */
  projectId?: string;
}

/** Options for {@link Templates.build}. */
export interface BuildTemplateOptions extends RequestOptions {
  /**
   * Cloud to build in. Defaults to the client's cloud (`aws`, or
   * `GRAVIXLAYER_CLOUD`).
   */
  cloud?: string;
  /**
   * Region to build in. Defaults to the client's region (`us-east-1`, or
   * `GRAVIXLAYER_REGION`).
   */
  region?: string;
}

/** Options for {@link Templates.buildAndWait}. */
export interface BuildAndWaitOptions extends BuildTemplateOptions {
  /** Milliseconds between status polls. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Milliseconds to wait before giving up. Defaults to 900000. */
  timeoutMs?: number;
  /**
   * Invoked when the build enters a new phase, not on every poll.
   *
   * Use it to drive a progress display without polling yourself.
   */
  onPhase?: (status: TemplateBuildStatus) => void;
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

/** Accept either a builder or an already-serialized build request. */
function toPayload(source: TemplateBuilder | Record<string, unknown>): Record<string, unknown> {
  return source instanceof TemplateBuilder ? source.toJSON() : { ...source };
}

function nonempty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Build and manage templates. */
export class Templates extends APIResource {
  /**
   * Fill cloud and region from the client unless the payload or call already
   * named them. Same contract as runtime create: `new GravixLayer()` builds
   * in aws/us-east-1.
   */
  private withPlacement(
    payload: Record<string, unknown>,
    options: BuildTemplateOptions,
  ): Record<string, unknown> {
    const cloud = nonempty(payload['cloud']) ?? nonempty(options.cloud) ?? this.cloud;
    const region = nonempty(payload['region']) ?? nonempty(options.region) ?? this.region;
    if (!cloud) {
      throw new GravixLayerInvalidArgumentError(
        'A cloud is required. Pass `cloud` to build(), or set it on the client.',
      );
    }
    if (!region) {
      throw new GravixLayerInvalidArgumentError(
        'A region is required. Pass `region` to build(), or set it on the client.',
      );
    }
    return { ...payload, cloud, region };
  }
  /**
   * Start a build and return immediately.
   *
   * Use {@link buildAndWait} unless you want to drive the polling yourself.
   *
   * Cloud and region default to the client's (`aws` / `us-east-1`) so a
   * `new GravixLayer()` call builds where runtimes from the same client
   * would be created. Pass them here, or set them on the builder payload,
   * to override.
   */
  async build(
    template: TemplateBuilder | Record<string, unknown>,
    options: BuildTemplateOptions = {},
  ): Promise<TemplateBuildResponse> {
    return parseTemplateBuildResponse(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: 'template/build',
          service: SERVICES.agents,
          body: this.withPlacement(toPayload(template), options),
          options: requestOptions(options),
        }),
      ),
    );
  }

  /** Check on a running build. */
  async getBuildStatus(
    buildId: string,
    options: RequestOptions = {},
  ): Promise<TemplateBuildStatus> {
    const build = pathSegment(buildId, 'buildId');

    return parseTemplateBuildStatus(
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
   * Start a build and wait for it to finish.
   *
   * Resolves with the final status on success, throws
   * {@link TemplateBuildError} when the build fails, and
   * {@link TemplateBuildTimeoutError} when it runs past the timeout.
   *
   * @example
   * ```ts
   * const status = await client.templates.buildAndWait(template, {
   *   onPhase: (s) => console.log(s.phase, `${s.progressPercent}%`),
   * });
   * console.log('Built', status.templateId);
   * ```
   */
  async buildAndWait(
    template: TemplateBuilder | Record<string, unknown>,
    options: BuildAndWaitOptions = {},
  ): Promise<TemplateBuildStatus> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const transport = requestOptions(options);

    const started = await this.build(template, {
      ...transport,
      cloud: options.cloud,
      region: options.region,
    });
    const buildId = started.buildId;
    const deadline = Date.now() + timeoutMs;

    let lastPhase = '';
    let lastStatus: TemplateBuildStatus | undefined;

    for (;;) {
      if (Date.now() > deadline) {
        throw new TemplateBuildTimeoutError(buildId, timeoutMs, lastStatus);
      }

      const status = await this.getBuildStatus(buildId, transport);
      lastStatus = status;

      if (status.phase !== lastPhase) {
        lastPhase = status.phase;
        options.onPhase?.(status);
      }

      if (isTerminalBuildState(status.status)) {
        if (isSuccessfulBuildState(status.status)) return status;
        throw new TemplateBuildError(buildId, status.error || 'The build failed.', status);
      }

      await sleep(pollIntervalMs, options.signal);
    }
  }

  /** List templates. */
  async list(options: ListTemplatesOptions = {}): Promise<TemplateListResponse> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const extra: Record<string, QueryValue> = { kind: 'sandbox' };
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

  /** Fetch one template. */
  async get(templateId: string, options: RequestOptions = {}): Promise<TemplateInfo> {
    const template = pathSegment(templateId, 'templateId');

    return parseTemplateInfo(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `template/${template}`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /** Fetch the stored image a template boots runtimes from. */
  async getSnapshot(templateId: string, options: RequestOptions = {}): Promise<TemplateSnapshot> {
    const template = pathSegment(templateId, 'templateId');

    return parseTemplateSnapshot(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `template/${template}/snapshot`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /** Delete a template and the image behind it. */
  async delete(templateId: string, options: RequestOptions = {}): Promise<TemplateDeleteResponse> {
    const template = pathSegment(templateId, 'templateId');

    await this.http.requestVoid({
      method: 'DELETE',
      path: `template/${template}`,
      service: SERVICES.agents,
      options,
    });

    // The API answers 204, so the confirmation is assembled here rather than
    // parsed from an empty body.
    return { templateId, deleted: true };
  }
}
