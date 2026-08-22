import { describe, expect, it, vi } from 'vitest';

import {
  GravixLayerAbortError,
  GravixLayerConnectionError,
  GravixLayerError,
  GravixLayerInvalidArgumentError,
  GravixLayerServerError,
  GravixLayerTimeoutError,
  PTY_BUFFER_LIMIT_BYTES,
  type FetchLike,
} from '../src/index.js';
import { toBase64, utf8Encode } from '../src/core/binary.js';
import {
  collect,
  emptyResponse,
  errorResponse,
  expectRejection,
  jsonResponse,
  mockFetch,
  RUNTIME_ID,
  sseJson,
  testClient,
} from './helpers.js';

const SESSION_ID = 'pty-1';

function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION_ID,
    runtime_id: RUNTIME_ID,
    pid: 42,
    shell: '/bin/bash',
    args: ['-l'],
    working_dir: '/workspace',
    cols: 80,
    rows: 24,
    status: 'running',
    exit_code: 0,
    ...overrides,
  };
}

describe('terminal sessions', () => {
  it('starts a session with the requested geometry', async () => {
    const { client, http } = testClient([jsonResponse(sessionPayload())]);
    const session = await client.runtime.pty.create(RUNTIME_ID, {
      shell: '/bin/bash',
      args: ['-l'],
      workingDir: '/workspace',
      environment: { TERM: 'xterm-256color' },
      cols: 120,
      rows: 40,
    });

    expect(http.last().url).toContain(`/runtime/${RUNTIME_ID}/pty`);
    expect(http.jsonBody()).toEqual({
      shell: '/bin/bash',
      args: ['-l'],
      working_dir: '/workspace',
      environment: { TERM: 'xterm-256color' },
      cols: 120,
      rows: 40,
    });
    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.pid).toBe(42);
  });

  it('sends an empty body when nothing is configured', async () => {
    const { client, http } = testClient([jsonResponse(sessionPayload())]);
    await client.runtime.pty.create(RUNTIME_ID);
    expect(http.jsonBody()).toEqual({});
  });

  it('lists and reads sessions', async () => {
    const { client, http } = testClient([
      jsonResponse({ sessions: [sessionPayload()] }),
      jsonResponse(sessionPayload({ status: 'exited', exit_code: 130 })),
    ]);

    expect(await client.runtime.pty.list(RUNTIME_ID)).toHaveLength(1);

    const session = await client.runtime.pty.get(RUNTIME_ID, SESSION_ID);
    expect(http.last().url).toContain(`/pty/${SESSION_ID}`);
    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(130);
  });

  it('sends text input as-is', async () => {
    const { client, http } = testClient([jsonResponse({ success: true, bytes_written: 6 })]);
    const result = await client.runtime.pty.sendInput(RUNTIME_ID, SESSION_ID, 'ls -l\n');

    expect(http.jsonBody()).toEqual({ data: 'ls -l\n' });
    expect(result.bytesWritten).toBe(6);
  });

  it('base64-encodes raw byte input so control codes survive', async () => {
    const { client, http } = testClient([jsonResponse({ success: true, bytes_written: 1 })]);
    // Ctrl-C.
    await client.runtime.pty.sendInput(RUNTIME_ID, SESSION_ID, new Uint8Array([0x03]));

    expect(http.jsonBody()).toEqual({ data_base64: toBase64(new Uint8Array([0x03])) });
  });

  it('resizes, signals, and kills', async () => {
    const { client, http } = testClient([
      jsonResponse({ success: true }),
      jsonResponse({ success: true }),
      jsonResponse({ success: true }),
    ]);

    expect(await client.runtime.pty.resize(RUNTIME_ID, SESSION_ID, 100, 30)).toBe(true);
    expect(http.jsonBody(0)).toEqual({ cols: 100, rows: 30 });

    expect(await client.runtime.pty.sendSignal(RUNTIME_ID, SESSION_ID, ' INT ')).toBe(true);
    expect(http.jsonBody(1)).toEqual({ signal: 'INT' });

    expect(await client.runtime.pty.kill(RUNTIME_ID, SESSION_ID)).toBe(true);
    expect(http.requests[2]?.method).toBe('DELETE');
  });

  it('validates geometry and identifiers', async () => {
    const { client, http } = testClient([jsonResponse({})]);

    await expectRejection(
      client.runtime.pty.resize(RUNTIME_ID, SESSION_ID, 0, 24),
      GravixLayerInvalidArgumentError,
    );
    await expectRejection(client.runtime.pty.get(RUNTIME_ID, ''), GravixLayerInvalidArgumentError);
    expect(http.requests).toHaveLength(0);
  });

  it('decodes streamed output from base64', async () => {
    const { client } = testClient([
      sseJson([
        { type: 'data', data: toBase64(utf8Encode('hello ')) },
        { type: 'data', data: toBase64(utf8Encode('world')) },
        { type: 'exit', exit_code: 0, status: 'exited' },
      ]),
    ]);

    const events = await collect(client.runtime.pty.stream(RUNTIME_ID, SESSION_ID));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'data' });
    expect(events[2]).toEqual({ type: 'exit', exitCode: 0, status: 'exited' });
  });
});

