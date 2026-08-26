/**
 * Publish an agent card so other agents can discover this one.
 *
 * An agent card is a machine-readable description — what the agent is, what it
 * can do, and how to talk to it — served at a well-known URL. It follows an
 * open interoperability specification, so any client that speaks it can find
 * and call the agent without being told anything in advance.
 *
 * Enable the `a2a` protocol alongside `http` and the platform publishes the
 * card and exposes an agent-to-agent endpoint next to the ordinary one.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/agents/04-agent-card.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GravixLayer, type AgentCard } from 'gravixlayer';

const client = new GravixLayer();

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'hello-agent');
const NAME = `discoverable-agent-${Date.now()}`;
const PORT = 8000;

const card: AgentCard = {
  name: 'Echo assistant',
  description: 'Repeats what it is told. A stand-in for something more useful.',
  version: '1.0.0',
  capabilities: { streaming: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    {
      id: 'echo',
      name: 'Echo',
      description: 'Returns the prompt it was given.',
      tags: ['utility', 'example'],
      examples: ['Say hello', 'Repeat after me: production ready'],
    },
  ],
};

console.log('Deploying  : this builds an image, so allow a few minutes.\n');

const agent = await client.agents.deploy({
  source: SOURCE,
  name: NAME,
  description: 'Agent publishing a discovery card',
  framework: 'python',
  pythonVersion: '3.12',
  entrypoint: `python -m uvicorn main:app --host 0.0.0.0 --port ${PORT}`,
  ports: [PORT],
  httpPort: PORT,
  protocols: ['http', 'a2a'],
  agentCard: card,
  isPublic: true,
  timeoutMs: 900_000,
});

console.log(`\nAgent ID   : ${agent.agentId}`);

const endpoint = await client.agents.get(agent.agentId);
console.log(`HTTP       : ${endpoint.endpoint}`);
console.log(`A2A        : ${endpoint.a2aEndpoint || 'pending'}`);
console.log(`Card       : ${endpoint.agentCardUrl || 'pending'}`);

// The card is public, so any client can read it without an API key.
if (endpoint.agentCardUrl) {
  const response = await fetch(endpoint.agentCardUrl);
  if (response.ok) {
    console.log(`\nPublished card:\n${JSON.stringify(await response.json(), null, 2)}`);
  } else {
    console.log(`\nCard not served yet (HTTP ${response.status}); DNS may still be propagating.`);
  }
}

console.log(
  `\nTear down  : GRAVIXLAYER_AGENT_ID=${agent.agentId} npx tsx examples/agents/03-manage.ts`,
);
