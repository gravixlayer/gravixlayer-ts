/**
 * Build a Python template from a public container image.
 *
 * A template is a prebuilt image. Installing packages once at build time means
 * every sandbox created from the template already has them, which is the
 * difference between a sandbox that is usable immediately and one that spends
 * its first minute installing.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/templates/01-python-image.ts
 */

import { GravixLayer, TemplateBuilder } from 'gravixlayer';

const client = new GravixLayer();

const APP = `from fastapi import FastAPI

app = FastAPI()

@app.get('/')
def health():
    return {'status': 'ok'}
`;

const template = new TemplateBuilder(
  `sdk-python-${Date.now()}`,
  'Python template built from a container image',
)
  .fromImage('python:3.12-slim')
  .vcpu(2)
  .memory(1024)
  .disk(4096)
  // Steps run in the order they are added, so system packages come before the
  // Python packages that might need them.
  .aptInstall('curl')
  .pipInstall('fastapi', 'uvicorn')
  .mkdir('/app')
  .addFile('/app/main.py', APP)
  // What to start when a sandbox boots, and how to tell it is ready.
  .startCmd('uvicorn main:app --host 0.0.0.0 --port 8080 --app-dir /app')
  .readyCmd(TemplateBuilder.waitForPort(8080), 300);

const status = await client.templates.buildAndWait(template, {
  pollIntervalMs: 10_000,
  timeoutMs: 900_000,
});

if (status.templateId) {
  console.log(`Use it     : client.runtime.create({ template: '${template.name}' })`);
}
