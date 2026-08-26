/**
 * Deploy an agent from a source directory.
 *
 * A sandbox is something you drive; an agent is something you deploy once and
 * then call. `deploy` packages the project, builds an image, waits for the
 * build, starts it, and gives it a public hostname.
 *
 * Reading the directory also tells the SDK what the project needs: its
 * framework from the dependency list, its interpreter version, and any `.env`
 * it ships. Anything you pass explicitly wins over what was inferred.
 *
 * The agent deployed here is `./hello-agent`, a small FastAPI service with
 * `/invoke` and `/stream`. Look at it — an agent is just an HTTP service.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/agents/01-deploy.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'hello-agent');
const NAME = `hello-agent-${Date.now()}`;
const PORT = 8000;

console.log(`Source     : ${SOURCE}`);
console.log('Deploying  : this builds an image, so allow a few minutes.\n');

const agent = await client.agents.deploy({
  source: SOURCE,
  name: NAME,
  description: 'Minimal HTTP agent deployed from the TypeScript SDK',
  framework: 'python',
  pythonVersion: '3.12',
  // A plain Python project needs to say how it starts. Frameworks the platform
  // knows how to serve, such as LangGraph, do not.
  entrypoint: `python -m uvicorn main:app --host 0.0.0.0 --port ${PORT}`,
  ports: [PORT],
  httpPort: PORT,
  isPublic: true,
  timeoutMs: 900_000,
});

console.log(`\nAgent ID   : ${agent.agentId}`);
console.log(`Endpoint   : ${agent.endpoint}`);
console.log(`Status     : ${agent.status}`);

// DNS for a brand new hostname takes a moment to propagate.
const endpoint = await client.agents.get(agent.agentId);
console.log(`Health     : ${endpoint.health}`);
console.log(`DNS        : ${endpoint.dnsStatus}`);

console.log(
  `\nTry it     : GRAVIXLAYER_AGENT_ID=${agent.agentId} npx tsx examples/agents/02-invoke.ts`,
);
console.log(
  `Tear down  : GRAVIXLAYER_AGENT_ID=${agent.agentId} npx tsx examples/agents/03-manage.ts`,
);
