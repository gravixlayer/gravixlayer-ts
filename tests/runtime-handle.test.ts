/**
 * The runtime handle.
 *
 * `client.runtime.get()` hands back a `Runtime` whose methods are the resource
 * methods with the runtime id already applied. What matters here is the
 * binding: that each call lands on the right resource method with the right
 * arguments, and that a terminated handle refuses to keep working. The wire
 * format behind those resource methods is covered by the resource tests.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GravixLayerInvalidArgumentError,
  type GravixLayer,
  type PtySession,
  type Runtime,
} from '../src/index.js';
import { collect, jsonResponse, runtimePayload, RUNTIME_ID, testClient } from './helpers.js';

/** Passed through on every call so the assertions see a concrete value. */
const OPTIONS = { requestTimeoutMs: 1234 };

/** Whatever a stubbed resource method resolves to. */
const SENTINEL = { ok: true };

const REPO = '/workspace/repo';
const SESSION_ID = 'pty-1';

/** One delegate, and the resource method it is expected to reach. */
interface ForwardCase {
  /** Dotted path to the resource method, relative to `client.runtime`. */
  target: string;
  /** Invoke the delegate on the handle. */
  call: (runtime: Runtime) => unknown;
  /** Arguments the resource method should receive after the runtime id. */
  args: readonly unknown[];
  /** Set for delegates that yield rather than resolve. */
  streams?: boolean;
}

