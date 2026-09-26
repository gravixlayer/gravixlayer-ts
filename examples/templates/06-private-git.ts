/**
 * Build a template from a private git repository.
 *
 * The token is used only while the image is built. It is not stored in the
 * finished template. Create a token with read access to that repository and
 * pass it in the environment. Do not put it in this file.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   export GIT_AUTH_TOKEN="your-token"
 *   export GIT_REPO_URL="https://github.com/your-org/your-private-repo.git"
 *   npx tsx examples/templates/06-private-git.ts
 */

import { GravixLayer, TemplateBuilder } from 'gravixlayer';

const token = process.env['GIT_AUTH_TOKEN'] ?? '';
const repo = process.env['GIT_REPO_URL'] ?? '';
if (!token || !repo) {
  console.error('Set GIT_AUTH_TOKEN and GIT_REPO_URL to run this example.');
  process.exit(1);
}

const client = new GravixLayer();

// The token comes from the environment. It is not written into this file.
// Build the image, then wait until it is ready.
const template = new TemplateBuilder(
  `python-private-repo-${Date.now()}`,
  'Python template from a private git repository',
)
  .fromImage('python:3.12-slim')
  .vcpu(2)
  .memory(1024)
  .disk(4096)
  .env('PYTHONUNBUFFERED', '1')
  .tags({ runtime: 'python', source: 'private-git' })
  .aptInstall('git', 'ca-certificates')
  .gitClone(repo, {
    destination: '/app',
    branch: 'main',
    depth: 1,
    authToken: token,
  })
  .run('pip install --no-cache-dir -r /app/requirements.txt')
  .startCmd('cd /app && uvicorn main:app --host 0.0.0.0 --port 8080')
  .readyCmd(TemplateBuilder.waitForPort(8080), 300);

await client.templates.buildAndWait(template, {
  pollIntervalMs: 10_000,
  timeoutMs: 900_000,
});
console.log(`Template   : ${template.name}`);
