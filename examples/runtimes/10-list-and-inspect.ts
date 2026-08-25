/**
 * List templates and running runtimes.
 *
 * The building block for dashboards, inventory reports, and cleanup jobs.
 * Nothing here creates or destroys anything.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/10-list-and-inspect.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

// 1. Templates a sandbox can boot from.
console.log('--- Templates ---');
const templates = await client.runtime.templates.list();
for (const template of templates.templates) {
  console.log(
    `  ${template.name.padEnd(24)} ${template.vcpuCount} vCPU | ${template.memoryMb} MB | ${template.description}`,
  );
}

// 2. Runtimes currently on the account, one page at a time.
console.log('\n--- Runtimes ---');
const { runtimes, total } = await client.runtime.list({ limit: 50, offset: 0 });
console.log(`Total      : ${total}`);

if (runtimes.length === 0) {
  console.log('  (none running)');
} else {
  for (const sandbox of runtimes) {
    console.log(
      `  ${sandbox.runtimeId}  status=${sandbox.status.padEnd(10)} template=${sandbox.template}`,
    );
  }

  // 3. `retrieve` reads one sandbox's state without binding a handle to it.
  const first = runtimes[0]!;
  const info = await client.runtime.retrieve(first.runtimeId);
  console.log(`\n--- ${info.runtimeId} ---`);
  console.log(`Status     : ${info.status}`);
  console.log(`Template   : ${info.template}`);
  console.log(`CPU        : ${info.cpuCount ?? 'n/a'}`);
  console.log(`Memory     : ${info.memoryMb ? `${info.memoryMb} MB` : 'n/a'}`);
  console.log(`Started    : ${info.startedAt}`);
}
