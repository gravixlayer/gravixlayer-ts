/**
 * Put a server running inside a sandbox on the public internet.
 *
 * A port inside the guest is unreachable until you publish it. Publishing
 * returns an HTTPS URL and, unless you ask for a public one, a token that every
 * request must carry. `connect` hands back a small HTTP client that attaches
 * the token for you.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/17-web-service.ts
 */

import { GravixLayer, type Runtime } from 'gravixlayer';

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';
const APP_DIR = '/workspace/app';
const PORT = 8000;

const APP = `
from fastapi import FastAPI

app = FastAPI()
items: list[dict] = []

@app.get("/items")
def list_items():
    return items

@app.post("/items")
def create_item(item: dict):
    items.append(item)
    return item
`;

/** Poll until the guest accepts connections on the port, or give up. */
async function waitForPort(sandbox: Runtime, port: number, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const probe = await sandbox.runCmd(
      `python -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 2)"`,
    );
    if (probe.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logs = await sandbox.runCmd('tail -n 50 /tmp/server.log');
  throw new Error(`The server never started listening.\n${logs.stdout}`);
}

// Installing the framework needs egress.
const policy = await client.networkPolicies.create(`web-service-${Date.now()}`, {
  egressMode: 'allow_all',
  description: 'Temporary egress for the web-service example',
});

let sandbox: Runtime | undefined;
try {
  sandbox = await client.runtime.create({
    template: TEMPLATE,
    networkPolicyIds: [policy.id],
    timeoutSeconds: 600,
  });
  console.log(`Runtime    : ${sandbox.runtimeId}`);

  await sandbox.file.createDirectory(APP_DIR);
  await sandbox.file.write(`${APP_DIR}/main.py`, APP);

  const install = await sandbox.runCmd('pip install fastapi uvicorn --quiet', {
    timeoutSeconds: 240,
  });
  if (install.exitCode !== 0) throw new Error(install.stderr || install.stdout);

  // Start the server detached so the command returns while it keeps running.
  await sandbox.runCmd(
    `nohup python -m uvicorn main:app --host 0.0.0.0 --port ${PORT} > /tmp/server.log 2>&1 &`,
    { workingDir: APP_DIR },
  );
  await waitForPort(sandbox, PORT);
  console.log('Server     : listening inside the guest');

  // Publish the port and call it from here.
  const api = await sandbox.service(PORT);
  console.log(`Public URL : ${api.url}`);

  await api.postJson('/items', { name: 'widget', price: 9.99 });
  await api.postJson('/items', { name: 'gadget', price: 24.99 });

  const items = await (await api.get('/items')).json();
  console.log(`Items      : ${JSON.stringify(items)}`);

  // Every published port for this sandbox, and how to take one down.
  const published = await client.runtime.service.list(sandbox.runtimeId);
  console.log(`Published  : ${published.map((service) => service.port).join(', ')}`);

  await client.runtime.service.revoke(sandbox.runtimeId, PORT);
  console.log('Revoked    : the URL stops resolving immediately');
} finally {
  await sandbox?.kill();
  await client.networkPolicies.delete(policy.id);
  console.log('\nRuntime terminated and policy removed.');
}
