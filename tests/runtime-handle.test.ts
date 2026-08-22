/**
 * The runtime handle.
 *
 * `client.runtimes.get()` hands back a `Runtime` whose methods are the resource
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
  /** Dotted path to the resource method, relative to `client.runtimes`. */
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
  { target: 'services.connect', call: (r) => r.service(8000, OPTIONS), args: [8000, OPTIONS] },

  // runtime.files
  { target: 'files.read', call: (r) => r.files.read('/a.txt', OPTIONS), args: ['/a.txt', OPTIONS] },
  {
    target: 'files.write',
    call: (r) => r.files.write('/a.txt', 'hi', OPTIONS),
    args: ['/a.txt', 'hi', OPTIONS],
  },
  {
    target: 'files.delete',
    call: (r) => r.files.delete('/a.txt', OPTIONS),
    args: ['/a.txt', OPTIONS],
  },
  { target: 'files.list', call: (r) => r.files.list('/', OPTIONS), args: ['/', OPTIONS] },
  {
    target: 'files.upload',
    call: (r) => r.files.upload('/a.txt', 'hi', OPTIONS),
    args: ['/a.txt', 'hi', OPTIONS],
  },
  {
    target: 'files.writeMany',
    call: (r) => r.files.writeMany([{ path: '/a.txt', data: 'hi' }], OPTIONS),
    args: [[{ path: '/a.txt', data: 'hi' }], OPTIONS],
  },
  {
    target: 'files.createDirectory',
    call: (r) => r.files.createDirectory('/dir', OPTIONS),
    args: ['/dir', OPTIONS],
  },
  {
    target: 'files.getInfo',
    call: (r) => r.files.getInfo('/a.txt', OPTIONS),
    args: ['/a.txt', OPTIONS],
  },
  {
    target: 'files.setPermissions',
    call: (r) => r.files.setPermissions('/a.txt', 0o755, OPTIONS),
    args: ['/a.txt', 0o755, OPTIONS],
  },
  {
    target: 'files.move',
    call: (r) => r.files.move('/a.txt', '/b.txt', OPTIONS),
    args: ['/a.txt', '/b.txt', OPTIONS],
  },
  {
    target: 'files.copy',
    call: (r) => r.files.copy('/a.txt', '/b.txt', OPTIONS),
    args: ['/a.txt', '/b.txt', OPTIONS],
  },
  {
    target: 'files.chown',
    call: (r) => r.files.chown('/a.txt', { user: 'app', ...OPTIONS }),
    args: ['/a.txt', { user: 'app', ...OPTIONS }],
  },
  {
    target: 'files.watch',
    call: (r) => r.files.watch('/dir', { recursive: true, ...OPTIONS }),
    args: ['/dir', { recursive: true, ...OPTIONS }],
    streams: true,
  },
  {
    target: 'files.find',
    call: (r) => r.files.find('/dir', { pattern: 'TODO', ...OPTIONS }),
    args: ['/dir', { pattern: 'TODO', ...OPTIONS }],
  },
  {
    target: 'files.replace',
    call: (r) => r.files.replace('/dir', 'old', 'new', OPTIONS),
    args: ['/dir', 'old', 'new', OPTIONS],
  },
  {
    target: 'files.uploadFile',
    call: (r) => r.files.uploadFile('hi', '/a.txt', OPTIONS),
    args: ['hi', '/a.txt', OPTIONS],
  },
  {
    target: 'files.download',
    call: (r) => r.files.download('/a.txt', OPTIONS),
    args: ['/a.txt', OPTIONS],
  },
  {
    target: 'files.downloadText',
    call: (r) => r.files.downloadText('/a.txt', OPTIONS),
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

  // runtime.services
  {
    target: 'services.publish',
    call: (r) => r.services.publish(8000, OPTIONS),
    args: [8000, OPTIONS],
  },
  {
    target: 'services.connect',
    call: (r) => r.services.connect(8000, OPTIONS),
    args: [8000, OPTIONS],
  },
  { target: 'services.list', call: (r) => r.services.list(OPTIONS), args: [OPTIONS] },
  {
    target: 'services.revoke',
    call: (r) => r.services.revoke(8000, OPTIONS),
    args: [8000, OPTIONS],
  },
];

/** Build a handle over a fake client, with no request left in the queue. */
async function handle(): Promise<{ client: GravixLayer; runtime: Runtime }> {
  const { client } = testClient([jsonResponse(runtimePayload())]);
  return { client, runtime: await client.runtimes.get(RUNTIME_ID) };
}

/** Replace one resource method with a recording stub. */
function stubMethod(client: GravixLayer, target: string, streams: boolean) {
  const path = target.split('.');
  const name = path.pop() as string;

  let owner = client.runtimes as unknown as Record<string, Record<string, unknown>>;
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
  });

  it('picks up new state on refresh', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse(runtimePayload({ status: 'paused', timeout_at: '2026-01-01T01:00:00Z' })),
    ]);

    const runtime = await client.runtimes.get(RUNTIME_ID);
    await runtime.refresh();

    expect(runtime.status).toBe('paused');
    expect(runtime.timeoutAt).toBe('2026-01-01T01:00:00Z');
  });

  it('reports liveness without throwing when the runtime is gone', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ error: 'not found' }, 404),
    ]);

    const runtime = await client.runtimes.get(RUNTIME_ID);

    expect(await runtime.isAlive()).toBe(false);
  });

  it('reports liveness from the refreshed status', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse(runtimePayload({ status: 'paused' })),
      jsonResponse(runtimePayload()),
    ]);

    const runtime = await client.runtimes.get(RUNTIME_ID);

    expect(await runtime.isAlive()).toBe(false);
    expect(await runtime.isAlive()).toBe(true);
  });

  it('refuses to work after it has been stopped', async () => {
    const { client } = testClient([jsonResponse(runtimePayload()), jsonResponse({ ok: true })]);

    const runtime = await client.runtimes.get(RUNTIME_ID);
    await runtime.kill();

    expect(runtime.status).toBe('terminated');
    expect(await runtime.isAlive()).toBe(false);
    await expect(runtime.runCode('1')).rejects.toBeInstanceOf(GravixLayerInvalidArgumentError);
    await expect(runtime.files.read('/a.txt')).rejects.toBeInstanceOf(
      GravixLayerInvalidArgumentError,
    );
    await expect(runtime.git.status('/repo')).rejects.toBeInstanceOf(
      GravixLayerInvalidArgumentError,
    );
    await expect(runtime.services.list()).rejects.toBeInstanceOf(GravixLayerInvalidArgumentError);
    await expect(runtime.pty.list()).rejects.toBeInstanceOf(GravixLayerInvalidArgumentError);
  });

  it('stops the runtime when an `await using` block exits', async () => {
    const { client, http } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ message: 'terminated' }),
    ]);

    {
      await using runtime = await client.runtimes.get(RUNTIME_ID);
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

    const pty = client.runtimes.pty as unknown as Record<string, unknown>;
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
    (client.runtimes.pty as unknown as Record<string, unknown>)['handle'] = make;

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
