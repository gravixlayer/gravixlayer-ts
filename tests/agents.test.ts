import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  AgentBuildError,
  AgentBuildTimeoutError,
  GravixLayerInvalidArgumentError,
  normalizeFramework,
} from '../src/index.js';
import { serializeAgentCard } from '../src/types/agents.js';
import { utf8Decode } from '../src/core/binary.js';
import { readProjectDirectory } from '../src/core/fs.js';
import {
  autoserveEntrypoint,
  inferAgentSource,
  loadProjectEnv,
  parseDotEnv,
  resolveHttpPort,
} from '../src/resources/agent-source.js';
import { collect, expectRejection, jsonResponse, sseJson, testClient } from './helpers.js';

const AGENT_ID = 'agent-1';

const BUILD_STARTED = {
  build_id: 'build-1',
  template_id: 'tpl-1',
  status: 'pending',
  message: 'queued',
};

const BUILD_DONE = {
  build_id: 'build-1',
  template_id: 'tpl-1',
  status: 'completed',
  phase: 'completed',
  progress_percent: 100,
};

const DEPLOYED = {
  agent_id: AGENT_ID,
  runtime_id: '11111111-2222-4333-8444-555555555555',
  endpoint: 'https://agent-1.example.test',
  agent_card_url: 'https://agent-1.example.test/.well-known/agent-card.json',
  status: 'active',
  dns_status: 'active',
  name: 'my-agent',
  framework: 'langgraph',
};

/** A minimal in-memory project. */
const FILES = [{ path: 'main.py', content: 'print("hello")\n' }] as const;

/** Read back the metadata and archive the SDK uploaded. */
async function uploadedParts(body: unknown) {
  if (!(body instanceof FormData)) throw new Error('The request body was not multipart.');

  const metadata = JSON.parse(String(body.get('metadata'))) as Record<string, unknown>;
  const archive = body.get('archive');
  if (!(archive instanceof File)) throw new Error('The archive part was missing.');

  const tar = new Uint8Array(gunzipSync(new Uint8Array(await archive.arrayBuffer())));
  return { metadata, archiveName: archive.name, tar };
}