describe('terminal handle', () => {
  it('buffers output and reports the exit status', async () => {
    const { client } = testClient([
      jsonResponse(sessionPayload()),
      sseJson([
        { type: 'data', data: toBase64(utf8Encode('$ echo hi\n')) },
        { type: 'data', data: toBase64(utf8Encode('hi\n')) },
        { type: 'exit', exit_code: 0, status: 'exited' },
      ]),
    ]);

    const session = await client.runtime.pty.create(RUNTIME_ID);
    const onData = vi.fn();
    const handle = client.runtime.pty.handle(RUNTIME_ID, session.sessionId).connect({ onData });

    // Let the background pump drain the stream.
    await vi.waitFor(() => expect(handle.exitCode).toBe(0));

    expect(handle.text).toBe('$ echo hi\nhi\n');
    expect(onData).toHaveBeenCalledTimes(2);
    expect(handle.isConnected).toBe(false);
  });

  it('drops the oldest output once the buffer is full', async () => {
    const big = 'x'.repeat(PTY_BUFFER_LIMIT_BYTES);
    const { client } = testClient([
      sseJson([
        { type: 'data', data: toBase64(utf8Encode(big)) },
        { type: 'data', data: toBase64(utf8Encode('tail')) },
        { type: 'exit', exit_code: 0, status: 'exited' },
      ]),
    ]);

    const handle = client.runtime.pty.handle(RUNTIME_ID, SESSION_ID).connect();
    await vi.waitFor(() => expect(handle.exitCode).toBe(0));

    expect(handle.text).toBe('tail');
  });

  it('records a stream-level error', async () => {
    const { client } = testClient([sseJson([{ type: 'error', message: 'session gone' }])]);

    const handle = client.runtime.pty.handle(RUNTIME_ID, SESSION_ID).connect();
    await vi.waitFor(() => expect(handle.error).toBe('session gone'));
  });

  it('detaches without treating the abort as a failure', async () => {
    // A stream that stays open until the request is aborted, which is what a
    // live terminal looks like while the shell sits at a prompt.
    const { client } = testClient([], {
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener('abort', () => {
                controller.error(new DOMException('aborted', 'AbortError'));
              });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });

    const handle = client.runtime.pty.handle(RUNTIME_ID, SESSION_ID).connect();
    expect(handle.isConnected).toBe(true);

    await handle.disconnect();
    expect(handle.isConnected).toBe(false);
    expect(handle.error).toBeUndefined();
  });

  it('returns the session once it stops running', async () => {
    const { client } = testClient([jsonResponse(sessionPayload({ status: 'exited' }))]);
    const session = await client.runtime.pty.handle(RUNTIME_ID, SESSION_ID).waitForExit(1000);
    expect(session.status).toBe('exited');
  });

  it('waits on the attached stream instead of polling', async () => {
    const { client, http } = testClient([
      sseJson([{ type: 'exit', exit_code: 3, status: 'exited' }]),
      // The one request the wait is allowed to make: reading the final state.
      jsonResponse(sessionPayload({ status: 'running', exit_code: 0 })),
    ]);

    const handle = client.runtime.pty.handle(RUNTIME_ID, SESSION_ID).connect();
    const session = await handle.waitForExit(5000);

    expect(http.requests).toHaveLength(2);
    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(3);
  });

  it('gives up with a timeout error when the shell keeps running', async () => {
    const { client } = testClient([jsonResponse(sessionPayload()), jsonResponse(sessionPayload())]);

    await expectRejection(
      client.runtime.pty.handle(RUNTIME_ID, SESSION_ID).waitForExit(0),
      GravixLayerTimeoutError,
    );
  });
});

