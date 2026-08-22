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
const OPTIONS = { timeout: 1234 };

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
