import { describe, expect, it } from 'vitest';

import { GravixLayerInvalidArgumentError, type MountInput } from '../src/index.js';
import { buildMountSpec } from '../src/resources/storage.js';
import { expectRejection, jsonResponse, RUNTIME_ID, testClient } from './helpers.js';

const BUCKET = {
  id: 'bkt-1',
  name: 'datasets',
  provider: 's3',
  region: 'us-east-1',
  bucket: 'glx-a1b2-datasets',
  status: 'active',
  error: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const LINK = {
  id: 'bkt-ext-1',
  name: 'byo-data',
  source: 'external',
  provider: 's3_compatible',
  bucket: 'acme-data',
  prefix: 'models/',
  region: 'eu-west-1',
  endpoint: 'https://objects.example.com',
  path_style: true,
  auth_mode: 'static',
  status: 'verified',
  verify_error: '',
  last_verified_at: '2026-01-02T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
};

const MOUNT = {
  id: 'att-1',
  runtime_id: RUNTIME_ID,
  kind: 'bucket',
  target_id: 'bkt-1',
  mount_path: '/mnt/data',
  mode: 'rw',
  state: 'attached',
  error: '',
  provenance: 's3://glx-a1b2-datasets',
  created_at: '2026-01-01T00:00:00Z',
};

describe('storage buckets', () => {
  it('creates a managed bucket', async () => {
    const { client, http } = testClient([jsonResponse({ bucket: BUCKET }, 201)]);
    const bucket = await client.storage.buckets.create('datasets', { region: 'us-east-1' });

    expect(http.last().url).toContain('/v1/agents/buckets');
    expect(http.jsonBody()).toEqual({ name: 'datasets', region: 'us-east-1' });
    expect(bucket.id).toBe('bkt-1');
    expect(bucket.bucket).toBe('glx-a1b2-datasets');
    expect(bucket.status).toBe('active');
  });

  it('scopes a list to a project', async () => {
    const { client, http } = testClient([jsonResponse({ buckets: [BUCKET], total: 1 })]);
    const result = await client.storage.buckets.list({ projectId: 'proj-1' });

    expect(http.query().get('project_id')).toBe('proj-1');
    expect(result.buckets).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('fetches by id and parses', async () => {
    const { client } = testClient([jsonResponse({ bucket: BUCKET })]);
    const bucket = await client.storage.buckets.get('bkt-1');
    expect(bucket.name).toBe('datasets');
    expect(bucket.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('deletes by id', async () => {
    const { client, http } = testClient([jsonResponse({ deleted: true })]);
    expect(await client.storage.buckets.delete('bkt-1')).toBe(true);
    expect(http.last().method).toBe('DELETE');
    expect(http.last().url).toContain('/v1/agents/buckets/bkt-1');
  });

  it('rejects an empty name before any request', async () => {
    const { client, http } = testClient([]);
    await expectRejection(client.storage.buckets.create(''), GravixLayerInvalidArgumentError);
    expect(http.requests).toHaveLength(0);
  });
});

describe('external buckets', () => {
  it('connects a static bucket with secret references only', async () => {
    const { client, http } = testClient([jsonResponse({ bucket: LINK }, 201)]);
    const link = await client.storage.buckets.connect('byo-data', 'acme-data', {
      provider: 's3_compatible',
      prefix: 'models/',
      region: 'eu-west-1',
      endpoint: 'https://objects.example.com',
      pathStyle: true,
      secretProviderId: 'prov-1',
      accessKeySecret: 'AWS_ACCESS_KEY_ID',
      secretKeySecret: 'AWS_SECRET_ACCESS_KEY',
    });

    const body = http.jsonBody() as Record<string, unknown>;
    expect(body).toEqual({
      name: 'byo-data',
      external: {
        provider: 's3_compatible',
        bucket: 'acme-data',
        auth_mode: 'static',
        prefix: 'models/',
        region: 'eu-west-1',
        endpoint: 'https://objects.example.com',
        path_style: true,
        secret_provider_id: 'prov-1',
        access_key_secret: 'AWS_ACCESS_KEY_ID',
        secret_key_secret: 'AWS_SECRET_ACCESS_KEY',
      },
    });
    expect(link.pathStyle).toBe(true);
    expect(link.status).toBe('verified');
    expect(link.lastVerifiedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('connects an oidc bucket', async () => {
    const { client, http } = testClient([jsonResponse({ bucket: LINK }, 201)]);
    await client.storage.buckets.connect('byo-data', 'acme-data', {
      authMode: 'oidc',
      roleArn: 'arn:aws:iam::1234:role/data-read',
      externalId: 'ext-9',
    });
    const body = http.jsonBody() as Record<string, unknown>;
    const external = body['external'] as Record<string, unknown>;
    expect(external['auth_mode']).toBe('oidc');
    expect(external['role_arn']).toBe('arn:aws:iam::1234:role/data-read');
    expect(external['external_id']).toBe('ext-9');
    expect(external['secret_provider_id']).toBeUndefined();
  });

  it('rejects bad external bucket combinations before any request', async () => {
    const { client, http } = testClient([]);
    const bad: Array<[string, Parameters<typeof client.storage.buckets.connect>[2]]> = [
      ['http endpoint', { provider: 's3_compatible', endpoint: 'http://a' }],
      ['s3 with endpoint', { provider: 's3', endpoint: 'https://x' }],
      ['s3_compatible without endpoint', { provider: 's3_compatible' }],
      ['static missing secrets', { provider: 's3' }],
      [
        'oidc missing externalId',
        { provider: 's3', authMode: 'oidc', roleArn: 'arn:aws:iam::1:role/r' },
      ],
      [
        'oidc on s3_compatible',
        {
          provider: 's3_compatible',
          endpoint: 'https://x',
          authMode: 'oidc',
          roleArn: 'r',
          externalId: 'e',
        },
      ],
      [
        'bad prefix',
        {
          provider: 's3',
          secretProviderId: 'p',
          accessKeySecret: 'a',
          secretKeySecret: 's',
          prefix: '/abs',
        },
      ],
    ];
    for (const [label, options] of bad) {
      await expectRejection(
        client.storage.buckets.connect('x', 'bkt', options),
        GravixLayerInvalidArgumentError,
      );
      void label;
    }
    expect(http.requests).toHaveLength(0);
  });

  it('verifies and disconnects a bucket', async () => {
    const { client, http } = testClient([
      jsonResponse({ bucket: LINK }),
      jsonResponse({ deleted: true }),
    ]);
    const verified = await client.storage.buckets.verify('bkt-ext-1');
    expect(http.last().url).toContain('/v1/agents/buckets/bkt-ext-1/verify');
    expect(http.last().method).toBe('POST');
    expect(verified.verifyError).toBeUndefined();

    expect(await client.storage.buckets.delete('bkt-ext-1')).toBe(true);
    expect(http.last().method).toBe('DELETE');
  });
});

describe('buildMountSpec', () => {
  it('builds a bucket mount by id', () => {
    expect(
      buildMountSpec({ kind: 'bucket', path: '/mnt/data', mode: 'rw', bucket: 'bkt-1' }),
    ).toEqual({ kind: 'bucket', path: '/mnt/data', mode: 'rw', bucket: 'bkt-1' });
  });

  it('builds a git mount with ref, depth and refresh', () => {
    expect(
      buildMountSpec({
        kind: 'git',
        path: '/mnt/repo',
        url: 'https://example.com/org/repo.git',
        ref: 'main',
        depth: 1,
        refreshSeconds: 300,
      }),
    ).toEqual({
      kind: 'git',
      path: '/mnt/repo',
      url: 'https://example.com/org/repo.git',
      git_ref: 'main',
      depth: 1,
      refresh_seconds: 300,
    });
  });

  it('builds a private git mount with credential references', () => {
    expect(
      buildMountSpec({
        kind: 'git',
        path: '/mnt/repo',
        url: 'https://example.com/org/private.git',
        credentialProvider: 'prov-1',
        credentialSecret: 'GIT_TOKEN',
      }),
    ).toEqual({
      kind: 'git',
      path: '/mnt/repo',
      url: 'https://example.com/org/private.git',
      credential_provider: 'prov-1',
      credential_secret: 'GIT_TOKEN',
    });
  });

  it('rejects invalid combinations without a request', () => {
    const bad: Array<[string, Parameters<typeof buildMountSpec>[0]]> = [
      ['no target', { kind: 'bucket', path: '/m' }],
      ['rw git', { kind: 'git', path: '/m', url: 'https://x/y.git', mode: 'rw' }],
      ['non-https git', { kind: 'git', path: '/m', url: 'git@x:y' }],
      ['missing url', { kind: 'git', path: '/m' }],
      ['relative path', { kind: 'bucket', path: 'rel', bucket: 'a' }],
      ['root path', { kind: 'bucket', path: '/', bucket: 'a' }],
      ['half creds', { kind: 'git', path: '/m', url: 'https://x/y.git', credentialProvider: 'p' }],
      ['bad mode', { kind: 'bucket', path: '/m', bucket: 'a', mode: 'rw+' }],
      ['bad depth', { kind: 'git', path: '/m', url: 'https://x/y.git', depth: -1 }],
      ['trailing slash', { kind: 'bucket', path: '/m/', bucket: 'a' }],
      ['double slash', { kind: 'bucket', path: '/m//x', bucket: 'a' }],
      ['overflow depth', { kind: 'git', path: '/m', url: 'https://x/y.git', depth: 4294967296 }],
      [
        'bucket mount with url',
        { kind: 'bucket', path: '/m', bucket: 'a', url: 'https://x/y.git' },
      ],
      ['git mount with bucket', { kind: 'git', path: '/m', url: 'https://x/y.git', bucket: 'a' }],
      [
        'bucket mount with credential refs',
        {
          kind: 'bucket',
          path: '/m',
          bucket: 'a',
          credentialProvider: 'p',
          credentialSecret: 's',
        },
      ],
      [
        'unknown key',
        { kind: 'bucket', path: '/m', bucket: 'a', credentialProviders: 'p' } as MountInput,
      ],
      ['typo key', { kind: 'bucket', path: '/m', bucket: 'a', typoKey: 'x' } as MountInput],
    ];
    for (const [label, input] of bad) {
      expect(() => buildMountSpec(input), label).toThrow(GravixLayerInvalidArgumentError);
    }
  });
});

describe('runtime mounts', () => {
  it('attaches a mount to a running runtime', async () => {
    const { client, http } = testClient([jsonResponse({ attachment: MOUNT }, 201)]);
    const mount = await client.storage.mounts.attach(RUNTIME_ID, {
      kind: 'bucket',
      path: '/mnt/data',
      mode: 'rw',
      bucket: 'bkt-1',
    });

    expect(http.last().url).toContain(`/v1/agents/runtime/${RUNTIME_ID}/mounts`);
    expect(http.jsonBody()).toEqual({
      kind: 'bucket',
      path: '/mnt/data',
      mode: 'rw',
      bucket: 'bkt-1',
    });
    expect(mount.state).toBe('attached');
    expect(mount.provenance).toBe('s3://glx-a1b2-datasets');
    expect(mount.targetId).toBe('bkt-1');
  });

  it('lists mounts', async () => {
    const { client, http } = testClient([jsonResponse({ mounts: [MOUNT] })]);
    const { mounts } = await client.storage.mounts.list(RUNTIME_ID);
    expect(http.last().url).toContain(`/v1/agents/runtime/${RUNTIME_ID}/mounts`);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.mountPath).toBe('/mnt/data');
  });

  it('detaches by attachment id', async () => {
    const { client, http } = testClient([jsonResponse({ detached: true })]);
    expect(await client.storage.mounts.detach(RUNTIME_ID, 'att-1')).toBe(true);
    expect(http.last().url).toContain(`/v1/agents/runtime/${RUNTIME_ID}/mounts/att-1`);
    expect(http.last().method).toBe('DELETE');
  });

  it('rejects a malformed runtime id locally', async () => {
    const { client, http } = testClient([]);
    await expectRejection(
      client.storage.mounts.attach('not-an-id', { kind: 'bucket', path: '/m', bucket: 'a' }),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });

  it('is reachable from the runtime handle', async () => {
    const { client } = testClient([
      jsonResponse({ runtime_id: RUNTIME_ID, status: 'running' }),
      jsonResponse({ attachment: MOUNT }, 201),
      jsonResponse({ mounts: [MOUNT] }),
      jsonResponse({ detached: true }),
    ]);
    const sandbox = await client.runtime.create();
    const attached = await sandbox.mounts.attach({
      kind: 'bucket',
      path: '/mnt/data',
      bucket: 'bkt-1',
    });
    expect(attached.state).toBe('attached');
    const { mounts } = await sandbox.mounts.list();
    expect(mounts[0]?.id).toBe('att-1');
    expect(await sandbox.mounts.detach('att-1')).toBe(true);
  });
});

describe('runtime create with mounts', () => {
  it('sends mounts on the create body', async () => {
    const { client, http } = testClient([
      jsonResponse({ runtime_id: RUNTIME_ID, status: 'running' }),
    ]);
    await client.runtime.create({
      mounts: [
        { kind: 'bucket', path: '/mnt/data', mode: 'rw', bucket: 'bkt-1' },
        { kind: 'git', path: '/mnt/repo', url: 'https://example.com/r.git', ref: 'v1' },
      ],
    });
    const body = http.jsonBody() as Record<string, unknown>;
    expect(body['mounts']).toEqual([
      { kind: 'bucket', path: '/mnt/data', mode: 'rw', bucket: 'bkt-1' },
      { kind: 'git', path: '/mnt/repo', url: 'https://example.com/r.git', git_ref: 'v1' },
    ]);
  });

  it('rejects an invalid mount before the request', async () => {
    const { client, http } = testClient([]);
    await expectRejection(
      client.runtime.create({ mounts: [{ kind: 'bucket', path: '/m', bucket: '' }] }),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });
});