/** Names of the files inside an uncompressed tar. */
function tarPaths(tar: Uint8Array): string[] {
  const paths: string[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = utf8Decode(tar.slice(offset, offset + 100)).replace(/\0.*$/, '');
    if (name === '') break;
    const size = parseInt(
      utf8Decode(tar.slice(offset + 124, offset + 136)).replace(/\0.*$/, ''),
      8,
    );
    paths.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

describe('framework names', () => {
  it('canonicalizes aliases and separators', () => {
    expect(normalizeFramework('LangGraph')).toBe('langgraph');
    expect(normalizeFramework('google_adk')).toBe('google-adk');
    expect(normalizeFramework('claude')).toBe('anthropic');
    expect(normalizeFramework('claude-agent-sdk')).toBe('anthropic');
    expect(normalizeFramework('openai')).toBe('openai-agents');
    expect(normalizeFramework('strands_agents')).toBe('strands');
    expect(normalizeFramework('  ')).toBe('');
  });

  it('explains that agent-to-agent is a protocol, not a framework', () => {
    expect(() => normalizeFramework('a2a')).toThrow(/protocol, not a framework/);
    expect(() => normalizeFramework('a2a_native')).toThrow(GravixLayerInvalidArgumentError);
  });

  it('passes an unrecognised name through for the API to judge', () => {
    expect(normalizeFramework('some-new-framework')).toBe('some-new-framework');
  });
});

describe('agent cards', () => {
  it('serializes a card in the interoperability format', () => {
    const card = serializeAgentCard({
      name: 'Research',
      description: 'Looks things up',
      version: '1.0.0',
      capabilities: { streaming: true },
      skills: [
        {
          id: 'search',
          name: 'Search',
          description: 'Finds sources',
          tags: ['research'],
          inputModes: ['text/plain'],
        },
      ],
      defaultInputModes: ['text/plain'],
    });

    expect(card).toEqual({
      name: 'Research',
      description: 'Looks things up',
      version: '1.0.0',
      capabilities: { streaming: true },
      skills: [
        {
          id: 'search',
          name: 'Search',
          description: 'Finds sources',
          tags: ['research'],
          inputModes: ['text/plain'],
        },
      ],
      defaultInputModes: ['text/plain'],
    });
  });

  it('always includes a capabilities object', () => {
    expect(serializeAgentCard({ name: 'a', description: 'b' })).toEqual({
      name: 'a',
      description: 'b',
      capabilities: {},
    });
  });
});

describe('entrypoints and ports', () => {
  it('builds a start command for a framework the platform can serve', () => {
    const command = autoserveEntrypoint('langgraph', [8000], 'app.graph:agent', ['http', 'a2a']);

    expect(command).toContain('--framework langgraph');
    expect(command).toContain('--port 8000');
    expect(command).toContain('--protocols http,a2a');
    expect(command).toContain('--target app.graph:agent');
  });

  it('leaves the command to the project for other frameworks', () => {
    expect(autoserveEntrypoint('python', [8000])).toBe('');
    expect(autoserveEntrypoint('crewai', [8000])).toBe('');
  });

  it('quotes an argument that would otherwise be split', () => {
    expect(autoserveEntrypoint('langgraph', [8000], 'my app:graph')).toContain("'my app:graph'");
  });

  it('deduplicates protocols and ignores blanks', () => {
    const command = autoserveEntrypoint('langgraph', [8000], '', ['HTTP', ' http ', '', 'a2a']);
    expect(command).toContain('--protocols http,a2a');
  });

  it('prefers an explicit port, then the first declared one', () => {
    expect(resolveHttpPort(9000, [8000])).toBe(9000);
    expect(resolveHttpPort(undefined, [8080, 9090])).toBe(8080);
    expect(resolveHttpPort(0, [])).toBe(8000);
  });
});

describe('.env parsing', () => {
  it('reads key/value pairs and skips comments', () => {
    expect(
      parseDotEnv(
        ['# comment', 'A=1', '', 'B = two ', 'C="quoted"', "D='single'", 'nokey'].join('\n'),
      ),
    ).toEqual({ A: '1', B: 'two', C: 'quoted', D: 'single' });
  });

  it('keeps an equals sign inside a value', () => {
    expect(parseDotEnv('URL=https://x.test/?a=1')).toEqual({ URL: 'https://x.test/?a=1' });
  });

  it('does not write to the current process environment', () => {
    parseDotEnv('GRAVIXLAYER_TEST_SHOULD_NOT_LEAK=1');
    expect(process.env['GRAVIXLAYER_TEST_SHOULD_NOT_LEAK']).toBeUndefined();
  });
});

describe('reading a project from disk', () => {
  const created: string[] = [];

  async function project(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'gravixlayer-agent-'));
    created.push(root);

    for (const [relative, contents] of Object.entries(files)) {
      const full = join(root, relative);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, contents);
    }
    return root;
  }

  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('collects files recursively, sorted for a reproducible archive', async () => {
    const root = await project({
      'main.py': 'print(1)',
      'pkg/util.py': 'x = 1',
      'requirements.txt': 'langgraph\n',
    });

    const entries = await readProjectDirectory(root);
    expect(entries.map((entry) => entry.path)).toEqual([
      'main.py',
      'pkg/util.py',
      'requirements.txt',
    ]);
  });

  it('leaves out caches, virtual environments, and secrets', async () => {
    const root = await project({
      'main.py': 'print(1)',
      '.env': 'SECRET=1',
      '__pycache__/main.cpython-312.pyc': 'x',
      'node_modules/pkg/index.js': 'x',
      '.git/config': 'x',
      'build/out.txt': 'x',
    });

    expect((await readProjectDirectory(root)).map((entry) => entry.path)).toEqual(['main.py']);
  });

  it('reports a missing directory clearly', async () => {
    await expectRejection(
      readProjectDirectory(join(tmpdir(), 'gravixlayer-does-not-exist')),
      GravixLayerInvalidArgumentError,
    );
  });

  it('infers LangGraph from a graph configuration', async () => {
    const root = await project({
      'langgraph.json': JSON.stringify({
        python_version: '3.12.4',
        graphs: { agent: './app/graph.py:graph' },
      }),
    });

    expect(await inferAgentSource(root)).toEqual({
      framework: 'langgraph',
      pythonVersion: '3.12',
      ports: [8000],
      target: './app/graph.py:graph',
    });
  });

  it('infers a framework from requirements', async () => {
    const crew = await project({ 'requirements.txt': 'crewai==0.80.0\nrequests\n' });
    expect((await inferAgentSource(crew)).framework).toBe('crewai');

    const chain = await project({ 'requirements.txt': 'langchain-core>=0.3,<0.4\n' });
    expect((await inferAgentSource(chain)).framework).toBe('langchain');

    const plain = await project({ 'requirements.txt': 'flask\n' });
    expect((await inferAgentSource(plain)).framework).toBe('python');
  });

  it('infers a framework named in a project file', async () => {
    const root = await project({
      'pyproject.toml': '[project]\ndependencies = ["google-adk>=1.0"]\n',
    });
    expect((await inferAgentSource(root)).framework).toBe('google-adk');
  });

  it('reads the environment files a project ships', async () => {
    const root = await project({
      '.env': 'FROM_ENV=1\nSHARED=base\n',
      'gravixlayer/.env.local': 'SHARED=override\n',
    });

    expect(await loadProjectEnv(root)).toEqual({ FROM_ENV: '1', SHARED: 'override' });
  });
});

