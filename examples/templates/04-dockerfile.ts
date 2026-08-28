/**
 * Build a template from a Dockerfile.
 *
 * Use this when you want full control over the image. Everything goes in the
 * Dockerfile rather than in build steps — `aptInstall` and `pipInstall` are for
 * the `fromImage` route and the two cannot be combined.
 *
 * `startCmd` and `readyCmd` are still needed: a `CMD` in the Dockerfile
 * describes the image, while these describe what a sandbox should launch and
 * how to know it came up.
 *
 * Run:
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/templates/04-dockerfile.ts
 */

import { GravixLayer, TemplateBuilder } from 'gravixlayer';

const client = new GravixLayer();

// Classic Dockerfile syntax only. A BuildKit heredoc (`COPY <<`) is rejected
// when the host prepares the build image.
const DOCKERFILE = `FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1

RUN apt-get update \\
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl \\
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir fastapi "uvicorn[standard]"

WORKDIR /app

RUN echo 'from fastapi import FastAPI\\n\\
app = FastAPI(title="Dockerfile template")\\n\\
\\n\\
@app.get("/")\\n\\
def root():\\n\\
    return {"message": "Built from a Dockerfile"}\\n\\
\\n\\
@app.get("/health")\\n\\
def health():\\n\\
    return {"status": "healthy"}' > main.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
`;

const template = new TemplateBuilder(
  `sdk-dockerfile-${Date.now()}`,
  'Template built from a Dockerfile',
)
  .dockerfile(DOCKERFILE)
  .vcpu(2)
  .memory(1024)
  .disk(4096)
  .tags({ source: 'dockerfile' })
  .startCmd('cd /app && uvicorn main:app --host 0.0.0.0 --port 8080')
  .readyCmd(TemplateBuilder.waitForPort(8080), 300);

await client.templates.buildAndWait(template, {
  pollIntervalMs: 10_000,
  timeoutMs: 900_000,
});
