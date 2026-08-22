/**
 * Pick up a runtime that is already running.
 *
 * A runtime outlives the process that created it. Store its id, and any other
 * process — a worker, a later request, another machine — can attach to it with
 * `connect` and use it exactly as if it had created it.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/13-reconnect.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

// Stand in for an earlier session: create a runtime and keep only its id.
const created = await client.runtime.create({ template: TEMPLATE, timeoutSeconds: 600 });
const savedId = created.runtimeId;
await created.runCode('marker = "written before reconnecting"');
console.log(`Created    : ${savedId}`);

// Later, elsewhere, with nothing but the id.
const runtime = await client.runtime.connect(savedId);
console.log(`Reconnected: ${runtime.runtimeId} (${runtime.status})`);

// Everything works as usual.
const uname = await runtime.runCmd('uname -a');
console.log(`\nuname      : ${uname.stdout.trim()}`);

await runtime.file.write('/workspace/reconnect.txt', 'written after reconnecting');
const file = await runtime.file.read('/workspace/reconnect.txt');
console.log(`File       : ${file.content}`);

// `get` fetches a handle without the connect round trip, when you already know
// the runtime is up.
const same = await client.runtime.get(savedId);
console.log(`Fetched    : ${same.runtimeId} (${same.status})`);

await runtime.kill();
console.log('\nRuntime terminated.');
