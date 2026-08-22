/**
 * Read a runtime's resource usage.
 *
 * Each call samples CPU, memory, disk, and network counters at that instant.
 * Poll it to watch a workload, or read it once to size a template.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/08-metrics.ts
 */

import { GravixLayer, type RuntimeMetrics } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

function report(label: string, metrics: RuntimeMetrics): void {
  console.log(`\n--- ${label} ---`);
  console.log(`CPU        : ${metrics.cpuUsage.toFixed(1)}%`);
  console.log(`Memory     : ${mib(metrics.memoryUsage)} of ${mib(metrics.memoryTotal)}`);
  console.log(`Disk       : read ${mib(metrics.diskRead)}, written ${mib(metrics.diskWrite)}`);
  console.log(`Network    : in ${mib(metrics.networkRx)}, out ${mib(metrics.networkTx)}`);
  console.log(`Sampled at : ${metrics.timestamp}`);
}

const runtime = await client.runtimes.create({ template: TEMPLATE });
console.log(`Runtime    : ${runtime.runtimeId}`);

report('Idle', await runtime.getMetrics());

// Give it something to do, then sample again.
await runtime.runCode('sum(i * i for i in range(10_000_000))');
await new Promise((resolve) => setTimeout(resolve, 1000));

report('After a CPU-bound job', await runtime.getMetrics());

await runtime.kill();
console.log('\nRuntime terminated.');
