/**
 * Storage mounts: managed buckets, customer bucket links, and runtime mounts.
 *
 * Buckets and links live at account/project scope; a mount binds one of them
 * — or a git repository — to a runtime path. Credentials are referenced from
 * secret providers and resolved server-side; they never pass through this
 * SDK.
 *
 * ```ts
 * const client = new GravixLayer();
 *
 * const bucket = await client.storage.buckets.create('datasets');
 * const sandbox = await client.runtime.create({
 *   mounts: [{ kind: 'bucket', path: '/mnt/data', mode: 'rw', bucket: bucket.id }],
 * });
 * ```
 */

import { GravixLayerInvalidArgumentError } from '../core/errors.js';
import { asRecord, bool, num, parseList } from '../core/parse.js';
import type { RequestOptions } from '../core/transport.js';
import {
  pathSegment,
  SERVICES,
  withQuery,
  type QueryValue,
} from '../core/url.js';
import { assertNonEmpty, assertOneOf, assertPath, assertRuntimeId } from '../core/validate.js';
import {
  LINK_PROVIDERS,
  MountMode,
  parseBucketLink,
  parseRuntimeMount,
  parseStorageBucket,
  type BucketLink,
  type BucketLinkList,
  type RuntimeMount,
  type RuntimeMountList,
  type StorageBucket,
  type StorageBucketList,
} from '../types/storage.js';
import { APIResource, type ClientContext } from './resource.js';

/** Options common to writes, which may be scoped to a project. */
export interface StorageScopedOptions extends RequestOptions {
  /** Project to scope the operation to. Defaults to the account's default. */
  projectId?: string;
}

/** Strip operation-specific fields, leaving only per-request transport options. */
function requestOptions(options: RequestOptions): RequestOptions {
  const out: RequestOptions = {};
  if (options.signal) out.signal = options.signal;
  if (options.requestTimeoutMs !== undefined) out.requestTimeoutMs = options.requestTimeoutMs;
  if (options.maxRetries !== undefined) out.maxRetries = options.maxRetries;
  if (options.headers) out.headers = options.headers;
  return out;
}

/** Append the project scope when one was given. */
function scoped(path: string, projectId: string | undefined): string {
  const params: Record<string, QueryValue> = {};
  if (projectId) params['project_id'] = projectId;
  return withQuery(path, params);
}

// ---------------------------------------------------------------------------
// Mount requests
// ---------------------------------------------------------------------------

/** A mount declared at create time or attached to a running runtime. */
export interface MountInput {
  /** `bucket` or `git`. */
  kind: 'bucket' | 'git';
  /** Absolute guest path the mount lands on. */
  path: string;
  /** Read-only by default; bucket mounts also accept `rw`. */
  mode?: MountMode | string;
  /** A failed mount fails the create/attach when true (default). */
  required?: boolean;
  /** Managed bucket id or name (kind=bucket; XOR `link`). */
  bucket?: string;
  /** Bucket-link id or name (kind=bucket; XOR `bucket`). */
  link?: string;
  /** HTTPS clone URL (kind=git). */
  url?: string;
  /** Branch, tag, or commit (kind=git). */
  ref?: string;
  /** Shallow-clone depth (kind=git). */
  depth?: number;
  /** Re-materialize when the ref moves, in seconds; `0` = once (kind=git). */
  refreshSeconds?: number;
  /** Secret-provider id for private-repo auth (kind=git). */
  credentialProvider?: string;
  /** Secret name holding the HTTPS token (kind=git). */
  credentialSecret?: string;
}

const MOUNT_INPUT_KEYS = new Set([
  'kind', 'path', 'mode', 'required',
  'bucket', 'link',
  'url', 'ref', 'depth', 'refreshSeconds',
  'credentialProvider', 'credentialSecret',
]);

