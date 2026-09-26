/**
 * Print a line from inside a sandbox.
 *
 * After this script finishes, search that runtime's logs for the printed marker.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/26-runtime-logs.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();
const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';
const marker = `log-demo-${Date.now()}`;

const sandbox = await client.runtime.create({ template: TEMPLATE });
console.log(`Runtime    : ${sandbox.runtimeId}`);
console.log(`Marker     : ${marker}`);

// 1. Print a marker from inside the sandbox.
const result = await sandbox.runCmd('echo', { args: [marker] });
console.log(`stdout     : ${result.stdout.trim()}`);

// 2. Search this runtime's logs for the marker.

await sandbox.kill();
console.log('\nRuntime terminated.');
