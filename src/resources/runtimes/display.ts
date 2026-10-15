/**
 * Display plane — pixel-level control of the runtime's screen.
 *
 * The display is the virtual monitor every headed surface shares — browser
 * windows, file dialogs, native UI. Use it for the work the browser plane
 * cannot see (OS dialogs, canvas, WebGL, non-browser apps) and for
 * `screenshot` when pixels are the answer.
 */

import { asRecord, bool, num, str } from '../../core/parse.js';
import type { RequestOptions } from '../../core/transport.js';
import { SERVICES } from '../../core/url.js';
import { assertRuntimeId } from '../../core/validate.js';
import { APIResource } from '../resource.js';

/** Current display state. */
export interface DisplayStatus {
  readonly enabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly display: string;
  readonly wm: string;
}

/** A captured frame. `data` is base64. */
export interface DisplayScreenshot {
  readonly data: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
}

/** Options for {@link RuntimeDisplay.enable}. */
export interface DisplayEnableOptions extends RequestOptions {
  width?: number;
  height?: number;
  depth?: number;
  wm?: string;
}

/** Options for {@link RuntimeDisplay.screenshot}. */
export interface DisplayScreenshotOptions extends RequestOptions {
  /** `png` (default) or `jpeg`. */
  format?: 'png' | 'jpeg';
  /** Crop region `{x, y, w, h}`. */
  region?: { x: number; y: number; w: number; h: number };
  /** JPEG quality 1–100. */
  quality?: number;
  /** Downscale percentage. */
  scalePct?: number;
  /** Block until the framebuffer is pixel-stable this long. */
  waitStableMs?: number;
  timeoutMs?: number;
}

function parseStatus(v: unknown): DisplayStatus {
  const r = asRecord(v);
  return {
    enabled: bool(r, 'enabled'),
    width: num(r, 'width'),
    height: num(r, 'height'),
    depth: num(r, 'depth'),
    display: str(r, 'display'),
    wm: str(r, 'wm'),
  };
}

function parseShot(v: unknown): DisplayScreenshot {
  const r = asRecord(v);
  return {
    data: str(r, 'data'),
    format: str(r, 'format'),
    width: num(r, 'width'),
    height: num(r, 'height'),
  };
}

/** `client.runtime.display` — the pixel plane. */
export class RuntimeDisplay extends APIResource {
  /** Enable the display; idempotent. */
  async enable(
    runtimeId: string,
    options: DisplayEnableOptions = {},
  ): Promise<DisplayStatus> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, ...rest } = options;
    return parseStatus(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/display/enable`,
          service: SERVICES.agents,
          body: rest,
          options: { signal, requestTimeoutMs, maxRetries },
        }),
      ),
    );
  }

  /** Disable the display. */
  async disable(runtimeId: string, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/disable`,
      service: SERVICES.agents,
      options,
    });
  }

  /** Current display state. */
  async status(runtimeId: string, options: RequestOptions = {}): Promise<DisplayStatus> {
    assertRuntimeId(runtimeId);
    return parseStatus(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `runtime/${runtimeId}/display/status`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /**
   * Screenshot the display. `waitStableMs` polls the framebuffer until
   * pixel-stable — the anti-flake wait for model loops.
   */
  async screenshot(
    runtimeId: string,
    options: DisplayScreenshotOptions = {},
  ): Promise<DisplayScreenshot> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, scalePct, waitStableMs, timeoutMs, ...rest } =
      options;
    return parseShot(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/display/screenshot`,
          service: SERVICES.agents,
          body: {
            ...rest,
            scale_pct: scalePct,
            wait_stable_ms: waitStableMs,
            timeout_ms: timeoutMs,
          },
          options: { signal, requestTimeoutMs, maxRetries },
        }),
      ),
    );
  }

  /** Click a display coordinate. */
  async click(
    runtimeId: string,
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle' = 'left',
    options: RequestOptions = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/click`,
      service: SERVICES.agents,
      body: { x, y, button },
      options,
    });
  }

  /** Move the pointer. */
  async move(runtimeId: string, x: number, y: number, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/move`,
      service: SERVICES.agents,
      body: { x, y },
      options,
    });
  }

  /** Scroll at a display coordinate. */
  async scroll(
    runtimeId: string,
    dx: number,
    dy: number,
    options: RequestOptions & { x?: number; y?: number } = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, x, y } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/scroll`,
      service: SERVICES.agents,
      body: { x: x ?? 0, y: y ?? 0, dx, dy },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Type text into the focused window. */
  async type(
    runtimeId: string,
    text: string,
    options: RequestOptions & { delayMs?: number } = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, delayMs } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/keyboard/type`,
      service: SERVICES.agents,
      body: { text, delay_ms: delayMs },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Press a named key (`enter`, `tab`, `escape`, `f5`, …). */
  async press(runtimeId: string, key: string, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/keyboard/press`,
      service: SERVICES.agents,
      body: { key },
      options,
    });
  }

  /** Press a chord (`['ctrl','c']`). */
  async hotkey(runtimeId: string, keys: string[], options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/keyboard/hotkey`,
      service: SERVICES.agents,
      body: { keys },
      options,
    });
  }

  /** Block until the framebuffer is pixel-stable. */
  async waitStable(
    runtimeId: string,
    stableMs = 300,
    timeoutMs = 10_000,
    options: RequestOptions = {},
  ): Promise<{ settled: boolean; waitedMs: number }> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/display/wait_stable`,
        service: SERVICES.agents,
        body: { stable_ms: stableMs, timeout_ms: timeoutMs },
        options,
      }),
    );
    return { settled: bool(r, 'settled'), waitedMs: num(r, 'waited_ms') };
  }

  /** Live view/takeover endpoint a human can open. */
  async view(
    runtimeId: string,
    options: RequestOptions & { fps?: number; quality?: number } = {},
  ): Promise<{ url: string; browserUrl: string; port: number; expiresAt?: string }> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, ...rest } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/display/view`,
        service: SERVICES.agents,
        body: rest,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return {
      url: str(r, 'url'),
      browserUrl: str(r, 'browser_url'),
      port: num(r, 'port'),
      expiresAt: typeof r.expires_at === 'string' ? r.expires_at : undefined,
    };
  }
}
