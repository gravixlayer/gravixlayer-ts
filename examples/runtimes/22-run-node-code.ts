/**
 * Run JavaScript in a sandbox.
 *
 * Base templates include Node as well as Python. Pass `language: 'javascript'`
 * to `runCode`. A program that should be its own process goes through `runCmd`.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/22-run-node-code.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();
const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const sandbox = await client.runtime.create({ template: TEMPLATE });
console.log(`Runtime    : ${sandbox.runtimeId}`);

// 1. A one-line script.
const hello = await sandbox.runCode("console.log('Hello from Node.js')", {
  language: 'javascript',
});
console.log(`\nHello      : ${hello.text.trim()}`);

// 2. A script that uses a built-in module.
const info = await sandbox.runCode(
  `
const os = require('os');
console.log(JSON.stringify({
  platform: os.platform(),
  cpus: os.cpus().length,
}));
`,
  { language: 'javascript' },
);
console.log(`\nSystem     : ${info.text.trim()}`);

// 3. A file run as its own process.
await sandbox.file.write('/workspace/demo.js', "console.log(JSON.stringify({ status: 'ok' }))\n");
const ran = await sandbox.runCmd('node', { args: ['/workspace/demo.js'] });
console.log(`\nnode demo  : exit=${ran.exitCode} ${ran.stdout.trim()}`);

await sandbox.kill();
console.log('\nRuntime terminated.');