/** Validate a mount request and emit the wire body. */
export function buildMountSpec(input: MountInput): Record<string, unknown> {
  if (input === null || typeof input !== 'object') {
    throw new GravixLayerInvalidArgumentError('mount must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!MOUNT_INPUT_KEYS.has(key)) {
      throw new GravixLayerInvalidArgumentError(`mount.${key} is not a supported mount field.`);
    }
  }
  const kind = assertOneOf(input.kind, ['bucket', 'git'], 'mount.kind');
  const path = assertPath(input.path, 'mount.path');
  if (
    !path.startsWith('/') ||
    path === '/' ||
    path.endsWith('/') ||
    path.includes('//')
  ) {
    throw new GravixLayerInvalidArgumentError(
      `mount.path must be a normalized absolute path below the guest root; received ${JSON.stringify(input.path)}.`,
    );
  }

  const body: Record<string, unknown> = { kind, path };
  if (input.mode !== undefined) {
    const mode = assertOneOf(input.mode, [MountMode.ReadOnly, MountMode.ReadWrite], 'mount.mode');
    if (kind === 'git' && mode === MountMode.ReadWrite) {
      throw new GravixLayerInvalidArgumentError('git mounts are read-only.');
    }
    body['mode'] = mode;
  }
  if (input.required !== undefined) body['required'] = input.required;

  if (kind === 'bucket') {
    for (const stray of ['url', 'ref', 'depth', 'refreshSeconds'] as const) {
      if (input[stray] !== undefined) {
        throw new GravixLayerInvalidArgumentError(`mount.${stray} is for git mounts, not bucket.`);
      }
    }
    if (input.bucket !== undefined && input.link !== undefined) {
      throw new GravixLayerInvalidArgumentError(
        'a bucket mount takes `bucket` or `link`, not both.',
      );
    }
    if (input.bucket === undefined && input.link === undefined) {
      throw new GravixLayerInvalidArgumentError(
        'a bucket mount needs `bucket` (managed bucket id/name) or `link` (link id/name).',
      );
    }
    if (input.bucket !== undefined) body['bucket'] = assertNonEmpty(input.bucket, 'mount.bucket');
    if (input.link !== undefined) body['link'] = assertNonEmpty(input.link, 'mount.link');
    return body;
  }

  if (input.bucket !== undefined || input.link !== undefined) {
    throw new GravixLayerInvalidArgumentError(
      'mount.bucket/mount.link are for bucket mounts, not git.',
    );
  }
  const url = assertNonEmpty(input.url ?? '', 'mount.url');
  if (!url.toLowerCase().startsWith('https://')) {
    throw new GravixLayerInvalidArgumentError('mount.url must be an https:// clone URL.');
  }
  body['url'] = url;
  if (input.ref !== undefined) body['git_ref'] = assertNonEmpty(input.ref, 'mount.ref');
  if (input.depth !== undefined) {
    if (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > 0xffff_ffff) {
      throw new GravixLayerInvalidArgumentError(
        'mount.depth must be an integer between 0 and 4294967295.',
      );
    }
    body['depth'] = input.depth;
  }
  if (input.refreshSeconds !== undefined) {
    if (
      !Number.isInteger(input.refreshSeconds) ||
      input.refreshSeconds < 0 ||
      input.refreshSeconds > 0xffff_ffff
    ) {
      throw new GravixLayerInvalidArgumentError(
        'mount.refreshSeconds must be an integer between 0 and 4294967295.',
      );
    }
    body['refresh_seconds'] = input.refreshSeconds;
  }
  if (
    (input.credentialProvider === undefined) !== (input.credentialSecret === undefined)
  ) {
    throw new GravixLayerInvalidArgumentError(
      'git credentials need both `credentialProvider` and `credentialSecret`.',
    );
  }
  if (input.credentialProvider !== undefined) {
    body['credential_provider'] = assertNonEmpty(
      input.credentialProvider,
      'mount.credentialProvider',
    );
    body['credential_secret'] = assertNonEmpty(
      input.credentialSecret ?? '',
      'mount.credentialSecret',
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/** Options for {@link StorageBuckets.create}. */
export interface CreateBucketOptions extends StorageScopedOptions {
  /** Region for the managed bucket. Defaults to the runtime region. */
  region?: string;
}

/** Managed buckets the platform provisions for the account. */
export class StorageBuckets extends APIResource {
  /** Create a managed bucket. */
  async create(name: string, options: CreateBucketOptions = {}): Promise<StorageBucket> {
    const body: Record<string, unknown> = { name: assertNonEmpty(name, 'name') };
    if (options.region !== undefined) body['region'] = assertNonEmpty(options.region, 'region');
    if (options.projectId !== undefined) body['project_id'] = options.projectId;

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: 'buckets',
        service: SERVICES.agents,
        body,
        options: requestOptions(options),
      }),
    );
    return parseStorageBucket(asRecord(data['bucket']));
  }

  /** List managed buckets. */
  async list(options: StorageScopedOptions = {}): Promise<StorageBucketList> {
    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: scoped('buckets', options.projectId),
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    const buckets = parseList(data, 'buckets', parseStorageBucket);
    return { buckets, total: num(data, 'total', buckets.length) };
  }

  /** Fetch one bucket by id or name. */
  async get(idOrName: string, options: RequestOptions = {}): Promise<StorageBucket> {
    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `buckets/${pathSegment(idOrName, 'bucketId')}`,
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    return parseStorageBucket(asRecord(data['bucket']));
  }

  /** Delete a managed bucket by id. Refuses while mounted. */
  async delete(bucketId: string, options: RequestOptions = {}): Promise<boolean> {
    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: `buckets/${pathSegment(bucketId, 'bucketId')}`,
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    return bool(data, 'deleted', true);
  }
}

