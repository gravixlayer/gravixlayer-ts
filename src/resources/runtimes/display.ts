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

/** Live display geometry — follows resizes, unlike the enable-time config. */
export interface DisplayInfo {
  readonly enabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly dpi: number;
  readonly display: string;
  readonly attached: boolean;
}

/** Live pointer position. */
export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

/** A captured frame. `data` is base64. */
export interface DisplayScreenshot {
  readonly data: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  /** Applied downscale factor (1 = full resolution). */
  readonly scale: number;
  /** Frame revision — feed back as `ifRev` to skip unchanged shots. */
  readonly rev: number;
  /** True when `ifRev` matched the current frame — `data` is empty. */
  readonly unchanged: boolean;
}

/** Options for {@link RuntimeDisplay.enable}. */
export interface DisplayEnableOptions extends RequestOptions {
  width?: number;
  height?: number;
  depth?: number;
  wm?: string;
  /** Display name to use, e.g. `:0`. */
  display?: string;
  /**
   * `auto` (default) attaches to the session's display when the image
   * ships one and spawns a virtual display otherwise; `spawn` forces a
   * new virtual display; `attach` requires a session display.
   */
  mode?: 'auto' | 'spawn' | 'attach';
}

/** Options for {@link RuntimeDisplay.screenshot}. */
export interface DisplayScreenshotOptions extends RequestOptions {
  /** `png` (default), `jpeg` or `webp`. */
  format?: 'png' | 'jpeg' | 'webp';
  /** Crop region `{x, y, w, h}`. */
  region?: { x: number; y: number; w: number; h: number };
  /** JPEG/WebP quality 1–100. */
  quality?: number;
  /** Downscale percentage. */
  scalePct?: number;
  /** Fit inside `maxWidth`×`maxHeight` preserving aspect. */
  maxWidth?: number;
  maxHeight?: number;
  /** Composite the pointer into the shot. */
  cursor?: boolean;
  /**
   * Skip encode+transfer when the frame is unchanged — pass a previous
   * reply's `rev`; `unchanged` is then true and `data` empty.
   */
  ifRev?: number;
  /** Block until the framebuffer is pixel-stable this long. */
  waitStableMs?: number;
  timeoutMs?: number;
}

/**
 * One input action inside {@link RuntimeDisplay.act}. Either the nested
 * shape — `{ kind: 'click', mouse: { x, y, button } }`,
 * `{ kind: 'type', key: { text } }` — or the flat per-verb body the input
 * methods take — `{ kind: 'click', x, y, button, clickCount }`. `kind`
 * decides which sub-message flat fields fill. `{ kind: 'wait', ms }`
 * (or `durationMs`) pauses the batch for a fixed interval.
 */
export interface DisplayAction {
  readonly kind: string;
  readonly mouse?: Record<string, unknown>;
  /** Key name — the flat wire form (`"escape"`, `"ctrl+c"`) or a nested body. */
  readonly key?: string | Record<string, unknown>;
  readonly coordinateSpace?: 'display' | 'screenshot';
  readonly [field: string]: unknown;
}

/** Options for {@link RuntimeDisplay.act}. */
export interface ActOptions extends RequestOptions {
  /** Inputs applied in order before settling. */
  actions: DisplayAction[];
  /** Extra quiet time required after the last observed change. */
  settleMs?: number;
  /** Overall budget for actions + settle. */
  timeoutMs?: number;
  /**
   * Observation shot — screenshot options in wire form
   * (`format`, `region`, `quality`, `scale_pct`, `max_width`,
   * `max_height`, `cursor`, `if_rev`). Omit for no image.
   */
  observe?: Record<string, unknown>;
}

/** Result of {@link RuntimeDisplay.act} — one agent step. */
export interface ActResult {
  /** The screen settled within the budget. */
  readonly settled: boolean;
  /** Frame revision at observation time — feed back via `observe.if_rev`. */
  readonly rev: number;
  readonly screenshot?: DisplayScreenshot;
}

/** Window ops accepted by {@link RuntimeDisplay.windowOp}. */
export type WindowOp =
  | 'focus'
  | 'close'
  | 'raise'
  | 'lower'
  | 'move'
  | 'resize'
  | 'maximize'
  | 'unmaximize'
  | 'minimize'
  | 'fullscreen'
  | 'unfullscreen';

