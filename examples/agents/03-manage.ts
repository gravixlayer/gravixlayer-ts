/**
 * Inspect and tear down agents.
 *
 * Building and deploying are separate steps. An image built once can be
 * deployed many times, which is how you roll a new instance without paying for
 * another build.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/agents/03-manage.ts
 *
 * Optional: GRAVIXLAYER_AGENT_ID=<id> to inspect and destroy one.
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

// 1. Every agent image that has been built.
console.log('--- Agent images ---');
const { templates } = await client.agents.listTemplates({ limit: 20 });
console.log(`Total      : ${templates.length}\n`);

for (const template of templates) {
  console.log(`  ${template.id}  ${template.name.padEnd(28)} ${template.createdAt}`);
}

const agentId = process.env['GRAVIXLAYER_AGENT_ID'];
if (!agentId) {
  console.log('\nSet GRAVIXLAYER_AGENT_ID=<id> to inspect and destroy a deployed agent.');
  console.log('Deploy an existing image without rebuilding:');
  console.log(
    "  await client.agents.deploy({ templateId: '<id>', framework: 'python', httpPort: 8000 });",
  );
} else {
  // 2. Everything known about one deployment.
  const endpoint = await client.agents.get(agentId);
  console.log(`\n--- ${endpoint.name} ---`);
  console.log(`Endpoint   : ${endpoint.endpoint}`);
  console.log(`Internal   : ${endpoint.internalEndpoint}`);
  console.log(`Framework  : ${endpoint.framework}`);
  console.log(`Status     : ${endpoint.status}`);
  console.log(`Health     : ${endpoint.health}`);
  console.log(`DNS        : ${endpoint.dnsStatus}`);
  console.log(`Card       : ${endpoint.agentCardUrl || 'not published'}`);
  for (const [protocol, url] of Object.entries(endpoint.protocols)) {
    console.log(`  ${protocol.padEnd(6)} ${url}`);
  }

  // 3. Destroying releases the hostname and stops the runtime behind it. The
  //    image stays, so the agent can be deployed again.
  const destroyed = await client.agents.destroy(agentId);
  console.log(`\nDestroyed  : ${destroyed.agentId} (${destroyed.status})`);
}
