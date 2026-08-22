/**
 * SSH into a runtime.
 *
 * Enabling SSH returns a ready-to-paste command and, the first time, a private
 * key. The key is shown once — save it or rotate it. Disabling revokes access
 * immediately without disturbing anything running inside the guest.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/12-ssh-access.ts
 */

import { chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const runtime = await client.runtimes.create({ template: TEMPLATE, timeoutSeconds: 1800 });
console.log(`Runtime    : ${runtime.runtimeId}`);

// 1. Turn on SSH.
const ssh = await runtime.enableSsh();
console.log(`\nUser       : ${ssh.username}`);
console.log(`Port       : ${ssh.port}`);
console.log(`Connect    : ${ssh.connectCmd}`);

// 2. Save the private key with owner-only permissions, which is what ssh
//    insists on before it will use a key file.
if (ssh.privateKey) {
  const keyPath = join(homedir(), `.gravixlayer-${runtime.runtimeId}.pem`);
  await writeFile(keyPath, ssh.privateKey, 'utf8');
  await chmod(keyPath, 0o600);
  console.log(`Key saved  : ${keyPath}`);
}

// 3. Check whether the daemon is accepting connections.
const status = await runtime.sshStatus();
console.log(`\nStatus     : enabled=${status.enabled} listening=${status.daemonRunning}`);

// 4. Revoke access.
await runtime.disableSsh();
const revoked = await runtime.sshStatus();
console.log(`After off  : enabled=${revoked.enabled} listening=${revoked.daemonRunning}`);

// 5. Turning it back on reuses the existing key. Pass `regenerateKeys` to
//    issue a new one and invalidate the old.
await runtime.enableSsh();
const rotated = await runtime.enableSsh({ regenerateKeys: true });
console.log(`Rotated    : enabled=${rotated.enabled}, new key=${Boolean(rotated.privateKey)}`);

await runtime.kill();
console.log('\nRuntime terminated.');