/** A top-level window. */
export interface DisplayWindow {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  readonly windowClass: string;
  readonly instance: string;
  readonly desktop: number;
  readonly focused: boolean;
  readonly states: string[];
}

/** An installed application (freedesktop entry). */
export interface DisplayApp {
  readonly id: string;
  readonly name: string;
  readonly exec: string;
  readonly icon: string;
  readonly categories: string[];
}

/** Result of {@link RuntimeDisplay.launchApp} / {@link RuntimeDisplay.open}. */
export interface LaunchResult {
  readonly pid: number;
  /** Set when `waitWindow` resolved a new top-level window. */
  readonly windowId?: number;
  readonly app: string;
  readonly mime: string;
}

/** Pointer button. */
export type MouseButton = 'left' | 'right' | 'middle';

/** Options shared by pointer actions. */
export interface PointerOptions extends RequestOptions {
  /** Held modifiers during the action (`['ctrl']`, …). */
  modifiers?: string[];
  /**
   * `screenshot` maps coordinates in delivered pixels back to display
   * space — use after a fitted `screenshot({ maxWidth, maxHeight })`.
   */
  coordinateSpace?: 'display' | 'screenshot';
}

/** Options for {@link RuntimeDisplay.click}. */
export interface ClickOptions extends PointerOptions {
  /** 2 = double-click. */
  clickCount?: number;
}

/** Options for {@link RuntimeDisplay.drag}. */
export interface DragOptions extends PointerOptions {
  /** Drag start — defaults to the current pointer position. */
  from?: { x: number; y: number };
  /** Interpolation steps (0 = direct). */
  steps?: number;
  /** Total drag time. */
  durationMs?: number;
}

/** Options for {@link RuntimeDisplay.type}. */
export interface TypeOptions extends RequestOptions {
  /** Per-keystroke delay. */
  delayMs?: number;
  /**
   * `paste` stages the text on the clipboard and sends ctrl+v — faster
   * and lossless for large blocks. Default types keystrokes.
   */
  mode?: 'keys' | 'paste';
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

function parseInfo(v: unknown): DisplayInfo {
  const r = asRecord(v);
  return {
    enabled: bool(r, 'enabled'),
    width: num(r, 'width'),
    height: num(r, 'height'),
    depth: num(r, 'depth'),
    dpi: num(r, 'dpi'),
    display: str(r, 'display'),
    attached: bool(r, 'attached'),
  };
}

function parseShot(v: unknown): DisplayScreenshot {
  const r = asRecord(v);
  return {
    data: str(r, 'data'),
    format: str(r, 'format'),
    width: num(r, 'width'),
    height: num(r, 'height'),
    scale: num(r, 'scale'),
    rev: num(r, 'rev'),
    unchanged: bool(r, 'unchanged'),
  };
}

function parseWindow(v: unknown): DisplayWindow {
  const r = asRecord(v);
  return {
    id: num(r, 'id'),
    x: num(r, 'x'),
    y: num(r, 'y'),
    w: num(r, 'w'),
    h: num(r, 'h'),
    title: str(r, 'title'),
    windowClass: str(r, 'window_class'),
    instance: str(r, 'instance'),
    desktop: num(r, 'desktop'),
    focused: bool(r, 'focused'),
    states: Array.isArray(r.states) ? (r.states as string[]) : [],
  };
}

function parseApp(v: unknown): DisplayApp {
  const r = asRecord(v);
  return {
    id: str(r, 'id'),
    name: str(r, 'name'),
    exec: str(r, 'exec'),
    icon: str(r, 'icon'),
    categories: Array.isArray(r.categories) ? (r.categories as string[]) : [],
  };
}

function parseLaunch(v: unknown): LaunchResult {
  const r = asRecord(v);
  const windowId = num(r, 'window_id');
  return {
    pid: num(r, 'pid'),
    windowId: windowId || undefined,
    app: str(r, 'app'),
    mime: str(r, 'mime'),
  };
}

/** camelCase option names accepted inside `act` actions. */
const ACTION_WIRE_KEYS: Record<string, string> = {
  clickCount: 'click_count',
  toX: 'to_x',
  toY: 'to_y',
  durationMs: 'duration_ms',
  delayMs: 'delay_ms',
  coordinateSpace: 'coordinate_space',
};

function wireActionFields(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    out[ACTION_WIRE_KEYS[k] ?? k] = v;
  }
  return out;
}

