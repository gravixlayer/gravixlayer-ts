/**
 * Browser plane — semantic control of the runtime's browser.
 *
 * The browser lives inside the runtime, so `snapshot`/`evaluate`/actions run
 * without a network hop, and `runtime.fork()` produces identical logged-in
 * sessions. Actions are element-first: pass a ref from `snapshot()` (`"e3"`)
 * or a `{by, value}` selector; the runtime resolves, checks actionability,
 * dispatches, and waits for the page to settle before returning. Coordinates
 * work too when the surface isn't an element (canvas, WebGL).
 */

import { asRecord, bool, num, str } from '../../core/parse.js';
import { iterSSEJson } from '../../core/sse.js';
import type { RequestOptions } from '../../core/transport.js';
import { SERVICES } from '../../core/url.js';
import { assertRuntimeId } from '../../core/validate.js';
import { APIResource } from '../resource.js';
import { parsePresence, type Presence } from './display.js';

/** Percent-encode one URL path segment — caller-supplied ids (browser,
 * target, download) must never carry `/`, `?` or `#` into a path. */
function seg(id: string): string {
  return encodeURIComponent(id);
}

/** One page/frame in the browser. */
export interface BrowserTargetInfo {
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
  readonly type: string;
  readonly active: boolean;
  readonly loading: boolean;
  /** Owning context — empty for the default context. */
  readonly contextId?: string;
}

/** A browser session. */
export interface BrowserInfo {
  readonly browserId: string;
  readonly engine: string;
  readonly version: string;
  readonly headless: boolean;
  readonly state: string;
  readonly targets: readonly BrowserTargetInfo[];
  /** Live-view takeover mode: `shared` | `human` | `agent`. Status only. */
  readonly controlMode?: string;
  /** Live-view presence roster — viewers plus the agent pointer slot. */
  readonly viewers?: readonly Presence[];
}

/** One interactable element in a snapshot digest. */
export interface SnapshotElement {
  readonly ref: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly rect: { x: number; y: number; w: number; h: number };
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly href: string;
  readonly inputType: string;
  readonly text: string;
}

/** The element digest — the model's ground truth for targeting. */
export interface BrowserSnapshot {
  readonly url: string;
  readonly title: string;
  readonly viewport: { width: number; height: number };
  readonly rev: string;
  readonly elements: readonly SnapshotElement[];
}

/** Result of a mutating action. */
export interface ActionResult {
  readonly ok: boolean;
  readonly navigated: boolean;
  readonly settled: boolean;
  readonly url: string;
  /** @deprecated Actionability failures are `409` errors naming the failed
   * check; this field stays on the wire for compatibility and is always
   * empty on success. */
  readonly reason: string;
}

/** A download entry. */
export interface BrowserDownload {
  readonly id: string;
  readonly filename: string;
  readonly path: string;
  readonly bytes: number;
  readonly state: string;
  readonly mime: string;
  readonly url: string;
}

/**
 * An element target: a ref string, `{x, y}` coords, or the full selector.
 * `by` is `ref`|`css`|`role`|`text`|`xpath`|`coords`|`frame`; `pierce`
 * crosses shadow DOM; `inner` nests the element inside a `frame` target.
 */
export type ElementTarget =
  | string
  | { x: number; y: number }
  | {
      by: 'ref' | 'css' | 'role' | 'text' | 'xpath' | 'coords' | 'frame';
      value?: string;
      attrs?: Record<string, string>;
      exact?: boolean;
      inner?: ElementTarget;
      pierce?: boolean;
    };

/**
 * Coherent device persona — user agent, client hints, platform, locale,
 * timezone, geolocation and mobile applied consistently as a set.
 */
export interface BrowserFingerprint {
  userAgent?: string;
  platform?: string;
  uaFullVersion?: string;
  locale?: string;
  timezoneId?: string;
  geolocationLat?: number;
  geolocationLon?: number;
  geolocationAccuracy?: number;
  mobile?: boolean;
}

/** Options for {@link RuntimeBrowser.open}. */
export interface BrowserOpenOptions extends RequestOptions {
  engine?: 'chromium' | 'firefox';
  /** Default false — the window is on the runtime's display. */
  headless?: boolean;
  profileDir?: string;
  args?: string[];
  url?: string;
  /** `"handoff"` transfers live control to a human when a captcha is detected. */
  captchaPolicy?: 'handoff';
  /** Coherent device persona for the default context. */
  fingerprint?: BrowserFingerprint;
}

/** Options for {@link RuntimeBrowser.navigate}. */
export interface NavigateOptions extends RequestOptions {
  targetId?: string;
  /** `load` (default), `domcontentloaded`, `commit`, `networkidle`. */
  waitUntil?: 'load' | 'domcontentloaded' | 'commit' | 'networkidle';
  timeoutMs?: number;
}

/** Options for {@link RuntimeBrowser.screenshot}. */
export interface BrowserScreenshotOptions extends RequestOptions {
  targetId?: string;
  format?: 'png' | 'jpeg';
  /** Capture the scrollable page, not just the viewport. */
  fullPage?: boolean;
  /** Clip to an element's box. */
  element?: ElementTarget;
  /** JPEG quality 0–100 — ignored for PNG. */
  quality?: number;
  /** Block until pixel-stable before capturing. */
  waitStableMs?: number;
  timeoutMs?: number;
}

/** Shared shape for element-action options. */
export interface ActionOptions extends RequestOptions {
  targetId?: string;
  /** Wait for the page to settle after the action (default true). */
  settle?: boolean;
  settleTimeoutMs?: number;
  /** Skip the actionability gate. */
  force?: boolean;
  /** Bound on target resolution (ms). */
  targetTimeoutMs?: number;
}

