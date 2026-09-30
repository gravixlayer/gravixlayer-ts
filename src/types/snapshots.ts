/**
 * Snapshot types.
 *
 * A snapshot captures a runtime's filesystem, and for a hot snapshot its
 * memory too, so a new runtime can be started from that exact state instead of
 * repeating the setup work.
 */

import { asRecord, bool, num, optStr, str } from '../core/parse.js';
import { parseRuntimeInfo, type RuntimeInfo } from './runtime.js';

/** How much of a runtime a snapshot captures. */
export const SnapshotKind = {
  /** Filesystem only. Smaller and cheaper to store. */
  Cold: 'cold',
  /** Filesystem and memory, so restored runtimes resume mid-process. */
  Hot: 'hot',
} as const;

export type SnapshotKind = (typeof SnapshotKind)[keyof typeof SnapshotKind];

/** A stored snapshot. */
export interface Snapshot {
  id: string;
  name: string;
  description: string;
  /** `cold` or `hot`. */
  kind: string;
  /** Lifecycle state, for example `ready`. */
  state: string;
  cloud: string;
  region: string;
  vcpuCount: number;
  memoryMb: number;
  diskSizeMb: number;
  /** `private` or `public`. */
  visibility: string;
  /** True when the snapshot can be used to start runtimes. */
  isActive: boolean;
  /** What the snapshot was captured from. */
  source: string;
  /** Template the source runtime was built from. */
  sourceTemplateId: string;
  /** Runtime the snapshot was captured from. */
  sourceRuntimeId?: string;
  /** Progress of copying the snapshot to the hosts that can serve it. */
  distributionStatus: string;
  /** Stored size in bytes. */
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export function parseSnapshot(data: Record<string, unknown>): Snapshot {
  const snapshot: Snapshot = {
    id: str(data, 'id'),
    name: str(data, 'name'),
    description: str(data, 'description'),
    kind: str(data, 'kind', SnapshotKind.Cold),
    state: str(data, 'state'),
    cloud: str(data, 'cloud') || str(data, 'provider'),
    region: str(data, 'region'),
    vcpuCount: num(data, 'vcpu_count'),
    memoryMb: num(data, 'memory_mb'),
    diskSizeMb: num(data, 'disk_size_mb'),
    visibility: str(data, 'visibility', 'private'),
    isActive: bool(data, 'is_active'),
    source: str(data, 'source'),
    sourceTemplateId: str(data, 'source_template_id'),
    distributionStatus: str(data, 'distribution_status'),
    sizeBytes: num(data, 'size_bytes'),
    createdAt: str(data, 'created_at'),
    updatedAt: str(data, 'updated_at'),
  };
  const sourceRuntimeId = optStr(data, 'source_runtime_id');
  if (sourceRuntimeId !== undefined) snapshot.sourceRuntimeId = sourceRuntimeId;
  const lastUsedAt = optStr(data, 'last_used_at');
  if (lastUsedAt !== undefined) snapshot.lastUsedAt = lastUsedAt;
  return snapshot;
}

/** One page of snapshots. */
export interface SnapshotListResponse {
  snapshots: Snapshot[];
  limit: number;
  offset: number;
  total: number;
}

/** Result of deleting a snapshot. */
export interface SnapshotDeleteResponse {
  /** The identifier or name that was deleted. */
  snapshotId: string;
  deleted: boolean;
}

/**
 * One fork child that failed to start. Fork resolves per child — a single
 * failure never fails the request.
 */
export interface ForkError {
  /** Human-readable failure reason. */
  error: string;
  /** Stable machine-readable code, for example `capacity_exhausted`. */
  code: string;
}

/** Result of `runtimes.fork` and `snapshots.fork`. */
export interface ForkResponse {
  /**
   * Per-child results in request order — a `RuntimeInfo` on success or a
   * `ForkError` on failure.
   */
  children: (RuntimeInfo | ForkError)[];
  /** Snapshot the children were created from. */
  snapshotId: string;
  /** Whether the capture was kept as a named snapshot. */
  snapshotPersisted: boolean;
  /** Parent runtime on a live fork; absent on a snapshot fork. */
  parentRuntimeId?: string;
}

function isForkError(child: RuntimeInfo | ForkError): child is ForkError {
  return (child as ForkError).code !== undefined;
}

/** RuntimeInfo entries that started — drops the per-child failures. */
export function forkRuntimes(response: ForkResponse): RuntimeInfo[] {
  return response.children.filter((c): c is RuntimeInfo => !isForkError(c));
}

/** Per-child failures inside the response. */
export function forkErrors(response: ForkResponse): ForkError[] {
  return response.children.filter(isForkError);
}

export function parseForkResponse(data: Record<string, unknown>): ForkResponse {
  const raw = data['children'];
  const children = (Array.isArray(raw) ? raw : []).map((item): RuntimeInfo | ForkError => {
    const rec = asRecord(item);
    const runtime = rec['runtime'];
    if (runtime && typeof runtime === 'object') {
      return parseRuntimeInfo(asRecord(runtime));
    }
    return { error: str(rec, 'error', 'fork failed'), code: str(rec, 'code', 'internal_error') };
  });
  const response: ForkResponse = {
    children,
    snapshotId: str(data, 'snapshot_id'),
    snapshotPersisted: bool(data, 'snapshot_persisted'),
  };
  const parentRuntimeId = optStr(data, 'parent_runtime_id');
  if (parentRuntimeId !== undefined) response.parentRuntimeId = parentRuntimeId;
  return response;
}
