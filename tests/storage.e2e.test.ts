/**
 * Live E2E for the storage-mount surface — buckets, git
 * mounts, lifecycle, credential hygiene. Runs against a real deployment.
 * Skipped unless GRAVIXLAYER_E2E=1 and GRAVIXLAYER_API_KEY are set.
 *
 * Storage test config — env vars or ~/.config/gravix-test/aws.env:
 *   TEST_S3_BUCKET, TEST_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *   PUBLIC_REPO, PRIVATE_REPO, GIT_TOKEN
 *
 *   GRAVIXLAYER_BASE_URL — API origin (staging)
 *   GRAVIXLAYER_TEMPLATE — runtime template (default: base-small)
 *
 *   npx vitest run tests/storage.e2e.test.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GravixLayer } from '../src/index.js';

// ── config ──────────────────────────────────────────────────────────────────

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const [k, ...rest] = t.split('=');
    const key = (k ?? '').trim();
    if (key && !(key in process.env)) {
      process.env[key] = rest
        .join('=')
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
}
loadEnvFile(join(homedir(), '.config', 'gravix-test', 'aws.env'));

const E2E = process.env.GRAVIXLAYER_E2E === '1';
const API_KEY = process.env.GRAVIXLAYER_API_KEY ?? '';
const BASE_URL = process.env.GRAVIXLAYER_BASE_URL ?? 'https://api.gravixlayer.ai';
const TEMPLATE = process.env.GRAVIXLAYER_TEMPLATE ?? 'base-small';
const PROJECT_ID = process.env.GRAVIXLAYER_PROJECT_ID || undefined;

const TEST_BUCKET = process.env.TEST_S3_BUCKET ?? 'demo-gl-157541785332-ap-south-1-an';
const TEST_BUCKET_REGION = process.env.TEST_S3_REGION ?? 'ap-south-1';
const AWS_KEY = process.env.AWS_ACCESS_KEY_ID ?? '';
const AWS_SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? '';
const PUBLIC_REPO = process.env.PUBLIC_REPO ?? '';
const PRIVATE_REPO = process.env.PRIVATE_REPO ?? '';
const GIT_TOKEN = process.env.GIT_TOKEN ?? '';

const RUN_ID = Math.random().toString(36).slice(2, 10);

const HAS_LINK_CREDS = Boolean(AWS_KEY && AWS_SECRET);
const HAS_PUBLIC_REPO = Boolean(PUBLIC_REPO);
const HAS_PRIVATE_REPO = Boolean(PRIVATE_REPO && GIT_TOKEN);

const MOUNT_BUCKET = '/mnt/bucket';
const MOUNT_RO = '/mnt/bucket-ro';
const MOUNT_LINK = '/mnt/byo';
const MOUNT_GIT = '/mnt/repo';

// ── helpers ─────────────────────────────────────────────────────────────────

type CmdResult = { exitCode: number; stdout: string; stderr: string };
type Sandbox = {
  runCmd: (
    c: string,
    o?: object,
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
};

async function sh(sandbox: Sandbox, cmd: string): Promise<CmdResult> {
  const res = await sandbox.runCmd('sh', { args: ['-c', cmd], timeout: 60 });
  return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
}

async function waitStatus(
  client: GravixLayer,
  id: string,
  want = 'running',
  timeoutS = 240,
): Promise<string> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const st = (await client.runtime.get(id)).status;
    if (st === want) return st;
    if (['error', 'killed', 'stopped', 'dead'].includes(st)) {
      throw new Error(`runtime ${id} reached ${st} (wanted ${want})`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`runtime ${id} not ${want} within ${timeoutS}s`);
}

async function waitAttachment(
  client: GravixLayer,
  id: string,
  path: string,
  want = 'attached',
  timeoutS = 180,
) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const { mounts } = await client.storage.mounts.list(id);
    const m = mounts.find((x) => x.mountPath === path && x.state === want);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`no ${want} attachment at ${path} on ${id}`);
}

// ── suite ───────────────────────────────────────────────────────────────────

const e2e = describe.skipIf(!(E2E && API_KEY));

e2e('storage mounts e2e', () => {
  let client!: GravixLayer;
  beforeAll(() => {
    client = new GravixLayer({ apiKey: API_KEY, baseUrl: BASE_URL });
  });
  const runtimeIds: string[] = [];
  const bucketIds: string[] = [];
  const providerIds: string[] = [];

  // Kill runtimes first (mounts detach) — buckets refuse delete while
  // mounted. Everything is best-effort so teardown never masks a failure.
  afterAll(async () => {
    for (const id of runtimeIds) {
      await client.runtime.kill(id).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2000));
    for (const id of bucketIds) await client.storage.buckets.delete(id).catch(() => {});
    for (const id of providerIds) {
      await client.identity.providers.delete(id).catch(() => {});
    }
  });

  it('managed bucket: create → rw mount → guest ops → cross-runtime read → ro enforcement', async () => {
    const bucket = await client.storage.buckets.create(`e2e-${RUN_ID}`, {
      region: TEST_BUCKET_REGION,
      ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
    });
    bucketIds.push(bucket.id);
    // poll to active
    const deadline = Date.now() + 240_000;
    let status = bucket.status;
    while (Date.now() < deadline && status !== 'active' && status !== 'failed') {
      await new Promise((r) => setTimeout(r, 3000));
      status = (await client.storage.buckets.get(bucket.id)).status;
    }
    expect(status).toBe('active');

    const sandbox = await client.runtime.create({
      template: TEMPLATE,
      mounts: [{ kind: 'bucket', path: MOUNT_BUCKET, bucket: bucket.id, mode: 'rw' }],
    });
    runtimeIds.push(sandbox.runtimeId);
    await waitStatus(client, sandbox.runtimeId);

    const att = await waitAttachment(client, sandbox.runtimeId, MOUNT_BUCKET);
    expect(att.kind).toBe('bucket');
    expect(att.mode).toBe('rw');
    expect(att.targetId).toBe(bucket.id);

    const r = await sh(
      sandbox,
      `echo hello-${RUN_ID} > ${MOUNT_BUCKET}/probe.txt && sync && ` +
        `cat ${MOUNT_BUCKET}/probe.txt && mkdir ${MOUNT_BUCKET}/d && ` +
        `mv ${MOUNT_BUCKET}/probe.txt ${MOUNT_BUCKET}/d/m.txt && ` +
        `cat ${MOUNT_BUCKET}/d/m.txt && rm ${MOUNT_BUCKET}/d/m.txt && ` +
        `rmdir ${MOUNT_BUCKET}/d && echo DONE`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`hello-${RUN_ID}`);

    // credential hygiene — nothing sensitive in the guest environment
    const env = await sh(sandbox, "env; cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'; true");
    if (AWS_KEY) expect(env.stdout).not.toContain(AWS_KEY);
    if (AWS_SECRET) expect(env.stdout).not.toContain(AWS_SECRET);

    // second runtime on the same bucket — the object really is in S3
    await sh(sandbox, `echo p2-${RUN_ID} > ${MOUNT_BUCKET}/p2.txt && sync`);
    const s2 = await client.runtime.create({
      template: TEMPLATE,
      mounts: [{ kind: 'bucket', path: MOUNT_RO, bucket: bucket.id, mode: 'ro' }],
    });
    runtimeIds.push(s2.runtimeId);
    await waitStatus(client, s2.runtimeId);
    await waitAttachment(client, s2.runtimeId, MOUNT_RO);
    const rd = await sh(s2, `cat ${MOUNT_RO}/p2.txt`);
    expect(rd.stdout).toContain(`p2-${RUN_ID}`);
    const wr = await sh(s2, `touch ${MOUNT_RO}/nope 2>&1`);
    expect(wr.exitCode).not.toBe(0);
  }, 600_000);

  it('external bucket: static creds → verify → rw mount → write lands', async () => {
    if (!HAS_LINK_CREDS) return;
    const provider = await client.identity.providers.create(`e2e-aws-${RUN_ID}`, {
      secrets: [
        { key: 'AWS_ACCESS_KEY_ID', value: AWS_KEY },
        { key: 'AWS_SECRET_ACCESS_KEY', value: AWS_SECRET },
      ],
      ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
    });
    providerIds.push(provider.id);

    const link = await client.storage.buckets.connect(`e2e-bucket-${RUN_ID}`, TEST_BUCKET, {
      provider: 's3',
      region: TEST_BUCKET_REGION,
      authMode: 'static',
      secretProviderId: provider.id,
      accessKeySecret: 'AWS_ACCESS_KEY_ID',
      secretKeySecret: 'AWS_SECRET_ACCESS_KEY',
      ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
    });
    bucketIds.push(link.id);

    const verified = await client.storage.buckets.verify(link.id);
    expect(verified.verifyError ?? '').toBe('');

    const sandbox = await client.runtime.create({
      template: TEMPLATE,
      mounts: [{ kind: 'bucket', path: MOUNT_LINK, bucket: link.id, mode: 'rw' }],
    });
    runtimeIds.push(sandbox.runtimeId);
    await waitStatus(client, sandbox.runtimeId);
    await waitAttachment(client, sandbox.runtimeId, MOUNT_LINK);
    const r = await sh(
      sandbox,
      `echo link-${RUN_ID} > ${MOUNT_LINK}/via-link.txt && sync && cat ${MOUNT_LINK}/via-link.txt`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`link-${RUN_ID}`);
  }, 600_000);

  it('git mount: public repo materializes read-only; bad url required=false still boots', async () => {
    if (!HAS_PUBLIC_REPO) return;
    const sandbox = await client.runtime.create({
      template: TEMPLATE,
      mounts: [
        { kind: 'git', path: MOUNT_GIT, url: PUBLIC_REPO, depth: 1 },
        {
          kind: 'git',
          path: '/mnt/bad',
          url: 'https://invalid.invalid/nope.git',
          required: false,
        },
      ],
    });
    runtimeIds.push(sandbox.runtimeId);
    await waitStatus(client, sandbox.runtimeId);
    const att = await waitAttachment(client, sandbox.runtimeId, MOUNT_GIT);
    expect(att.kind).toBe('git');

    const r = await sh(sandbox, `ls ${MOUNT_GIT}`);
    expect(r.exitCode).toBe(0);
    const dotgit = await sh(sandbox, `test -d ${MOUNT_GIT}/.git`);
    expect(dotgit.exitCode).not.toBe(0);
    const wr = await sh(sandbox, `touch ${MOUNT_GIT}/w.txt 2>&1`);
    expect(wr.exitCode).not.toBe(0);
  }, 600_000);

  it('private git mount: credential references never reach the guest', async () => {
    if (!(HAS_PRIVATE_REPO && HAS_LINK_CREDS)) return;
    const provider = await client.identity.providers.create(`e2e-git-${RUN_ID}`, {
      secrets: [{ key: 'GIT_TOKEN', value: GIT_TOKEN }],
      ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
    });
    providerIds.push(provider.id);
    const sandbox = await client.runtime.create({
      template: TEMPLATE,
      mounts: [
        {
          kind: 'git',
          path: '/mnt/priv',
          url: PRIVATE_REPO,
          credentialProvider: provider.id,
          credentialSecret: 'GIT_TOKEN',
        },
      ],
    });
    runtimeIds.push(sandbox.runtimeId);
    await waitStatus(client, sandbox.runtimeId);
    await waitAttachment(client, sandbox.runtimeId, '/mnt/priv');
    const env = await sh(sandbox, "env; cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n'; true");
    if (GIT_TOKEN) expect(env.stdout).not.toContain(GIT_TOKEN);
  }, 600_000);

  it('lifecycle: pause/resume preserves mount; kill detaches', async () => {
    const bucket = await client.storage.buckets.create(`e2e-life-${RUN_ID}`, {
      region: TEST_BUCKET_REGION,
      ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
    });
    bucketIds.push(bucket.id);
    const sandbox = await client.runtime.create({
      template: TEMPLATE,
      mounts: [{ kind: 'bucket', path: MOUNT_BUCKET, bucket: bucket.id, mode: 'rw' }],
    });
    runtimeIds.push(sandbox.runtimeId);
    await waitStatus(client, sandbox.runtimeId);
    await waitAttachment(client, sandbox.runtimeId, MOUNT_BUCKET);
    await sh(sandbox, `echo pause-${RUN_ID} > ${MOUNT_BUCKET}/p.txt && sync`);

    await sandbox.pause();
    await waitStatus(client, sandbox.runtimeId, 'paused');
    await sandbox.resume();
    await waitStatus(client, sandbox.runtimeId, 'running');
    const rd = await sh(sandbox, `cat ${MOUNT_BUCKET}/p.txt`);
    expect(rd.stdout).toContain(`pause-${RUN_ID}`);

    await client.runtime.kill(sandbox.runtimeId);
    runtimeIds.splice(runtimeIds.indexOf(sandbox.runtimeId), 1);
    const deadline = Date.now() + 90_000;
    let detached = false;
    while (Date.now() < deadline) {
      const { mounts } = await client.storage.mounts.list(sandbox.runtimeId);
      if (mounts.length > 0 && mounts.every((m) => m.state !== 'attached')) {
        detached = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(detached).toBe(true);
  }, 600_000);
});