function fingerprintBody(f: BrowserFingerprint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.userAgent !== undefined) out['user_agent'] = f.userAgent;
  if (f.platform !== undefined) out['platform'] = f.platform;
  if (f.uaFullVersion !== undefined) out['ua_full_version'] = f.uaFullVersion;
  if (f.locale !== undefined) out['locale'] = f.locale;
  if (f.timezoneId !== undefined) out['timezone_id'] = f.timezoneId;
  if (f.geolocationLat !== undefined) out['geolocation_lat'] = f.geolocationLat;
  if (f.geolocationLon !== undefined) out['geolocation_lon'] = f.geolocationLon;
  if (f.geolocationAccuracy !== undefined) out['geolocation_accuracy'] = f.geolocationAccuracy;
  if (f.mobile !== undefined) out['mobile'] = f.mobile;
  return out;
}

function normTarget(t: ElementTarget | undefined): unknown {
  if (t === undefined) return undefined;
  if (typeof t === 'string') return { by: 'ref', value: t };
  if (typeof t === 'object' && 'x' in t && 'y' in t) {
    return { by: 'coords', attrs: { x: String(t.x), y: String(t.y) } };
  }
  return t;
}

/** One browser event from the `events` stream. */
export interface BrowserEvent {
  /** Monotonic sequence — resume strictly after it via `since`/`Last-Event-ID`. */
  readonly seq: number;
  readonly kind: string;
  readonly targetId: string;
  /** Event time in microseconds since epoch. */
  readonly usec: number;
  readonly detail: Record<string, unknown>;
}

/** An isolated browser context (separate cookie/storage jars). */
export interface BrowserContext {
  readonly contextId: string;
  readonly proxy: string;
  readonly targetCount: number;
  readonly createdUsec: number;
}

function parseBrowserEvent(v: unknown): BrowserEvent {
  const r = asRecord(v);
  return {
    seq: num(r, 'seq'),
    kind: str(r, 'kind'),
    targetId: str(r, 'target_id'),
    usec: num(r, 'usec'),
    detail: asRecord(r.detail ?? {}),
  };
}

function parseContext(v: unknown): BrowserContext {
  const r = asRecord(v);
  return {
    contextId: str(r, 'context_id'),
    proxy: r.proxy == null ? '' : str(r, 'proxy'),
    targetCount: r.target_count == null ? 0 : num(r, 'target_count'),
    createdUsec: r.created_usec == null ? 0 : num(r, 'created_usec'),
  };
}

function parseTargetInfo(v: unknown): BrowserTargetInfo {
  const r = asRecord(v);
  return {
    targetId: str(r, 'target_id'),
    url: str(r, 'url'),
    title: str(r, 'title'),
    type: str(r, 'type'),
    active: bool(r, 'active'),
    loading: bool(r, 'loading'),
    contextId: r.context_id == null ? undefined : str(r, 'context_id'),
  };
}

function parseInfo(v: unknown): BrowserInfo {
  const r = asRecord(v);
  const targets = Array.isArray(r.targets) ? r.targets.map(parseTargetInfo) : [];
  return {
    browserId: str(r, 'browser_id'),
    engine: str(r, 'engine'),
    version: str(r, 'version'),
    headless: bool(r, 'headless'),
    state: str(r, 'state'),
    targets,
    controlMode: r.control_mode == null ? undefined : str(r, 'control_mode'),
    viewers: Array.isArray(r.viewers) ? r.viewers.map(parsePresence) : undefined,
  };
}

function parseAction(v: unknown): ActionResult {
  const r = asRecord(v);
  return {
    ok: bool(r, 'ok'),
    navigated: bool(r, 'navigated'),
    settled: bool(r, 'settled'),
    url: str(r, 'url'),
    reason: str(r, 'reason'),
  };
}

function parseDownload(v: unknown): BrowserDownload {
  const r = asRecord(v);
  return {
    id: str(r, 'id'),
    filename: str(r, 'filename'),
    path: str(r, 'path'),
    bytes: num(r, 'bytes'),
    state: str(r, 'state'),
    mime: str(r, 'mime'),
    url: str(r, 'url'),
  };
}

/** `client.runtime.browser` — the semantic plane. */
export class RuntimeBrowser extends APIResource {
  /** The default browser per runtime — opened on first `goto`/`ensure` use. */
  private readonly defaultBrowser = new Map<string, string>();

  /** The runtime's default browser — auto-opens on first use. */
  private async ensure(runtimeId: string): Promise<string> {
    let bid = this.defaultBrowser.get(runtimeId);
    if (!bid) {
      bid = (await this.open(runtimeId)).browserId;
      this.defaultBrowser.set(runtimeId, bid);
    }
    return bid;
  }

  /** Auto-opens a browser if needed and navigates it — the simple path. */
  async goto(
    runtimeId: string,
    url: string,
    options: NavigateOptions = {},
  ): ReturnType<RuntimeBrowser['navigate']> {
    assertRuntimeId(runtimeId);
    const bid = await this.ensure(runtimeId);
    try {
      return await this.navigate(runtimeId, bid, url, options);
    } catch (e) {
      // A remembered browser that died is a dead cache entry — evict,
      // reopen, retry once.
      if ((e as { status?: number }).status !== 404 || this.defaultBrowser.get(runtimeId) !== bid)
        throw e;
      this.defaultBrowser.delete(runtimeId);
      return this.navigate(runtimeId, await this.ensure(runtimeId), url, options);
    }
  }

  // -- lifecycle ---------------------------------------------------------------

