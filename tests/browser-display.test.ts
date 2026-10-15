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

  it('auto-dismisses dialogs by default', async () => {
    const { client, http } = testClient([jsonResponse({})]);
    await client.runtime.browser.dialog(RUNTIME_ID, BID);
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body.auto_dismiss).toBe(true);
    expect(body.accept).toBe(true);
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
      jsonResponse({ url: 'https://s.service.example', browser_url: 'https://s.service.example/auth', port: 9871 }),
    ]);
    const v = await client.runtime.browser.view(RUNTIME_ID, BID);
    expect(http.last().url).toContain(`browser/${BID}/view`);
    expect(v.url).toBe('https://s.service.example');
    expect(v.browserUrl).toContain('auth');
    expect(v.port).toBe(9871);
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
    jsonResponse({ browser_id: 'b1' }),           // open
    jsonResponse({ error: 'gone' }, 404),         // navigate b1 → dead
    jsonResponse({ browser_id: 'b2' }),           // reopen
    jsonResponse({ url: 'https://x', navigated: true }), // navigate b2
    jsonResponse({ target_id: 't9' }),            // activate
  ]);
  const nav = await client.runtime.browser.goto(RUNTIME_ID, 'https://x');
  expect(nav.navigated).toBe(true);
  await client.runtime.browser.command(RUNTIME_ID, 'b2', 'activate', 't9');
  expect(http.last().url).toContain('/activate');
});
