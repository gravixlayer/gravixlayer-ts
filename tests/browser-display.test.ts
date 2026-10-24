import { describe, expect, it } from 'vitest';

import { jsonResponse, RUNTIME_ID, testClient } from './helpers.js';

const BID = 'b1';

describe('display plane', () => {
  it('enables the display with the requested geometry', async () => {
    const { client, http } = testClient([
      jsonResponse({ enabled: true, width: 1920, height: 1080, display: ':0' }),
    ]);
    const s = await client.runtime.display.enable(RUNTIME_ID, { width: 1920, height: 1080 });
    expect(s.enabled).toBe(true);
    expect(s.width).toBe(1920);
    expect(http.last().url).toContain(`runtime/${RUNTIME_ID}/display/enable`);
    expect(http.last().method).toBe('POST');
  });

  it('screenshots with wait_stable', async () => {
    const { client, http } = testClient([
      jsonResponse({ data: 'UE5H', format: 'png', width: 100, height: 100 }),
    ]);
    const s = await client.runtime.display.screenshot(RUNTIME_ID, {
      waitStableMs: 300,
      timeoutMs: 5000,
    });
    expect(s.data).toBe('UE5H');
    expect((http.jsonBody() as Record<string, unknown>).wait_stable_ms).toBe(300);
    expect((http.jsonBody() as Record<string, unknown>).timeout_ms).toBe(5000);
  });

  it('sends raw mouse + keyboard input', async () => {
    const { client, http } = testClient([jsonResponse({}), jsonResponse({})]);
    await client.runtime.display.click(RUNTIME_ID, 10, 20);
    await client.runtime.display.hotkey(RUNTIME_ID, ['ctrl', 'c']);
    expect(http.requests[0]?.url).toContain('display/mouse/click');
    expect(http.requests[1]?.url).toContain('display/keyboard/hotkey');
    expect((http.jsonBody(1) as Record<string, unknown>).keys).toEqual(['ctrl', 'c']);
  });

  it('waits for pixel-stable frames', async () => {
    const { client } = testClient([jsonResponse({ settled: true, waited_ms: 350 })]);
    const r = await client.runtime.display.waitStable(RUNTIME_ID, 300, 5000);
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBe(350);
  });

  it('sends scroll axes only when given — zero is not "unset"', async () => {
    const { client, http } = testClient([jsonResponse({}), jsonResponse({})]);
    await client.runtime.display.scroll(RUNTIME_ID, 0, -480);
    let body = http.jsonBody() as Record<string, unknown>;
    expect(body).toEqual({ dx: 0, dy: -480 });
    await client.runtime.display.scroll(RUNTIME_ID, 0, -480, { x: 0, y: 200 });
    body = http.jsonBody() as Record<string, unknown>;
    expect(body).toEqual({ dx: 0, dy: -480, x: 0, y: 200 });
  });

  it('view() sends rotate_token to re-mint the watch url', async () => {
    const { client, http } = testClient([
      jsonResponse({ url: 'https://s.service.example', browser_url: 'https://s/auth', port: 9871 }),
    ]);
    await client.runtime.display.view(RUNTIME_ID, { fps: 10, rotateToken: true });
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body.rotate_token).toBe(true);
    expect(body.fps).toBe(10);
  });

  it('view() mints a watch-role link and returns its token', async () => {
    const { client, http } = testClient([
      jsonResponse({
        url: 'https://s.service.example',
        browser_url: 'https://s/auth',
        port: 9871,
        view_token: 'vt-abc',
      }),
    ]);
    const v = await client.runtime.display.view(RUNTIME_ID, { role: 'watch' });
    expect(v.viewToken).toBe('vt-abc');
    expect((http.jsonBody() as Record<string, unknown>).role).toBe('watch');
  });

  it('stopView() frees the view port', async () => {
    const { client, http } = testClient([jsonResponse({})]);
    await client.runtime.display.stopView(RUNTIME_ID);
    expect(http.last().url).toContain('display/view/stop');
    expect(http.last().method).toBe('POST');
  });

  it('info() and position() report live display state', async () => {
    const { client } = testClient([
      jsonResponse({
        enabled: true,
        width: 1280,
        height: 720,
        depth: 24,
        dpi: 96,
        display: ':1',
        attached: true,
      }),
      jsonResponse({ x: 412, y: 87 }),
    ]);
    const info = await client.runtime.display.info(RUNTIME_ID);
    expect(info.attached).toBe(true);
    expect(info.dpi).toBe(96);
    const pos = await client.runtime.display.position(RUNTIME_ID);
    expect(pos).toEqual({ x: 412, y: 87 });
  });

  it('keys() lists the supported key names', async () => {
    const { client, http } = testClient([jsonResponse({ keys: ['enter', 'tab', 'f5'] })]);
    const keys = await client.runtime.display.keys(RUNTIME_ID);
    expect(keys).toEqual(['enter', 'tab', 'f5']);
    expect(http.last().url).toContain('display/keys');
  });

  it('click carries click_count, modifiers and coordinate_space', async () => {
    const { client, http } = testClient([jsonResponse({})]);
    await client.runtime.display.click(RUNTIME_ID, 640, 360, 'left', {
      clickCount: 2,
      modifiers: ['ctrl'],
      coordinateSpace: 'screenshot',
    });
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body).toEqual({
      x: 640,
      y: 360,
      button: 'left',
      click_count: 2,
      modifiers: ['ctrl'],
      coordinate_space: 'screenshot',
    });
  });

  it('click without coordinates hits the current pointer position', async () => {
    const { client, http } = testClient([jsonResponse({})]);
    await client.runtime.display.click(RUNTIME_ID);
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body.button).toBe('left');
    expect(body.x).toBeUndefined();
    expect(body.y).toBeUndefined();
  });

  it('down/up/drag/scroll compose pointer actions', async () => {
    const { client, http } = testClient([
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({}),
    ]);
    await client.runtime.display.down(RUNTIME_ID, 10, 10, 'left', { modifiers: ['shift'] });
    expect(http.requests[0]?.url).toContain('display/mouse/down');
    await client.runtime.display.up(RUNTIME_ID);
    expect(http.requests[1]?.url).toContain('display/mouse/up');
    await client.runtime.display.drag(RUNTIME_ID, 400, 300, 'left', {
      from: { x: 10, y: 10 },
      steps: 8,
      durationMs: 200,
    });
    const drag = http.jsonBody(2) as Record<string, unknown>;
    expect(drag).toMatchObject({
      x: 10,
      y: 10,
      to_x: 400,
      to_y: 300,
      button: 'left',
      steps: 8,
      duration_ms: 200,
    });
    await client.runtime.display.scroll(RUNTIME_ID, 0, -480, { modifiers: ['ctrl'] });
    expect((http.jsonBody(3) as Record<string, unknown>).modifiers).toEqual(['ctrl']);
  });

  it('screenshot carries fit bounds and the reply exposes the scale', async () => {
    const { client, http } = testClient([
      jsonResponse({ data: 'V0VCUA==', format: 'webp', width: 960, height: 540, scale: 0.5 }),
    ]);
    const s = await client.runtime.display.screenshot(RUNTIME_ID, {
      format: 'webp',
      maxWidth: 960,
      maxHeight: 960,
      cursor: true,
    });
    expect(s.scale).toBe(0.5);
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body).toMatchObject({ format: 'webp', max_width: 960, max_height: 960, cursor: true });
  });

  it('type can route through the clipboard paste path', async () => {
    const { client, http } = testClient([jsonResponse({})]);
    await client.runtime.display.type(RUNTIME_ID, 'big block', { mode: 'paste' });
    expect(http.jsonBody()).toEqual({ text: 'big block', mode: 'paste' });
  });

  it('clipboard get/set round-trips through the display', async () => {
    const { client, http } = testClient([jsonResponse({ text: 'hello' }), jsonResponse({})]);
    expect(await client.runtime.display.getClipboard(RUNTIME_ID)).toBe('hello');
    await client.runtime.display.setClipboard(RUNTIME_ID, 'world');
    expect(http.requests[0]?.url).toContain('display/clipboard');
    expect(http.jsonBody(1)).toEqual({ op: 'set', text: 'world' });
  });

  it('press and hotkey carry held modifiers', async () => {
    const { client, http } = testClient([jsonResponse({}), jsonResponse({})]);
    await client.runtime.display.press(RUNTIME_ID, 'enter', { modifiers: ['ctrl'] });
    expect(http.jsonBody()).toEqual({ key: 'enter', modifiers: ['ctrl'] });
    await client.runtime.display.hotkey(RUNTIME_ID, ['f4'], { modifiers: ['alt'] });
    expect(http.jsonBody(1)).toEqual({ keys: ['f4'], modifiers: ['alt'] });
  });

  it('act() batches inputs, settles and returns the observation', async () => {
    const { client, http } = testClient([
      jsonResponse({
        settled: true,
        rev: 42,
        screenshot: { data: 'UE5H', format: 'png', width: 100, height: 100, scale: 1, rev: 42 },
      }),
    ]);
    const r = await client.runtime.display.act(RUNTIME_ID, {
      actions: [
        { kind: 'click', mouse: { x: 10, y: 20, button: 'left' } },
        { kind: 'type', key: { text: 'hi' } },
      ],
      settleMs: 200,
      timeoutMs: 5000,
      observe: { format: 'png', if_rev: 41 },
    });
    expect(r.settled).toBe(true);
    expect(r.rev).toBe(42);
    expect(r.screenshot?.rev).toBe(42);
    const body = http.jsonBody() as Record<string, unknown>;
    expect(http.last().url).toContain('display/act');
    expect(body.settle_ms).toBe(200);
    expect((body.actions as unknown[]).length).toBe(2);
    expect((body.observe as Record<string, unknown>).if_rev).toBe(41);
  });

  it('act() translates camelCase action fields to wire names', async () => {
    const { client, http } = testClient([jsonResponse({ settled: true, rev: 1 })]);
    await client.runtime.display.act(RUNTIME_ID, {
      actions: [
        { kind: 'click', x: 5, y: 6, clickCount: 2 },
        { kind: 'drag', mouse: { toX: 9, toY: 9, durationMs: 300 } },
        { kind: 'type', key: { text: 'x', delayMs: 5 } },
      ],
    });
    const actions = (http.jsonBody() as Record<string, unknown>).actions as Record<
      string,
      unknown
    >[];
    expect(actions[0]).toEqual({ kind: 'click', x: 5, y: 6, click_count: 2 });
    expect(actions[1]).toEqual({
      kind: 'drag',
      mouse: { to_x: 9, to_y: 9, duration_ms: 300 },
    });
    expect(actions[2]).toEqual({ kind: 'type', key: { text: 'x', delay_ms: 5 } });
  });

  it('screenshot if_rev feeds back to skip unchanged frames', async () => {
    const { client, http } = testClient([
      jsonResponse({ data: '', format: 'png', width: 0, height: 0, rev: 7, unchanged: true }),
    ]);
    const s = await client.runtime.display.screenshot(RUNTIME_ID, { ifRev: 7 });
    expect(s.unchanged).toBe(true);
    expect(s.rev).toBe(7);
    expect((http.jsonBody() as Record<string, unknown>).if_rev).toBe(7);
  });

  it('resize() live-resizes and returns the new geometry', async () => {
    const { client, http } = testClient([
      jsonResponse({ enabled: true, width: 1280, height: 720, depth: 24, dpi: 96, display: ':0' }),
    ]);
    const info = await client.runtime.display.resize(RUNTIME_ID, 1280, 720);
    expect(info.width).toBe(1280);
    expect(http.last().url).toContain('display/resize');
    expect(http.jsonBody()).toEqual({ width: 1280, height: 720 });
  });

  it('windows() lists and filters top-level windows', async () => {
    const { client, http } = testClient([
      jsonResponse({
        windows: [
          {
            id: 2097155,
            x: 0,
            y: 0,
            w: 800,
            h: 600,
            title: 'Terminal',
            window_class: 'XTerm',
            instance: 'xterm',
            desktop: 0,
            focused: true,
            states: ['focused'],
          },
        ],
        focused: 2097155,
      }),
    ]);
    const r = await client.runtime.display.windows(RUNTIME_ID, { windowClass: 'term' });
    expect(r.focused).toBe(2097155);
    expect(r.windows[0]?.windowClass).toBe('XTerm');
    expect(http.last().url).toContain('window_class=term');
  });

  it('windowOp() moves and resizes windows', async () => {
    const { client, http } = testClient([
      jsonResponse({
        id: 1,
        x: 10,
        y: 20,
        w: 400,
        h: 300,
        title: 'w',
        window_class: 'c',
        instance: '',
        desktop: 0,
        focused: false,
        states: [],
      }),
      jsonResponse({ id: 1 }),
    ]);
    const w = await client.runtime.display.windowOp(RUNTIME_ID, 1, 'move', {
      at: { x: 10, y: 20 },
    });
    expect(w.x).toBe(10);
    expect(http.jsonBody()).toMatchObject({ id: 1, op: 'move', x: 10, y: 20 });
    await client.runtime.display.windowOp(RUNTIME_ID, 1, 'resize', {
      size: { w: 400, h: 300 },
    });
    expect(http.jsonBody(1)).toMatchObject({ op: 'resize', w: 400, h: 300 });
  });

  it('apps() lists installed applications', async () => {
    const { client } = testClient([
      jsonResponse({
        apps: [
          {
            id: 'org.mozilla.firefox',
            name: 'Firefox',
            exec: 'firefox %u',
            icon: 'firefox',
            categories: ['Network'],
          },
        ],
      }),
    ]);
    const apps = await client.runtime.display.apps(RUNTIME_ID);
    expect(apps[0]?.name).toBe('Firefox');
    expect(apps[0]?.categories).toEqual(['Network']);
  });

  it('launchApp() and open() wait for windows and report ids', async () => {
    const { client, http } = testClient([
      jsonResponse({ pid: 4242, window_id: 2097155, app: 'org.mozilla.firefox' }),
      jsonResponse({ pid: 4243, window_id: 0, app: 'org.mozilla.firefox', mime: 'text/html' }),
    ]);
    const l = await client.runtime.display.launchApp(RUNTIME_ID, 'org.mozilla.firefox', {
      uri: 'https://example.com',
      waitWindow: true,
      timeoutMs: 8000,
    });
    expect(l.pid).toBe(4242);
    expect(l.windowId).toBe(2097155);
    expect(http.jsonBody()).toMatchObject({
      app: 'org.mozilla.firefox',
      uri: 'https://example.com',
      wait_window: true,
      timeout_ms: 8000,
    });
    const o = await client.runtime.display.open(RUNTIME_ID, 'https://example.com');
    expect(o.mime).toBe('text/html');
    expect(o.windowId).toBeUndefined();
    expect(http.jsonBody(1)).toMatchObject({ target: 'https://example.com' });
  });

  it('clipboard image get/set uses base64 png payloads', async () => {
    const { client, http } = testClient([jsonResponse({ png: 'aVBORw==' }), jsonResponse({})]);
    expect(await client.runtime.display.getClipboardImage(RUNTIME_ID)).toBe('aVBORw==');
    await client.runtime.display.setClipboardImage(RUNTIME_ID, 'aVBORw==');
    expect(http.jsonBody(1)).toEqual({ op: 'set', png: 'aVBORw==' });
  });

  it('view() can stream a single window', async () => {
    const { client, http } = testClient([
      jsonResponse({ url: 'https://s.service.example', browser_url: 'https://s/auth', port: 9871 }),
    ]);
    await client.runtime.display.view(RUNTIME_ID, { windowId: 2097155 });
    expect((http.jsonBody() as Record<string, unknown>).window_id).toBe(2097155);
  });
});

