/**
 * Keep state between executions with a code context.
 *
 * Each `runCode` call is independent by default. A context is a live
 * interpreter session, so variables, imports, and function definitions stay
 * available across calls — the usual way to build up an analysis step by step.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/07-code-contexts.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const runtime = await client.runtimes.create({ template: TEMPLATE });
console.log(`Runtime    : ${runtime.runtimeId}`);

// Create the session. Everything below runs inside it.
const context = await runtime.createContext({ language: 'python' });
console.log(`Context    : ${context.contextId} (${context.language})`);

// 1. Define some data.
await runtime.runCode('data = [10, 20, 30, 40, 50]', { contextId: context.contextId });

// 2. A later call still sees it.
const stats = await runtime.runCode(
  "total = sum(data)\nprint(f'total={total} mean={total / len(data)}')",
  { contextId: context.contextId },
);
console.log(`\nComputed   : ${stats.stdout.trim()}`);

// 3. Functions persist too.
await runtime.runCode(
  `def describe(values):
    return {'count': len(values), 'min': min(values), 'max': max(values)}
`,
  { contextId: context.contextId },
);

const described = await runtime.runCode('import json; print(json.dumps(describe(data)))', {
  contextId: context.contextId,
});
console.log(`Describe   : ${described.stdout.trim()}`);

// 4. Without the context, the same code has nothing to work with.
const isolated = await runtime.runCode('print(data)');
console.log(`\nNo context : success=${isolated.success}`);

// 5. Inspect and then release the session.
const info = await runtime.getContext(context.contextId);
console.log(`\nContext    : language=${info.language} cwd=${info.cwd}`);

await runtime.deleteContext(context.contextId);
console.log('Context deleted.');

await runtime.kill();
console.log('\nRuntime terminated.');
