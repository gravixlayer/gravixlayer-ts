/**
 * Build a Node template and run a server from it.
 *
 * Installing into a project directory with `run('npm install')` keeps
 * dependencies where `require` looks for them, which is what an app expects.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/templates/02-node-image.ts
 */

import { GravixLayer, TemplateBuilder } from 'gravixlayer';

const client = new GravixLayer();

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'example-server',
    private: true,
    main: 'server.js',
    dependencies: { express: '^4' },
  },
  null,
  2,
);

const SERVER = `const express = require('express');

const app = express();

app.get('/', (req, res) => res.json({ message: 'Hello, World!' }));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

app.listen(8080, '0.0.0.0', () => console.log('listening on 8080'));
`;

const template = new TemplateBuilder(
  `sdk-node-${Date.now()}`,
  'Node and Express hello-world template',
)
  .fromImage('node:20-slim')
  .vcpu(2)
  .memory(512)
  .disk(4096)
  .env('NODE_ENV', 'production')
  // Tags are labels for organizing templates; they do not affect the build.
  .tags({ runtime: 'node', framework: 'express' })
  .aptInstall('curl')
  .mkdir('/app')
  .addFiles([
    { path: '/app/package.json', content: PACKAGE_JSON },
    { path: '/app/server.js', content: SERVER },
  ])
  .run('cd /app && npm install')
  .startCmd('node /app/server.js')
  .readyCmd(TemplateBuilder.waitForPort(8080), 30);

console.log(`Building   : ${template.name}`);

const status = await client.templates.buildAndWait(template, {
  pollIntervalMs: 10_000,
  onPhase: (s) => console.log(`  ${s.phase.padEnd(12)} ${s.progressPercent}%`),
});

console.log(`\nBuilt      : ${status.templateId}`);
