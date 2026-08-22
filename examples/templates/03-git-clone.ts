/**
 * Build a template from a git repository.
 *
 * The repository is cloned during the build, so the code is baked into the
 * image and a runtime starts with it already present. A shallow clone of one
 * branch keeps builds quick.
 *
 * For a private repository, pass an auth token. It is used only while the build
 * runs and is not written into the finished image.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/templates/03-git-clone.ts
 *
 * Optional: GIT_REPO_URL, GIT_BRANCH, GIT_AUTH_TOKEN (for a private repository)
 */

import { GravixLayer, TemplateBuilder } from 'gravixlayer';

const client = new GravixLayer();

const REPO = process.env['GIT_REPO_URL'] ?? 'https://github.com/IBM/node-hello-world';
const BRANCH = process.env['GIT_BRANCH'] ?? 'main';
const TOKEN = process.env['GIT_AUTH_TOKEN'];

const template = new TemplateBuilder(
  `sdk-git-${Date.now()}`,
  'Template built from a git repository',
)
  .fromImage('node:20-slim')
  .vcpu(2)
  .memory(512)
  .disk(4096)
  .env('NODE_ENV', 'production')
  .tags({ runtime: 'node', source: 'git' })
  // `git` and CA certificates are needed to clone over HTTPS.
  .aptInstall('git', 'ca-certificates')
  .gitClone(REPO, {
    destination: '/app',
    branch: BRANCH,
    depth: 1,
    ...(TOKEN ? { authToken: TOKEN } : {}),
  })
  .run('cd /app && npm install --production')
  .startCmd('cd /app && node app.js')
  .readyCmd(TemplateBuilder.waitForPort(8080), 60);

console.log(`Repository : ${REPO} (${BRANCH})`);
console.log(`Auth       : ${TOKEN ? 'token supplied' : 'none, so the repo must be public'}`);
console.log(`Building   : ${template.name}`);

const status = await client.templates.buildAndWait(template, {
  pollIntervalMs: 10_000,
  onPhase: (s) => console.log(`  ${s.phase.padEnd(12)} ${s.progressPercent}%`),
});

console.log(`\nBuilt      : ${status.templateId}`);
