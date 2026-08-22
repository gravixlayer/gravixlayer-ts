/**
 * Environment variables and metadata.
 *
 * `envVars` are set inside the guest and visible to every process in it.
 * `metadata` is stored alongside the sandbox and returned on every read, which
 * makes it useful for attributing runtimes to a project, owner, or job.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/03-env-and-metadata.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const sandbox = await client.runtime.create({
  template: TEMPLATE,
  envVars: {
    APP_ENV: 'staging',
    DEBUG: 'true',
    DATABASE_URL: 'postgres://localhost:5432/mydb',
  },
  metadata: {
    project: 'data-pipeline',
    owner: 'analytics-team',
    costCenter: 'eng-42',
  },
});

console.log(`Runtime ID : ${sandbox.runtimeId}`);
console.log(`Metadata   : ${JSON.stringify(sandbox.metadata)}`);

// The variables are visible to code...
const fromCode = await sandbox.runCode("import os; print(os.environ.get('APP_ENV', 'not set'))");
console.log(`\nAPP_ENV (code)  : ${fromCode.stdout.trim()}`);

// ...and to shell commands.
const fromShell = await sandbox.runCmd('echo "${DEBUG:-not set}"');
console.log(`DEBUG   (shell) : ${fromShell.stdout.trim()}`);

// A single command can also carry variables of its own, which apply only to it.
const perCommand = await sandbox.runCmd('echo "$GREETING"', {
  environment: { GREETING: 'set for this command only' },
});
console.log(`Per-command     : ${perCommand.stdout.trim()}`);

await sandbox.kill();
console.log('\nRuntime terminated.');
