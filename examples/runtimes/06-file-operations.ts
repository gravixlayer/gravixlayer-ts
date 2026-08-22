/**
 * The guest filesystem.
 *
 * Covers read and write, directories, uploads and downloads, metadata and
 * permissions, move and copy, search and replace, and watching for changes.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/06-file-operations.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';

const runtime = await client.runtime.create({ template: TEMPLATE });
console.log(`Runtime    : ${runtime.runtimeId}\n`);

// 1. Write and read text.
await runtime.file.write('/workspace/hello.txt', 'Hello from the SDK.\nSecond line.');
const hello = await runtime.file.read('/workspace/hello.txt');
console.log(`Read       : ${hello.content.split('\n')[0]}`);

// 2. Create a directory. Parents are created too, unless you say otherwise.
await runtime.file.createDirectory('/workspace/project/src');

// 3. Write a file into it and list the directory.
await runtime.file.write('/workspace/project/src/main.py', 'print("version 1.0")\n');
const listing = await runtime.file.list('/workspace/project/src');
for (const entry of listing.files) {
  console.log(`  ${entry.isDir ? '[dir] ' : '      '}${entry.name}  (${entry.size} bytes)`);
}

// 4. Upload sends the body as multipart, which suits binary and large files.
await runtime.file.upload('/workspace/project/config.json', '{"debug": true, "port": 8080}');

// 5. Several files in one request. Each entry can carry its own mode.
const batch = await runtime.file.writeMany([
  { path: '/workspace/project/README.md', data: '# My project\n' },
  { path: '/workspace/project/run.sh', data: '#!/bin/sh\npython src/main.py\n' },
]);
console.log(`\nBatch      : wrote ${batch.files.length} file(s)`);

// 6. Metadata and permissions.
const before = await runtime.file.getInfo('/workspace/project/run.sh');
console.log(`Info       : exists=${before.exists} mode=${before.info?.mode}`);

await runtime.file.setPermissions('/workspace/project/run.sh', '0755');
const after = await runtime.file.getInfo('/workspace/project/run.sh');
console.log(`After chmod: mode=${after.info?.mode}`);

// 7. Download bytes, or text if that is what the file holds.
const bytes = await runtime.file.download('/workspace/hello.txt');
console.log(`\nDownloaded : ${bytes.length} bytes`);
console.log(
  `As text    : ${(await runtime.file.downloadText('/workspace/hello.txt')).split('\n')[0]}`,
);

// 8. Move and copy. A directory needs `recursive`.
await runtime.file.move('/workspace/hello.txt', '/workspace/project/notes.txt');
await runtime.file.copy('/workspace/project/notes.txt', '/workspace/project/notes.bak');
await runtime.file.copy('/workspace/project/src', '/workspace/project/src-copy', {
  recursive: true,
});

// 9. Change ownership. Accepts names or numeric ids.
const owner = (await runtime.runCmd('id -un')).stdout.trim();
await runtime.file.chown('/workspace/project/src-copy', { user: owner, recursive: true });
console.log(`Owner      : /workspace/project/src-copy -> ${owner}`);

// 10. Search by filename, then by content. A pattern is literal text unless
//     you pass `regex: true`.
const byName = await runtime.file.find('/workspace/project', { glob: '*.py' });
console.log(`\nBy name    : ${byName.matches.length} file(s), scanned ${byName.filesScanned}`);

const byContent = await runtime.file.find('/workspace/project', { pattern: 'version' });
for (const match of byContent.matches) {
  console.log(`  ${match.path}:${match.line}:${match.column}  ${match.content.trim()}`);
}

// 11. Replace across files. Preview first, then apply.
const preview = await runtime.file.replace('/workspace/project', '1.0', '2.0', {
  glob: '*.py',
  dryRun: true,
});
console.log(`\nDry run    : would change ${preview.totalReplacements} occurrence(s)`);

const applied = await runtime.file.replace('/workspace/project', '1.0', '2.0', { glob: '*.py' });
console.log(`Replaced   : ${applied.totalReplacements} occurrence(s)`);

// 12. Watch a directory. The first event is always `start`, which tells you the
//     watcher is armed; changes made before it may not be reported.
const watched = '/workspace/project/watched.txt';
console.log('\nWatching   : /workspace/project');

let seen = 0;
let changes: Promise<void> | undefined;

for await (const event of runtime.file.watch('/workspace/project')) {
  if (event.type === 'start') {
    // Make some changes now that the watcher is listening. Not awaited, so the
    // loop below keeps consuming events while they happen.
    changes = (async () => {
      await runtime.file.write(watched, 'first');
      await runtime.file.write(watched, 'second');
      await runtime.file.delete(watched);
    })();
    continue;
  }

  console.log(`  ${event.type.padEnd(8)} ${event.name}`);
  seen += 1;
  if (seen >= 3) break;
}

// Leaving the loop stops the watch, but the changes above can still be in
// flight. Let them finish before the runtime goes away.
await changes;

await runtime.kill();
console.log('\nRuntime terminated.');
