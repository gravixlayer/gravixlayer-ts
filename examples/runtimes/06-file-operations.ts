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

const runtime = await client.runtimes.create({ template: TEMPLATE });
console.log(`Runtime    : ${runtime.runtimeId}\n`);

// 1. Write and read text.
await runtime.files.write('/home/user/hello.txt', 'Hello from the SDK.\nSecond line.');
const hello = await runtime.files.read('/home/user/hello.txt');
console.log(`Read       : ${hello.content.split('\n')[0]}`);

// 2. Create a directory. Parents are created too, unless you say otherwise.
await runtime.files.createDirectory('/home/user/project/src');

// 3. Write a file into it and list the directory.
await runtime.files.write('/home/user/project/src/main.py', 'print("version 1.0")\n');
const listing = await runtime.files.list('/home/user/project/src');
for (const entry of listing.files) {
  console.log(`  ${entry.isDir ? '[dir] ' : '      '}${entry.name}  (${entry.size} bytes)`);
}

// 4. Upload sends the body as multipart, which suits binary and large files.
await runtime.files.upload('/home/user/project/config.json', '{"debug": true, "port": 8080}');

// 5. Several files in one request. Each entry can carry its own mode.
const batch = await runtime.files.writeMany([
  { path: '/home/user/project/README.md', data: '# My project\n' },
  { path: '/home/user/project/run.sh', data: '#!/bin/sh\npython src/main.py\n' },
]);
console.log(`\nBatch      : wrote ${batch.files.length} file(s)`);

// 6. Metadata and permissions.
const before = await runtime.files.getInfo('/home/user/project/run.sh');
console.log(`Info       : exists=${before.exists} mode=${before.info?.mode}`);

await runtime.files.setPermissions('/home/user/project/run.sh', '0755');
const after = await runtime.files.getInfo('/home/user/project/run.sh');
console.log(`After chmod: mode=${after.info?.mode}`);

// 7. Download bytes, or text if that is what the file holds.
const bytes = await runtime.files.download('/home/user/hello.txt');
console.log(`\nDownloaded : ${bytes.length} bytes`);
console.log(
  `As text    : ${(await runtime.files.downloadText('/home/user/hello.txt')).split('\n')[0]}`,
);

// 8. Move and copy. A directory needs `recursive`.
await runtime.files.move('/home/user/hello.txt', '/home/user/project/notes.txt');
await runtime.files.copy('/home/user/project/notes.txt', '/home/user/project/notes.bak');
await runtime.files.copy('/home/user/project/src', '/home/user/project/src-copy', {
  recursive: true,
});

// 9. Change ownership. Accepts names or numeric ids.
const owner = (await runtime.runCmd('id -un')).stdout.trim();
await runtime.files.chown('/home/user/project/src-copy', { user: owner, recursive: true });
console.log(`Owner      : /home/user/project/src-copy -> ${owner}`);

// 10. Search by filename, then by content. A pattern is literal text unless
//     you pass `regex: true`.
const byName = await runtime.files.find('/home/user/project', { glob: '*.py' });
console.log(`\nBy name    : ${byName.matches.length} file(s), scanned ${byName.filesScanned}`);

const byContent = await runtime.files.find('/home/user/project', { pattern: 'version' });
for (const match of byContent.matches) {
  console.log(`  ${match.path}:${match.line}:${match.column}  ${match.content.trim()}`);
}

// 11. Replace across files. Preview first, then apply.
const preview = await runtime.files.replace('/home/user/project', '1.0', '2.0', {
  glob: '*.py',
  dryRun: true,
});
console.log(`\nDry run    : would change ${preview.totalReplacements} occurrence(s)`);

const applied = await runtime.files.replace('/home/user/project', '1.0', '2.0', { glob: '*.py' });
console.log(`Replaced   : ${applied.totalReplacements} occurrence(s)`);

// 12. Watch a directory. The first event is always `start`, which tells you the
//     watcher is armed; changes made before it may not be reported.
const watched = '/home/user/project/watched.txt';
console.log('\nWatching   : /home/user/project');

let seen = 0;
for await (const event of runtime.files.watch('/home/user/project')) {
  if (event.type === 'start') {
    // Make some changes now that the watcher is listening. Not awaited, so the
    // loop below keeps consuming events while they happen.
    void (async () => {
      await runtime.files.write(watched, 'first');
      await runtime.files.write(watched, 'second');
      await runtime.files.delete(watched);
    })();
    continue;
  }

  console.log(`  ${event.type.padEnd(8)} ${event.name}`);
  seen += 1;
  if (seen >= 3) break;
}

await runtime.kill();
console.log('\nRuntime terminated.');