describe('desktop session plane', () => {
  it('status lists declared components', async () => {
    const { client } = testClient([
      jsonResponse({
        present: true,
        display: ':1',
        user: 'agent',
        components: [
          { name: 'display', unit: 'xvfb.service', state: 'active', sub_state: 'running' },
        ],
      }),
    ]);
    const s = await client.runtime.desktop.status(RUNTIME_ID);
    expect(s.present).toBe(true);
    expect(s.components[0]?.unit).toBe('xvfb.service');
    expect(s.components[0]?.subState).toBe('running');
  });

  it('component() sends the lifecycle op and parses the post state', async () => {
    const { client, http } = testClient([
      jsonResponse({ name: 'session', unit: 'gnome.service', state: 'active', sub_state: 'running' }),
    ]);
    const c = await client.runtime.desktop.component(RUNTIME_ID, 'session', 'restart');
    expect(c.state).toBe('active');
    expect(http.jsonBody()).toEqual({ name: 'session', op: 'restart' });
  });

  it('logs() pages the component journal', async () => {
    const { client, http } = testClient([
      jsonResponse({
        entries: [{ timestamp: 't', message: 'm', priority: 3 }],
        next_cursor: 'c2',
        truncated: true,
      }),
    ]);
    const page = await client.runtime.desktop.logs(RUNTIME_ID, 'display', {
      cursor: 'c1',
      max: 100,
      priority: 'err',
    });
    expect(page.entries[0]?.message).toBe('m');
    expect(page.nextCursor).toBe('c2');
    expect(http.jsonBody()).toEqual({ name: 'display', cursor: 'c1', max: 100, priority: 'err' });
  });
});

