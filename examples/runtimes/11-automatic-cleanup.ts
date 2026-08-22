/**
 * Stop a runtime automatically when the block ends.
 *
 * `await using` calls the runtime's disposer on the way out of the block, so it
 * is stopped whether the code finishes, returns early, or throws. It needs
 * TypeScript 5.2 or newer and a runtime with `Symbol.asyncDispose`, which means
 * Node 20 or newer. Everywhere else, use `try`/`finally` — shown at the bottom.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/11-automatic-cleanup.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

console.log('--- await using ---');
{
  await using runtime = await client.runtime.create({
    template: TEMPLATE,
    timeoutSeconds: 300,
  });

  console.log(`Runtime    : ${runtime.runtimeId}`);

  const greeting = await runtime.runCode('print("hello from a disposed runtime")');
  console.log(`Output     : ${greeting.stdout.trim()}`);

  await runtime.file.write('/workspace/greeting.txt', 'written inside the block');
  const file = await runtime.file.read('/workspace/greeting.txt');
  console.log(`File       : ${file.content}`);
}
console.log('Runtime terminated on the way out of the block.');

console.log('\n--- try/finally ---');
const runtime = await client.runtime.create({ template: TEMPLATE, timeoutSeconds: 300 });
try {
  const version = await runtime.runCmd('python --version');
  console.log(`Python     : ${version.stdout.trim()}`);
} finally {
  // `kill` is safe to call more than once, so this is safe even if the block
  // above already stopped the runtime.
  await runtime.kill();
}
console.log('Runtime terminated in the finally block.');
