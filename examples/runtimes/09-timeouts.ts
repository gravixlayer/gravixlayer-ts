/**
 * Stop a runtime automatically.
 *
 * A runtime with no timeout runs until you stop it. Set one at creation to cap
 * the cost of work that might hang, and extend it later if the job is still
 * making progress. The maximum is 12 hours.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/09-timeouts.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

// Expire after two minutes unless something extends it.
const runtime = await client.runtimes.create({ template: TEMPLATE, timeoutSeconds: 120 });
console.log(`Runtime    : ${runtime.runtimeId}`);
console.log(`Expires at : ${runtime.timeoutAt}`);

// The job needs longer than expected, so push the deadline out.
const extended = await runtime.setTimeout(600);
console.log(`\nExtended   : ${extended.message}`);
console.log(`Expires at : ${extended.timeoutAt}`);

// Re-read the runtime to confirm.
await runtime.refresh();
console.log(`Confirmed  : ${runtime.timeoutAt}`);

await runtime.kill();
console.log('\nRuntime terminated.');