describe('browser plane', () => {
  it('opens headed by default', async () => {
    const { client, http } = testClient([
      jsonResponse({ browser_id: BID, engine: 'chromium', headless: false }),
    ]);
    const b = await client.runtime.browser.open(RUNTIME_ID);
    expect(b.browserId).toBe(BID);
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body.engine).toBe('chromium');
    expect(body.headless).toBe(false);
  });

  it('navigates and reports settle', async () => {
    const { client } = testClient([
      jsonResponse({
        url: 'https://x.io',
        title: 'X',
        status: 200,
        navigated: true,
        settled: true,
      }),
    ]);
    const r = await client.runtime.browser.navigate(RUNTIME_ID, BID, 'https://x.io');
    expect(r.settled).toBe(true);
    expect(r.navigated).toBe(true);
  });

  it('clicks a ref and settles', async () => {
    const { client, http } = testClient([
      jsonResponse({ ok: true, navigated: false, settled: true }),
    ]);
    const r = await client.runtime.browser.click(RUNTIME_ID, BID, 'e3');
    expect(r.ok).toBe(true);
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body.verb).toBe('click');
    expect(body.target).toEqual({ by: 'ref', value: 'e3' });
    expect(http.last().url).toContain(`browser/${BID}/actions/click`);
  });

  it('clicks coords as a coords target', async () => {
    const { client, http } = testClient([jsonResponse({ ok: true })]);
    await client.runtime.browser.click(RUNTIME_ID, BID, { x: 10, y: 20 });
    const body = http.jsonBody() as Record<string, unknown>;
    const target = body.target as Record<string, unknown>;
    expect(target.by).toBe('coords');
    expect(target.attrs).toEqual({ x: '10', y: '20' });
  });

  it('fills via secret_ref and never serializes the secret', async () => {
    const { client, http } = testClient([jsonResponse({ ok: true })]);
    await client.runtime.browser.fill(RUNTIME_ID, BID, 'e7', { secretRef: 'ssv_x' });
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body.secret_ref).toBe('ssv_x');
    expect('text' in body).toBe(false);
  });

  it('snapshots the element digest', async () => {
    const { client } = testClient([
      jsonResponse({
        url: 'https://x.io',
        title: 'X',
        rev: 'r1',
        viewport: { width: 1280, height: 800 },
        elements: [
          {
            ref: 'e1',
            tag: 'button',
            role: 'button',
            name: 'Export',
            rect: { x: 1, y: 2, w: 3, h: 4 },
            enabled: true,
            visible: true,
          },
        ],
      }),
    ]);
    const s = await client.runtime.browser.snapshot(RUNTIME_ID, BID);
    expect(s.elements[0]?.ref).toBe('e1');
    expect(s.elements[0]?.name).toBe('Export');
    expect(s.viewport.width).toBe(1280);
  });

  it('evaluates JavaScript', async () => {
    const { client, http } = testClient([jsonResponse({ value: 'X', is_error: false })]);
    const r = await client.runtime.browser.evaluate(RUNTIME_ID, BID, 'document.title');
    expect(r.value).toBe('X');
    expect(r.isError).toBe(false);
    expect((http.jsonBody() as Record<string, unknown>).expression).toBe('document.title');
  });

  it('evaluate returns the parsed JSON value — objects pass through', async () => {
    const { client } = testClient([
      jsonResponse({ value: { n: 1, list: ['a'] }, is_error: false }),
    ]);
    const r = await client.runtime.browser.evaluate(RUNTIME_ID, BID, '({n:1,list:["a"]})');
    expect(r.value).toEqual({ n: 1, list: ['a'] });
  });

  it('waits on downloads and fetches bytes', async () => {
    const { client, http } = testClient([
      jsonResponse({
        downloads: [{ id: 'd1', filename: 'report.csv', bytes: 3, state: 'done' }],
      }),
      jsonResponse({ entry: { id: 'd1', filename: 'report.csv' }, data: 'Y3N2' }),
    ]);
    const list = await client.runtime.browser.downloads(RUNTIME_ID, BID, {
      waitName: 'report.csv',
    });
    expect(list[0]?.filename).toBe('report.csv');
    const dl = await client.runtime.browser.download(RUNTIME_ID, BID, 'd1');
    expect(dl.data).toBe('Y3N2');
    expect(http.requests[0]?.url).toContain(`browser/${BID}/downloads`);
  });

  it('renders a target to pdf', async () => {
    const { client, http } = testClient([jsonResponse({ data: 'JVBER', format: 'pdf' })]);
    const r = await client.runtime.browser.pdf(RUNTIME_ID, BID, 't1');
    expect(r.data).toBe('JVBER');
    expect(http.last().url).toContain(`browser/${BID}/targets/t1/pdf`);
  });

  it('answers dialogs by default; autoDismiss is opt-in', async () => {
    const { client, http } = testClient([jsonResponse({}), jsonResponse({})]);
    await client.runtime.browser.dialog(RUNTIME_ID, BID);
    let body = http.jsonBody() as Record<string, unknown>;
    expect(body.auto_dismiss).toBe(false);
    expect(body.accept).toBe(true);
    await client.runtime.browser.dialog(RUNTIME_ID, BID, { autoDismiss: true });
    body = http.jsonBody() as Record<string, unknown>;
    expect(body.auto_dismiss).toBe(true);
  });

  it('runs target commands (back/forward/reload)', async () => {
    const { client, http } = testClient([
      jsonResponse({ target_id: 't1', url: 'https://prev.io' }),
    ]);
    const t = await client.runtime.browser.command(RUNTIME_ID, BID, 'back', 't1');
    expect(t.url).toBe('https://prev.io');
    expect(http.last().url).toContain(`browser/${BID}/back`);
    expect((http.jsonBody() as Record<string, unknown>).verb).toBe('back');
  });

  it('sends dblclick and hover through the action path', async () => {
    const { client, http } = testClient([
      jsonResponse({ ok: true, settled: true }),
      jsonResponse({ ok: true, settled: true }),
    ]);
    await client.runtime.browser.dblclick(RUNTIME_ID, BID, 'e2');
    const d = http.jsonBody() as Record<string, unknown>;
    expect(d.verb).toBe('dblclick');
    expect((d.target as Record<string, unknown>).by).toBe('ref');
    await client.runtime.browser.hover(RUNTIME_ID, BID, { x: 10, y: 20 });
    const h = http.jsonBody(1) as Record<string, unknown>;
    expect(h.verb).toBe('hover');
    const attrs = (h.target as Record<string, unknown>).attrs as Record<string, unknown>;
    expect(attrs.x).toBe('10');
  });

  it('goto auto-opens the default browser once', async () => {
    const { client, http } = testClient([
      jsonResponse({ browser_id: BID, engine: 'chromium' }),
      jsonResponse({ url: 'https://a.io', navigated: true }),
      jsonResponse({ url: 'https://b.io', navigated: true }),
    ]);
    await client.runtime.browser.goto(RUNTIME_ID, 'https://a.io');
    await client.runtime.browser.goto(RUNTIME_ID, 'https://b.io');
    // one open, two navigates — the browser is reused
    expect(http.requests[0]?.url).toContain('browser/open');
    expect(http.requests[1]?.url).toContain(`browser/${BID}/navigate`);
    expect(http.requests[2]?.url).toContain(`browser/${BID}/navigate`);
    expect(http.requests.length).toBe(3);
  });

  it('view() returns the service record with a watch url', async () => {
    const { client, http } = testClient([
      jsonResponse({
        url: 'https://s.service.example',
        browser_url: 'https://s.service.example/auth',
        port: 9871,
      }),
    ]);
    const v = await client.runtime.browser.view(RUNTIME_ID, BID);
    expect(http.last().url).toContain(`browser/${BID}/view`);
    expect(v.url).toBe('https://s.service.example');
    expect(v.browserUrl).toContain('auth');
    expect(v.port).toBe(9871);
  });

  it('view() sends role and composes the vt capability into watchUrl', async () => {
    const { client, http } = testClient([
      jsonResponse({
        url: 'https://s.service.example',
        browser_url: 'https://s.service.example/_ws/auth?token=t',
        port: 9871,
        view_token: 'vt-watch-1',
      }),
    ]);
    const v = await client.runtime.browser.view(RUNTIME_ID, BID, { role: 'watch' });
    expect((http.jsonBody() as Record<string, unknown>).role).toBe('watch');
    expect(v.viewToken).toBe('vt-watch-1');
    expect(v.watchUrl).toBe('https://s.service.example/_ws/auth?token=t&vt=vt-watch-1');
  });

  it('caller ids are percent-encoded in the route path', async () => {
    const { client, http } = testClient([
      jsonResponse({ entry: { id: 'd?9' } }),
    ]);
    await client.runtime.browser.download(RUNTIME_ID, 'b/1', 'd?9');
    expect(http.last().url).toContain('browser/b%2F1/downloads/d%3F9');
  });
});

