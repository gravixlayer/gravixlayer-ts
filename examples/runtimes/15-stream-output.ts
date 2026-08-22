/**
 * Watch output arrive instead of waiting for it.
 *
 * Two shapes, same transport underneath. Pass callbacks to `runCmd` to keep the
 * single aggregated result while seeing output as it is produced, or use
 * `streamCmd` to consume events with `for await`.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/15-stream-output.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const runtime = await client.runtime.create({ template: TEMPLATE });
console.log(`Runtime    : ${runtime.runtimeId}`);

// 1. Callbacks. The promise still resolves with the full result, so existing
//    code that reads `stdout` and `exitCode` keeps working unchanged.
console.log('\n--- callbacks ---');
const result = await runtime.runCmd("sh -lc 'for i in 1 2 3; do echo line-$i; sleep 1; done'", {
  onStdout: (chunk) => process.stdout.write(chunk),
  onStderr: (chunk) => process.stderr.write(chunk),
  onExit: (code) => console.log(`[finished with ${code}]`),
});
console.log(`Aggregated : exit=${result.exitCode}, ${result.stdout.length} bytes of stdout`);

// 2. An async iterator, when you would rather drive the loop yourself. Breaking
//    out of it cancels the request.
console.log('\n--- for await ---');
for await (const event of runtime.streamCmd("sh -lc 'echo one; echo two; echo three'")) {
  if (event.type === 'stdout') process.stdout.write(event.data);
  else if (event.type === 'stderr') process.stderr.write(event.data);
  else if (event.type === 'end') console.log(`[exit ${event.exitCode}]`);
  else console.log(`[error: ${event.message}]`);
}

// 3. Code executions stream too, and carry rich results as well as text.
console.log('\n--- streaming code ---');
for await (const event of runtime.streamCode(
  'import time\nfor i in range(3):\n    print(f"step {i}")\n    time.sleep(0.5)',
)) {
  if (event.type === 'stdout') process.stdout.write(event.text);
  else if (event.type === 'error') console.log(`[error: ${event.error.value}]`);
}

await runtime.kill();
console.log('\nRuntime terminated.');