// ---------------------------------------------------------------------------
// Bucket links
// ---------------------------------------------------------------------------

/** Options for {@link BucketLinks.create}. */
export interface CreateBucketLinkOptions extends StorageScopedOptions {
  /** `s3` (default) or `s3_compatible` for an S3-compatible endpoint. */
  provider?: string;
  /** Object-prefix the link is rooted at. Defaults to the bucket root. */
  prefix?: string;
  /** Bucket region. */
  region?: string;
  /** https endpoint for `s3_compatible` providers. */
  endpoint?: string;
  /** Path-style addressing for `s3_compatible` endpoints. */
  pathStyle?: boolean;
  /** `static` (default): secret references; `oidc`: role assumption. */
  authMode?: 'static' | 'oidc';
  /** Secret provider holding the credentials (authMode=static). */
  secretProviderId?: string;
  /** Secret name holding the access key id (authMode=static). */
  accessKeySecret?: string;
  /** Secret name holding the secret key (authMode=static). */
  secretKeySecret?: string;
  /** Secret name holding the session token (authMode=static). */
  sessionTokenSecret?: string;
  /** Role to assume (authMode=oidc). */
  roleArn?: string;
  /** External id for the assume (authMode=oidc). */
  externalId?: string;
}

/** Links to buckets the account already owns. */
export class BucketLinks extends APIResource {
  /**
   * Create a link. Credentials are referenced by secret-provider key names —
   * secret material never passes through the API.
   */
  async create(name: string, bucket: string, options: CreateBucketLinkOptions = {}): Promise<BucketLink> {
    const provider = assertOneOf(
      options.provider ?? 's3',
      LINK_PROVIDERS,
      'provider',
    );
    const authMode = assertOneOf(options.authMode ?? 'static', ['static', 'oidc'], 'authMode');

    const body: Record<string, unknown> = {
      name: assertNonEmpty(name, 'name'),
      provider,
      bucket: assertNonEmpty(bucket, 'bucket'),
      auth_mode: authMode,
    };
    if (options.prefix !== undefined) {
      const prefix = options.prefix;
      if (prefix.startsWith('/') || prefix.split('/').includes('..')) {
        throw new GravixLayerInvalidArgumentError(
          'prefix must be a relative object prefix — no leading "/" or ".." segments.',
        );
      }
      body['prefix'] = prefix;
    }
    if (options.region !== undefined) body['region'] = options.region;
    if (options.endpoint !== undefined) {
      const endpoint = assertNonEmpty(options.endpoint, 'endpoint');
      if (!endpoint.toLowerCase().startsWith('https://')) {
        throw new GravixLayerInvalidArgumentError('endpoint must be an https:// URL.');
      }
      if (provider === 's3') {
        throw new GravixLayerInvalidArgumentError('endpoint is for s3_compatible links only.');
      }
      body['endpoint'] = endpoint;
    }
    if (provider === 's3_compatible' && options.endpoint === undefined) {
      throw new GravixLayerInvalidArgumentError('s3_compatible links need an https endpoint.');
    }
    if (authMode === 'oidc' && provider !== 's3') {
      throw new GravixLayerInvalidArgumentError('oidc auth is s3-only.');
    }
    if (authMode === 'static') {
      if (
        options.secretProviderId === undefined ||
        options.accessKeySecret === undefined ||
        options.secretKeySecret === undefined
      ) {
        throw new GravixLayerInvalidArgumentError(
          'static auth needs secretProviderId, accessKeySecret, and secretKeySecret.',
        );
      }
    } else {
      if (options.roleArn === undefined || options.externalId === undefined) {
        throw new GravixLayerInvalidArgumentError('oidc auth needs roleArn and externalId.');
      }
    }
    if (options.pathStyle !== undefined) body['path_style'] = options.pathStyle;
    if (options.secretProviderId !== undefined)
      body['secret_provider_id'] = options.secretProviderId;
    if (options.accessKeySecret !== undefined)
      body['access_key_secret'] = options.accessKeySecret;
    if (options.secretKeySecret !== undefined)
      body['secret_key_secret'] = options.secretKeySecret;
    if (options.sessionTokenSecret !== undefined)
      body['session_token_secret'] = options.sessionTokenSecret;
    if (options.roleArn !== undefined) body['role_arn'] = options.roleArn;
    if (options.externalId !== undefined) body['external_id'] = options.externalId;
    if (options.projectId !== undefined) body['project_id'] = options.projectId;

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: 'bucket-links',
        service: SERVICES.agents,
        body,
        options: requestOptions(options),
      }),
    );
    return parseBucketLink(asRecord(data['link']));
  }

  /** List bucket links. */
  async list(options: StorageScopedOptions = {}): Promise<BucketLinkList> {
    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: scoped('bucket-links', options.projectId),
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    const links = parseList(data, 'links', parseBucketLink);
    return { links, total: num(data, 'total', links.length) };
  }

  /** Fetch one link by id or name. */
  async get(idOrName: string, options: RequestOptions = {}): Promise<BucketLink> {
    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `bucket-links/${pathSegment(idOrName, 'linkId')}`,
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    return parseBucketLink(asRecord(data['link']));
  }

  /** Probe the link's credentials against the provider and refresh status. */
  async verify(linkId: string, options: RequestOptions = {}): Promise<BucketLink> {
    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `bucket-links/${pathSegment(linkId, 'linkId')}/verify`,
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    return parseBucketLink(asRecord(data['link']));
  }

  /** Delete a link by id. Refuses while a runtime mounts it. */
  async delete(linkId: string, options: RequestOptions = {}): Promise<boolean> {
    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: `bucket-links/${pathSegment(linkId, 'linkId')}`,
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    return bool(data, 'deleted', true);
  }
}

