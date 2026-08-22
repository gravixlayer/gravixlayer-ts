/**
 * Run JavaScript in a runtime.
 *
 * The base templates ship both Python and Node, so the same template that runs
 * Python also runs JavaScript. Pick the interpreter with `language`.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/02-node-runtime.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const runtime = await client.runtimes.create({ template: TEMPLATE });
console.log(`Runtime    : ${runtime.runtimeId}`);

// Which Node is installed?
const version = await runtime.runCmd('node -v');
console.log(`Node       : ${version.stdout.trim()}`);

// Run a script through the Node interpreter.
const info = await runtime.runCode(
  `const os = require('os');
   console.log(JSON.stringify({ platform: os.platform(), cpus: os.cpus().length }, null, 2));`,
  { language: 'javascript' },
);
console.log(`\nSystem info:\n${info.stdout}`);

// Asynchronous code works the same way; the call returns when the script does.
const timed = await runtime.runCode(
  `const start = Date.now();
   await new Promise((resolve) => setTimeout(resolve, 100));
   console.log(\`waited \${Date.now() - start}ms\`);`,
  { language: 'javascript' },
);
console.log(`Async      : ${timed.stdout.trim()}`);

await runtime.kill();
console.log('\nRuntime terminated.');
