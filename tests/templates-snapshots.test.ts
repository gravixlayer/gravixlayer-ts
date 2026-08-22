import { describe, expect, it, vi } from 'vitest';

import {
  GravixLayerInvalidArgumentError,
  SnapshotKind,
  TemplateBuildError,
  TemplateBuilder,
  TemplateBuildTimeoutError,
  isSuccessfulBuildState,
  isTerminalBuildState,
} from '../src/index.js';
import { fromBase64, utf8Decode } from '../src/core/binary.js';
import { RUNTIME_ID, emptyResponse, expectRejection, jsonResponse, testClient } from './helpers.js';

interface Step {
  type: string;
  args: string[];
  content?: string;
  options?: Record<string, string>;
}

/** The build steps a builder serialized. */
function steps(builder: TemplateBuilder): Step[] {
  return (builder.toJSON()['build_steps'] as Step[] | undefined) ?? [];
}

describe('describing a template', () => {
  it('requires a name', () => {
    expect(() => new TemplateBuilder('')).toThrow(GravixLayerInvalidArgumentError);
    expect(() => new TemplateBuilder('   ')).toThrow(GravixLayerInvalidArgumentError);
  });

  it('applies sensible resource defaults', () => {
    expect(new TemplateBuilder('base').toJSON()).toEqual({
      name: 'base',
      vcpu_count: 2,
      memory_mb: 1024,
      disk_mb: 4096,
    });
  });

  it('chains and keeps steps in the order they were added', () => {
    const builder = new TemplateBuilder('data-science', 'For notebooks')
      .fromImage('python:3.12-slim')
      .vcpu(4)
      .memory(4096)
      .disk(20480)
      .aptInstall('git', 'curl')
      .pipInstall('pandas')
      .npmInstall('typescript')
      .bunInstall('hono')
      .run('echo hello')
      .mkdir('/data', '0755')
      .env('STAGE', 'test')
      .envs({ REGION: 'local' })
      .tags({ team: 'research' })
      .startCmd('python -m http.server 8080')
      .readyCmd(TemplateBuilder.waitForPort(8080), 30);

    const payload = builder.toJSON();
    expect(payload).toMatchObject({
      name: 'data-science',
      description: 'For notebooks',
      docker_image: 'python:3.12-slim',
      vcpu_count: 4,
      memory_mb: 4096,
      disk_mb: 20480,
      start_cmd: 'python -m http.server 8080',
      ready_cmd: 'ss -tuln | grep -q :8080',
      ready_timeout_secs: 30,
      environment: { STAGE: 'test', REGION: 'local' },
      tags: { team: 'research' },
    });

    expect(steps(builder).map((step) => step.type)).toEqual([
      'apt_install',
      'pip_install',
      'npm_install',
      'bun_install',
      'run',
      'mkdir',
    ]);
    expect(steps(builder)[0]?.args).toEqual(['git', 'curl']);
    expect(steps(builder)[5]?.options).toEqual({ mode: '0755' });
  });

  it('floors resources at one unit', () => {
    const payload = new TemplateBuilder('tiny').vcpu(0).memory(-5).disk(0).toJSON();
    expect(payload).toMatchObject({ vcpu_count: 1, memory_mb: 1, disk_mb: 1 });
  });

  it('base64-encodes file contents and normalizes the mode', () => {
    const builder = new TemplateBuilder('files')
      .addFile('/app/run.sh', '#!/bin/sh\necho hi\n', { mode: 0o755, user: 'app' })
      .addFile('/app/data.bin', new Uint8Array([0, 1, 2, 255]));

    const [script, binary] = steps(builder);
    expect(script?.type).toBe('copy_file');
    expect(script?.args).toEqual(['/app/run.sh']);
    expect(utf8Decode(fromBase64(script?.content ?? ''))).toBe('#!/bin/sh\necho hi\n');
    expect(script?.options).toEqual({ mode: '0755', user: 'app' });
    expect([...fromBase64(binary?.content ?? '')]).toEqual([0, 1, 2, 255]);
  });

  it('adds several files at once', () => {
    const builder = new TemplateBuilder('files').addFiles([
      { path: '/a.txt', content: 'a' },
      { path: '/b.txt', content: 'b', mode: '644' },
    ]);

    expect(steps(builder)).toHaveLength(2);
    expect(steps(builder)[1]?.options).toEqual({ mode: '0644' });
  });

  it('rejects a mode that is not octal', () => {
    expect(() => new TemplateBuilder('files').addFile('/a', 'a', { mode: '999' })).toThrow(
      GravixLayerInvalidArgumentError,
    );
  });

  it('records a git clone with its options', () => {
    const builder = new TemplateBuilder('repo').gitClone('https://example.test/repo.git', {
      destination: '/srv/repo',
      branch: 'main',
      depth: 1,
    });

    expect(steps(builder)[0]).toEqual({
      type: 'git_clone',
      args: ['https://example.test/repo.git', '/srv/repo'],
      options: { branch: 'main', depth: '1' },
    });
  });

  it('refuses a base image and a Dockerfile together', () => {
    const builder = new TemplateBuilder('conflict')
      .fromImage('python:3.12-slim')
      .dockerfile('FROM python:3.12-slim');

    expect(() => builder.toJSON()).toThrow(GravixLayerInvalidArgumentError);
  });

  it('offers readiness checks for the usual cases', () => {
    expect(TemplateBuilder.waitForPort(5432)).toContain(':5432');
    expect(TemplateBuilder.waitForUrl('http://localhost:8080/health')).toContain('200');
    expect(TemplateBuilder.waitForFile('/opt/ready')).toBe('test -f /opt/ready');
    expect(TemplateBuilder.waitForProcess('nginx')).toContain('nginx');
  });

  it('targets an existing template when rebuilding', () => {
    expect(new TemplateBuilder('base').templateId('tpl-1').toJSON()).toMatchObject({
      template_id: 'tpl-1',
    });
  });
});

