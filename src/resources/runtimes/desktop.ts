/**
 * Desktop session plane — component lifecycle on desktop-template runtimes.
 *
 * Inspect and control the components a desktop image declares (the display
 * server, the session, the window manager) and read their journal logs.
 * On runtimes without a desktop image the calls return not-found errors.
 */

import { asRecord, bool, str } from '../../core/parse.js';
import type { RequestOptions } from '../../core/transport.js';
import { SERVICES } from '../../core/url.js';
import { assertRuntimeId } from '../../core/validate.js';
import { APIResource } from '../resource.js';

/** One declared component's live state. */
export interface DesktopComponent {
  readonly name: string;
  readonly unit: string;
  readonly state: string;
  readonly subState: string;
  readonly description: string;
}

/** Desktop session status. `present` is false on non-desktop images. */
export interface DesktopStatus {
  readonly present: boolean;
  readonly display: string;
  readonly user: string;
  readonly components: DesktopComponent[];
}

/** Options for {@link RuntimeDesktop.logs}. */
export interface DesktopLogsOptions extends RequestOptions {
  /** Resume from a previous page's `nextCursor`. */
  cursor?: string;
  /** Cap the returned entries. */
  max?: number;
  /** Filter by priority, e.g. `'err'`. */
  priority?: string;
}

/** A journal page. */
export interface DesktopLogs {
  readonly entries: { timestamp: string; message: string; priority: number }[];
  readonly nextCursor: string;
  readonly truncated: boolean;
}

function parseComponent(v: unknown): DesktopComponent {
  const r = asRecord(v);
  return {
    name: str(r, 'name'),
    unit: str(r, 'unit'),
    state: str(r, 'state'),
    subState: str(r, 'sub_state'),
    description: str(r, 'description'),
  };
}

/** `client.runtime.desktop` — the session plane for desktop images. */
export class RuntimeDesktop extends APIResource {
  /** Declared components and their live states. */
  async status(runtimeId: string, options: RequestOptions = {}): Promise<DesktopStatus> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/desktop/status`,
        service: SERVICES.agents,
        options,
      }),
    );
    return {
      present: bool(r, 'present'),
      display: str(r, 'display'),
      user: str(r, 'user'),
      components: Array.isArray(r.components) ? r.components.map(parseComponent) : [],
    };
  }

  /** Lifecycle op on a component — returns its post-op state. */
  async component(
    runtimeId: string,
    name: string,
    op: 'start' | 'stop' | 'restart',
    options: RequestOptions = {},
  ): Promise<DesktopComponent> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/desktop/component`,
        service: SERVICES.agents,
        body: { name, op },
        options,
      }),
    );
    return parseComponent(r);
  }

  /** Journal page for a component — pass `nextCursor` back for the next page. */
  async logs(
    runtimeId: string,
    name: string,
    options: DesktopLogsOptions = {},
  ): Promise<DesktopLogs> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, ...rest } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/desktop/logs`,
        service: SERVICES.agents,
        body: { name, ...rest },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return {
      entries: Array.isArray(r.entries)
        ? (r.entries as Record<string, unknown>[]).map((e) => ({
            timestamp: typeof e.timestamp === 'string' ? e.timestamp : '',
            message: typeof e.message === 'string' ? e.message : '',
            priority: typeof e.priority === 'number' ? e.priority : 0,
          }))
        : [],
      nextCursor: str(r, 'next_cursor'),
      truncated: bool(r, 'truncated'),
    };
  }
}
