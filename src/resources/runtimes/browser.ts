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
import type { RequestOptions } from '../../core/transport.js';
import { SERVICES } from '../../core/url.js';
import { assertRuntimeId } from '../../core/validate.js';
import { APIResource } from '../resource.js';

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
}

/** A browser session. */
export interface BrowserInfo {
  readonly browserId: string;
  readonly engine: string;
  readonly version: string;
  readonly headless: boolean;
  readonly state: string;
  readonly targets: readonly BrowserTargetInfo[];
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

/** Options for {@link RuntimeBrowser.open}. */
export interface BrowserOpenOptions extends RequestOptions {
  engine?: 'chromium' | 'firefox';
  /** Default false — the window is on the runtime's display. */
  headless?: boolean;
  profileDir?: string;
  args?: string[];
  url?: string;
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

function normTarget(t: ElementTarget | undefined): unknown {
  if (t === undefined) return undefined;
  if (typeof t === 'string') return { by: 'ref', value: t };
  if (typeof t === 'object' && 'x' in t && 'y' in t) {
    return { by: 'coords', attrs: { x: String(t.x), y: String(t.y) } };
  }
  return t;
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
    const { signal, requestTimeoutMs, maxRetries, profileDir, engine, headless, ...rest } = options;
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

  async activate(runtimeId: string, browserId: string, targetId: string, options: RequestOptions = {}) {
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
    options: RequestOptions & { url?: string; activate?: boolean } = {},
  ): Promise<{ targetId: string; targets: readonly BrowserTargetInfo[] }> {
    assertRuntimeId(runtimeId);
    const { signal, requestTimeoutMs, maxRetries, url, activate } = options;
    const r = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/browser/${seg(browserId)}/targets`,
        service: SERVICES.agents,
        body: { url: url ?? '', activate: activate ?? true },
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
   * screencast. `browserUrl` carries the auth token; it is minted on the first
   * call for a port, so a repeat call returns a token-less URL unless
   * `rotateToken` is set (fresh token — invalidates the previous URL).
   * `role: 'watch'` mints a view-only link: `viewToken`/`watchUrl` carry a
   * `vt=` capability that sees frames but can never inject input. Headed
   * browsers ride the display's token-gated feed, where `vt=` is required.
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
      watchUrl: viewToken && browserUrl
        ? `${browserUrl}${browserUrl.includes('?') ? '&' : '?'}vt=${viewToken}`
        : browserUrl,
      port: num(r, 'port'),
      viewToken,
      expiresAt: typeof r.expires_at === 'string' ? r.expires_at : undefined,
    };
  }
}