describe('building', () => {
  it('uploads metadata and a gzipped archive', async () => {
    const { client, http } = testClient([jsonResponse(BUILD_STARTED)]);
    const result = await client.agents.build(
      { files: [...FILES] },
      { name: 'my-agent', framework: 'langgraph' },
    );

    expect(http.last().url).toContain('/v1/agents/template/build-agent');
    expect(http.last().headers['content-type']).toBeUndefined();

    const { metadata, archiveName, tar } = await uploadedParts(http.last().body);
    expect(archiveName).toBe('project.tar.gz');
    expect(tarPaths(tar)).toEqual(['main.py']);
    expect(metadata).toMatchObject({ name: 'my-agent', framework: 'langgraph', ports: [8000] });
    expect(result.buildId).toBe('build-1');
  });

  it('omits values the caller did not set', async () => {
    const { client, http } = testClient([jsonResponse(BUILD_STARTED)]);
    await client.agents.build({ files: [...FILES] }, { name: 'my-agent' });

    const { metadata } = await uploadedParts(http.last().body);
    expect(metadata).not.toHaveProperty('description');
    expect(metadata).not.toHaveProperty('vcpu_count');
    expect(metadata).not.toHaveProperty('tags');
  });

  it('passes resource settings through', async () => {
    const { client, http } = testClient([jsonResponse(BUILD_STARTED)]);
    await client.agents.build(
      { files: [...FILES] },
      {
        name: 'my-agent',
        description: 'does things',
        vcpuCount: 4,
        memoryMb: 4096,
        diskMb: 20480,
        pythonVersion: '3.12',
        ports: [9000],
        environment: { LOG_LEVEL: 'debug' },
        tags: { team: 'research' },
      },
    );

    const { metadata } = await uploadedParts(http.last().body);
    expect(metadata).toMatchObject({
      description: 'does things',
      vcpu_count: 4,
      memory_mb: 4096,
      disk_mb: 20480,
      python_version: '3.12',
      ports: [9000],
      environment: { LOG_LEVEL: 'debug' },
      tags: { team: 'research' },
    });
  });

  it('requires a name and a non-empty source', async () => {
    const { client, http } = testClient([jsonResponse(BUILD_STARTED)]);

    await expectRejection(
      client.agents.build({ files: [...FILES] }, { name: '' }),
      GravixLayerInvalidArgumentError,
    );
    await expectRejection(
      client.agents.build({ files: [] }, { name: 'my-agent' }),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });

  it('polls a build to completion', async () => {
    const { client } = testClient([
      jsonResponse({ ...BUILD_DONE, status: 'running', phase: 'building' }),
      jsonResponse(BUILD_DONE),
    ]);

    const onPhase = vi.fn();
    const status = await client.agents.waitForBuild('build-1', { pollIntervalMs: 0, onPhase });

    expect(status.status).toBe('completed');
    expect(onPhase).toHaveBeenCalledTimes(2);
  });

  it('raises with the failure reason', async () => {
    const { client } = testClient([
      jsonResponse({ build_id: 'build-1', status: 'failed', error: 'compile error' }),
    ]);

    const error = await expectRejection(
      client.agents.waitForBuild('build-1', { pollIntervalMs: 0 }),
      AgentBuildError,
    );
    expect(error.message).toContain('compile error');
  });

  it('raises a timeout that is still an AgentBuildError', async () => {
    const { client } = testClient([jsonResponse({ build_id: 'build-1', status: 'running' })]);

    const error = await expectRejection(
      client.agents.waitForBuild('build-1', { pollIntervalMs: 0, timeoutMs: -1 }),
      AgentBuildTimeoutError,
    );
    expect(error).toBeInstanceOf(AgentBuildError);
  });
});

describe('deploying', () => {
  it('builds, waits, then deploys, uploading the source only once', async () => {
    const { client, http } = testClient([
      jsonResponse(BUILD_STARTED),
      jsonResponse(BUILD_DONE),
      jsonResponse(DEPLOYED),
    ]);

    const agent = await client.agents.deploy({
      source: { files: [...FILES] },
      name: 'my-agent',
      framework: 'langgraph',
      isPublic: true,
      pollIntervalMs: 0,
    });

    expect(http.requests).toHaveLength(3);
    expect(http.requests[0]?.url).toContain('/template/build-agent');
    expect(http.requests[1]?.url).toContain('/template/builds/build-1/status');
    expect(http.requests[2]?.url).toContain('/v1/agents/deploy');

    expect(http.jsonBody(2)).toEqual({
      template_id: 'tpl-1',
      framework: 'langgraph',
      entry_point: expect.stringContaining('--framework langgraph'),
      http_port: 8000,
      is_public: true,
    });
    expect(agent.endpoint).toBe('https://agent-1.example.test');
  });

  it('deploys an image that was already built', async () => {
    const { client, http } = testClient([jsonResponse(DEPLOYED)]);
    await client.agents.deploy({ templateId: 'tpl-1', framework: 'python', httpPort: 9000 });

    expect(http.requests).toHaveLength(1);
    expect(http.jsonBody()).toEqual({
      template_id: 'tpl-1',
      framework: 'python',
      http_port: 9000,
    });
  });

  it('requires exactly one of source and templateId', async () => {
    const { client, http } = testClient([jsonResponse(DEPLOYED)]);

    await expectRejection(client.agents.deploy({ name: 'a' }), GravixLayerInvalidArgumentError);
    await expectRejection(
      client.agents.deploy({ name: 'a', source: { files: [...FILES] }, templateId: 'tpl-1' }),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });

  it('lets deploy-time environment override build-time values', async () => {
    const { client, http } = testClient([
      jsonResponse(BUILD_STARTED),
      jsonResponse(BUILD_DONE),
      jsonResponse(DEPLOYED),
    ]);

    await client.agents.deploy({
      source: { files: [...FILES] },
      name: 'my-agent',
      environment: { STAGE: 'build' },
      deployEnvironment: { STAGE: 'run' },
      pollIntervalMs: 0,
    });

    expect(http.jsonBody(2)).toMatchObject({ environment: { STAGE: 'run' } });
  });

  it('sends the protocol ports and agent card', async () => {
    const { client, http } = testClient([jsonResponse(DEPLOYED)]);
    await client.agents.deploy({
      templateId: 'tpl-1',
      protocols: ['http', 'a2a'],
      a2aPort: 8001,
      mcpPort: 8002,
      agentCard: { name: 'Research', description: 'Looks things up' },
    });

    expect(http.jsonBody()).toMatchObject({
      protocols: ['http', 'a2a'],
      a2a_port: 8001,
      mcp_port: 8002,
      agent_card: { name: 'Research', description: 'Looks things up', capabilities: {} },
    });
  });
});

describe('deployed agents', () => {
  const ENDPOINT = {
    agent_id: AGENT_ID,
    endpoint: 'https://agent-1.example.test/',
    internal_endpoint: 'http://agent-1.internal',
    protocols: { http: 'https://agent-1.example.test', a2a: 'https://agent-1.example.test/a2a' },
    health: 'healthy',
    dns_status: 'active',
    name: 'my-agent',
    framework: 'langgraph',
    status: 'active',
  };

  it('lists built agent images', async () => {
    const { client, http } = testClient([
      jsonResponse({ templates: [{ id: 'tpl-1', name: 'my-agent', kind: 'agent' }] }),
    ]);
    const result = await client.agents.listTemplates({ projectId: 'proj-1' });

    expect(http.query().get('kind')).toBe('agent');
    expect(http.query().get('project_id')).toBe('proj-1');
    expect(result.templates[0]?.id).toBe('tpl-1');
  });

  it('reads an endpoint, filling protocol URLs from the map', async () => {
    const { client, http } = testClient([jsonResponse(ENDPOINT)]);
    const endpoint = await client.agents.get(AGENT_ID);

    expect(http.last().url).toContain(`/v1/agents/${AGENT_ID}/endpoint`);
    expect(endpoint.health).toBe('healthy');
    expect(endpoint.a2aEndpoint).toBe('https://agent-1.example.test/a2a');
    expect(endpoint.mcpEndpoint).toBe('');
  });

  it('destroys an agent', async () => {
    const { client, http } = testClient([jsonResponse({ agent_id: AGENT_ID, status: 'deleting' })]);
    const result = await client.agents.destroy(AGENT_ID);

    expect(http.last().method).toBe('DELETE');
    expect(result).toEqual({ agentId: AGENT_ID, status: 'deleting' });
  });

  it('invokes the agent at its own URL, not through the control plane', async () => {
    const { client, http } = testClient([jsonResponse(ENDPOINT), jsonResponse({ output: 'done' })]);

    const result = await client.agents.invoke<{ output: string }>(AGENT_ID, {
      input: { prompt: 'hi' },
      sessionId: 'sess-1',
      metadata: { source: 'test' },
    });

    expect(http.last().url).toBe('https://agent-1.example.test/invoke');
    expect(http.jsonBody()).toEqual({
      input: { prompt: 'hi' },
      session_id: 'sess-1',
      metadata: { source: 'test' },
    });
    expect(result.output).toBe('done');
  });

  it('streams a response', async () => {
    const { client, http } = testClient([
      jsonResponse(ENDPOINT),
      sseJson([{ delta: 'he' }, { delta: 'llo' }]),
    ]);

    const events = await collect(client.agents.stream(AGENT_ID, { input: 'hi' }));
    expect(http.last().url).toBe('https://agent-1.example.test/stream');
    expect(events).toEqual([{ delta: 'he' }, { delta: 'llo' }]);
  });

  it('validates the agent id', async () => {
    const { client, http } = testClient([jsonResponse(ENDPOINT)]);
    await expectRejection(client.agents.get(''), GravixLayerInvalidArgumentError);
    expect(http.requests).toHaveLength(0);
  });
});
