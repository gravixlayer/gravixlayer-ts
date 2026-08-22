/**
 * Call a deployed agent.
 *
 * `invoke` waits for the whole answer; `stream` yields it as it is produced.
 * Both go straight to the agent's own URL rather than through the control
 * plane, so there is no extra hop in the request path.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   export GRAVIXLAYER_AGENT_ID="<id printed by 01-deploy.ts>"
 *   npx tsx examples/agents/02-invoke.ts
 */

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const AGENT_ID = process.env['GRAVIXLAYER_AGENT_ID'];
if (!AGENT_ID) {
  console.error('Set GRAVIXLAYER_AGENT_ID to an agent id. Run 01-deploy.ts to create one.');
  process.exit(1);
}

// Where the agent lives and whether it is answering.
const endpoint = await client.agents.get(AGENT_ID);
console.log(`Agent      : ${endpoint.name}`);
console.log(`Endpoint   : ${endpoint.endpoint}`);
console.log(`Health     : ${endpoint.health}`);
console.log(`Protocols  : ${Object.keys(endpoint.protocols).join(', ') || 'http'}`);

// 1. One request, one answer.
const reply = await client.agents.invoke(AGENT_ID, {
  input: { prompt: 'Hello from the TypeScript SDK' },
  sessionId: 'demo-session',
  metadata: { source: 'examples/agents/02-invoke.ts' },
});
console.log(`\nInvoke     : ${JSON.stringify(reply)}`);

// 2. The same request, streamed. Breaking out of the loop cancels it.
console.log('\nStream     : ');
for await (const event of client.agents.stream<{ type: string; text?: string }>(AGENT_ID, {
  input: { prompt: 'Stream this answer back to me' },
  sessionId: 'demo-session',
})) {
  if (event.type === 'token') process.stdout.write(event.text ?? '');
  else if (event.type === 'done') console.log('\n[done]');
}
