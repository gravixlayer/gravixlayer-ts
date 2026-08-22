/**
 * Save a sandbox and start new ones from it.
 *
 * Set a sandbox up once — dependencies installed, data loaded — capture it, and
 * every later sandbox created from that snapshot begins in exactly that state
 * instead of repeating the work.
 *
 *   cold  filesystem only. Smaller to store; the new sandbox boots fresh.
 *   hot   filesystem and memory. The new sandbox resumes mid-process.
 *
 * The kind is chosen when you capture, not when you restore.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/19-snapshots.ts
 *
 * Optional: GRAVIXLAYER_SNAPSHOT_KIND=cold|hot (defaults to cold)
 */

import { GravixLayer, GravixLayerBadRequestError, type Runtime } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';
const KIND = process.env['GRAVIXLAYER_SNAPSHOT_KIND'] ?? 'cold';
const MARKER = '/workspace/checkpoint.txt';
const NAME = `demo-${KIND}-${Date.now()}`;

let sandbox: Runtime | undefined;
let restored: Runtime | undefined;
let captured = false;

try {
  sandbox = await client.runtime.create({ template: TEMPLATE });
  console.log(`Source     : ${sandbox.runtimeId}`);

  // Put the sandbox into the state worth keeping.
  await sandbox.file.write(MARKER, 'state at capture time');

  // Capturing pauses the guest briefly, so it can take a while. The SDK already
  // allows for that with a longer request budget.
  const snapshot = await client.snapshots.create(sandbox.runtimeId, NAME, {
    kind: KIND,
    description: 'Snapshot lifecycle example',
  });
  captured = true;
  console.log(`Captured   : ${snapshot.name} (${snapshot.kind}, ${snapshot.sizeBytes} bytes)`);

  // Change the source afterwards, so the restore is clearly not just a copy of
  // whatever the source happens to look like now.
  await sandbox.file.write(MARKER, 'mutated after capture');

  const listed = await client.snapshots.list({ kind: KIND, runtimeId: sandbox.runtimeId });
  console.log(`Listed     : ${listed.total} snapshot(s) from this runtime`);

  const found = await client.snapshots.get(NAME);
  console.log(`Fetched    : ${found.id} state=${found.state} active=${found.isActive}`);

  // Restoring always produces a new sandbox. `snapshot` and `template` are
  // mutually exclusive, because a snapshot already carries its template.
  restored = await client.runtime.create({ snapshot: NAME });
  console.log(`\nRestored   : ${restored.runtimeId}`);

  const contents = (await restored.file.read(MARKER)).content;
  console.log(`Its disk   : ${contents}`);
  if (contents !== 'state at capture time') {
    throw new Error('The restored runtime did not replay the captured state.');
  }

  // Deactivating stops new runtimes being created from it. Anything already
  // running from it is unaffected.
  await client.snapshots.deactivate(NAME);
  console.log('\nDeactivated: new runtimes are refused');

  try {
    const blocked = await client.runtime.create({ snapshot: NAME });
    await blocked.kill();
    throw new Error('Expected the API to refuse an inactive snapshot.');
  } catch (error) {
    if (!(error instanceof GravixLayerBadRequestError)) throw error;
    console.log(`Refused    : ${error.message}`);
  }

  await client.snapshots.activate(NAME);
  console.log('Reactivated: usable again');
} finally {
  await restored?.kill();
  await sandbox?.kill();
  if (captured) {
    const deleted = await client.snapshots.delete(NAME);
    console.log(`\nDeleted    : ${deleted.snapshotId}`);
  }
  console.log('Runtimes terminated.');
}