it('sends world/targetTimeoutMs/metaOnly/marginsIn', async () => {
  const { client, http } = testClient([
    jsonResponse({ value: '1', is_error: false }),
    jsonResponse({ ok: true }),
    jsonResponse({ entry: { id: 'd1' }, data: null }),
    jsonResponse({ data: 'JVBERg==' }),
  ]);
  await client.runtime.browser.evaluate(RUNTIME_ID, BID, '1', { world: 'main' });
  expect((http.jsonBody() as Record<string, unknown>).world).toBe('main');
  await client.runtime.browser.click(RUNTIME_ID, BID, 'e3', { force: true, targetTimeoutMs: 500 });
  const act = http.jsonBody() as Record<string, unknown>;
  expect(act.force).toBe(true);
  expect(act.target_timeout_ms).toBe(500);
  await client.runtime.browser.download(RUNTIME_ID, BID, 'd1', { metaOnly: true });
  expect(http.last().url).toContain('meta_only=true');
  await client.runtime.browser.pdf(RUNTIME_ID, BID, 't1', {
    marginsIn: { top: 0.4, left: 0.25 },
  });
  const pdf = http.jsonBody() as Record<string, unknown>;
  expect(pdf.margin_top_in).toBe(0.4);
  expect(pdf.margin_left_in).toBe(0.25);
});

it('activate + goto evicts a dead default browser', async () => {
  const { client, http } = testClient([
    jsonResponse({ browser_id: 'b1' }), // open
    jsonResponse({ error: 'gone' }, 404), // navigate b1 → dead
    jsonResponse({ browser_id: 'b2' }), // reopen
    jsonResponse({ url: 'https://x', navigated: true }), // navigate b2
    jsonResponse({ target_id: 't9' }), // activate
  ]);
  const nav = await client.runtime.browser.goto(RUNTIME_ID, 'https://x');
  expect(nav.navigated).toBe(true);
  await client.runtime.browser.command(RUNTIME_ID, 'b2', 'activate', 't9');
  expect(http.last().url).toContain('/activate');
});
