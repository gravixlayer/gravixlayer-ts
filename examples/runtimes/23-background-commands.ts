/**
 * Start a command and come back to it later.
 *
 * `background: true` returns as soon as the process is running. The command
 * keeps running after that call returns. `wait` reads its output until it
 * exits. `kill` stops it. A later call can attach again with the pid.
 *
 * `timeoutSeconds: 0` sets no deadline on a background command.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/23-background-commands.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();
const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const sandbox = await client.runtime.create({ template: TEMPLATE });
console.log(`Runtime    : ${sandbox.runtimeId}`);

// 1. Start it and return immediately. The command keeps running.
const handle = await sandbox.runCmd("sh -lc 'echo started; sleep 2; echo finished'", {
  background: true,
  timeoutSeconds: 0,
});
console.log(`pid        : ${handle.pid}`);

// 2. See it in the running list.
const listed = await sandbox.command.list();
console.log(
  `running    : ${listed.filter((item) => item.status === 'running').map((item) => item.pid)}`,
);

// 3. Wait until it exits, then read the output.
const finished = await handle.wait();
console.log(`exit       : ${finished.exitCode}`);
console.log(`stdout     : ${finished.stdout.trim()}`);

// 4. Attach again with the pid. The output is still there.
if (handle.pid === null) {
  throw new Error('the command exited before it had a pid');
}
const again = await sandbox.command.connect(handle.pid);
console.log(`reattach   : ${again.stdout.trim()}`);

// 5. Stop a command that is still running.
const server = await sandbox.runCmd('sleep 30', { background: true, timeoutSeconds: 0 });
await server.kill();
console.log(`stopped    : ${(await server.refresh()).status}`);

await sandbox.kill();
console.log('\nRuntime terminated.');