describe('build states', () => {
  it('knows which states are final and which succeeded', () => {
    expect(isTerminalBuildState('completed')).toBe(true);
    expect(isTerminalBuildState('failed')).toBe(true);
    expect(isTerminalBuildState('running')).toBe(false);
    expect(isSuccessfulBuildState('completed')).toBe(true);
    expect(isSuccessfulBuildState('failed')).toBe(false);
  });
});

describe('templates', () => {
  const STARTED = { build_id: 'build-1', template_id: 'tpl-1', status: 'pending', message: 'ok' };
  const DONE = {
    build_id: 'build-1',
    template_id: 'tpl-1',
    status: 'completed',
    phase: 'completed',
    progress_percent: 100,
  };

  it('starts a build from a builder', async () => {
    const { client, http } = testClient([jsonResponse(STARTED)]);
    const result = await client.templates.build(new TemplateBuilder('base').vcpu(2));

    expect(http.last().url).toContain('/v1/agents/template/build');
    expect(http.jsonBody()).toMatchObject({ name: 'base', vcpu_count: 2 });
    expect(result.templateId).toBe('tpl-1');
  });

  it('accepts an already-serialized request body', async () => {
    const { client, http } = testClient([jsonResponse(STARTED)]);
    await client.templates.build({ name: 'raw', vcpu_count: 1 });
    expect(http.jsonBody()).toEqual({ name: 'raw', vcpu_count: 1 });
  });

  it('waits for a build and reports each new phase once', async () => {
    const { client } = testClient([
      jsonResponse(STARTED),
      jsonResponse({ ...DONE, status: 'running', phase: 'building', progress_percent: 10 }),
      jsonResponse({ ...DONE, status: 'running', phase: 'building', progress_percent: 60 }),
      jsonResponse(DONE),
    ]);

    const onPhase = vi.fn();
    const status = await client.templates.buildAndWait(new TemplateBuilder('base'), {
      pollIntervalMs: 0,
      onPhase,
    });

    expect(status.status).toBe('completed');
    expect(onPhase.mock.calls.map(([s]) => s.phase)).toEqual(['building', 'completed']);
  });

  it('raises with the reason the build failed', async () => {
    const { client } = testClient([
      jsonResponse(STARTED),
      jsonResponse({ ...DONE, status: 'failed', phase: 'building', error: 'apt failed' }),
    ]);

    const error = await expectRejection(
      client.templates.buildAndWait(new TemplateBuilder('base'), { pollIntervalMs: 0 }),
      TemplateBuildError,
    );
    expect(error.message).toContain('apt failed');
    expect(error.buildStatus?.phase).toBe('building');
  });

  it('gives up after the timeout and says the build may still be running', async () => {
    const { client } = testClient([
      jsonResponse(STARTED),
      jsonResponse({ ...DONE, status: 'running', phase: 'building' }),
    ]);

    const error = await expectRejection(
      client.templates.buildAndWait(new TemplateBuilder('base'), {
        pollIntervalMs: 0,
        timeoutMs: -1,
      }),
      TemplateBuildTimeoutError,
    );
    expect(error.message).toContain('getBuildStatus');
  });

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController();
    const { client } = testClient([
      jsonResponse(STARTED),
      jsonResponse({ ...DONE, status: 'running', phase: 'building' }),
    ]);

    const pending = client.templates.buildAndWait(new TemplateBuilder('base'), {
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    // Let the first poll land before cancelling, so the abort interrupts the
    // wait between polls rather than the request itself.
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toBeDefined();
  });

  it('lists runtime templates', async () => {
    const { client, http } = testClient([
      jsonResponse({ templates: [{ id: 'tpl-1', name: 'base', kind: 'sandbox' }], limit: 100 }),
    ]);
    const result = await client.templates.list({ projectId: 'proj-1' });

    expect(http.query().get('kind')).toBe('sandbox');
    expect(http.query().get('project_id')).toBe('proj-1');
    expect(http.query().get('limit')).toBe('100');
    expect(result.templates[0]?.name).toBe('base');
  });

  it('reads one template', async () => {
    const { client, http } = testClient([
      jsonResponse({
        id: 'tpl-1',
        name: 'base',
        description: 'Base image',
        vcpu_count: 2,
        memory_mb: 2048,
        disk_size_mb: 8192,
        provider: 'aws',
        region: 'us-east-1',
      }),
    ]);
    const template = await client.templates.get('tpl-1');

    expect(http.last().url).toContain('/v1/agents/template/tpl-1');
    expect(template).toMatchObject({
      id: 'tpl-1',
      memoryMb: 2048,
      visibility: 'private',
      cloud: 'aws',
    });
  });

  it('reads the stored image behind a template', async () => {
    const { client, http } = testClient([
      jsonResponse({
        template_id: 'tpl-1',
        name: 'base',
        has_snapshot: true,
        vcpu_count: 2,
        memory_mb: 2048,
        guest_agent_version: '1.4.0',
        snapshot_size_bytes: 1024,
      }),
    ]);
    const snapshot = await client.templates.getSnapshot('tpl-1');

    expect(http.last().url).toContain('/template/tpl-1/snapshot');
    expect(snapshot).toMatchObject({
      hasSnapshot: true,
      guestAgentVersion: '1.4.0',
      snapshotSizeBytes: 1024,
    });
  });

  it('deletes a template and confirms it', async () => {
    const { client, http } = testClient([emptyResponse()]);
    expect(await client.templates.delete('tpl-1')).toEqual({ templateId: 'tpl-1', deleted: true });
    expect(http.last().method).toBe('DELETE');
  });

  it('validates identifiers before sending anything', async () => {
    const { client, http } = testClient([jsonResponse({})]);

    await expectRejection(client.templates.get(''), GravixLayerInvalidArgumentError);
    await expectRejection(client.templates.getSnapshot(''), GravixLayerInvalidArgumentError);
    await expectRejection(client.templates.delete(''), GravixLayerInvalidArgumentError);
    await expectRejection(client.templates.getBuildStatus(''), GravixLayerInvalidArgumentError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('snapshots', () => {
  const SNAPSHOT = {
    id: 'snap-1',
    name: 'deps-installed',
    kind: 'hot',
    state: 'ready',
    cloud: 'aws',
    region: 'us-east-1',
    vcpu_count: 2,
    memory_mb: 2048,
    disk_size_mb: 8192,
    is_active: true,
    source: 'runtime',
    source_runtime_id: RUNTIME_ID,
    size_bytes: 2_147_483_648,
    created_at: '2026-01-01T00:00:00Z',
  };

  it('captures a runtime, defaulting to a filesystem-only snapshot', async () => {
    const { client, http } = testClient([jsonResponse(SNAPSHOT)]);
    await client.snapshots.create(RUNTIME_ID, 'deps-installed');

    expect(http.last().url).toContain('/v1/agents/snapshots');
    expect(http.jsonBody()).toEqual({
      runtime_id: RUNTIME_ID,
      name: 'deps-installed',
      kind: SnapshotKind.Cold,
    });
  });

  it('captures memory too when asked, and parses the result', async () => {
    const { client, http } = testClient([jsonResponse(SNAPSHOT)]);
    const snapshot = await client.snapshots.create(RUNTIME_ID, 'deps-installed', {
      kind: 'hot',
      description: 'after pip install',
    });

    expect(http.jsonBody()).toMatchObject({ kind: 'hot', description: 'after pip install' });
    expect(snapshot).toMatchObject({
      id: 'snap-1',
      kind: 'hot',
      isActive: true,
      sourceRuntimeId: RUNTIME_ID,
      sizeBytes: 2_147_483_648,
    });
  });

  it('checks the runtime id and the name', async () => {
    const { client, http } = testClient([jsonResponse(SNAPSHOT)]);

    await expectRejection(
      client.snapshots.create('not-a-uuid', 'name'),
      GravixLayerInvalidArgumentError,
    );
    await expectRejection(client.snapshots.create(RUNTIME_ID, ''), GravixLayerInvalidArgumentError);
    expect(http.requests).toHaveLength(0);
  });

  it('lists with filters', async () => {
    const { client, http } = testClient([
      jsonResponse({ snapshots: [SNAPSHOT], total: 1, limit: 20, offset: 0 }),
    ]);
    const result = await client.snapshots.list({
      kind: 'hot',
      runtimeId: RUNTIME_ID,
      state: 'ready',
      source: 'runtime',
      projectId: 'proj-1',
    });

    const query = http.query();
    expect(query.get('kind')).toBe('hot');
    expect(query.get('runtime_id')).toBe(RUNTIME_ID);
    expect(query.get('state')).toBe('ready');
    expect(query.get('source')).toBe('runtime');
    expect(query.get('project_id')).toBe('proj-1');
    expect(query.get('limit')).toBe('20');
    expect(result.total).toBe(1);
  });

  it('falls back to counting the page when no total is returned', async () => {
    const { client } = testClient([jsonResponse({ snapshots: [SNAPSHOT] })]);
    expect((await client.snapshots.list()).total).toBe(1);
  });

  it('fetches, activates, and deactivates by name', async () => {
    const { client, http } = testClient([jsonResponse(SNAPSHOT)]);

    await client.snapshots.get('deps-installed');
    expect(http.last().url).toContain('/snapshots/deps-installed');

    await client.snapshots.activate('deps-installed');
    expect(http.last().url).toContain('/snapshots/deps-installed/activate');
    expect(http.last().method).toBe('POST');

    await client.snapshots.deactivate('deps-installed');
    expect(http.last().url).toContain('/snapshots/deps-installed/deactivate');
  });

  it('escapes a name that needs it', async () => {
    const { client, http } = testClient([jsonResponse(SNAPSHOT)]);
    await client.snapshots.get('team/base image');
    expect(http.last().url).toContain('/snapshots/team%2Fbase%20image');
  });

  it('deletes a snapshot and confirms it', async () => {
    const { client, http } = testClient([emptyResponse()]);
    expect(await client.snapshots.delete('snap-1')).toEqual({
      snapshotId: 'snap-1',
      deleted: true,
    });
    expect(http.last().method).toBe('DELETE');
  });

  it('requires a reference for every lookup', async () => {
    const { client, http } = testClient([jsonResponse(SNAPSHOT)]);

    await expectRejection(client.snapshots.get(''), GravixLayerInvalidArgumentError);
    await expectRejection(client.snapshots.activate(''), GravixLayerInvalidArgumentError);
    await expectRejection(client.snapshots.deactivate(''), GravixLayerInvalidArgumentError);
    await expectRejection(client.snapshots.delete(''), GravixLayerInvalidArgumentError);
    expect(http.requests).toHaveLength(0);
  });
});
