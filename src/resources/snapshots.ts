/**
 * Snapshots: a runtime frozen and stored under a name.
 *
 * Capture a runtime once it is set up — dependencies installed, data loaded,
 * a server warm — and every later runtime created from that snapshot starts in
 * exactly that state instead of repeating the work.
 *
 * A `hot` snapshot captures memory and disk, so the guest resumes mid-process.
 * A `cold` snapshot captures disk only and boots fresh.
 */

import { asRecord, num } from '../core/parse.js';
import type { RequestOptions } from '../core/transport.js';
import { buildListEndpoint, encodePathSegment, SERVICES, type QueryValue } from '../core/url.js';
import { assertNonEmpty, assertRuntimeId } from '../core/validate.js';
import {
  parseSnapshot,
  SnapshotKind,
  type Snapshot,
  type SnapshotDeleteResponse,
  type SnapshotListResponse,
} from '../types/snapshots.js';
import { APIResource } from './resource.js';

/**
 * Capturing a snapshot pauses the guest and writes its memory and disk out,
 * which takes longer than the default request budget allows.
 */
const SNAPSHOT_CREATE_TIMEOUT_MS = 600_000;

/** Default page size for {@link Snapshots.list}. */
const DEFAULT_PAGE_SIZE = 20;

/** Options for {@link Snapshots.create}. */
export interface CreateSnapshotOptions extends RequestOptions {
  /**
   * `hot` captures memory and disk; `cold` captures disk only.
   * Defaults to `cold`.
   */
  kind?: SnapshotKind | string;
  /** Human-readable description. */
  description?: string;
}

/** Options for {@link Snapshots.list}. */
export interface ListSnapshotsOptions extends RequestOptions {
  /** Maximum number of snapshots to return. Defaults to 20. */
  limit?: number;
  /** Number of snapshots to skip. Defaults to 0. */
  offset?: number;
  /** Return only `hot` or only `cold` snapshots. */
  kind?: SnapshotKind | string;
  /** Return only snapshots captured from this runtime. */
  runtimeId?: string;
  /** Filter by storage state. */
  state?: string;
  /** Filter by how the snapshot was produced. */
  source?: string;
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

/** Resolve a snapshot reference, which may be a UUID or a name. */
function snapshotPath(reference: string): string {
  return `snapshots/${encodePathSegment(assertNonEmpty(reference, 'snapshot'))}`;
}

/** Capture, catalog, and restore snapshots. */
export class Snapshots extends APIResource {
  /**
   * Capture a runtime into the catalog.
   *
   * @example
   * ```ts
   * await client.snapshots.create(runtime.runtimeId, 'deps-installed', { kind: 'hot' });
   * const warm = await client.runtimes.create({ snapshot: 'deps-installed' });
   * ```
   */
  async create(
    runtimeId: string,
    name: string,
    options: CreateSnapshotOptions = {},
  ): Promise<Snapshot> {
    assertRuntimeId(runtimeId);
    assertNonEmpty(name, 'name');

    const body: Record<string, unknown> = {
      runtime_id: runtimeId,
      name,
      kind: options.kind ?? SnapshotKind.Cold,
    };
    if (options.description !== undefined) body['description'] = options.description;

    const transport = requestOptions(options);
    if (transport.timeout === undefined) transport.timeout = SNAPSHOT_CREATE_TIMEOUT_MS;

    return parseSnapshot(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: 'snapshots',
          service: SERVICES.agents,
          body,
          options: transport,
        }),
      ),
    );
  }

  /** List snapshots. */
  async list(options: ListSnapshotsOptions = {}): Promise<SnapshotListResponse> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    const offset = options.offset ?? 0;

    const extra: Record<string, QueryValue> = {};
    if (options.kind) extra['kind'] = options.kind;
    if (options.runtimeId) extra['runtime_id'] = options.runtimeId;
    if (options.state) extra['state'] = options.state;
    if (options.source) extra['source'] = options.source;
    if (options.projectId) extra['project_id'] = options.projectId;

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: buildListEndpoint('snapshots', { limit, offset, extra }),
        service: SERVICES.agents,
        options: requestOptions(options),
      }),
    );

    const raw = data['snapshots'];
    const snapshots = (Array.isArray(raw) ? raw : []).map((item) => parseSnapshot(asRecord(item)));
    return {
      snapshots,
      limit: num(data, 'limit', limit),
      offset: num(data, 'offset', offset),
      total: num(data, 'total', snapshots.length),
    };
  }

  /** Fetch a snapshot by id or name. */
  async get(snapshot: string, options: RequestOptions = {}): Promise<Snapshot> {
    return parseSnapshot(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: snapshotPath(snapshot),
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /** Allow new runtimes to be created from a snapshot again. */
  async activate(snapshot: string, options: RequestOptions = {}): Promise<Snapshot> {
    return parseSnapshot(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `${snapshotPath(snapshot)}/activate`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /**
   * Stop new runtimes from being created from a snapshot.
   *
   * Runtimes already running from it are unaffected.
   */
  async deactivate(snapshot: string, options: RequestOptions = {}): Promise<Snapshot> {
    return parseSnapshot(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `${snapshotPath(snapshot)}/deactivate`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /**
   * Delete a snapshot.
   *
   * Runtimes already running from it keep the files they have open and are not
   * disturbed.
   */
  async delete(snapshot: string, options: RequestOptions = {}): Promise<SnapshotDeleteResponse> {
    const path = snapshotPath(snapshot);

    await this.http.requestVoid({
      method: 'DELETE',
      path,
      service: SERVICES.agents,
      options,
    });

    // The API answers 204, so the confirmation is assembled here.
    return { snapshotId: snapshot, deleted: true };
  }
}
