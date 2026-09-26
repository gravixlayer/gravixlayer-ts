/**
 * Snapshot lifecycle.
 *
 * Capture a sandbox, restore a new one from it, then deactivate, activate,
 * and delete the snapshot.
 *
 *   cold  filesystem only. The new sandbox boots fresh.
 *   hot   filesystem and memory. The new sandbox resumes mid-process.
 *
 * The kind is chosen when you capture. Restore always creates a new sandbox.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/19-snapshot-lifecycle.ts
 *
 * Optional: GRAVIXLAYER_SNAPSHOT_KIND=cold,hot (the default), or cold, or hot.
 * Optional: GRAVIXLAYER_TEMPLATE (defaults to base-small).
 */

import { GravixLayer, GravixLayerBadRequestError, type Runtime } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';
const KIND_SPEC = (process.env['GRAVIXLAYER_SNAPSHOT_KIND'] ?? 'cold,hot').trim().toLowerCase();
const kinds = KIND_SPEC.split(',')
  .map((kind) => kind.trim())
  .filter((kind) => kind.length > 0);

if (kinds.length === 0 || kinds.some((kind) => kind !== 'cold' && kind !== 'hot')) {
  console.error(`GRAVIXLAYER_SNAPSHOT_KIND must be cold, hot, or cold,hot, got ${KIND_SPEC}`);
  process.exit(1);
}

const MARKER = '/workspace/checkpoint.txt';

let sandbox: Runtime | undefined;
const restored: Runtime[] = [];
const captured: string[] = [];

try {
  sandbox = await client.runtime.create({ template: TEMPLATE });
  console.log(`Source     : ${sandbox.runtimeId}`);
  console.log(`Kinds      : ${kinds.join(', ')}\n`);

  for (const kind of kinds) {
    const name = `demo-${kind}-${Date.now()}`;
    const capturedText = `state at ${kind} capture`;
    console.log(`--- ${kind} ---`);

    // 1. Put the sandbox into the state worth keeping.
    await sandbox.file.write(MARKER, capturedText);
    console.log(`Wrote      : ${capturedText}`);

    // 2. Capture it. The kind is chosen here, not when you restore.
    const snapshot = await client.snapshots.create(sandbox.runtimeId, name, {
      kind,
      description: `${kind} snapshot lifecycle example`,
    });
    captured.push(name);
    console.log(`Captured   : ${snapshot.name} (${snapshot.kind}, ${snapshot.sizeBytes} bytes)`);

    // 3. Change the source so the restore is not a copy of the live sandbox.
    await sandbox.file.write(MARKER, `mutated after ${kind} capture`);

    // 4. List and fetch the snapshot.
    const listed = await client.snapshots.list({ kind, runtimeId: sandbox.runtimeId });
    console.log(`Listed     : ${listed.total} snapshot(s) from this runtime`);
    const found = await client.snapshots.get(name);
    console.log(`Fetched    : ${found.id} state=${found.state} active=${found.isActive}`);

    // 5. Restore into a new sandbox and read the file back.
    const child = await client.runtime.create({ snapshot: name });
    restored.push(child);
    console.log(`Restored   : ${child.runtimeId}`);
    const contents = (await child.file.read(MARKER)).content;
    console.log(`Its disk   : ${contents}`);
    if (contents !== capturedText) {
      throw new Error(`${kind} restore did not replay the captured state.`);
    }

    // 6. Deactivate. New sandboxes are refused. Then turn it back on.
    await client.snapshots.deactivate(name);
    console.log('Deactivated: new runtimes are refused');
    try {
      const blocked = await client.runtime.create({ snapshot: name });
      await blocked.kill();
      throw new Error(`Expected the API to refuse an inactive ${kind} snapshot.`);
    } catch (error) {
      if (!(error instanceof GravixLayerBadRequestError)) throw error;
      console.log(`Refused    : ${error.message}`);
    }
    const active = await client.snapshots.activate(name);
    console.log(`Reactivated: state=${active.state} active=${active.isActive}`);

    // 7. Delete the snapshot and stop the restored sandbox.
    const deleted = await client.snapshots.delete(name);
    captured.splice(captured.indexOf(name), 1);
    console.log(`Deleted    : ${deleted.snapshotId}`);
    await child.kill();
    restored.splice(restored.indexOf(child), 1);
    console.log(`Stopped    : ${child.runtimeId}\n`);
  }
} finally {
  await Promise.all(restored.map((child) => child.kill()));
  await sandbox?.kill();
  await Promise.all(
    captured.map(async (name) => {
      try {
        await client.snapshots.delete(name);
        console.log(`Cleaned    : ${name}`);
      } catch {
        // Already deleted, or delete failed after the example stopped.
      }
    }),
  );
  console.log('Runtimes terminated.');
}
