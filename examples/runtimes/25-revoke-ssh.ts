/**
 * Turn SSH off, then back on, then rotate the key.
 *
 * Enabling again reuses the current key. `regenerateKeys` issues a new key
 * and invalidates the old one.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/25-revoke-ssh.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();
const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const sandbox = await client.runtime.create({ template: TEMPLATE, timeoutSeconds: 1800 });

// 1. Turn SSH on.
const enabled = await sandbox.enableSsh();
console.log(`enabled    : ${enabled.enabled} user=${enabled.username}`);

// 2. Turn it off.
await sandbox.disableSsh();
console.log('revoked');

// 3. Turn it back on. The current key is reused.
const restored = await sandbox.enableSsh();
console.log(`re-enabled : ${restored.enabled}`);

// 4. Rotate the key. The previous key stops working.
const rotated = await sandbox.enableSsh({ regenerateKeys: true });
console.log(`rotated    : ${rotated.enabled} new key=${Boolean(rotated.privateKey)}`);

await sandbox.kill();
console.log('\nRuntime terminated.');
