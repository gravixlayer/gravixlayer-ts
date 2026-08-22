/**
 * Create a sandbox, look at it, and shut it down.
 *
 * A sandbox is an isolated virtual machine that boots from a template and runs
 * whatever you send it. Cloud and region default to `aws` / `us-east-1`, and a
 * sandbox with no timeout runs until you stop it.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/01-create-runtime.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

// Boot a sandbox. This resolves once the guest is up and ready for work.
const sandbox = await client.runtime.create({ template: TEMPLATE });

console.log(`Runtime ID : ${sandbox.runtimeId}`);
console.log(`Status     : ${sandbox.status}`);
console.log(`Template   : ${sandbox.template}`);
console.log(`CPU        : ${sandbox.cpuCount}`);
console.log(`Memory     : ${sandbox.memoryMb} MB`);

// The handle caches the state it was created with. `refresh()` re-reads it.
await sandbox.refresh();
console.log(`\nAfter refresh: status=${sandbox.status} startedAt=${sandbox.startedAt}`);

// Always stop a sandbox you are finished with.
await sandbox.kill();
console.log('\nRuntime terminated.');
