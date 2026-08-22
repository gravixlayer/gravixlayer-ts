/**
 * Run Python code.
 *
 * `runCode` sends a snippet to the runtime's interpreter and returns everything
 * it produced: standard output, standard error, rich results, and the error if
 * the code raised.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/04-run-python-code.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const runtime = await client.runtimes.create({ template: TEMPLATE });
console.log(`Runtime    : ${runtime.runtimeId}`);

// 1. A single expression.
const sum = await runtime.runCode('print(2 + 2)');
console.log(`\nSimple     : ${sum.text.trim()}`);

// 2. A multi-line script with imports.
const script = await runtime.runCode(`
import json
import platform
import sys

print(json.dumps({
    "python": sys.version.split()[0],
    "platform": platform.platform(),
}, indent=2))
`);
console.log(`\nSystem info:\n${script.stdout}`);

// 3. Anything the code defines is gone when the call returns, unless you run it
//    in a context. See 08-code-contexts.ts for state that survives.
const fib = await runtime.runCode(`
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b

values = list(fibonacci(15))
print(f"First 15: {values}")
print(f"Sum: {sum(values)}")
`);
console.log(`\nFibonacci  :\n${fib.stdout}`);

// 4. A failure is reported rather than thrown, so you can inspect it.
const failed = await runtime.runCode('1 / 0');
console.log(`\nSucceeded  : ${failed.success}`);
console.log(`Error      : ${JSON.stringify(failed.error)}`);

await runtime.kill();
console.log('\nRuntime terminated.');
