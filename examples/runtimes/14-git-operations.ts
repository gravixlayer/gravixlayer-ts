/**
 * Work with a git repository inside a sandbox.
 *
 * Every call runs `git` in the guest and reports the process result rather than
 * throwing, so check `result.success` the way you would after running the
 * command yourself.
 *
 * Reaching a remote needs egress, so this attaches a temporary allow-all
 * network policy. An auth token is per call: it authenticates one operation and
 * is never stored in the checkout, so clone, fetch, pull, and push each need
 * their own.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/14-git-operations.ts
 *
 * Optional: GIT_CLONE_URL, GIT_BRANCH, GIT_AUTH_TOKEN
 */

import { GravixLayer, type Runtime } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';
const CLONE_URL = process.env['GIT_CLONE_URL'] ?? 'https://github.com/octocat/Hello-World.git';
const BRANCH = process.env['GIT_BRANCH'] ?? 'master';
const TOKEN = process.env['GIT_AUTH_TOKEN'];
const REPO = '/workspace/repo';

const policy = await client.networkPolicies.create(`git-example-${Date.now()}`, {
  egressMode: 'allow_all',
  description: 'Temporary egress for the git example',
});

let sandbox: Runtime | undefined;
try {
  sandbox = await client.runtime.create({
    template: TEMPLATE,
    networkPolicyIds: [policy.id],
    timeoutSeconds: 600,
  });
  console.log(`Runtime    : ${sandbox.runtimeId}`);
  console.log(`Cloning    : ${CLONE_URL} -> ${REPO}\n`);

  // A shallow clone of one branch is enough to work with and far quicker.
  const cloned = await sandbox.git.clone(CLONE_URL, REPO, {
    branch: BRANCH,
    depth: 1,
    ...(TOKEN ? { authToken: TOKEN } : {}),
  });
  console.log(`clone      : success=${cloned.success} exit=${cloned.exitCode}`);
  if (!cloned.success) throw new Error(cloned.stderr || cloned.error);

  const status = await sandbox.git.status(REPO);
  console.log(`status     : ${status.stdout.trim() || '(clean)'}`);

  const local = await sandbox.git.branchList(REPO);
  console.log(`branches   : ${local.stdout.trim().replace(/\s+/g, ' ')}`);

  const all = await sandbox.git.branchList(REPO, 'all');
  console.log(`  with remotes: ${all.stdout.trim().replace(/\s+/g, ' ')}`);

  // Branch off, come back, and clean up. A branch cannot be deleted while it
  // is checked out.
  await sandbox.git.createBranch(REPO, 'demo-branch');
  await sandbox.git.checkout(REPO, 'demo-branch');
  await sandbox.git.checkout(REPO, BRANCH);
  await sandbox.git.deleteBranch(REPO, 'demo-branch');
  console.log('branching  : created, switched, switched back, deleted');

  // Stage and commit a change.
  await sandbox.file.write(`${REPO}/note.txt`, 'written by the SDK\n');
  await sandbox.git.add(REPO, ['note.txt']);
  const committed = await sandbox.git.commit(REPO, 'Add a note', {
    authorName: 'Example',
    authorEmail: 'example@example.com',
  });
  console.log(`commit     : success=${committed.success}`);

  const fetched = await sandbox.git.fetch(REPO, {
    remote: 'origin',
    ...(TOKEN ? { authToken: TOKEN } : {}),
  });
  console.log(`fetch      : success=${fetched.success}`);

  // Pushing needs a credential, so it only runs when one is configured.
  if (TOKEN) {
    const pushed = await sandbox.git.push(REPO, { remote: 'origin', authToken: TOKEN });
    console.log(`push       : success=${pushed.success}`);
  } else {
    console.log('push       : skipped (set GIT_AUTH_TOKEN to try it)');
  }
} finally {
  await sandbox?.kill();
  await client.networkPolicies.delete(policy.id);
  console.log('\nRuntime terminated and policy removed.');
}