describe('git', () => {
  const OK = { success: true, exit_code: 0, stdout: 'done', stderr: '', error: '' };

  it('clones with options', async () => {
    const { client, http } = testClient([jsonResponse(OK)]);
    const result = await client.runtime.git.clone(
      RUNTIME_ID,
      'https://example.test/repo.git',
      '/workspace/repo',
      { branch: 'main', depth: 1, authToken: 'secret' },
    );

    expect(http.last().url).toContain(`/runtime/${RUNTIME_ID}/git/clone`);
    expect(http.jsonBody()).toEqual({
      url: 'https://example.test/repo.git',
      path: '/workspace/repo',
      branch: 'main',
      depth: 1,
      auth_token: 'secret',
    });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('done');
  });

  it('maps each operation to its endpoint and body', async () => {
    const { client, http } = testClient([jsonResponse(OK)]);
    const repo = '/workspace/repo';

    await client.runtime.git.status(RUNTIME_ID, repo);
    expect(http.last().url).toContain('/git/status');
    expect(http.jsonBody()).toEqual({ repository_path: repo });

    await client.runtime.git.branchList(RUNTIME_ID, repo, 'all');
    expect(http.last().url).toContain('/git/branches');
    expect(http.jsonBody()).toEqual({ repository_path: repo, scope: 'all' });

    await client.runtime.git.checkout(RUNTIME_ID, repo, 'feature');
    expect(http.last().url).toContain('/git/checkout');
    expect(http.jsonBody()).toEqual({ repository_path: repo, ref_name: 'feature' });

    await client.runtime.git.pull(RUNTIME_ID, repo, { remote: 'origin', branch: 'main' });
    expect(http.jsonBody()).toEqual({
      repository_path: repo,
      remote: 'origin',
      branch: 'main',
    });

    await client.runtime.git.fetch(RUNTIME_ID, repo, { remote: 'upstream' });
    expect(http.jsonBody()).toEqual({ repository_path: repo, remote: 'upstream' });

    await client.runtime.git.push(RUNTIME_ID, repo, { refspec: 'HEAD:main', authToken: 't' });
    expect(http.jsonBody()).toEqual({
      repository_path: repo,
      refspec: 'HEAD:main',
      auth_token: 't',
    });

    await client.runtime.git.add(RUNTIME_ID, repo, ['a.ts', 'b.ts']);
    expect(http.jsonBody()).toEqual({ repository_path: repo, paths: ['a.ts', 'b.ts'] });

    await client.runtime.git.commit(RUNTIME_ID, repo, 'first', {
      authorName: 'Ada',
      authorEmail: 'ada@example.test',
    });
    expect(http.jsonBody()).toEqual({
      repository_path: repo,
      message: 'first',
      author_name: 'Ada',
      author_email: 'ada@example.test',
    });

    await client.runtime.git.createBranch(RUNTIME_ID, repo, 'feature', 'main');
    expect(http.last().url).toContain('/git/branch/create');
    expect(http.jsonBody()).toEqual({
      repository_path: repo,
      branch_name: 'feature',
      start_point: 'main',
    });

    await client.runtime.git.deleteBranch(RUNTIME_ID, repo, 'feature', true);
    expect(http.last().url).toContain('/git/branch/delete');
    expect(http.jsonBody()).toEqual({
      repository_path: repo,
      branch_name: 'feature',
      force: true,
    });
  });

  it('reports a failed git command rather than throwing', async () => {
    const { client } = testClient([
      jsonResponse({ success: false, exit_code: 128, stderr: 'not a repository' }),
    ]);
    const result = await client.runtime.git.status(RUNTIME_ID, '/tmp');

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toBe('not a repository');
  });

  it('validates its arguments', async () => {
    const { client, http } = testClient([jsonResponse(OK)]);

    await expectRejection(
      client.runtime.git.clone(RUNTIME_ID, '', '/repo'),
      GravixLayerInvalidArgumentError,
    );
    await expectRejection(
      client.runtime.git.commit(RUNTIME_ID, '/repo', ''),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });
});

describe('published services', () => {
  const SERVICE = {
    runtime_id: RUNTIME_ID,
    port: 8000,
    web_url: 'https://svc.example.test',
    expires_at: '2026-01-01T01:00:00Z',
    is_public: false,
    token: 'tok-1',
  };

  /** Answer the publish call with a service, then hand later calls to `next`. */
  function reply(next: FetchLike): FetchLike {
    let served = false;
    return async (url, init) => {
      if (served) return next(url, init);
      served = true;
      return jsonResponse(SERVICE);
    };
  }

  /** A request that never completes until it is aborted. */
  const hang: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

  it('publishes a port with sensible defaults', async () => {
    const { client, http } = testClient([jsonResponse(SERVICE)]);
    const service = await client.runtime.service.publish(RUNTIME_ID, 8000);

    expect(http.jsonBody()).toEqual({
      port: 8000,
      expires_in_seconds: 3600,
      is_public: false,
      rotate_token: false,
    });
    expect(service.url).toBe('https://svc.example.test');
    expect(service.serviceUrl).toBe('https://svc.example.test/');
  });

  it('passes publishing options through', async () => {
    const { client, http } = testClient([jsonResponse(SERVICE)]);
    await client.runtime.service.publish(RUNTIME_ID, 8000, {
      expiresInSeconds: 60,
      isPublic: true,
      rotateToken: true,
    });

    expect(http.jsonBody()).toEqual({
      port: 8000,
      expires_in_seconds: 60,
      is_public: true,
      rotate_token: true,
    });
  });

  it('lists and revokes', async () => {
    const { client, http } = testClient([jsonResponse({ services: [SERVICE] }), emptyResponse()]);

    expect(await client.runtime.service.list(RUNTIME_ID)).toHaveLength(1);

    await client.runtime.service.revoke(RUNTIME_ID, 8000);
    expect(http.last().method).toBe('DELETE');
    expect(http.last().url).toContain('/services/8000');
  });

  it('rejects a port outside the valid range', async () => {
    const { client } = testClient([jsonResponse(SERVICE)]);
    await expectRejection(
      client.runtime.service.publish(RUNTIME_ID, 70000),
      GravixLayerInvalidArgumentError,
    );
  });

  it('attaches the access token to calls on the published URL', async () => {
    const http = mockFetch([jsonResponse(SERVICE), jsonResponse({ ok: true })]);
    const { client } = testClient([], { fetch: http.fetch });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    await handle.get('/health');

    expect(http.last().url).toBe('https://svc.example.test/health');
    expect(http.last().headers['x-gravix-web-service-token']).toBe('tok-1');
  });

  it('omits the token for a public service', async () => {
    const http = mockFetch([
      jsonResponse({ ...SERVICE, is_public: true }),
      jsonResponse({ ok: true }),
    ]);
    const { client } = testClient([], { fetch: http.fetch });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    await handle.get('/');

    expect(http.last().headers['x-gravix-web-service-token']).toBeUndefined();
  });

  it('posts JSON and parses the reply', async () => {
    const http = mockFetch([jsonResponse(SERVICE), jsonResponse({ echoed: true })]);
    const { client } = testClient([], { fetch: http.fetch });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    const body = await handle.postJson<{ echoed: boolean }>('/echo', { a: 1 });

    expect(body).toEqual({ echoed: true });
    expect(http.last().headers['content-type']).toBe('application/json');
    expect(http.last().body).toBe('{"a":1}');
  });

  it('keeps a base path when one is present', async () => {
    const http = mockFetch([
      jsonResponse({ ...SERVICE, service_url: 'https://svc.example.test/app/' }),
      jsonResponse({}),
    ]);
    const { client } = testClient([], { fetch: http.fetch });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    await handle.get('status');

    expect(http.last().url).toBe('https://svc.example.test/app/status');
  });

  it('hands back an error status rather than throwing', async () => {
    const http = mockFetch([jsonResponse(SERVICE), errorResponse(503, 'starting up')]);
    const { client } = testClient([], { fetch: http.fetch });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    const response = await handle.get('/health');

    expect(response.status).toBe(503);
  });

  it('turns a failed JSON call into a typed error', async () => {
    const http = mockFetch([jsonResponse(SERVICE), errorResponse(500, 'boom')]);
    const { client } = testClient([], { fetch: http.fetch });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    const error = await expectRejection(handle.postJson('/echo', {}), GravixLayerServerError);

    expect(error.status).toBe(500);
  });

  it('reports a reply that is not JSON rather than leaking a parse error', async () => {
    const http = mockFetch([jsonResponse(SERVICE), new Response('<html>hi</html>')]);
    const { client } = testClient([], { fetch: http.fetch });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    const error = await expectRejection(handle.postJson('/echo', {}), GravixLayerError);

    expect(error.message).toMatch(/malformed JSON/);
  });

  it('sends each verb through to the service', async () => {
    const http = mockFetch([jsonResponse(SERVICE), jsonResponse({})]);
    const { client } = testClient([], { fetch: http.fetch });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    await handle.post('/items');
    await handle.put('/items/1');
    await handle.patch('/items/1');
    await handle.delete('/items/1');

    expect(http.requests.slice(1).map((request) => request.method)).toEqual([
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
    ]);
  });

  it('reports a service that cannot be reached as a connection error', async () => {
    const { client } = testClient([], {
      fetch: reply(async () => {
        throw new TypeError('fetch failed');
      }),
    });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    await expectRejection(handle.get('/health'), GravixLayerConnectionError);
  });

  it('gives up on a slow service with a timeout error', async () => {
    const { client } = testClient([], { fetch: reply(hang) });

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    const error = await expectRejection(
      handle.get('/health', { timeout: 5 }),
      GravixLayerTimeoutError,
    );

    expect(error.message).toMatch(/5ms/);
  });

  it('surfaces the caller cancelling as an abort', async () => {
    const { client } = testClient([], { fetch: reply(hang) });
    const controller = new AbortController();

    const handle = await client.runtime.service.connect(RUNTIME_ID, 8000);
    const pending = handle.get('/health', { signal: controller.signal });
    controller.abort();

    await expectRejection(pending, GravixLayerAbortError);
  });
});
