/**
 * Storage mounts.
 *
 * A *bucket* is managed object storage the platform provisions for you. A
 * *bucket link* binds an S3-compatible bucket you already own — credentials
 * are referenced by name from a secret provider and never passed through the
 * API. A *mount* attaches a bucket, link, or git repository to a runtime at a
 * guest path.
 */

import { bool, optStr, str } from '../core/parse.js';

/** Object storage providers a link may target. */
export const LINK_PROVIDERS = ['s3', 's3_compatible'] as const;

/** Mount write permission. */
export const MountMode = {
  /** Read-only. */
  ReadOnly: 'ro',
  /** Read-write (bucket mounts only). */
  ReadWrite: 'rw',
} as const;

export type MountMode = (typeof MountMode)[keyof typeof MountMode];

/** A managed bucket. */
export interface StorageBucket {
  id: string;
  name: string;
  provider: string;
  region: string;
  /** Provider-side bucket name once provisioned. */
  bucket: string;
  status: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function parseStorageBucket(data: Record<string, unknown>): StorageBucket {
  const bucket: StorageBucket = {
    id: str(data, 'id'),
    name: str(data, 'name'),
    provider: str(data, 'provider'),
    region: str(data, 'region'),
    bucket: str(data, 'bucket'),
    status: str(data, 'status'),
  };
  const error = optStr(data, 'error');
  if (error !== undefined) bucket.error = error;
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) bucket.createdAt = createdAt;
  const updatedAt = optStr(data, 'updated_at');
  if (updatedAt !== undefined) bucket.updatedAt = updatedAt;
  return bucket;
}

/** A link to a bucket the account already owns. */
export interface BucketLink {
  id: string;
  name: string;
  /** One of {@link LINK_PROVIDERS}. */
  provider: string;
  bucket: string;
  prefix: string;
  region: string;
  /** Custom endpoint for `s3_compatible` providers. */
  endpoint?: string;
  pathStyle: boolean;
  /** `static` (provider secret references) or `oidc` (role assumption). */
  authMode: string;
  status: string;
  verifyError?: string;
  lastVerifiedAt?: string;
  createdAt?: string;
}

export function parseBucketLink(data: Record<string, unknown>): BucketLink {
  const link: BucketLink = {
    id: str(data, 'id'),
    name: str(data, 'name'),
    provider: str(data, 'provider'),
    bucket: str(data, 'bucket'),
    prefix: str(data, 'prefix'),
    region: str(data, 'region'),
    pathStyle: bool(data, 'path_style'),
    authMode: str(data, 'auth_mode'),
    status: str(data, 'status'),
  };
  const endpoint = optStr(data, 'endpoint');
  if (endpoint !== undefined) link.endpoint = endpoint;
  const verifyError = optStr(data, 'verify_error');
  if (verifyError !== undefined) link.verifyError = verifyError;
  const lastVerifiedAt = optStr(data, 'last_verified_at');
  if (lastVerifiedAt !== undefined) link.lastVerifiedAt = lastVerifiedAt;
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) link.createdAt = createdAt;
  return link;
}

/** A mount attached to a runtime. */
export interface RuntimeMount {
  id: string;
  runtimeId: string;
  /** `bucket` or `git`. */
  kind: string;
  /** The bucket or link id a bucket mount binds to. */
  targetId?: string;
  mountPath: string;
  /** `ro` or `rw`. */
  mode: string;
  /** `attached`, `detached`, or `failed`. */
  state: string;
  error?: string;
  /** Where the mount resolved to — e.g. the pinned git commit. */
  provenance?: string;
  createdAt?: string;
  /** Set once the mount detaches. */
  detachedAt?: string;
}

export function parseRuntimeMount(data: Record<string, unknown>): RuntimeMount {
  const mount: RuntimeMount = {
    id: str(data, 'id'),
    runtimeId: str(data, 'runtime_id'),
    kind: str(data, 'kind'),
    mountPath: str(data, 'mount_path'),
    mode: str(data, 'mode'),
    state: str(data, 'state'),
  };
  const targetId = optStr(data, 'target_id');
  if (targetId !== undefined) mount.targetId = targetId;
  const error = optStr(data, 'error');
  if (error !== undefined) mount.error = error;
  const provenance = optStr(data, 'provenance');
  if (provenance !== undefined) mount.provenance = provenance;
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) mount.createdAt = createdAt;
  const detachedAt = optStr(data, 'detached_at');
  if (detachedAt !== undefined) mount.detachedAt = detachedAt;
  return mount;
}

export interface StorageBucketList {
  buckets: StorageBucket[];
  total: number;
}

export interface BucketLinkList {
  links: BucketLink[];
  total: number;
}

export interface RuntimeMountList {
  mounts: RuntimeMount[];
}
