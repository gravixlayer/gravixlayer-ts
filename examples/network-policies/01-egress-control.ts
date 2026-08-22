/**
 * Control what a runtime can reach on the network.
 *
 * A runtime starts fail-closed: a baseline policy is always attached, is never
 * listed, and cannot be detached. Anything you want to allow, you allow
 * explicitly.
 *
 * Egress modes, from most to least restrictive:
 *
 *   deny_all    nothing leaves the guest
 *   allowlist   only the destinations in the rules
 *   denylist    everything except the destinations in the rules
 *   allow_all   unrestricted
 *
 * Attaching several policies applies the most restrictive of them, so adding a
 * policy can only ever narrow access, never widen it.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/network-policies/01-egress-control.ts
 */

import { GravixLayer, type NetworkPolicy, type Runtime } from 'gravixlayer';

const client = new GravixLayer();
const policies = client.networkPolicies;

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';
const NAME = `demo-egress-${Date.now()}`;

/** Try to open a TCP connection from inside the guest. */
async function canReach(runtime: Runtime, host: string, port = 443): Promise<boolean> {
  const probe = await runtime.runCmd('python', {
    args: ['-c', `import socket; socket.create_connection(('${host}', ${port}), 5)`],
    timeoutSeconds: 30,
  });
  return probe.exitCode === 0;
}

let policy: NetworkPolicy | undefined;
let runtime: Runtime | undefined;

try {
  // 1. Create a policy with its rules in one call. If a rule is rejected the
  //    policy is rolled back, so you never end up with a half-configured one.
  policy = await policies.create(NAME, {
    egressMode: 'allowlist',
    description: 'HTTPS to one host only',
    rules: [{ destination: 'example.com', port: 443, protocol: 'tcp', description: 'Example' }],
  });
  console.log(`Created    : ${policy.id} mode=${policy.egressMode} rules=${policy.ruleCount}`);

  // 2. Find it again, and read it back with its rules.
  const found = await policies.list({ limit: 10, search: 'demo-egress' });
  console.log(`Listed     : ${found.total} match(es)`);

  const detail = await policies.get(policy.id, { includeRules: true });
  console.log(`Fetched    : ${detail.name} active=${detail.isActive}`);
  for (const rule of detail.rules ?? []) {
    console.log(`  ${rule.destination}:${rule.port}/${rule.protocol}  ${rule.description ?? ''}`);
  }

  // 3. Rename it.
  policy = await policies.update(policy.id, {
    name: `${NAME}-renamed`,
    description: 'HTTPS allowlist',
  });
  console.log(`\nRenamed    : ${policy.name}`);

  // 4. Rules can be added, edited, and removed after the fact.
  const extra = await policies.addRule(policy.id, 'api.github.com', {
    port: 443,
    protocol: 'tcp',
    description: 'GitHub API',
  });
  console.log(`Added rule : ${extra.destination}:${extra.port}`);

  await policies.updateRule(policy.id, extra.id, { description: 'GitHub API (updated)' });
  await policies.deleteRule(policy.id, extra.id);
  console.log(`Rules now  : ${(await policies.listRules(policy.id)).rules.length}`);

  // 5. Attaching at creation applies the policy before the guest's first
  //    packet, rather than after it is already running.
  runtime = await client.runtimes.create({
    template: TEMPLATE,
    networkPolicyIds: [policy.id],
    timeoutSeconds: 600,
  });
  console.log(`\nRuntime    : ${runtime.runtimeId}`);

  const attached = await policies.listForRuntime(runtime.runtimeId);
  console.log(`Attached   : ${attached.policies.map((p) => p.name).join(', ')}`);

  const withBaseline = await policies.listForRuntime(runtime.runtimeId, { includeSystem: true });
  console.log(`With baseline: ${withBaseline.policies.length} polic(ies)`);

  // 6. The allowlist is enforced in the data path, not by the guest, so code
  //    inside the runtime cannot talk its way around it.
  console.log(`\nexample.com    : reachable=${await canReach(runtime, 'example.com')}`);
  console.log(`api.github.com : reachable=${await canReach(runtime, 'api.github.com')}`);

  // 7. Detaching takes effect immediately, as does attaching again.
  await policies.detach(policy.id, runtime.runtimeId);
  console.log(`\nDetached   : ${(await policies.listForRuntime(runtime.runtimeId)).total} left`);

  await policies.attach(policy.id, runtime.runtimeId);
  console.log(`Re-attached: ${(await policies.listForRuntime(runtime.runtimeId)).total} attached`);
} finally {
  await runtime?.kill();
  if (policy) await policies.delete(policy.id);
  console.log('\nRuntime terminated and policy deleted.');
}