  /** Open a browser. Headed by default — the window is on the runtime's display. */
  async open(runtimeId: string, options: BrowserOpenOptions = {}): Promise<BrowserInfo> {
    assertRuntimeId(runtimeId);
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      profileDir,
      engine,
      headless,
      captchaPolicy,
      fingerprint,
      ...rest
    } = options;
    return parseInfo(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/browser/open`,
          service: SERVICES.agents,
          body: {
            ...rest,
            engine: engine ?? 'chromium',
            headless: headless ?? false,
            profile_dir: profileDir,
            ...(captchaPolicy ? { captcha_policy: captchaPolicy } : {}),
            ...(fingerprint ? { fingerprint: fingerprintBody(fingerprint) } : {}),
          },
          options: { signal, requestTimeoutMs, maxRetries },
        }),
      ),
    );
  }

  /** Close a browser session. */
  async close(runtimeId: string, browserId: string, options: RequestOptions = {}): Promise<void> {
    assertRuntimeId(runtimeId);
    if (this.defaultBrowser.get(runtimeId) === browserId) {
      this.defaultBrowser.delete(runtimeId);
    }
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/browser/${seg(browserId)}/close`,
      service: SERVICES.agents,
      options,
    });
  }

  /** List the runtime's browsers. */
  async list(runtimeId: string, options: RequestOptions = {}): Promise<BrowserInfo[]> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/browser`,
        service: SERVICES.agents,
        options,
      }),
    );
    return Array.isArray(r.browsers) ? r.browsers.map(parseInfo) : [];
  }

  /** Browser status (`{browser_id, state, targets}`). */
  async status(
    runtimeId: string,
    browserId: string,
    options: RequestOptions = {},
  ): Promise<BrowserInfo> {
    assertRuntimeId(runtimeId);
    return parseInfo(
      asRecord(
        await this.http.request({
          method: 'GET',
          path: `runtime/${runtimeId}/browser/${seg(browserId)}/status`,
          service: SERVICES.agents,
          options,
        }),
      ),
    );
  }

  // -- navigation ---------------------------------------------------------------

  /** Navigate a target; returns once the page settles. */
  async navigate(
    runtimeId: string,
    browserId: string,
    url: string,
    options: NavigateOptions = {},
  ): Promise<{ url: string; title: string; status: number; navigated: boolean; settled: boolean }> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, targetId, waitUntil, timeoutMs } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/navigate`,
        service: SERVICES.agents,
        body: {
          target_id: targetId ?? '',
          url,
          wait_until: waitUntil ?? 'load',
          timeout_ms: timeoutMs,
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return {
      url: str(r, 'url'),
      title: str(r, 'title'),
      status: num(r, 'status'),
      navigated: bool(r, 'navigated'),
      settled: bool(r, 'settled'),
    };
  }

  /** History back/forward/reload — and `activate` to bring a tab to front. */
  async command(
    runtimeId: string,
    browserId: string,
    verb: 'back' | 'forward' | 'reload' | 'activate',
    targetId = '',
    options: RequestOptions = {},
  ): Promise<BrowserTargetInfo> {
    assertRuntimeId(runtimeId);
    return parseTargetInfo(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/browser/${seg(browserId)}/${seg(verb)}`,
          service: SERVICES.agents,
          body: { target_id: targetId, verb },
          options,
        }),
      ),
    );
  }

  async back(runtimeId: string, browserId: string, targetId = '', options: RequestOptions = {}) {
    return this.command(runtimeId, browserId, 'back', targetId, options);
  }

  async forward(runtimeId: string, browserId: string, targetId = '', options: RequestOptions = {}) {
    return this.command(runtimeId, browserId, 'forward', targetId, options);
  }

  async reload(runtimeId: string, browserId: string, targetId = '', options: RequestOptions = {}) {
    return this.command(runtimeId, browserId, 'reload', targetId, options);
  }

  async activate(
    runtimeId: string,
    browserId: string,
    targetId: string,
    options: RequestOptions = {},
  ) {
    return this.command(runtimeId, browserId, 'activate', targetId, options);
  }

  // -- observation ---------------------------------------------------------------

  /** Page screenshot — viewport default, `fullPage` or `element` scoped. Base64 data. */
  async screenshot(
    runtimeId: string,
    browserId: string,
    options: BrowserScreenshotOptions = {},
  ): Promise<{ data: string; format: string; width: number; height: number }> {
    assertRuntimeId(runtimeId);
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      targetId,
      format,
      fullPage,
      element,
      quality,
      waitStableMs,
      timeoutMs,
    } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/screenshot`,
        service: SERVICES.agents,
        body: {
          target_id: targetId ?? '',
          format: format ?? 'png',
          full_page: fullPage ?? false,
          quality,
          element: normTarget(element),
          wait_stable_ms: waitStableMs,
          timeout_ms: timeoutMs,
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return {
      data: str(r, 'data'),
      format: str(r, 'format'),
      width: num(r, 'width'),
      height: num(r, 'height'),
    };
  }

  /** Interactable-element digest — feed this to the model for targeting. */
  async snapshot(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & {
      targetId?: string;
      viewportOnly?: boolean;
      diff?: string;
      filterRole?: string;
      filterName?: string;
    } = {},
  ): Promise<BrowserSnapshot> {
    assertRuntimeId(runtimeId);
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      targetId,
      viewportOnly,
      diff,
      filterRole,
      filterName,
    } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/snapshot`,
        service: SERVICES.agents,
        body: {
          target_id: targetId ?? '',
          viewport_only: viewportOnly ?? true,
          diff: diff ?? '',
          filter_role: filterRole ?? '',
          filter_name: filterName ?? '',
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    const vp = asRecord(r.viewport);
    const elements = Array.isArray(r.elements)
      ? r.elements.map((e) => {
          const el = asRecord(e);
          const rect = asRecord(el.rect);
          return {
            ref: str(el, 'ref'),
            tag: str(el, 'tag'),
            role: str(el, 'role'),
            name: str(el, 'name'),
            rect: { x: num(rect, 'x'), y: num(rect, 'y'), w: num(rect, 'w'), h: num(rect, 'h') },
            enabled: bool(el, 'enabled'),
            visible: bool(el, 'visible'),
            href: str(el, 'href'),
            inputType: str(el, 'input_type'),
            text: str(el, 'text'),
          };
        })
      : [];
    return {
      url: str(r, 'url'),
      title: str(r, 'title'),
      viewport: { width: num(vp, 'width'), height: num(vp, 'height') },
      rev: str(r, 'rev'),
      elements,
    };
  }

  /** The escape hatch: run JavaScript in the page. */
  async evaluate(
    runtimeId: string,
    browserId: string,
    expression: string,
    options: RequestOptions & {
      targetId?: string;
      awaitPromise?: boolean;
      timeoutMs?: number;
      /** `isolated` (default) or `main` — the JavaScript world to run in. */
      world?: 'isolated' | 'main';
    } = {},
  ): Promise<{ value: unknown; error: string; isError: boolean }> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, targetId, awaitPromise, timeoutMs, world } =
      options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/evaluate`,
        service: SERVICES.agents,
        body: {
          target_id: targetId ?? '',
          expression,
          await_promise: awaitPromise ?? true,
          timeout_ms: timeoutMs ?? 30_000,
          world: world ?? 'isolated',
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    // `value` arrives as parsed JSON — numbers/objects/booleans pass through.
    return { value: r['value'], error: str(r, 'error'), isError: bool(r, 'is_error') };
  }

  // -- actions ---------------------------------------------------------------

  private async act(
    runtimeId: string,
    browserId: string,
    verb: string,
    body: Record<string, unknown>,
    options: ActionOptions,
  ): Promise<ActionResult> {
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      targetId,
      settle,
      settleTimeoutMs,
      force,
      targetTimeoutMs,
    } = options;
    return parseAction(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/browser/${seg(browserId)}/actions/${seg(verb)}`,
          service: SERVICES.agents,
          body: {
            ...body,
            verb,
            target_id: targetId ?? '',
            settle: settle ?? true,
            settle_timeout_ms: settleTimeoutMs,
            force: force ?? false,
            target_timeout_ms: targetTimeoutMs,
          },
          options: { signal, requestTimeoutMs, maxRetries },
        }),
      ),
    );
  }

  /** Click an element (ref/selector/coords) — resolve, actionability, dispatch, settle. */
  async click(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions & { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    const { button, clickCount, ...rest } = options;
    return this.act(
      runtimeId,
      browserId,
      'click',
      { target: normTarget(target), button: button ?? 'left', click_count: clickCount ?? 1 },
      rest,
    );
  }

  /** Double-click an element. */
  async dblclick(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions & { button?: 'left' | 'right' | 'middle' } = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    const { button, ...rest } = options;
    return this.act(
      runtimeId,
      browserId,
      'dblclick',
      { target: normTarget(target), button: button ?? 'left' },
      rest,
    );
  }

  /** Move the pointer onto an element (triggers :hover / tooltips). */
  async hover(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(runtimeId, browserId, 'hover', { target: normTarget(target) }, options);
  }

  /** Clear + insert text. `secretRef` types from the secrets store — the value
   *  never crosses the client. */
  async fill(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions & { text?: string; secretRef?: string } = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    const { text, secretRef, ...rest } = options;
    return this.act(
      runtimeId,
      browserId,
      'fill',
      {
        target: normTarget(target),
        ...(secretRef ? { secret_ref: secretRef } : { text: text ?? '' }),
      },
      rest,
    );
  }

  /** Type text into an element. */
  async type(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    text: string,
    options: ActionOptions & { delayMs?: number } = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    const { delayMs, ...rest } = options;
    return this.act(
      runtimeId,
      browserId,
      'type',
      { target: normTarget(target), text, delay_ms: delayMs },
      rest,
    );
  }

  /** Press a named key. */
  async press(
    runtimeId: string,
    browserId: string,
    key: string,
    options: ActionOptions & { target?: ElementTarget } = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    const { target, ...rest } = options;
    return this.act(runtimeId, browserId, 'press', { key, target: normTarget(target) }, rest);
  }

  /** Press a chord. */
  async hotkey(
    runtimeId: string,
    browserId: string,
    keys: string[],
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(runtimeId, browserId, 'hotkey', { keys }, options);
  }

  /** Scroll — page-level, or the element's box when targeted. */
  async scroll(
    runtimeId: string,
    browserId: string,
    options: ActionOptions & { target?: ElementTarget; dx?: number; dy?: number } = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    const { target, dx, dy, ...rest } = options;
    return this.act(
      runtimeId,
      browserId,
      'scroll',
      { target: normTarget(target), dx: dx ?? 0, dy: dy ?? 0 },
      rest,
    );
  }

  // -- dialogs / downloads / pdf / view ---------------------------------------------------------------

  /** Answer a pending alert/confirm/prompt (`promptText` fills prompt
   *  dialogs). `autoDismiss: true` instead restores auto-dismiss policy and
   *  clears any pending dialog. */
  async dialog(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & {
      accept?: boolean;
      promptText?: string;
      autoDismiss?: boolean;
      targetId?: string;
    } = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, accept, promptText, autoDismiss, targetId } =
      options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/browser/${seg(browserId)}/dialog`,
      service: SERVICES.agents,
      body: {
        target_id: targetId ?? '',
        accept: accept ?? true,
        prompt_text: promptText ?? '',
        auto_dismiss: autoDismiss ?? false,
      },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  /** List targets, or open one (`url` non-empty → new tab). */
  async targets(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { url?: string; activate?: boolean; contextId?: string } = {},
  ): Promise<{ targetId: string; targets: readonly BrowserTargetInfo[] }> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, url, activate, contextId } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/targets`,
        service: SERVICES.agents,
        body: {
          url: url ?? '',
          activate: activate ?? true,
          ...(contextId !== undefined ? { context_id: contextId } : {}),
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return {
      targetId: str(r, 'target_id'),
      targets: Array.isArray(r.targets) ? r.targets.map(parseTargetInfo) : [],
    };
  }

  /** List downloads; `waitName` blocks until that file lands. */
  async downloads(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { waitName?: string; timeoutMs?: number } = {},
  ): Promise<BrowserDownload[]> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, waitName, timeoutMs } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/downloads`,
        service: SERVICES.agents,
        body: { wait_name: waitName ?? '', timeout_ms: timeoutMs ?? 0 },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return Array.isArray(r.downloads) ? r.downloads.map(parseDownload) : [];
  }

  /** Get a download's bytes (base64 in `data`). */
  async download(
    runtimeId: string,
    browserId: string,
    downloadId: string,
    options: RequestOptions & { metaOnly?: boolean } = {},
  ): Promise<{ entry: BrowserDownload | null; data: string | null }> {
    assertRuntimeId(runtimeId);
    const { metaOnly, ...rest } = options;
    const r = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/downloads/${seg(downloadId)}${metaOnly ? '?meta_only=true' : ''}`,
        service: SERVICES.agents,
        options: rest,
      }),
    );
    return {
      entry: r.entry ? parseDownload(r.entry) : null,
      data: typeof r.data === 'string' ? r.data : null,
    };
  }

  /** Render a target to PDF (invoices, reports). Base64 data. */
  async pdf(
    runtimeId: string,
    browserId: string,
    targetId: string,
    options: RequestOptions & {
      landscape?: boolean;
      printBackground?: boolean;
      pageRanges?: string;
      paperWidthIn?: number;
      paperHeightIn?: number;
      marginsIn?: { top?: number; bottom?: number; left?: number; right?: number };
    } = {},
  ): Promise<{ data: string; format: string }> {
    assertRuntimeId(runtimeId);
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      landscape,
      printBackground,
      pageRanges,
      paperWidthIn,
      paperHeightIn,
      marginsIn,
    } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/targets/${seg(targetId)}/pdf`,
        service: SERVICES.agents,
        body: {
          landscape: landscape ?? false,
          print_background: printBackground ?? true,
          page_ranges: pageRanges ?? '',
          paper_width_in: paperWidthIn ?? 0,
          paper_height_in: paperHeightIn ?? 0,
          margin_top_in: marginsIn?.top ?? 0,
          margin_bottom_in: marginsIn?.bottom ?? 0,
          margin_left_in: marginsIn?.left ?? 0,
          margin_right_in: marginsIn?.right ?? 0,
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return { data: str(r, 'data'), format: str(r, 'format') };
  }

  /**
   * Live view endpoint — headed streams the display socket, headless the page
   * screencast. `browserUrl` carries a fresh auth token — every call mints
   * one, so repeat calls always return a working link (each mint invalidates
   * the previous token; already-open viewers keep their live sockets).
   * `rotateToken` is accepted but no longer needed. `role: 'watch'` mints a
   * view-only link: `viewToken`/`watchUrl` carry a `vt=` capability that
   * sees frames but can never inject input. Headed browsers ride the
   * display's token-gated feed, where `vt=` is required.
   */
  async view(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & {
      targetId?: string;
      fps?: number;
      quality?: number;
      role?: 'control' | 'watch';
      rotateToken?: boolean;
    } = {},
  ): Promise<{
    url: string;
    browserUrl: string;
    /** `browserUrl` with the role token composed in — ready to open. */
    watchUrl: string;
    port: number;
    viewToken?: string;
    expiresAt?: string;
  }> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, targetId, role, rotateToken, ...rest } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/view`,
        service: SERVICES.agents,
        body: {
          target_id: targetId ?? '',
          rotate_token: rotateToken,
          ...(role ? { role } : {}),
          ...rest,
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    const browserUrl = str(r, 'browser_url');
    // `vt=` on the WS upgrade carries the minted role — compose it so a
    // shared URL can never arrive un-tokened. Headed feeds require it;
    // headless feeds assert the role when present (absent = control).
    const viewToken = typeof r.view_token === 'string' && r.view_token ? r.view_token : undefined;
    return {
      url: str(r, 'url'),
      browserUrl,
      watchUrl:
        viewToken && browserUrl
          ? `${browserUrl}${browserUrl.includes('?') ? '&' : '?'}vt=${viewToken}`
          : browserUrl,
      port: num(r, 'port'),
      viewToken,
      expiresAt: typeof r.expires_at === 'string' ? r.expires_at : undefined,
    };
  }

  /**
   * Set the live-view takeover mode — same contract as the display plane:
   * `shared` (both sides may drive), `human` (only the human viewer; agent
   * `Action` calls reject with a precondition error), or `agent` (viewer
   * input is dropped). A human operator takes over with `human` and hands
   * back with `shared`/`agent`.
   */
  async viewControl(
    runtimeId: string,
    browserId: string,
    mode: 'shared' | 'human' | 'agent',
    options: RequestOptions = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/browser/${seg(browserId)}/view/control`,
      service: SERVICES.agents,
      body: { mode },
      options,
    });
  }

  /**
   * Stream browser events (page lifecycle, console, network, dialogs) as
   * server-sent events. `since`/`lastEventId` resume strictly after a
   * sequence number; `waitMs` bounds each long-poll page (server default
   * 25s, max 30s — pages chain without replay or drops).
   */
  async *events(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { since?: number; lastEventId?: string; waitMs?: number } = {},
  ): AsyncGenerator<BrowserEvent, void, undefined> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, since, lastEventId, waitMs } = options;
    const query: Record<string, string | number> = {};
    if (since !== undefined) query.since = since;
    if (waitMs !== undefined) query.wait_ms = waitMs;
    const headers: Record<string, string> = {};
    if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;

    const stream = await this.http.requestStream({
      method: 'GET',
      path: `runtime/${runtimeId}/browser/${seg(browserId)}/events`,
      service: SERVICES.agents,
      query,
      options: { signal, requestTimeoutMs, maxRetries, headers },
    });

    for await (const payload of iterSSEJson<Record<string, unknown>>(stream)) {
      yield parseBrowserEvent(payload);
    }
  }

  /**
   * Open an isolated browser context (separate cookie/storage jars) → its
   * `contextId`. `proxy` is a proxy server URL; `storageState` seeds the
   * context in the Playwright-compatible `{cookies, origins}` shape.
   */
  async contextCreate(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & {
      proxy?: string;
      storageState?: Record<string, unknown>;
      /** Upstream proxy username. */
      proxyUsername?: string;
      /** Provider secret name holding the proxy password — resolved server-side. */
      proxyPasswordSecretRef?: string;
      /** Per-context device persona. */
      fingerprint?: BrowserFingerprint;
    } = {},
  ): Promise<BrowserContext> {
    assertRuntimeId(runtimeId);
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      proxy,
      storageState,
      proxyUsername,
      proxyPasswordSecretRef,
      fingerprint,
    } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/context`,
        service: SERVICES.agents,
        body: {
          ...(proxy ? { proxy } : {}),
          ...(storageState !== undefined ? { storage_state: storageState } : {}),
          ...(proxyUsername ? { proxy_username: proxyUsername } : {}),
          ...(proxyPasswordSecretRef ? { proxy_password_secret_ref: proxyPasswordSecretRef } : {}),
          ...(fingerprint ? { fingerprint: fingerprintBody(fingerprint) } : {}),
        },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return parseContext(r);
  }

  /** List the browser's live contexts. */
  async contexts(
    runtimeId: string,
    browserId: string,
    options: RequestOptions = {},
  ): Promise<readonly BrowserContext[]> {
    assertRuntimeId(runtimeId);
    const r = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/contexts`,
        service: SERVICES.agents,
        options,
      }),
    );
    const list = r.contexts;
    return Array.isArray(list) ? list.map(parseContext) : [];
  }

  /** Close an isolated context (the default context cannot be deleted). */
  async contextDelete(
    runtimeId: string,
    browserId: string,
    contextId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    await this.http.request({
      method: 'DELETE',
      path: `runtime/${runtimeId}/browser/${seg(browserId)}/context/${seg(contextId)}`,
      service: SERVICES.agents,
      options,
    });
  }

  /**
   * Export cookies + storage for a context in the Playwright-compatible
   * `{cookies, origins}` shape. An empty `contextId` (the default)
   * addresses the default context.
   */
  async storageExport(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { contextId?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, contextId } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/storage/export`,
        service: SERVICES.agents,
        body: { context_id: contextId ?? '' },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
    return asRecord(r.storage_state ?? r);
  }

  /** Import a previously exported `{cookies, origins}` storage state. */
  async storageImport(
    runtimeId: string,
    browserId: string,
    storageState: Record<string, unknown>,
    options: RequestOptions & { contextId?: string } = {},
  ): Promise<void> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, contextId } = options;
    await this.http.request({
      method: 'POST',
      path: `runtime/${runtimeId}/browser/${seg(browserId)}/storage/import`,
      service: SERVICES.agents,
      body: { context_id: contextId ?? '', storage_state: storageState },
      options: { signal, requestTimeoutMs, maxRetries },
    });
  }

  // -- form + advanced verbs ---------------------------------------------------

  /** Pick a `<select>` option by value, label text, or index. */
  async select(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    option: string,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(
      runtimeId,
      browserId,
      'select',
      { target: normTarget(target), option },
      options,
    );
  }

  /** Check a checkbox/radio — a real click, only when state differs. */
  async check(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(runtimeId, browserId, 'check', { target: normTarget(target) }, options);
  }

  /** Uncheck a checkbox — no-op when already unchecked. */
  async uncheck(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(runtimeId, browserId, 'uncheck', { target: normTarget(target) }, options);
  }

  /** Move DOM focus onto an element. */
  async focus(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(runtimeId, browserId, 'focus', { target: normTarget(target) }, options);
  }

  /** Remove DOM focus from an element. */
  async blur(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(runtimeId, browserId, 'blur', { target: normTarget(target) }, options);
  }

  /** Scroll an element into the viewport (nearest block/inline). */
  async scrollIntoView(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(
      runtimeId,
      browserId,
      'scroll_into_view',
      { target: normTarget(target) },
      options,
    );
  }

  /** Drag `target` onto `dropTarget` — stepped pointer move so intermediate
   * `dragover` handlers fire. */
  async dragTo(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    dropTarget: ElementTarget,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(
      runtimeId,
      browserId,
      'drag_to',
      { target: normTarget(target), drop_target: normTarget(dropTarget) },
      options,
    );
  }

  /** Set files on a `<input type=file>` element. `paths` are guest paths —
   * ship customer files first via the files API `write`. */
  async upload(
    runtimeId: string,
    browserId: string,
    target: ElementTarget,
    paths: readonly string[],
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    assertRuntimeId(runtimeId);
    return this.act(
      runtimeId,
      browserId,
      'upload',
      { target: normTarget(target), paths: [...paths] },
      options,
    );
  }

  // -- emulation, network, auth ------------------------------------------------

  /** Apply emulation overrides to a target — viewport `{width, height,
   * scale}`, `geolocation` `{latitude, longitude, accuracy?}`, `timezone`
   * (IANA), `locale` (also sets accept-language), `userAgent`, `touch`,
   * `colorScheme` (`light`/`dark`). Only carried keys override; they persist
   * across target re-attach. */
  async emulate(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & {
      targetId?: string;
      viewport?: { width: number; height: number; scale?: number };
      geolocation?: { latitude: number; longitude: number; accuracy?: number };
      timezone?: string;
      locale?: string;
      userAgent?: string;
      mobile?: boolean;
      touch?: boolean;
      colorScheme?: 'light' | 'dark';
      contextId?: string;
      clear?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const {
      signal,
      requestTimeoutMs,
      maxRetries,
      targetId,
      viewport,
      geolocation,
      timezone,
      locale,
      userAgent,
      mobile,
      touch,
      colorScheme,
      contextId,
      clear,
    } = options;
    const body: Record<string, unknown> = {};
    if (targetId) body.target_id = targetId;
    if (contextId) body.context_id = contextId;
    if (viewport !== undefined) {
      if (viewport.width) body.width = viewport.width;
      if (viewport.height) body.height = viewport.height;
      if (viewport.scale) body.device_scale_factor = viewport.scale;
    }
    if (geolocation !== undefined) {
      if (geolocation.latitude !== undefined) body.geolocation_lat = geolocation.latitude;
      if (geolocation.longitude !== undefined) body.geolocation_lon = geolocation.longitude;
      if (geolocation.accuracy !== undefined) body.geolocation_accuracy = geolocation.accuracy;
    }
    if (timezone) body.timezone_id = timezone;
    if (locale) body.locale = locale;
    if (userAgent) body.user_agent = userAgent;
    if (mobile !== undefined) body.mobile = mobile;
    if (touch !== undefined) body.touch = touch;
    if (colorScheme) body.color_scheme = colorScheme;
    if (clear) body.clear = true;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/emulate`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Install request-interception rules — each `{url_pattern, action:
   * "continue"|"block"|"mock", resource_type?, mock_status?, mock_headers?,
   * mock_body_b64?}`. Matching runs in the runtime; the network tap stays
   * off while no rules exist. */
  async intercept(
    runtimeId: string,
    browserId: string,
    rules: readonly Record<string, unknown>[],
    options: RequestOptions & { targetId?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, targetId } = options;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/intercept`,
        service: SERVICES.agents,
        body: { target_id: targetId ?? '', rules: [...rules] },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Remove interception rules — `ruleIds` for specific rules, empty clears all. */
  async interceptClear(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { ruleIds?: readonly string[]; targetId?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, ruleIds, targetId } = options;
    const body: Record<string, unknown> = {};
    if (ruleIds && ruleIds.length) body.rule_ids = [...ruleIds];
    if (targetId) body.target_id = targetId;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/intercept/clear`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Answer HTTP basic/digest challenges in-page. `secretRef` resolves the
   * password server-side; `clear` disarms the handler. */
  async auth(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & {
      username?: string;
      password?: string;
      secretRef?: string;
      clear?: boolean;
      targetId?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, username, password, secretRef, clear, targetId } =
      options;
    const body: Record<string, unknown> = {};
    if (username) body.username = username;
    if (secretRef) body.secret_ref = secretRef;
    else if (password) body.password = password;
    if (clear) body.clear = true;
    if (targetId) body.target_id = targetId;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/auth`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  // -- extensions + CDP --------------------------------------------------------

  /** Hot-load an unpacked extension from a guest directory → `{extension_id}`. */
  async extensionLoad(
    runtimeId: string,
    browserId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries } = options;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/extensions/load`,
        service: SERVICES.agents,
        body: { path },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Unload an extension by the id `extensionLoad` returned. */
  async extensionUnload(
    runtimeId: string,
    browserId: string,
    extensionId: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries } = options;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/extensions/unload`,
        service: SERVICES.agents,
        body: { extension_id: extensionId },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Start a tokened CDP WebSocket bridge → `{port, path, token}` — the
   * attach point for external drivers. Raw protocol semantics: the bridge
   * bypasses targeting/actionability. */
  async cdpEndpoint(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { port?: number; token?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, port, token } = options;
    const body: Record<string, unknown> = {};
    if (port) body.port = port;
    if (token) body.token = token;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/cdp_endpoint`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Tear down the CDP bridge. */
  async cdpEndpointStop(
    runtimeId: string,
    browserId: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries } = options;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/cdp_endpoint/stop`,
        service: SERVICES.agents,
        body: {},
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  // -- approvals ----------------------------------------------------------------

  /** Ask an operator for approval — parks until resolved or `timeoutMs`
   * lapses → `{approval_id, resolved, approved?}`. Resolve from another
   * call, or watch `approval_request` events. */
  async approvalRequest(
    runtimeId: string,
    browserId: string,
    message: string,
    options: RequestOptions & { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, timeoutMs } = options;
    const body: Record<string, unknown> = { message };
    if (timeoutMs) body.timeout_ms = timeoutMs;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/approvals`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Resolve a pending approval — the parked `approvalRequest` wakes with
   * the answer. */
  async approvalResolve(
    runtimeId: string,
    browserId: string,
    approvalId: string,
    approved: boolean,
    options: RequestOptions & { note?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, note } = options;
    const body: Record<string, unknown> = { approved };
    if (note) body.note = note;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/approvals/${seg(approvalId)}/resolve`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  // -- reads: content + cookies --------------------------------------------------

  /** Serialized page content — rendered HTML by default, `format` selects
   * the extraction. */
  async content(
    runtimeId: string,
    browserId: string,
    targetId: string = '',
    options: RequestOptions & { format?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, format } = options;
    const body: Record<string, unknown> = { target_id: targetId };
    if (format) body.format = format;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/content`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** List the context's cookies — empty `contextId` is the default context. */
  async cookies(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { contextId?: string; url?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, contextId, url } = options;
    const body: Record<string, unknown> = {};
    if (contextId) body.context_id = contextId;
    if (url) body.url = url;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/cookies`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Set one cookie — `url` scopes it, `attrs` carries domain/path/secure/
   * expiry fields. */
  async setCookie(
    runtimeId: string,
    browserId: string,
    name: string,
    value: string,
    options: RequestOptions & {
      url?: string;
      contextId?: string;
      attrs?: Record<string, unknown>;
    } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, url, contextId, attrs } = options;
    const body: Record<string, unknown> = { op: 'set', name, value };
    if (url) body.url = url;
    if (contextId) body.context_id = contextId;
    if (attrs) body.attrs = attrs;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/cookies`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Delete one cookie by name (`url` scopes the match). */
  async deleteCookie(
    runtimeId: string,
    browserId: string,
    name: string,
    options: RequestOptions & { url?: string; contextId?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, url, contextId } = options;
    const body: Record<string, unknown> = { op: 'delete', name };
    if (url) body.url = url;
    if (contextId) body.context_id = contextId;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/cookies`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Clear every cookie in the context. */
  async clearCookies(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { contextId?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, contextId } = options;
    const body: Record<string, unknown> = { op: 'clear' };
    if (contextId) body.context_id = contextId;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/cookies`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  // -- downloads, recording, profile, replay, fork -------------------------------

  /** Drop a download record; `deleteFile` also removes the guest file. */
  async downloadDelete(
    runtimeId: string,
    browserId: string,
    downloadId: string,
    options: RequestOptions & { deleteFile?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, deleteFile } = options;
    const suffix = deleteFile ? '?delete_file=true' : '';
    return asRecord(
      await this.http.request({
        method: 'DELETE',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/downloads/${seg(downloadId)}${suffix}`,
        service: SERVICES.agents,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Start a per-target video recording (works headless) → recording handle. */
  async recordingStart(
    runtimeId: string,
    browserId: string,
    targetId: string,
    options: RequestOptions & { fps?: number; quality?: number } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, fps, quality } = options;
    const body: Record<string, unknown> = {};
    if (fps) body.fps = fps;
    if (quality) body.quality = quality;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/targets/${seg(targetId)}/recording/start`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Stop a target recording → sealed artifact metadata. */
  async recordingStop(
    runtimeId: string,
    browserId: string,
    targetId: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries } = options;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/targets/${seg(targetId)}/recording/stop`,
        service: SERVICES.agents,
        body: {},
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Copy a finished recording's artifacts into `destDir` (guest path). */
  async recordingExport(
    runtimeId: string,
    browserId: string,
    recordingId: string,
    destDir: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries } = options;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/recordings/export`,
        service: SERVICES.agents,
        body: { recording_id: recordingId, dest_dir: destDir },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Quiesce and tar the browser's profile (cookies, storage, prefs —
   * durable auth) → `destPath`. */
  async profileExport(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { destPath?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, destPath } = options;
    const body: Record<string, unknown> = {};
    if (destPath) body.dest_path = destPath;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/profile/export`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Respawn the browser against a previously exported profile tar. */
  async profileImport(
    runtimeId: string,
    browserId: string,
    archivePath: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries } = options;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/profile/import`,
        service: SERVICES.agents,
        body: { archive_path: archivePath },
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Replay recorded action steps with per-step effect checks — `steps` are
   * `{action, expect_*?}` entries; `stopOnFail` halts on the first failed
   * check. */
  async replay(
    runtimeId: string,
    browserId: string,
    steps: readonly Record<string, unknown>[],
    options: RequestOptions & {
      stopOnFail?: boolean;
      stepTimeoutMs?: number;
      targetId?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, stopOnFail, stepTimeoutMs, targetId } = options;
    const body: Record<string, unknown> = { steps: [...steps], stop_on_fail: stopOnFail ?? false };
    if (stepTimeoutMs) body.step_timeout_ms = stepTimeoutMs;
    if (targetId) body.target_id = targetId;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/replay`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }

  /** Fork the page into a cohort of identical targets (1–8) for best-of-N
   * runs → `{target_ids: [...]}`. */
  async fork(
    runtimeId: string,
    browserId: string,
    options: RequestOptions & { count?: number; url?: string; targetId?: string } = {},
  ): Promise<Record<string, unknown>> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, count, url, targetId } = options;
    const body: Record<string, unknown> = { count: count ?? 1 };
    if (url) body.url = url;
    if (targetId) body.target_id = targetId;
    return asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/fork`,
        service: SERVICES.agents,
        body,
        options: { signal, requestTimeoutMs, maxRetries },
      }),
    );
  }
}
