/**
 * Desktop — the runtime's computer-use surface.
 *
 * `client.runtime.desktop` is the single entry point for driving a runtime's
 * desktop: pixel input and screenshots, windows, apps, clipboard, live view,
 * agent `act` batches, and the session plane (component lifecycle and journal
 * logs) on desktop-template images. `client.runtime.browser` stays the
 * semantic plane for in-page element work.
 */

import { asRecord, bool, num, str } from '../../core/parse.js';
import type { RequestOptions } from '../../core/transport.js';
import { SERVICES } from '../../core/url.js';
import { assertRuntimeId } from '../../core/validate.js';
import { RuntimeDisplay } from './display.js';

/** One declared component's live state. */
export interface DesktopComponent {
  readonly name: string;
  readonly unit: string;
  readonly active: string;
  readonly sub: string;
  readonly result: string;
  readonly restarts: number;
  readonly startedUsec: number;
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
  /** Resume from a previous page's `cursor`. */
  cursor?: string;
  /** Cap the returned entries. */
  max?: number;
  /** Filter by priority, e.g. `'err'`. */
  priority?: string;
}

/** A journal page — feed `cursor` back for the next page. */
export interface DesktopLogs {
  readonly entries: {
    usec: number;
    unit: string;
    priority: number;
    message: string;
    identifier: string;
  }[];
  readonly cursor: string;
}

function parseComponent(v: unknown): DesktopComponent {
  const r = asRecord(v);
  return {
    name: str(r, 'name'),
    unit: str(r, 'unit'),
    active: str(r, 'active'),
    sub: str(r, 'sub'),
    result: str(r, 'result'),
    restarts: num(r, 'restarts'),
    startedUsec: num(r, 'started_usec'),
  };
}

/** `client.runtime.desktop` — the full computer-use surface. */
export class RuntimeDesktop extends RuntimeDisplay {
  /** Declared components and their live states. */
  async components(runtimeId: string, options: RequestOptions = {}): Promise<DesktopStatus> {
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

  /** Journal page for a component — pass `cursor` back for the next page. */
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
            usec: num(asRecord(e), 'usec'),
            unit: str(asRecord(e), 'unit'),
            priority: num(asRecord(e), 'priority'),
            message: str(asRecord(e), 'message'),
            identifier: str(asRecord(e), 'identifier'),
          }))
        : [],
      cursor: str(r, 'cursor'),
    };
  }

  async startComponent(
    runtimeId: string,
    name: string,
    options: RequestOptions = {},
  ): Promise<DesktopComponent> {
    return this.component(runtimeId, name, 'start', options);
  }

  async stopComponent(
    runtimeId: string,
    name: string,
    options: RequestOptions = {},
  ): Promise<DesktopComponent> {
    return this.component(runtimeId, name, 'stop', options);
  }

  async restartComponent(
    runtimeId: string,
    name: string,
    options: RequestOptions = {},
  ): Promise<DesktopComponent> {
    return this.component(runtimeId, name, 'restart', options);
  }

  // ── simple mouse/keyboard conveniences ────────────────────────────────

  async leftClick(runtimeId: string, x?: number, y?: number, options: RequestOptions = {}) {
    return this.click(runtimeId, x, y, 'left', options);
  }

  async doubleClick(runtimeId: string, x?: number, y?: number, options: RequestOptions = {}) {
    return this.click(runtimeId, x, y, 'left', { ...options, clickCount: 2 });
  }

  async rightClick(runtimeId: string, x?: number, y?: number, options: RequestOptions = {}) {
    return this.click(runtimeId, x, y, 'right', options);
  }

  async middleClick(runtimeId: string, x?: number, y?: number, options: RequestOptions = {}) {
    return this.click(runtimeId, x, y, 'middle', options);
  }

  async mousePress(
    runtimeId: string,
    button?: 'left' | 'right' | 'middle',
    x?: number,
    y?: number,
    options: RequestOptions = {},
  ) {
    return this.down(runtimeId, x, y, button, options);
  }

  async mouseRelease(
    runtimeId: string,
    button?: 'left' | 'right' | 'middle',
    x?: number,
    y?: number,
    options: RequestOptions = {},
  ) {
    return this.up(runtimeId, button, { ...options, x, y });
  }

  async moveMouse(runtimeId: string, x: number, y: number, options: RequestOptions = {}) {
    return this.move(runtimeId, x, y, options);
  }

  async write(runtimeId: string, text: string, delayMs?: number, options: RequestOptions = {}) {
    return this.type(runtimeId, text, { ...options, delayMs });
  }
}