const CASES: readonly ForwardCase[] = [
  // Lifecycle and execution, straight off the handle.
  { target: 'pause', call: (r) => r.pause(OPTIONS), args: [OPTIONS] },
  { target: 'resume', call: (r) => r.resume(OPTIONS), args: [OPTIONS] },
  { target: 'setTimeout', call: (r) => r.setTimeout(60, OPTIONS), args: [60, OPTIONS] },
  { target: 'getMetrics', call: (r) => r.getMetrics(OPTIONS), args: [OPTIONS] },
  { target: 'runCode', call: (r) => r.runCode('1 + 1', OPTIONS), args: ['1 + 1', OPTIONS] },
  { target: 'runCmd', call: (r) => r.runCmd('ls', OPTIONS), args: ['ls', OPTIONS] },
  {
    target: 'streamCode',
    call: (r) => r.streamCode('1 + 1', OPTIONS),
    args: ['1 + 1', OPTIONS],
    streams: true,
  },
  {
    target: 'streamCmd',
    call: (r) => r.streamCmd('ls', OPTIONS),
    args: ['ls', OPTIONS],
    streams: true,
  },
  { target: 'createContext', call: (r) => r.createContext(OPTIONS), args: [OPTIONS] },
  { target: 'getContext', call: (r) => r.getContext('ctx-1', OPTIONS), args: ['ctx-1', OPTIONS] },
  {
    target: 'deleteContext',
    call: (r) => r.deleteContext('ctx-1', OPTIONS),
    args: ['ctx-1', OPTIONS],
  },
  { target: 'enableSsh', call: (r) => r.enableSsh(OPTIONS), args: [OPTIONS] },
  { target: 'disableSsh', call: (r) => r.disableSsh(OPTIONS), args: [OPTIONS] },
  { target: 'sshStatus', call: (r) => r.sshStatus(OPTIONS), args: [OPTIONS] },
  { target: 'retrieve', call: (r) => r.refresh(OPTIONS), args: [OPTIONS] },
  { target: 'service.connect', call: (r) => r.service(8000, OPTIONS), args: [8000, OPTIONS] },

  // runtime.file
  { target: 'file.read', call: (r) => r.file.read('/a.txt', OPTIONS), args: ['/a.txt', OPTIONS] },
  {
    target: 'file.write',
    call: (r) => r.file.write('/a.txt', 'hi', OPTIONS),
    args: ['/a.txt', 'hi', OPTIONS],
  },
  {
    target: 'file.delete',
    call: (r) => r.file.delete('/a.txt', OPTIONS),
    args: ['/a.txt', OPTIONS],
  },
  { target: 'file.list', call: (r) => r.file.list('/', OPTIONS), args: ['/', OPTIONS] },
  {
    target: 'file.upload',
    call: (r) => r.file.upload('/a.txt', 'hi', OPTIONS),
    args: ['/a.txt', 'hi', OPTIONS],
  },
  {
    target: 'file.writeMany',
    call: (r) => r.file.writeMany([{ path: '/a.txt', data: 'hi' }], OPTIONS),
    args: [[{ path: '/a.txt', data: 'hi' }], OPTIONS],
  },
  {
    target: 'file.createDirectory',
    call: (r) => r.file.createDirectory('/dir', OPTIONS),
    args: ['/dir', OPTIONS],
  },
  {
    target: 'file.getInfo',
    call: (r) => r.file.getInfo('/a.txt', OPTIONS),
    args: ['/a.txt', OPTIONS],
  },
  {
    target: 'file.setPermissions',
    call: (r) => r.file.setPermissions('/a.txt', 0o755, OPTIONS),
    args: ['/a.txt', 0o755, OPTIONS],
  },
  {
    target: 'file.move',
    call: (r) => r.file.move('/a.txt', '/b.txt', OPTIONS),
    args: ['/a.txt', '/b.txt', OPTIONS],
  },
  {
    target: 'file.copy',
    call: (r) => r.file.copy('/a.txt', '/b.txt', OPTIONS),
    args: ['/a.txt', '/b.txt', OPTIONS],
  },
  {
    target: 'file.chown',
    call: (r) => r.file.chown('/a.txt', { user: 'app', ...OPTIONS }),
    args: ['/a.txt', { user: 'app', ...OPTIONS }],
  },
  {
    target: 'file.watch',
    call: (r) => r.file.watch('/dir', { recursive: true, ...OPTIONS }),
    args: ['/dir', { recursive: true, ...OPTIONS }],
    streams: true,
  },
  {
    target: 'file.find',
    call: (r) => r.file.find('/dir', { pattern: 'TODO', ...OPTIONS }),
    args: ['/dir', { pattern: 'TODO', ...OPTIONS }],
  },
  {
    target: 'file.replace',
    call: (r) => r.file.replace('/dir', 'old', 'new', OPTIONS),
    args: ['/dir', 'old', 'new', OPTIONS],
  },
  {
    target: 'file.uploadFile',
    call: (r) => r.file.uploadFile('hi', '/a.txt', OPTIONS),
    args: ['hi', '/a.txt', OPTIONS],
  },
  {
    target: 'file.download',
    call: (r) => r.file.download('/a.txt', OPTIONS),
    args: ['/a.txt', OPTIONS],
  },
  {
    target: 'file.downloadText',
    call: (r) => r.file.downloadText('/a.txt', OPTIONS),
    args: ['/a.txt', OPTIONS],
  },

  // runtime.pty
  { target: 'pty.create', call: (r) => r.pty.create(OPTIONS), args: [OPTIONS] },
  { target: 'pty.list', call: (r) => r.pty.list(OPTIONS), args: [OPTIONS] },
  { target: 'pty.get', call: (r) => r.pty.get(SESSION_ID, OPTIONS), args: [SESSION_ID, OPTIONS] },
  {
    target: 'pty.sendInput',
    call: (r) => r.pty.sendInput(SESSION_ID, 'ls\n', OPTIONS),
    args: [SESSION_ID, 'ls\n', OPTIONS],
  },
  {
    target: 'pty.resize',
    call: (r) => r.pty.resize(SESSION_ID, 120, 40, OPTIONS),
    args: [SESSION_ID, 120, 40, OPTIONS],
  },
  {
    target: 'pty.sendSignal',
    call: (r) => r.pty.sendSignal(SESSION_ID, 'SIGINT', OPTIONS),
    args: [SESSION_ID, 'SIGINT', OPTIONS],
  },
  { target: 'pty.kill', call: (r) => r.pty.kill(SESSION_ID, OPTIONS), args: [SESSION_ID, OPTIONS] },
  {
    target: 'pty.stream',
    call: (r) => r.pty.stream(SESSION_ID, OPTIONS),
    args: [SESSION_ID, OPTIONS],
    streams: true,
  },

  // runtime.git
  {
    target: 'git.clone',
    call: (r) => r.git.clone('https://example.test/r.git', REPO, OPTIONS),
    args: ['https://example.test/r.git', REPO, OPTIONS],
  },
  { target: 'git.status', call: (r) => r.git.status(REPO, OPTIONS), args: [REPO, OPTIONS] },
  {
    target: 'git.branchList',
    call: (r) => r.git.branchList(REPO, 'all', OPTIONS),
    args: [REPO, 'all', OPTIONS],
  },
  {
    target: 'git.checkout',
    call: (r) => r.git.checkout(REPO, 'main', OPTIONS),
    args: [REPO, 'main', OPTIONS],
  },
  { target: 'git.pull', call: (r) => r.git.pull(REPO, OPTIONS), args: [REPO, OPTIONS] },
  { target: 'git.fetch', call: (r) => r.git.fetch(REPO, OPTIONS), args: [REPO, OPTIONS] },
  { target: 'git.push', call: (r) => r.git.push(REPO, OPTIONS), args: [REPO, OPTIONS] },
  {
    target: 'git.add',
    call: (r) => r.git.add(REPO, ['a.txt'], OPTIONS),
    args: [REPO, ['a.txt'], OPTIONS],
  },
  {
    target: 'git.commit',
    call: (r) => r.git.commit(REPO, 'first', OPTIONS),
    args: [REPO, 'first', OPTIONS],
  },
  {
    target: 'git.createBranch',
    call: (r) => r.git.createBranch(REPO, 'feature', 'main', OPTIONS),
    args: [REPO, 'feature', 'main', OPTIONS],
  },
  {
    target: 'git.deleteBranch',
    call: (r) => r.git.deleteBranch(REPO, 'feature', true, OPTIONS),
    args: [REPO, 'feature', true, OPTIONS],
  },

  // runtime.browser — every bound method delegates to the resource with the
  // runtime id first; BID is the browser id.
  {
    target: 'browser.open',
    call: (r) => r.browser.open(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'browser.goto',
    call: (r) => r.browser.goto('https://x/', OPTIONS),
    args: ['https://x/', OPTIONS],
  },
  {
    target: 'browser.close',
    call: (r) => r.browser.close('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },
  {
    target: 'browser.list',
    call: (r) => r.browser.list(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'browser.status',
    call: (r) => r.browser.status('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },
  {
    target: 'browser.navigate',
    call: (r) => r.browser.navigate('b1', 'https://x/', OPTIONS),
    args: ['b1', 'https://x/', OPTIONS],
  },
  {
    target: 'browser.command',
    call: (r) => r.browser.command('b1', 'back', 'T1', OPTIONS),
    args: ['b1', 'back', 'T1', OPTIONS],
  },
  {
    target: 'browser.back',
    call: (r) => r.browser.back('b1', 'T1', OPTIONS),
    args: ['b1', 'T1', OPTIONS],
  },
  {
    target: 'browser.forward',
    call: (r) => r.browser.forward('b1', 'T1', OPTIONS),
    args: ['b1', 'T1', OPTIONS],
  },
  {
    target: 'browser.reload',
    call: (r) => r.browser.reload('b1', 'T1', OPTIONS),
    args: ['b1', 'T1', OPTIONS],
  },
  {
    target: 'browser.activate',
    call: (r) => r.browser.activate('b1', 'T1', OPTIONS),
    args: ['b1', 'T1', OPTIONS],
  },
  {
    target: 'browser.screenshot',
    call: (r) => r.browser.screenshot('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },
  {
    target: 'browser.snapshot',
    call: (r) => r.browser.snapshot('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },
  {
    target: 'browser.evaluate',
    call: (r) => r.browser.evaluate('b1', '1', OPTIONS),
    args: ['b1', '1', OPTIONS],
  },
  {
    target: 'browser.click',
    call: (r) => r.browser.click('b1', 'e3', OPTIONS),
    args: ['b1', 'e3', OPTIONS],
  },
  {
    target: 'browser.dblclick',
    call: (r) => r.browser.dblclick('b1', 'e3', OPTIONS),
    args: ['b1', 'e3', OPTIONS],
  },
  {
    target: 'browser.hover',
    call: (r) => r.browser.hover('b1', 'e3', OPTIONS),
    args: ['b1', 'e3', OPTIONS],
  },
  {
    target: 'browser.fill',
    call: (r) => r.browser.fill('b1', 'e3', OPTIONS),
    args: ['b1', 'e3', OPTIONS],
  },
  {
    target: 'browser.type',
    call: (r) => r.browser.type('b1', 'e3', 'hi', OPTIONS),
    args: ['b1', 'e3', 'hi', OPTIONS],
  },
  {
    target: 'browser.press',
    call: (r) => r.browser.press('b1', 'Enter', OPTIONS),
    args: ['b1', 'Enter', OPTIONS],
  },
  {
    target: 'browser.hotkey',
    call: (r) => r.browser.hotkey('b1', ['ctrl', 'c'], OPTIONS),
    args: ['b1', ['ctrl', 'c'], OPTIONS],
  },
  {
    target: 'browser.scroll',
    call: (r) => r.browser.scroll('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },
  {
    target: 'browser.dialog',
    call: (r) => r.browser.dialog('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },
  {
    target: 'browser.targets',
    call: (r) => r.browser.targets('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },
  {
    target: 'browser.downloads',
    call: (r) => r.browser.downloads('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },
  {
    target: 'browser.download',
    call: (r) => r.browser.download('b1', 'd1', OPTIONS),
    args: ['b1', 'd1', OPTIONS],
  },
  {
    target: 'browser.pdf',
    call: (r) => r.browser.pdf('b1', 'T1', OPTIONS),
    args: ['b1', 'T1', OPTIONS],
  },
  {
    target: 'browser.view',
    call: (r) => r.browser.view('b1', OPTIONS),
    args: ['b1', OPTIONS],
  },

  // runtime.desktop — the merged pixel + session surface.
  {
    target: 'desktop.enable',
    call: (r) => r.desktop.enable(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.disable',
    call: (r) => r.desktop.disable(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.status',
    call: (r) => r.desktop.status(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.screenshot',
    call: (r) => r.desktop.screenshot(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.click',
    call: (r) => r.desktop.click(10, 20, 'left', OPTIONS),
    args: [10, 20, 'left', OPTIONS],
  },
  {
    target: 'desktop.move',
    call: (r) => r.desktop.move(10, 20, OPTIONS),
    args: [10, 20, OPTIONS],
  },
  {
    target: 'desktop.scroll',
    call: (r) => r.desktop.scroll(0, -480, OPTIONS),
    args: [0, -480, OPTIONS],
  },
  {
    target: 'desktop.type',
    call: (r) => r.desktop.type('hi', OPTIONS),
    args: ['hi', OPTIONS],
  },
  {
    target: 'desktop.press',
    call: (r) => r.desktop.press('Enter', OPTIONS),
    args: ['Enter', OPTIONS],
  },
  {
    target: 'desktop.hotkey',
    call: (r) => r.desktop.hotkey(['ctrl', 'c'], OPTIONS),
    args: [['ctrl', 'c'], OPTIONS],
  },
  {
    target: 'desktop.waitStable',
    call: (r) => r.desktop.waitStable(300, 5000, OPTIONS),
    args: [300, 5000, OPTIONS],
  },
  {
    target: 'desktop.view',
    call: (r) => r.desktop.view(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.stopView',
    call: (r) => r.desktop.stopView(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.info',
    call: (r) => r.desktop.info(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.position',
    call: (r) => r.desktop.position(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.keys',
    call: (r) => r.desktop.keys(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.down',
    call: (r) => r.desktop.down(10, 20, 'left', OPTIONS),
    args: [10, 20, 'left', OPTIONS],
  },
  {
    target: 'desktop.up',
    call: (r) => r.desktop.up('left', OPTIONS),
    args: ['left', OPTIONS],
  },
  {
    target: 'desktop.drag',
    call: (r) => r.desktop.drag(30, 40, 'left', OPTIONS),
    args: [30, 40, 'left', OPTIONS],
  },
  {
    target: 'desktop.getClipboard',
    call: (r) => r.desktop.getClipboard(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.setClipboard',
    call: (r) => r.desktop.setClipboard('hi', OPTIONS),
    args: ['hi', OPTIONS],
  },
  {
    target: 'desktop.getClipboardImage',
    call: (r) => r.desktop.getClipboardImage(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.setClipboardImage',
    call: (r) => r.desktop.setClipboardImage('aGk=', OPTIONS),
    args: ['aGk=', OPTIONS],
  },
  {
    target: 'desktop.act',
    call: (r) => r.desktop.act({ actions: [], ...OPTIONS }),
    args: [{ actions: [], ...OPTIONS }],
  },
  {
    target: 'desktop.resize',
    call: (r) => r.desktop.resize(1920, 1080, OPTIONS),
    args: [1920, 1080, OPTIONS],
  },
  {
    target: 'desktop.windows',
    call: (r) => r.desktop.windows(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.windowOp',
    call: (r) => r.desktop.windowOp(7, 'focus', OPTIONS),
    args: [7, 'focus', OPTIONS],
  },
  {
    target: 'desktop.apps',
    call: (r) => r.desktop.apps(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.launchApp',
    call: (r) => r.desktop.launchApp('terminal', OPTIONS),
    args: ['terminal', OPTIONS],
  },
  {
    target: 'desktop.open',
    call: (r) => r.desktop.open('/etc/hosts', OPTIONS),
    args: ['/etc/hosts', OPTIONS],
  },
  {
    target: 'desktop.components',
    call: (r) => r.desktop.components(OPTIONS),
    args: [OPTIONS],
  },
  {
    target: 'desktop.component',
    call: (r) => r.desktop.component('display', 'restart', OPTIONS),
    args: ['display', 'restart', OPTIONS],
  },
  {
    target: 'desktop.startComponent',
    call: (r) => r.desktop.startComponent('display', OPTIONS),
    args: ['display', OPTIONS],
  },
  {
    target: 'desktop.stopComponent',
    call: (r) => r.desktop.stopComponent('display', OPTIONS),
    args: ['display', OPTIONS],
  },
  {
    target: 'desktop.restartComponent',
    call: (r) => r.desktop.restartComponent('display', OPTIONS),
    args: ['display', OPTIONS],
  },
  {
    target: 'desktop.logs',
    call: (r) => r.desktop.logs('display', OPTIONS),
    args: ['display', OPTIONS],
  },
  {
    target: 'desktop.leftClick',
    call: (r) => r.desktop.leftClick(10, 20, OPTIONS),
    args: [10, 20, OPTIONS],
  },
  {
    target: 'desktop.doubleClick',
    call: (r) => r.desktop.doubleClick(10, 20, OPTIONS),
    args: [10, 20, OPTIONS],
  },
  {
    target: 'desktop.rightClick',
    call: (r) => r.desktop.rightClick(10, 20, OPTIONS),
    args: [10, 20, OPTIONS],
  },
  {
    target: 'desktop.middleClick',
    call: (r) => r.desktop.middleClick(10, 20, OPTIONS),
    args: [10, 20, OPTIONS],
  },
  {
    target: 'desktop.mousePress',
    call: (r) => r.desktop.mousePress('left', 10, 20, OPTIONS),
    args: ['left', 10, 20, OPTIONS],
  },
  {
    target: 'desktop.mouseRelease',
    call: (r) => r.desktop.mouseRelease('left', 10, 20, OPTIONS),
    args: ['left', 10, 20, OPTIONS],
  },
  {
    target: 'desktop.moveMouse',
    call: (r) => r.desktop.moveMouse(10, 20, OPTIONS),
    args: [10, 20, OPTIONS],
  },
  {
    target: 'desktop.write',
    call: (r) => r.desktop.write('hi', 5, OPTIONS),
    args: ['hi', 5, OPTIONS],
  },
];

/** Build a handle over a fake client, with no request left in the queue. */
async function handle(): Promise<{ client: GravixLayer; runtime: Runtime }> {
  const { client } = testClient([jsonResponse(runtimePayload())]);
  return { client, runtime: await client.runtime.get(RUNTIME_ID) };
}

/** Replace one resource method with a recording stub. */
function stubMethod(client: GravixLayer, target: string, streams: boolean) {
  const path = target.split('.');
  const name = path.pop() as string;

  let owner = client.runtime as unknown as Record<string, Record<string, unknown>>;
  for (const step of path) owner = owner[step] as Record<string, Record<string, unknown>>;

  const spy = streams
    ? vi.fn(async function* () {
        yield SENTINEL;
      })
    : vi.fn(async () => SENTINEL);

  (owner as unknown as Record<string, unknown>)[name] = spy;
  return spy;
}

describe('Runtime handle', () => {
  it('exposes the state it was built from', async () => {
    const { runtime } = await handle();

    expect(runtime.runtimeId).toBe(RUNTIME_ID);
    expect(runtime.status).toBe('running');
    expect(runtime.template).toBe('base-small');
    expect(runtime.cloud).toBe('aws');
    expect(runtime.region).toBe('us-east-1');
    expect(runtime.cpuCount).toBe(2);
    expect(runtime.memoryMb).toBe(2048);
    expect(runtime.diskSizeMb).toBe(8192);
    expect(runtime.startedAt).toBe('2026-01-01T00:00:00Z');
    expect(runtime.timeoutAt).toBeUndefined();
    expect(runtime.metadata).toBeUndefined();
    expect(runtime.info.runtimeId).toBe(RUNTIME_ID);
    expect((runtime as { files?: unknown }).files).toBeUndefined();
    expect((runtime as { services?: unknown }).services).toBeUndefined();
  });

  it('picks up new state on refresh', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse(runtimePayload({ status: 'paused', timeout_at: '2026-01-01T01:00:00Z' })),
    ]);

    const runtime = await client.runtime.get(RUNTIME_ID);
    await runtime.refresh();

    expect(runtime.status).toBe('paused');
    expect(runtime.timeoutAt).toBe('2026-01-01T01:00:00Z');
  });

  it('reports liveness without throwing when the runtime is gone', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ error: 'not found' }, 404),
    ]);

    const runtime = await client.runtime.get(RUNTIME_ID);

    expect(await runtime.isAlive()).toBe(false);
  });

  it('reports liveness from the refreshed status', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse(runtimePayload({ status: 'paused' })),
      jsonResponse(runtimePayload()),
    ]);

    const runtime = await client.runtime.get(RUNTIME_ID);

    expect(await runtime.isAlive()).toBe(false);
    expect(await runtime.isAlive()).toBe(true);
  });

  it('refuses to work after it has been stopped', async () => {
    const { client } = testClient([jsonResponse(runtimePayload()), jsonResponse({ ok: true })]);

    const runtime = await client.runtime.get(RUNTIME_ID);
    await runtime.kill();

    expect(runtime.status).toBe('terminated');
    expect(await runtime.isAlive()).toBe(false);
    await expect(runtime.runCode('1')).rejects.toBeInstanceOf(GravixLayerInvalidArgumentError);
    await expect(runtime.file.read('/a.txt')).rejects.toBeInstanceOf(
      GravixLayerInvalidArgumentError,
    );
    await expect(runtime.git.status('/repo')).rejects.toBeInstanceOf(
      GravixLayerInvalidArgumentError,
    );
    await expect(runtime.service(8000)).rejects.toBeInstanceOf(GravixLayerInvalidArgumentError);
    await expect(runtime.pty.list()).rejects.toBeInstanceOf(GravixLayerInvalidArgumentError);
  });

  it('stops the runtime when an `await using` block exits', async () => {
    const { client, http } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ message: 'terminated' }),
    ]);

    {
      await using runtime = await client.runtime.get(RUNTIME_ID);
      expect(runtime.runtimeId).toBe(RUNTIME_ID);
    }

    expect(http.last().method).toBe('DELETE');
    expect(http.requests).toHaveLength(2);
  });

  it('opens a terminal and attaches to it in one step', async () => {
    const { client, runtime } = await handle();
    const session: PtySession = {
      sessionId: SESSION_ID,
      runtimeId: RUNTIME_ID,
      pid: 100,
      shell: '/bin/bash',
      args: [],
      workingDir: '/workspace',
      cols: 80,
      rows: 24,
      status: 'running',
      exitCode: 0,
    };

    const create = vi.fn(async () => session);
    const connect = vi.fn(async () => ({ sessionId: SESSION_ID }));
    const make = vi.fn(() => ({ connect }));

    const pty = client.runtime.pty as unknown as Record<string, unknown>;
    pty['create'] = create;
    pty['handle'] = make;

    await runtime.pty.open({ shell: '/bin/bash' });

    expect(create).toHaveBeenCalledWith(RUNTIME_ID, { shell: '/bin/bash' });
    expect(make).toHaveBeenCalledWith(RUNTIME_ID, SESSION_ID);
    expect(connect).toHaveBeenCalled();
  });

  it('hands out a stateful terminal handle bound to the runtime', async () => {
    const { client, runtime } = await handle();
    const make = vi.fn(() => ({ sessionId: SESSION_ID }));
    (client.runtime.pty as unknown as Record<string, unknown>)['handle'] = make;

    runtime.pty.handle(SESSION_ID);

    expect(make).toHaveBeenCalledWith(RUNTIME_ID, SESSION_ID);
  });

  describe('applies the runtime id to every delegate', () => {
    for (const testCase of CASES) {
      it(testCase.target, async () => {
        const { client, runtime } = await handle();
        const spy = stubMethod(client, testCase.target, testCase.streams === true);

        const result = testCase.call(runtime);
        if (testCase.streams) await collect(result as AsyncIterable<unknown>);
        else await result;

        expect(spy).toHaveBeenCalledWith(RUNTIME_ID, ...testCase.args);
      });
    }
  });
});