// ---------------------------------------------------------------------------
// Runtime mounts
// ---------------------------------------------------------------------------

/** Mounts bound to one runtime — also usable standalone via the client. */
export class RuntimeMounts extends APIResource {
  /** Attach a mount to a running runtime. */
  async attach(
    runtimeId: string,
    mount: MountInput,
    options: RequestOptions = {},
  ): Promise<RuntimeMount> {
    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${assertRuntimeId(runtimeId)}/mounts`,
        service: SERVICES.agents,
        body: buildMountSpec(mount),
        options: requestOptions(options),
      }),
    );
    return parseRuntimeMount(asRecord(data['attachment']));
  }

  /** List a runtime's mounts and their states. */
  async list(runtimeId: string, options: RequestOptions = {}): Promise<RuntimeMountList> {
    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${assertRuntimeId(runtimeId)}/mounts`,
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    return { mounts: parseList(data, 'mounts', parseRuntimeMount) };
  }

  /** Detach a mount by attachment id. */
  async detach(
    runtimeId: string,
    attachmentId: string,
    options: RequestOptions = {},
  ): Promise<boolean> {
    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: `runtime/${assertRuntimeId(runtimeId)}/mounts/${pathSegment(attachmentId, 'attachmentId')}`,
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );
    return bool(data, 'detached', true);
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Top-level storage surface: `client.storage`. */
export class Storage extends APIResource {
  readonly buckets: StorageBuckets;
  readonly links: BucketLinks;
  readonly mounts: RuntimeMounts;

  constructor(client: ClientContext) {
    super(client);
    this.buckets = new StorageBuckets(client);
    this.links = new BucketLinks(client);
    this.mounts = new RuntimeMounts(client);
  }
}
