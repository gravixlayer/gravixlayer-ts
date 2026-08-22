/**
 * Create a runtime, look at it, and shut it down.
 *
 * A runtime is an isolated virtual machine that boots from a template and runs
 * whatever you send it. Cloud and region default to `aws` / `us-east-1`, and a
 * runtime with no timeout runs until you stop it.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/01-create-runtime.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

// Boot a runtime. This resolves once the guest is up and ready for work.
const runtime = await client.runtimes.create({ template: TEMPLATE });

console.log(`Runtime ID : ${runtime.runtimeId}`);
console.log(`Status     : ${runtime.status}`);
console.log(`Template   : ${runtime.template}`);
console.log(`CPU        : ${runtime.cpuCount}`);
console.log(`Memory     : ${runtime.memoryMb} MB`);

// The handle caches the state it was created with. `refresh()` re-reads it.
await runtime.refresh();
console.log(`\nAfter refresh: status=${runtime.status} startedAt=${runtime.startedAt}`);

// Always stop a runtime you are finished with.
await runtime.kill();
console.log('\nRuntime terminated.');
