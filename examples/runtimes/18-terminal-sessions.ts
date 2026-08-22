/**
 * Drive a real terminal inside a runtime.
 *
 * A terminal session is owned by the runtime, not by the client that opened it,
 * so the shell keeps running after you disconnect and you can attach again
 * later from anywhere. A handle wraps the session: it holds the output stream,
 * buffers what it receives, and tracks the exit status.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/18-terminal-sessions.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const decoder = new TextDecoder();
const show = (chunk: Uint8Array) => process.stdout.write(decoder.decode(chunk));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runtime = await client.runtimes.create({ template: TEMPLATE });
console.log(`Runtime    : ${runtime.runtimeId}`);

// 1. Start a session with the shell, size, and environment you want.
const session = await runtime.pty.create({
  shell: '/bin/bash',
  workingDir: '/workspace',
  environment: { DEMO: 'terminal' },
  cols: 100,
  rows: 30,
});
console.log(
  `Session    : ${session.sessionId} (pid ${session.pid}, ${session.cols}x${session.rows})`,
);

// 2. Attach. Output arrives through the callback and is buffered on the handle.
const terminal = runtime.pty.handle(session.sessionId).connect({ onData: show });
console.log('\n--- attached ---');

// 3. Type into it.
await terminal.sendInput('echo hello from $DEMO\n');
await terminal.sendInput('pwd\n');
await pause(1500);

// 4. Resizing sends the usual window-change signal to the foreground process.
await terminal.resize(120, 40);
await terminal.sendInput('stty size\n');
await pause(1000);

// 5. Interrupt a long-running command without killing the shell. Sending the
//    interrupt character is exactly what pressing Ctrl-C does: the terminal
//    turns it into a signal for the job in the foreground, so the shell that
//    started it survives.
await terminal.sendInput('sleep 60\n');
await pause(500);
await terminal.sendInput('\x03');
await pause(1000);
console.log('\n--- interrupted, the shell is still alive ---');

// 6. Detaching leaves the session running.
await terminal.disconnect();
const survived = await runtime.pty.get(session.sessionId);
console.log(`Detached   : session is still ${survived.status}`);

const sessions = await runtime.pty.list();
console.log(`Sessions   : ${sessions.length}`);

// 7. Attaching again replays the retained scrollback, then continues live.
const reattached = runtime.pty.handle(session.sessionId).connect({ onData: show });
console.log('\n--- re-attached ---');
await reattached.sendInput('echo back in the same shell\n');
await pause(1000);

// 8. Let the shell exit and wait for its status.
await reattached.sendInput('exit 7\n');
const finished = await reattached.waitForExit(30_000);
console.log(`\nFinished   : status=${finished.status} exit=${finished.exitCode}`);
await reattached.disconnect();

// 9. Signals can also be sent out of band, without attaching. `HUP` is the one
//    a terminal sends when it goes away, and a shell exits on it.
const scratch = await runtime.pty.create({ shell: '/bin/bash' });
await runtime.pty.handle(scratch.sessionId).sendSignal('HUP');
await pause(1000);
console.log(`\nScratch    : ${(await runtime.pty.get(scratch.sessionId)).status}`);

// 10. Killing a session ends it if it is still running, and releases it either way.
console.log(`Released   : ${await runtime.pty.kill(scratch.sessionId)}`);

await runtime.kill();
console.log('\nRuntime terminated.');
