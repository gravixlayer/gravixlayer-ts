/**
 * List templates, inspect one, and delete it.
 *
 * Deleting removes the image behind the template. Runtimes already started from
 * it keep running, but no new ones can be created.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/templates/05-list-and-delete.ts
 *
 * Optional: DELETE_TEMPLATE_ID=<id> to actually delete one.
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

console.log('--- Templates ---');
const { templates } = await client.templates.list();
console.log(`Total      : ${templates.length}\n`);

for (const template of templates) {
  console.log(
    `  ${template.id}  ${template.name.padEnd(28)} ${template.vcpuCount} vCPU | ${template.memoryMb} MB`,
  );
}

if (templates.length > 0) {
  const first = templates[0]!;
  const info = await client.templates.get(first.id);

  console.log(`\n--- ${info.name} ---`);
  console.log(`Description: ${info.description}`);
  console.log(`vCPU       : ${info.vcpuCount}`);
  console.log(`Memory     : ${info.memoryMb} MB`);
  console.log(`Disk       : ${info.diskSizeMb} MB`);
  console.log(`Visibility : ${info.visibility}`);
  console.log(`Created    : ${info.createdAt}`);

  // The stored image, and how large it is.
  const snapshot = await client.templates.getSnapshot(info.id);
  console.log(
    `Image      : ready=${snapshot.hasSnapshot} size=${snapshot.snapshotSizeBytes ?? 0} bytes`,
  );
}

// Deletion is opt-in, so running this example never destroys anything by
// accident.
const toDelete = process.env['DELETE_TEMPLATE_ID'];
if (toDelete) {
  const result = await client.templates.delete(toDelete);
  console.log(`\nDeleted    : ${result.templateId}`);
} else {
  console.log('\nSet DELETE_TEMPLATE_ID=<id> to delete a template.');
}
