/**
 * Storage mounts.
 *
 * A *bucket* is S3 or S3-compatible object storage. The platform can provision
 * it, or it can connect to a bucket the account already owns. A *mount*
 * attaches a bucket or git repository to a runtime at a guest path.
 */

import { bool, optStr, str } from '../core/parse.js';

/** Object storage providers a bucket may target. */
export const BUCKET_PROVIDERS = ['s3', 's3_compatible'] as const;

/** Mount write permission. */
export const MountMode = {
  /** Read-only. */
  ReadOnly: 'ro',
  /** Read-write (bucket mounts only). */
  ReadWrite: 'rw',
} as const;

export type MountMode = (typeof MountMode)[keyof typeof MountMode];

/** An S3 or S3-compatible bucket, managed or externally connected. */
export interface StorageBucket {
  id: string;
  name: string;
  /** `managed` when provisioned by the platform, `external` when connected. */
  source: 'managed' | 'external' | string;
  /** One of {@link BUCKET_PROVIDERS}. */
  provider: string;
  region: string;
  /** Provider-side bucket name. */
  bucket: string;
  /** Object prefix for external buckets. */
  prefix?: string;
  /** Custom endpoint for `s3_compatible` providers. */
  endpoint?: string;
  pathStyle?: boolean;
  /** `static` (secret references) or `oidc` (role assumption). */
  authMode?: string;
  status: string;
  error?: string;
  verifyError?: string;
  lastVerifiedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function parseStorageBucket(data: Record<string, unknown>): StorageBucket {
  const bucket: StorageBucket = {
    id: str(data, 'id'),
    name: str(data, 'name'),
    source: str(data, 'source', 'managed'),
    provider: str(data, 'provider'),
    region: str(data, 'region'),
    bucket: str(data, 'bucket'),
    status: str(data, 'status'),
  };
  const prefix = optStr(data, 'prefix');
  if (prefix !== undefined) bucket.prefix = prefix;
  const endpoint = optStr(data, 'endpoint');
  if (endpoint !== undefined) bucket.endpoint = endpoint;
  if (data['path_style'] !== undefined) bucket.pathStyle = bool(data, 'path_style');
  const authMode = optStr(data, 'auth_mode');
  if (authMode !== undefined) bucket.authMode = authMode;
  const error = optStr(data, 'error');
  if (error !== undefined) bucket.error = error;
  const verifyError = optStr(data, 'verify_error');
  if (verifyError !== undefined) bucket.verifyError = verifyError;
  const lastVerifiedAt = optStr(data, 'last_verified_at');
  if (lastVerifiedAt !== undefined) bucket.lastVerifiedAt = lastVerifiedAt;
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) bucket.createdAt = createdAt;
  const updatedAt = optStr(data, 'updated_at');
  if (updatedAt !== undefined) bucket.updatedAt = updatedAt;
  return bucket;
}

/** A mount attached to a runtime. */
export interface RuntimeMount {
  id: string;
  runtimeId: string;
  /** `bucket` or `git`. */
  kind: string;
  /** The bucket id a bucket mount binds to. */
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

export interface RuntimeMountList {
  mounts: RuntimeMount[];
}