/** Actions travel on the wire with snake_case fields. */
function normalizeAction(a: DisplayAction): Record<string, unknown> {
  const { kind, mouse, key, coordinateSpace, ...rest } = a;
  return {
    kind,
    ...wireActionFields(rest),
    ...(mouse ? { mouse: wireActionFields(mouse) } : {}),
    ...(key ? { key: typeof key === 'object' ? wireActionFields(key) : key } : {}),
    ...(coordinateSpace ? { coordinate_space: coordinateSpace } : {}),
  };
}

/** The pixel plane — exposed through `client.runtime.desktop`. */
export class RuntimeDisplay extends APIResource {
  /** Enable the display; idempotent. */
  async enable(runtimeId: string, options: DisplayEnableOptions = {}): Promise<DisplayStatus> {
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

  /** Live geometry as the display reports it now — follows resizes. */
  async info(runtimeId: string, options: RequestOptions = {}): Promise<DisplayInfo> {
    assertRuntimeId(runtimeId);
    return parseInfo(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `runtime/${runtimeId}/display/info`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  /** Live pointer coordinates. */
  async position(runtimeId: string, options: RequestOptions = {}): Promise<PointerPosition> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/display/position`,
        service: SERVICES.agents,
        options,
      }),
    );
    return { x: num(r, 'x'), y: num(r, 'y') };
  }

  /** Key names `press`/`hotkey` accept. */
  async keys(runtimeId: string, options: RequestOptions = {}): Promise<string[]> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/display/keys`,
        service: SERVICES.agents,
        options,
      }),
    );
    return Array.isArray(r.keys) ? (r.keys as string[]) : [];
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
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      scalePct,
      waitStableMs,
      timeoutMs,
      maxWidth,
      maxHeight,
      ifRev,
      ...rest
    } = options;
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
            // The settle wait's budget defaults to 4× the stability
            // window — same derivation the Python SDK applies — or
            // cellcore falls back to its fixed settle default.
            timeout_ms: timeoutMs ?? (waitStableMs ? waitStableMs * 4 : undefined),
            max_width: maxWidth,
            max_height: maxHeight,
            if_rev: ifRev,
          },
          options: { signal, requestTimeoutMs, maxRetries },
        }),
      ),
    );
  }

  /**
   * Click — unset axes keep the current pointer position; `clickCount` 2
   * is a double-click; `modifiers` are held during the click.
   */
  async click(
    runtimeId: string,
    x?: number,
    y?: number,
    button: MouseButton = 'left',
    options: ClickOptions = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, clickCount, coordinateSpace, modifiers } =
      options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/click`,
      service: SERVICES.agents,
      body: { x, y, button, click_count: clickCount, modifiers, coordinate_space: coordinateSpace },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Press a mouse button (compose with `up` or `drag`). */
  async down(
    runtimeId: string,
    x?: number,
    y?: number,
    button: MouseButton = 'left',
    options: PointerOptions = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, modifiers, coordinateSpace } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/down`,
      service: SERVICES.agents,
      body: { x, y, button, modifiers, coordinate_space: coordinateSpace },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Release a mouse button — `x`/`y` move the pointer first when given. */
  async up(
    runtimeId: string,
    button: MouseButton = 'left',
    options: PointerOptions & { x?: number; y?: number } = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, x, y, modifiers, coordinateSpace } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/up`,
      service: SERVICES.agents,
      body: { x, y, button, modifiers, coordinate_space: coordinateSpace },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /**
   * Drag from `options.from` (or the current position) to `(toX, toY)` with
   * `button` held, interpolated over `steps` inside `durationMs`.
   */
  async drag(
    runtimeId: string,
    toX: number,
    toY: number,
    button: MouseButton = 'left',
    options: DragOptions = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      from,
      steps,
      durationMs,
      modifiers,
      coordinateSpace,
    } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/drag`,
      service: SERVICES.agents,
      body: {
        x: from?.x,
        y: from?.y,
        to_x: toX,
        to_y: toY,
        button,
        steps,
        duration_ms: durationMs,
        modifiers,
        coordinate_space: coordinateSpace,
      },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Move the pointer — `coordinateSpace` maps screenshot pixels back. */
  async move(runtimeId: string, x: number, y: number, options: PointerOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, coordinateSpace } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/move`,
      service: SERVICES.agents,
      body: { x, y, coordinate_space: coordinateSpace },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /**
   * Scroll the wheel `dx`/`dy` units. `x`/`y` position the pointer first —
   * the wheel lands under the pointer; an unset axis keeps the current one.
   */
  async scroll(
    runtimeId: string,
    dx: number,
    dy: number,
    options: PointerOptions & { x?: number; y?: number } = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, x, y, modifiers, coordinateSpace } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/mouse/scroll`,
      service: SERVICES.agents,
      body: { x, y, dx, dy, modifiers, coordinate_space: coordinateSpace },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Type text into the focused window. */
  async type(runtimeId: string, text: string, options: TypeOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, delayMs, mode } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/keyboard/type`,
      service: SERVICES.agents,
      body: { text, delay_ms: delayMs, mode },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Press a named key (`enter`, `tab`, `escape`, `f5`, …), optionally with modifiers held. */
  async press(runtimeId: string, key: string, options: PointerOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, modifiers } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/keyboard/press`,
      service: SERVICES.agents,
      body: { key, modifiers },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Press a chord (`['ctrl','c']`). */
  async hotkey(runtimeId: string, keys: string[], options: PointerOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, modifiers } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/keyboard/hotkey`,
      service: SERVICES.agents,
      body: { keys, modifiers },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** Read the display clipboard contents. */
  async getClipboard(runtimeId: string, options: RequestOptions = {}): Promise<string> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/display/clipboard`,
        service: SERVICES.agents,
        body: { op: 'get' },
        options,
      }),
    );
    return str(r, 'text');
  }

  /** Own the display clipboard — subsequent pastes yield `text`. */
  async setClipboard(runtimeId: string, text: string, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/clipboard`,
      service: SERVICES.agents,
      body: { op: 'set', text },
      options,
    });
  }

  /** Block until the framebuffer is pixel-stable. */
  async waitStable(
    runtimeId: string,
    stableMs = 300,
    timeoutMs = 10_000,
    options: RequestOptions = {},
  ): Promise<{ settled: boolean; waitedMs: number; rev: number }> {
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
    return { settled: bool(r, 'settled'), waitedMs: num(r, 'waited_ms'), rev: num(r, 'rev') };
  }

  /**
   * Live view/takeover endpoint a human can open. `browserUrl` carries the
   * auth token; it is minted on the first call for a port, so a repeat call
   * returns a token-less URL unless `rotateToken` is set (fresh token —
   * invalidates the previous URL). `role: 'watch'` mints a view-only link
   * (no input injection). `watchUrl` is `browserUrl` with the role token
   * already composed — the ready-to-open link.
   */
  async view(
    runtimeId: string,
    options: RequestOptions & {
      fps?: number;
      quality?: number;
      rotateToken?: boolean;
      role?: 'control' | 'watch';
      /** Stream only this window's pixels. */
      windowId?: number;
    } = {},
  ): Promise<{
    url: string;
    browserUrl: string;
    watchUrl: string;
    port: number;
    expiresAt?: string;
    viewToken?: string;
  }> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, rotateToken, windowId, ...rest } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/display/view`,
        service: SERVICES.agents,
        body: { rotate_token: rotateToken, window_id: windowId, ...rest },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    const browserUrl = str(r, 'browser_url');
    const viewToken = typeof r.view_token === 'string' && r.view_token ? r.view_token : undefined;
    // The guest WS enforces the minted role via `?vt=` — compose it into
    // the share URL so callers can never hand out an un-tokened link.
    const watchUrl =
      browserUrl && viewToken
        ? `${browserUrl}${browserUrl.includes('?') ? '&' : '?'}vt=${viewToken}`
        : browserUrl;
    return {
      url: str(r, 'url'),
      browserUrl,
      watchUrl,
      port: num(r, 'port'),
      expiresAt: typeof r.expires_at === 'string' ? r.expires_at : undefined,
      viewToken,
    };
  }

  /** Stop the live view server and free its port. */
  async stopView(runtimeId: string, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/view/stop`,
      service: SERVICES.agents,
      options,
    });
  }

  /**
   * One agent step in one call: run `actions` in order, wait for the
   * screen to settle, return the observation (`{settled, rev, screenshot}`).
   * Feed `screenshot.rev` back as `observe.if_rev` on the next call to skip
   * unchanged frames.
   */
  async act(runtimeId: string, options: ActOptions): Promise<ActResult> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, actions, settleMs, timeoutMs, observe } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/display/act`,
        service: SERVICES.agents,
        body: {
          actions: actions.map(normalizeAction),
          settle_ms: settleMs,
          timeout_ms: timeoutMs,
          observe,
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return {
      settled: bool(r, 'settled'),
      rev: num(r, 'rev'),
      screenshot: r.screenshot !== undefined ? parseShot(r.screenshot) : undefined,
    };
  }

  /** Live-resize the display; returns the new live geometry. */
  async resize(
    runtimeId: string,
    width: number,
    height: number,
    options: RequestOptions = {},
  ): Promise<DisplayInfo> {
    assertRuntimeId(runtimeId);
    return parseInfo(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/display/resize`,
          service: SERVICES.agents,
          body: { width, height },
          options,
        }),
      ),
    );
  }

  /** Top-level windows; `windowClass` filters by a substring of the class. */
  async windows(
    runtimeId: string,
    options: RequestOptions & { windowClass?: string } = {},
  ): Promise<{ windows: DisplayWindow[]; focused: number }> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, windowClass } = options;
    const r = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/display/windows`,
        service: SERVICES.agents,
        query: windowClass ? { window_class: windowClass } : undefined,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return {
      windows: Array.isArray(r.windows) ? r.windows.map(parseWindow) : [],
      focused: num(r, 'focused'),
    };
  }

  /** Window management op; `move` uses `at`, `resize` uses `size`. */
  async windowOp(
    runtimeId: string,
    windowId: number,
    op: WindowOp,
    options: RequestOptions & {
      at?: { x: number; y: number };
      size?: { w: number; h: number };
    } = {},
  ): Promise<DisplayWindow> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, at, size } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/display/windows/op`,
        service: SERVICES.agents,
        body: { id: windowId, op, x: at?.x, y: at?.y, w: size?.w, h: size?.h },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return parseWindow(r);
  }

  /** Installed applications. */
  async apps(runtimeId: string, options: RequestOptions = {}): Promise<DisplayApp[]> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/display/apps`,
        service: SERVICES.agents,
        options,
      }),
    );
    return Array.isArray(r.apps) ? r.apps.map(parseApp) : [];
  }

  /**
   * Launch an installed app by its `apps()` id. `waitWindow` blocks until
   * a new top-level window maps and reports it as `windowId`.
   */
  async launchApp(
    runtimeId: string,
    app: string,
    options: RequestOptions & {
      uri?: string;
      waitWindow?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<LaunchResult> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, uri, waitWindow, timeoutMs } = options;
    return parseLaunch(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/display/apps/launch`,
          service: SERVICES.agents,
          body: { app, uri, wait_window: waitWindow, timeout_ms: timeoutMs },
          options: { signal, requestTimeoutMs, maxRetries },
        }),
      ),
    );
  }

  /**
   * Open a file path or URL with its registered handler. `waitWindow`
   * blocks until a new top-level window maps.
   */
  async open(
    runtimeId: string,
    target: string,
    options: RequestOptions & { waitWindow?: boolean; timeoutMs?: number } = {},
  ): Promise<LaunchResult> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, waitWindow, timeoutMs } = options;
    return parseLaunch(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/display/open`,
          service: SERVICES.agents,
          body: { target, wait_window: waitWindow, timeout_ms: timeoutMs },
          options: { signal, requestTimeoutMs, maxRetries },
        }),
      ),
    );
  }

  /** Clipboard image payload (base64 PNG; empty when no image). */
  async getClipboardImage(runtimeId: string, options: RequestOptions = {}): Promise<string> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/display/clipboard`,
        service: SERVICES.agents,
        body: { op: 'get' },
        options,
      }),
    );
    return str(r, 'png');
  }

  /** Own the display clipboard with a base64 PNG image. */
  async setClipboardImage(
    runtimeId: string,
    pngBase64: string,
    options: RequestOptions = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/display/clipboard`,
      service: SERVICES.agents,
      body: { op: 'set', png: pngBase64 },
      options,
    });
  }
}
