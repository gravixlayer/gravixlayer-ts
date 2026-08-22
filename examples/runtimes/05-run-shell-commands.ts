/**
 * Run shell commands.
 *
 * `runCmd` takes either a full shell string or a command plus an explicit
 * argument list. Prefer the argument list whenever any part of the command
 * comes from user input, since nothing in it is interpreted by a shell.
 *
 * A guest cannot reach the internet unless a network policy allows it, so this
 * example attaches a temporary allow-all policy in order to install a package.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/05-run-shell-commands.ts
 */

import { GravixLayer, type Runtime } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const policy = await client.networkPolicies.create(`shell-example-${Date.now()}`, {
  egressMode: 'allow_all',
  description: 'Temporary egress for the shell-command example',
});

let runtime: Runtime | undefined;
try {
  runtime = await client.runtimes.create({
    template: TEMPLATE,
    networkPolicyIds: [policy.id],
    timeoutSeconds: 600,
  });
  console.log(`Runtime    : ${runtime.runtimeId}`);

  // 1. A full shell string. Pipes, redirects, and `&&` all work.
  const uname = await runtime.runCmd('uname -a');
  console.log(`\nuname      : ${uname.stdout.trim()}`);
  console.log(`exit code  : ${uname.exitCode}  (${uname.durationMs} ms)`);

  // 2. The same command as a program plus arguments.
  const listed = await runtime.runCmd('ls', { args: ['-la', '/home/user'] });
  console.log(`\nls -la /home/user:\n${listed.stdout}`);

  // 3. Run somewhere other than the default working directory.
  const cwd = await runtime.runCmd('pwd', { workingDir: '/tmp' });
  console.log(`pwd in /tmp: ${cwd.stdout.trim()}`);

  // 4. Installing a package needs egress, hence the policy above. Give slow
  //    commands a longer timeout than the default.
  const install = await runtime.runCmd('pip', {
    args: ['install', 'requests', '--quiet'],
    timeoutSeconds: 180,
  });
  console.log(`\npip install: exit=${install.exitCode}`);

  // 5. A failing command is reported, not thrown. Check `success`.
  const missing = await runtime.runCmd('ls', { args: ['/nonexistent'] });
  console.log(`\nFailure    : success=${missing.success} exit=${missing.exitCode}`);
  console.log(`stderr     : ${missing.stderr.trim()}`);
} finally {
  await runtime?.kill();
  await client.networkPolicies.delete(policy.id);
  console.log('\nRuntime terminated and policy removed.');
}
