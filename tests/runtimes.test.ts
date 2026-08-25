import { describe, expect, it, vi } from 'vitest';

import { Execution, GravixLayerError, GravixLayerInvalidArgumentError } from '../src/index.js';
import {
  collect,
  emptyResponse,
  errorResponse,
  expectRejection,
  jsonResponse,
  runtimePayload,
  RUNTIME_ID,
  sseJson,
  testClient,
} from './helpers.js';

describe('create', () => {
  it('sends the default template with the client cloud and region', async () => {
    const { client, http } = testClient([jsonResponse(runtimePayload())]);
    const runtime = await client.runtime.create();

    expect(http.last().method).toBe('POST');
    expect(http.last().url).toBe('https://api.test.invalid/v1/agents/runtime');
    expect(http.jsonBody()).toEqual({
      cloud: 'aws',
      region: 'us-east-1',
      template: 'base-small',
    });
    expect(runtime.runtimeId).toBe(RUNTIME_ID);
    expect(runtime.status).toBe('running');
  });

  it('passes every creation option through in wire format', async () => {
    const { client, http } = testClient([jsonResponse(runtimePayload())]);
    await client.runtime.create({
      template: 'node-20',
      cloud: 'gcp',
      region: 'europe-west1',
      timeoutSeconds: 600,
      envVars: { NODE_ENV: 'production' },
      metadata: { owner: 'billing' },
      internetAccess: false,
      agentId: 'agent-1',
      providers: ['prov-1'],
      networkPolicyIds: ['pol-1'],
    });

    expect(http.jsonBody()).toEqual({
      cloud: 'gcp',
      region: 'europe-west1',
      template: 'node-20',
      timeout: 600,
      env_vars: { NODE_ENV: 'production' },
      metadata: { owner: 'billing' },
      internet_access: false,
      agent_id: 'agent-1',
      providers: ['prov-1'],
      network_policy_ids: ['pol-1'],
    });
  });

  it('sends a snapshot instead of a template', async () => {
    const { client, http } = testClient([jsonResponse(runtimePayload())]);
    await client.runtime.create({ snapshot: 'ml-ready' });

    const body = http.jsonBody() as Record<string, unknown>;
    expect(body['snapshot']).toBe('ml-ready');
    expect(body).not.toHaveProperty('template');
  });

  it('rejects a snapshot combined with an explicit template', async () => {
    const { client } = testClient([jsonResponse(runtimePayload())]);
    await expectRejection(
      client.runtime.create({ snapshot: 'ml-ready', template: 'node-20' }),
      GravixLayerInvalidArgumentError,
    );
  });

  it('allows a snapshot alongside the default template value', async () => {
    const { client } = testClient([jsonResponse(runtimePayload())]);
    await expect(
      client.runtime.create({ snapshot: 'ml-ready', template: 'base-small' }),
    ).resolves.toBeDefined();
  });

  it('rejects a non-positive timeout before sending anything', async () => {
    const { client, http } = testClient([jsonResponse(runtimePayload())]);
    await expectRejection(
      client.runtime.create({ timeoutSeconds: 0 }),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });

  it('falls back to the requested template when the API omits it', async () => {
    const { client } = testClient([jsonResponse({ runtime_id: RUNTIME_ID, status: 'running' })]);
    const runtime = await client.runtime.create({ template: 'node-20' });
    expect(runtime.template).toBe('node-20');
  });
});

describe('lifecycle', () => {
  it('lists runtimes with pagination', async () => {
    const { client, http } = testClient([jsonResponse({ runtimes: [runtimePayload()], total: 1 })]);
    const result = await client.runtime.list({ limit: 10, offset: 20 });

    expect(http.query().get('limit')).toBe('10');
    expect(http.query().get('offset')).toBe('20');
    expect(result.total).toBe(1);
    expect(result.runtimes[0]?.runtimeId).toBe(RUNTIME_ID);
  });

  it('derives the total when the API omits it', async () => {
    const { client } = testClient([jsonResponse({ runtimes: [runtimePayload()] })]);
    expect((await client.runtime.list()).total).toBe(1);
  });

  it('retrieves a runtime as plain information', async () => {
    const { client } = testClient([jsonResponse(runtimePayload({ status: 'paused' }))]);
    const info = await client.runtime.retrieve(RUNTIME_ID);

    expect(info.status).toBe('paused');
    expect(info.cpuCount).toBe(2);
    expect(info.memoryMb).toBe(2048);
  });

  it('connects by confirming the runtime then fetching it', async () => {
    const { client, http } = testClient([emptyResponse(), jsonResponse(runtimePayload())]);
    const runtime = await client.runtime.connect(RUNTIME_ID);

    expect(http.requests[0]?.url).toContain(`/runtime/${RUNTIME_ID}/connect`);
    expect(http.requests[0]?.method).toBe('POST');
    expect(http.requests[1]?.method).toBe('GET');
    expect(runtime.runtimeId).toBe(RUNTIME_ID);
  });

  it('kills a runtime', async () => {
    const { client, http } = testClient([jsonResponse({ message: 'terminated' })]);
    const result = await client.runtime.kill(RUNTIME_ID);

    expect(http.last().method).toBe('DELETE');
    expect(result).toEqual({ message: 'terminated', runtimeId: RUNTIME_ID });
  });

  it('pauses and resumes', async () => {
    const { client, http } = testClient([emptyResponse(), emptyResponse()]);
    await client.runtime.pause(RUNTIME_ID);
    await client.runtime.resume(RUNTIME_ID);

    expect(http.requests[0]?.url).toContain('/pause');
    expect(http.requests[1]?.url).toContain('/resume');
  });

  it('extends the timeout', async () => {
    const { client, http } = testClient([
      jsonResponse({ message: 'ok', timeout: 300, timeout_at: '2026-01-01T01:00:00Z' }),
    ]);
    const result = await client.runtime.setTimeout(RUNTIME_ID, 300);

    expect(http.jsonBody()).toEqual({ timeout: 300 });
    expect(result.timeout).toBe(300);
    expect(result.timeoutAt).toBe('2026-01-01T01:00:00Z');
  });

  it('reads metrics', async () => {
    const { client } = testClient([
      jsonResponse({
        timestamp: '2026-01-01T00:00:00Z',
        cpu_usage: 12.5,
        memory_usage: 536_870_912,
        memory_total: 2_147_483_648,
        disk_read: 1024,
        disk_write: 2048,
        network_rx: 100,
        network_tx: 200,
      }),
    ]);
    const metrics = await client.runtime.getMetrics(RUNTIME_ID);

    expect(metrics.cpuUsage).toBe(12.5);
    expect(metrics.memoryUsage).toBe(536_870_912);
    expect(metrics.networkTx).toBe(200);
  });

  it('validates the runtime id before any request', async () => {
    const { client, http } = testClient([jsonResponse({})]);

    await expectRejection(client.runtime.retrieve('nope'), GravixLayerInvalidArgumentError);
    await expectRejection(client.runtime.kill('nope'), GravixLayerInvalidArgumentError);
    await expectRejection(client.runtime.pause('nope'), GravixLayerInvalidArgumentError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('SSH', () => {
  it('enables SSH and returns connection details', async () => {
    const { client, http } = testClient([
      jsonResponse({
        host: 'ssh.example',
        port: 2222,
        username: 'user',
        private_key: 'KEY',
        connect_cmd: 'ssh user@ssh.example -p 2222',
      }),
    ]);
    const info = await client.runtime.enableSsh(RUNTIME_ID);

    expect(http.last().url).toContain('/ssh/enable');
    expect(info.enabled).toBe(true);
    expect(info.runtimeId).toBe(RUNTIME_ID);
    expect(info.port).toBe(2222);
    expect(info.privateKey).toBe('KEY');
    expect(info.connectCmd).toContain('ssh user@ssh.example');
  });

  it('asks for a fresh key pair', async () => {
    const { client, http } = testClient([jsonResponse({ host: 'ssh.example', port: 22 })]);
    await client.runtime.enableSsh(RUNTIME_ID, { regenerateKeys: true });
    expect(http.query().get('regenerate_keys')).toBe('true');
  });

  it('disables SSH and reports status', async () => {
    const { client, http } = testClient([
      emptyResponse(),
      jsonResponse({ enabled: true, daemon_running: true, port: 2222, username: 'user' }),
    ]);

    await client.runtime.disableSsh(RUNTIME_ID);
    expect(http.requests[0]?.url).toContain('/ssh/disable');

    const status = await client.runtime.sshStatus(RUNTIME_ID);
    expect(status.enabled).toBe(true);
    expect(status.daemonRunning).toBe(true);
    expect(status.runtimeId).toBe(RUNTIME_ID);
  });
});

describe('commands', () => {
  it('runs a command and returns its output', async () => {
    const { client, http } = testClient([
      jsonResponse({ stdout: 'v20.11.0\n', stderr: '', exit_code: 0, duration_ms: 12 }),
    ]);
    const result = await client.runtime.runCmd(RUNTIME_ID, 'node -v');

    expect(http.last().url).toContain('/commands/run');
    expect(http.jsonBody()).toEqual({ command: 'node -v' });
    expect(result.stdout).toBe('v20.11.0\n');
    expect(result.success).toBe(true);
  });

  it('reports a non-zero exit code instead of throwing', async () => {
    const { client } = testClient([
      jsonResponse({ stdout: '', stderr: 'not found', exit_code: 127 }),
    ]);
    const result = await client.runtime.runCmd(RUNTIME_ID, 'nope');

    expect(result.exitCode).toBe(127);
    expect(result.success).toBe(false);
  });

  it('converts the command timeout to milliseconds', async () => {
    const { client, http } = testClient([jsonResponse({ stdout: '', exit_code: 0 })]);
    await client.runtime.runCmd(RUNTIME_ID, 'sleep 1', {
      timeoutSeconds: 30,
      args: ['--flag'],
      workingDir: '/tmp',
      environment: { A: '1' },
    });

    expect(http.jsonBody()).toEqual({
      command: 'sleep 1',
      args: ['--flag'],
      working_dir: '/tmp',
      environment: { A: '1' },
      timeout: 30_000,
    });
  });

  it('rejects an empty command', async () => {
    const { client } = testClient([jsonResponse({})]);
    await expectRejection(
      client.runtime.runCmd(RUNTIME_ID, '   '),
      GravixLayerInvalidArgumentError,
    );
  });

  it('switches to streaming when a callback is supplied', async () => {
    const { client, http } = testClient([
      sseJson([
        { type: 'stdout', data: 'one\n' },
        { type: 'stderr', data: 'warn\n' },
        { type: 'end', exit_code: 0 },
      ]),
    ]);

    const onStdout = vi.fn();
    const onExit = vi.fn();
    const result = await client.runtime.runCmd(RUNTIME_ID, 'build', { onStdout, onExit });

    expect(http.query().get('stream')).toBe('true');
    expect(http.last().headers['accept']).toBe('text/event-stream');
    expect(http.last().headers['accept-encoding']).toBe('identity');
    expect(http.last().headers['cache-control']).toBe('no-cache');
    expect(onStdout).toHaveBeenCalledWith('one\n');
    expect(onExit).toHaveBeenCalledWith(0);
    expect(result.stdout).toBe('one\n');
    expect(result.stderr).toBe('warn\n');
    expect(result.success).toBe(true);
  });

  it('turns a stream-level error into a failed result', async () => {
    const { client } = testClient([sseJson([{ type: 'error', message: 'the guest went away' }])]);
    const result = await client.runtime.runCmd(RUNTIME_ID, 'build', { onStdout: vi.fn() });

    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
    expect(result.stderr).toBe('the guest went away');
  });

  it('iterates command events', async () => {
    const { client } = testClient([
      sseJson([
        { type: 'stdout', data: 'a' },
        { type: 'stdout', data: 'b' },
        { type: 'end', exit_code: 3 },
      ]),
    ]);

    const events = await collect(client.runtime.streamCmd(RUNTIME_ID, 'build'));
    expect(events).toEqual([
      { type: 'stdout', data: 'a' },
      { type: 'stdout', data: 'b' },
      { type: 'end', exitCode: 3 },
    ]);
  });

  it('ignores frames it does not recognise', async () => {
    const { client } = testClient([
      sseJson([
        { type: 'heartbeat' },
        { type: 'stdout', data: 'x' },
        { type: 'end', exit_code: 0 },
      ]),
    ]);
    const events = await collect(client.runtime.streamCmd(RUNTIME_ID, 'build'));
    expect(events.map((event) => event.type)).toEqual(['stdout', 'end']);
  });
});

describe('code', () => {
  it('runs code and returns logs and results', async () => {
    const { client, http } = testClient([
      jsonResponse({
        results: [{ text: '1024' }],
        logs: { stdout: ['1024\n'], stderr: [] },
      }),
    ]);
    const result = await client.runtime.runCode(RUNTIME_ID, 'print(2 ** 10)');

    expect(http.last().url).toContain('/code/run');
    expect(http.jsonBody()).toEqual({ code: 'print(2 ** 10)', language: 'python' });
    expect(result.logs.stdout).toEqual(['1024\n']);
    expect(result.results[0]?.text).toBe('1024');
  });

  it('keeps the code timeout in seconds', async () => {
    const { client, http } = testClient([jsonResponse({})]);
    await client.runtime.runCode(RUNTIME_ID, 'x = 1', {
      language: 'javascript',
      contextId: 'ctx-1',
      environment: { A: '1' },
      timeoutSeconds: 45,
    });

    expect(http.jsonBody()).toEqual({
      code: 'x = 1',
      language: 'javascript',
      context_id: 'ctx-1',
      environment: { A: '1' },
      timeout: 45,
    });
  });

  it('surfaces an exception raised by the code', async () => {
    const { client } = testClient([
      jsonResponse({
        results: [],
        logs: { stdout: [], stderr: [] },
        error: { name: 'ValueError', value: 'bad input', traceback: 'Traceback...' },
      }),
    ]);
    const result = await client.runtime.runCode(RUNTIME_ID, 'raise ValueError()');

    expect(result.error?.name).toBe('ValueError');
    expect(result.error?.value).toBe('bad input');
  });

  it('accepts an error returned as a bare string', async () => {
    const { client } = testClient([jsonResponse({ error: 'kernel died' })]);
    const result = await client.runtime.runCode(RUNTIME_ID, 'x');
    expect(result.error).toEqual({ name: '', value: 'kernel died', traceback: '' });
  });

  it('streams code output through callbacks', async () => {
    const { client } = testClient([
      sseJson([
        { type: 'stdout', text: 'working\n' },
        { type: 'result', result: { text: '42', png: 'AAA' } },
        { type: 'end' },
      ]),
    ]);

    const onStdout = vi.fn();
    const onResult = vi.fn();
    const result = await client.runtime.runCode(RUNTIME_ID, 'compute()', { onStdout, onResult });

    expect(onStdout).toHaveBeenCalledWith('working\n');
    expect(onResult).toHaveBeenCalledOnce();
    expect(result.logs.stdout).toEqual(['working\n']);
    expect(result.results[0]?.png).toBe('AAA');
  });

  it('iterates code events, including a structured error', async () => {
    const { client } = testClient([
      sseJson([
        { type: 'stderr', text: 'oops' },
        { type: 'error', error: { name: 'RuntimeError', value: 'boom' } },
        { type: 'end' },
      ]),
    ]);

    const events = await collect(client.runtime.streamCode(RUNTIME_ID, 'boom()'));
    expect(events[0]).toEqual({ type: 'stderr', text: 'oops' });
    expect(events[1]).toEqual({
      type: 'error',
      error: { name: 'RuntimeError', value: 'boom', traceback: '' },
    });
    expect(events[2]).toEqual({ type: 'end' });
  });
});

describe('code contexts', () => {
  it('creates a context', async () => {
    const { client, http } = testClient([
      jsonResponse({ id: 'ctx-1', language: 'python', cwd: '/workspace' }),
    ]);
    const context = await client.runtime.createContext(RUNTIME_ID, { cwd: '/workspace' });

    expect(http.jsonBody()).toEqual({ language: 'python', cwd: '/workspace' });
    expect(context).toEqual({ contextId: 'ctx-1', language: 'python', cwd: '/workspace' });
  });

  it('reads and deletes a context', async () => {
    const { client, http } = testClient([
      jsonResponse({ context_id: 'ctx-1', language: 'python' }),
      jsonResponse({ message: 'deleted' }),
    ]);

    const context = await client.runtime.getContext(RUNTIME_ID, 'ctx-1');
    expect(context.contextId).toBe('ctx-1');
    expect(context.cwd).toBe('/workspace');

    const deleted = await client.runtime.deleteContext(RUNTIME_ID, 'ctx-1');
    expect(http.last().method).toBe('DELETE');
    expect(deleted).toEqual({ message: 'deleted', contextId: 'ctx-1' });
  });

  it('rejects an empty context id', async () => {
    const { client } = testClient([jsonResponse({})]);
    await expectRejection(
      client.runtime.getContext(RUNTIME_ID, ''),
      GravixLayerInvalidArgumentError,
    );
  });
});

describe('runtime templates', () => {
  it('lists the templates a runtime can boot from', async () => {
    const { client, http } = testClient([
      jsonResponse({
        templates: [{ id: 'tpl-1', name: 'base-small', vcpu_count: 2, memory_mb: 2048 }],
        limit: 100,
        offset: 0,
      }),
    ]);
    const result = await client.runtime.templates.list();

    expect(http.query().get('kind')).toBe('sandbox');
    expect(result.templates[0]?.id).toBe('tpl-1');
    expect(result.templates[0]?.name).toBe('base-small');
    expect(result.templates[0]?.visibility).toBe('private');
  });
});

describe('runtime handle', () => {
  it('applies its own id to every call', async () => {
    const { client, http } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ stdout: 'hi\n', exit_code: 0 }),
      jsonResponse({ message: 'written', path: '/tmp/a.txt' }),
    ]);

    const runtime = await client.runtime.create();
    await runtime.runCmd('echo hi');
    await runtime.file.write('/tmp/a.txt', 'contents');

    expect(http.requests[1]?.url).toContain(`/runtime/${RUNTIME_ID}/commands/run`);
    expect(http.requests[2]?.url).toContain(`/runtime/${RUNTIME_ID}/files/write`);
  });

  it('wraps results in a unified execution view', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ stdout: 'out', stderr: 'err', exit_code: 0, duration_ms: 5 }),
    ]);

    const runtime = await client.runtime.create();
    const execution = await runtime.runCmd('echo out');

    expect(execution).toBeInstanceOf(Execution);
    expect(execution.stdout).toBe('out');
    expect(execution.text).toBe('out');
    expect(execution.success).toBe(true);
    expect(execution.durationMs).toBe(5);
    expect(execution.results).toEqual([]);
  });

  it('presents a code execution through the same view', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ results: [{ text: '42' }], logs: { stdout: ['printed\n'], stderr: [] } }),
    ]);

    const runtime = await client.runtime.create();
    const execution = await runtime.runCode('42');

    expect(execution.text).toBe('42');
    expect(execution.stdout).toBe('printed\n');
    expect(execution.exitCode).toBe(0);
    expect(execution.success).toBe(true);
  });

  it('puts the newlines back between code output lines', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({
        results: [],
        logs: { stdout: ['{', '  "ok": true', '}'], stderr: ['Traceback:', '  line 1'] },
      }),
    ]);

    const runtime = await client.runtime.create();
    const execution = await runtime.runCode('print("{}")');

    // The API reports one line per entry with the newline stripped. Joining
    // them with nothing glues the lines together and silently mangles any
    // multi-line output the code printed.
    expect(execution.stdout).toBe('{\n  "ok": true\n}');
    expect(execution.stderr).toBe('Traceback:\n  line 1');
  });

  it('reports command output as lines too', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ stdout: 'one\ntwo', stderr: '', exit_code: 0, duration_ms: 1 }),
    ]);

    const runtime = await client.runtime.create();
    const execution = await runtime.runCmd('printf "one\\ntwo"');

    expect(execution.logs.stdout).toEqual(['one', 'two']);
    expect(execution.logs.stderr).toEqual([]);
  });

  it('refreshes cached state', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse(runtimePayload({ status: 'paused' })),
    ]);

    const runtime = await client.runtime.create();
    expect(runtime.status).toBe('running');

    await runtime.refresh();
    expect(runtime.status).toBe('paused');
  });

  it('reports liveness without throwing when the runtime is gone', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      new Response('gone', { status: 404 }),
    ]);

    const runtime = await client.runtime.create();
    await expect(runtime.isAlive()).resolves.toBe(false);
  });

  it('kills once and then refuses further work', async () => {
    const { client, http } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ message: 'terminated' }),
    ]);

    const runtime = await client.runtime.create();
    await runtime.kill();
    await runtime.kill();

    expect(http.requests).toHaveLength(2);
    expect(runtime.status).toBe('terminated');
    await expect(runtime.isAlive()).resolves.toBe(false);
    await expectRejection(runtime.runCmd('ls'), GravixLayerInvalidArgumentError);
    await expectRejection(runtime.file.read('/tmp/a'), GravixLayerInvalidArgumentError);
  });

  it('stays usable when stopping fails, so the caller can retry', async () => {
    const { client } = testClient([
      jsonResponse(runtimePayload()),
      errorResponse(503, 'try again'),
      jsonResponse({ message: 'terminated' }),
    ]);

    const runtime = await client.runtime.create();

    await expect(runtime.kill()).rejects.toBeInstanceOf(GravixLayerError);
    expect(runtime.status).not.toBe('terminated');

    await runtime.kill();
    expect(runtime.status).toBe('terminated');
  });

  it('collapses concurrent stop requests into one', async () => {
    const { client, http } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ message: 'terminated' }),
    ]);

    const runtime = await client.runtime.create();
    await Promise.all([runtime.kill(), runtime.kill(), runtime.kill()]);

    expect(http.requests).toHaveLength(2);
  });

  it('stops the runtime when an `await using` block exits', async () => {
    const { client, http } = testClient([
      jsonResponse(runtimePayload()),
      jsonResponse({ message: 'terminated' }),
    ]);

    {
      await using runtime = await client.runtime.create();
      expect(runtime.runtimeId).toBe(RUNTIME_ID);
    }

    expect(http.requests).toHaveLength(2);
    expect(http.last().method).toBe('DELETE');
  });
});
