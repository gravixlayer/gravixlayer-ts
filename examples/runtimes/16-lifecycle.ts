/**
 * The sandbox lifecycle: create, pause, resume, stop.
 *
 *   create()  ->  running
 *   pause()   ->  paused      the machine is frozen and stops accruing cost
 *   resume()  ->  running     restored exactly as it was
 *   kill()    ->  terminated
 *
 * Pausing freezes the whole machine, so anything running inside it — including
 * an interpreter holding your variables — comes back untouched.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/16-lifecycle.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const sandbox = await client.runtime.create({ template: TEMPLATE, timeoutSeconds: 1800 });
console.log(`1. Created : ${sandbox.runtimeId} (${sandbox.status})`);

// Put some state in the interpreter and on disk.
const context = await sandbox.createContext();
await sandbox.runCode('answer = 42', { contextId: context.contextId });
await sandbox.file.write('/workspace/state.txt', 'written before pausing');
console.log('2. Working : set a variable and wrote a file');

await sandbox.pause();
await sandbox.refresh();
console.log(`3. Paused  : ${sandbox.status}`);

await sandbox.resume();
await sandbox.refresh();
console.log(`4. Resumed : ${sandbox.status}`);

// Both survive, because the machine itself was frozen rather than restarted.
const variable = await sandbox.runCode('print(f"answer is still {answer}")', {
  contextId: context.contextId,
});
console.log(`5. Memory  : ${variable.stdout.trim()}`);
console.log(`   Disk    : ${(await sandbox.file.read('/workspace/state.txt')).content}`);

await sandbox.kill();
console.log(`6. Stopped : alive=${await sandbox.isAlive()}`);
