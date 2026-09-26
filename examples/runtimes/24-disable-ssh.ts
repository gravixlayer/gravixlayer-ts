/**
 * Turn SSH off.
 *
 * Disabling SSH stops new logins. It does not stop anything already running
 * in the sandbox.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/24-disable-ssh.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();
const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const sandbox = await client.runtime.create({ template: TEMPLATE, timeoutSeconds: 1800 });

// 1. Turn SSH on and read the status.
await sandbox.enableSsh();
const before = await sandbox.sshStatus();
console.log(`before     : enabled=${before.enabled} listening=${before.daemonRunning}`);

// 2. Turn it off. New logins stop. The sandbox keeps running.
await sandbox.disableSsh();
const after = await sandbox.sshStatus();
console.log(`after      : enabled=${after.enabled} listening=${after.daemonRunning}`);

await sandbox.kill();
console.log('\nRuntime terminated.');
