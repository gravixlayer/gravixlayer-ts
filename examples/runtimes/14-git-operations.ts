/**
 * Work with a git repository inside a runtime.
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
const REPO = '/home/user/repo';

const policy = await client.networkPolicies.create(`git-example-${Date.now()}`, {
  egressMode: 'allow_all',
  description: 'Temporary egress for the git example',
});

let runtime: Runtime | undefined;
try {
  runtime = await client.runtimes.create({
    template: TEMPLATE,
    networkPolicyIds: [policy.id],
    timeoutSeconds: 600,
  });
  console.log(`Runtime    : ${runtime.runtimeId}`);
  console.log(`Cloning    : ${CLONE_URL} -> ${REPO}\n`);

  // A shallow clone of one branch is enough to work with and far quicker.
  const cloned = await runtime.git.clone(CLONE_URL, REPO, {
    branch: BRANCH,
    depth: 1,
    ...(TOKEN ? { authToken: TOKEN } : {}),
  });
  console.log(`clone      : success=${cloned.success} exit=${cloned.exitCode}`);
  if (!cloned.success) throw new Error(cloned.stderr || cloned.error);

  const status = await runtime.git.status(REPO);
  console.log(`status     : ${status.stdout.trim() || '(clean)'}`);

  const local = await runtime.git.branchList(REPO);
  console.log(`branches   : ${local.stdout.trim().replace(/\s+/g, ' ')}`);

  const all = await runtime.git.branchList(REPO, 'all');
  console.log(`  with remotes: ${all.stdout.trim().replace(/\s+/g, ' ')}`);

  // Branch off, come back, and clean up. A branch cannot be deleted while it
  // is checked out.
  await runtime.git.createBranch(REPO, 'demo-branch');
  await runtime.git.checkout(REPO, 'demo-branch');
  await runtime.git.checkout(REPO, BRANCH);
  await runtime.git.deleteBranch(REPO, 'demo-branch');
  console.log('branching  : created, switched, switched back, deleted');

  // Stage and commit a change.
  await runtime.files.write(`${REPO}/note.txt`, 'written by the SDK\n');
  await runtime.git.add(REPO, ['note.txt']);
  const committed = await runtime.git.commit(REPO, 'Add a note', {
    authorName: 'Example',
    authorEmail: 'example@example.com',
  });
  console.log(`commit     : success=${committed.success}`);

  const fetched = await runtime.git.fetch(REPO, {
    remote: 'origin',
    ...(TOKEN ? { authToken: TOKEN } : {}),
  });
  console.log(`fetch      : success=${fetched.success}`);

  // Pushing needs a credential, so it only runs when one is configured.
  if (TOKEN) {
    const pushed = await runtime.git.push(REPO, { remote: 'origin', authToken: TOKEN });
    console.log(`push       : success=${pushed.success}`);
  } else {
    console.log('push       : skipped (set GIT_AUTH_TOKEN to try it)');
  }
} finally {
  await runtime?.kill();
  await client.networkPolicies.delete(policy.id);
  console.log('\nRuntime terminated and policy removed.');
}
