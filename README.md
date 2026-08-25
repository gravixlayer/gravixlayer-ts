# GravixLayer TypeScript SDK

[![npm](https://img.shields.io/npm/v/gravixlayer.svg)](https://www.npmjs.com/package/gravixlayer)
[![Node 20+](https://img.shields.io/badge/node-20+-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Official TypeScript client for [GravixLayer](https://gravixlayer.ai). Create
isolated cloud runtimes, run code and commands in them, build reusable images,
and deploy agents.

```bash
npm install gravixlayer
export GRAVIXLAYER_API_KEY="your-api-key"
```

```ts
import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const sandbox = await client.runtime.create(); // defaults to template="base-small"
const result = await sandbox.runCode('print("Hello from GravixLayer")');
console.log(result.text);
await sandbox.kill();
```

Cloud and region default to `aws` / `us-east-1`. Override with
`GRAVIXLAYER_CLOUD` / `GRAVIXLAYER_REGION`, or pass them to the client.

**Docs:** [docs.gravixlayer.ai](https://docs.gravixlayer.ai) ·
**Examples:** [examples/](examples/)

## Requirements

Node 20 or newer. The SDK is built on `fetch` and web streams, so it also runs
on Deno, Bun, and edge runtimes. On Node, HTTPS multiplexes requests on one
HTTP/2 session per origin (HTTP/1.1 keep-alive if the origin cannot).

Browsers are refused by default — a browser build would hand your API key to
every visitor. Call the API from your own server.

## Configuration

```ts
const client = new GravixLayer({
  apiKey: process.env.GRAVIXLAYER_API_KEY,
  cloud: 'aws',
  region: 'us-east-1',
});
```

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `GRAVIXLAYER_API_KEY` | Required. |
| `baseUrl` | `GRAVIXLAYER_BASE_URL`, then `https://api.gravixlayer.ai` | |
| `cloud` | `GRAVIXLAYER_CLOUD`, then `aws` | Runtimes and template builds. |
| `region` | `GRAVIXLAYER_REGION`, then `us-east-1` | Runtimes and template builds. |
| `timeout` | `60000` | Per request, in milliseconds. `0` disables it. |
| `maxRetries` | `3` | Transient failures only. |
| `fetch` | Node pooled `fetch`, else global `fetch` | For a proxy, a custom agent, or tests. |

Construct the client once and reuse it. On Node, one client keeps a pooled
HTTP connection to the API. Call `await client.warmup()` at startup if you
want TCP and TLS paid before the first request that matters.
Call `await client.close()` when a short-lived process is done so keep-alive
sockets can drain.

## Runtimes

A sandbox is an isolated virtual machine that boots from a template. It runs
until you stop it, or until a timeout you set expires.

```ts
const sandbox = await client.runtime.create({
  template: 'base-small',
  envVars: { APP_ENV: 'staging' },
  timeoutSeconds: 600,
});
```

```ts
await using sandbox = await client.runtime.create({ template: 'base-small' });
// stopped when the block exits
```

`await using` needs TypeScript 5.2 and Node 20. Elsewhere, `try` / `finally`
with `sandbox.kill()` does the same job.

### Code and commands

```ts
const result = await sandbox.runCode('print(sum(range(100)))');
console.log(result.stdout, result.exitCode);

// Pass `args` when any part comes from user input — nothing in the list is
// interpreted by a shell.
await sandbox.runCmd('python', { args: ['--version'] });
```

Failures are reported, not thrown: check `success` and `exitCode`. An error
raised by the code is on `result.error`, with the traceback intact.

Guest egress is deny-by-default. Installing a package or reaching the internet
needs a [network policy](#network-policies).

Stream output as it arrives:

```ts
await sandbox.runCmd('npm test', {
  onStdout: (chunk) => process.stdout.write(chunk),
});

for await (const event of sandbox.streamCmd('npm run build')) {
  if (event.type === 'stdout') process.stdout.write(event.data);
}
```

### Files

```ts
await sandbox.file.write('/workspace/note.txt', 'hello\n');
const { content } = await sandbox.file.read('/workspace/note.txt');
```

Also: `list`, `upload`, `download`, `writeMany`, `move`, `copy`, `find`,
`replace`, `watch`, `delete`. See
[examples/runtimes/06-file-operations.ts](examples/runtimes/06-file-operations.ts).

### State, ports, git, SSH

```ts
const context = await sandbox.createContext();
await sandbox.runCode('x = 1', { contextId: context.contextId });

const api = await sandbox.service(8000);
console.log(api.url); // https://*.service.gravixlayer.ai
await api.get('/items');

await sandbox.git.clone('https://github.com/org/repo.git', '/workspace/repo', {
  depth: 1,
});

const ssh = await sandbox.enableSsh();
console.log(ssh.connectCmd);
```

## Templates

Build an image once so runtimes start with everything already installed.
Placement follows the client (`aws` / `us-east-1` unless you override it).

```ts
import { TemplateBuilder } from 'gravixlayer';

const template = new TemplateBuilder('data-science', 'Pandas and friends')
  .fromImage('python:3.12-slim')
  .vcpu(2)
  .memory(2048)
  .aptInstall('git')
  .pipInstall('pandas', 'matplotlib')
  .startCmd('python -m http.server 8080')
  .readyCmd(TemplateBuilder.waitForPort(8080), 60);

const status = await client.templates.buildAndWait(template);
const sandbox = await client.runtime.create({ template: status.templateId });
```

## Snapshots

```ts
await client.snapshots.create(sandbox.runtimeId, 'ready-to-work', { kind: 'cold' });
const restored = await client.runtime.create({ snapshot: 'ready-to-work' });
```

A `cold` snapshot stores the filesystem; a `hot` snapshot stores memory too, so
the restored sandbox resumes mid-process.

## Agents

```ts
const agent = await client.agents.deploy({
  source: './my-agent',
  name: 'my-agent',
  isPublic: true,
});

const reply = await client.agents.invoke(agent.agentId, { input: { prompt: 'hello' } });

for await (const event of client.agents.stream(agent.agentId, { input: { prompt: 'hello' } })) {
  console.log(event);
}
```

## Network policies

A sandbox starts fail-closed. Grant access explicitly:

```ts
const policy = await client.networkPolicies.create('model-access', {
  egressMode: 'allowlist',
  rules: [{ destination: 'api.example.com', port: 443 }],
});

const sandbox = await client.runtime.create({
  template: 'base-small',
  networkPolicyIds: [policy.id],
});
```

Attaching several policies applies the most restrictive of them, so adding one
can only narrow access.

## Secrets

```ts
const provider = await client.identity.providers.create('Model API', {
  secrets: [{ key: 'MODEL_API_KEY', value: process.env.MODEL_API_KEY! }],
});

const sandbox = await client.runtime.create({
  template: 'base-small',
  providers: [provider.id],
});
```

Values are write-only. What comes back is masked.

## Errors

Every failure extends `GravixLayerError`. Connection failures and 429, 502, 503,
and 504 are retried automatically, honouring `Retry-After` when the API sends
one.

```ts
import { GravixLayerError, GravixLayerRateLimitError } from 'gravixlayer';

try {
  await client.runtime.create({ template: 'base-small' });
} catch (error) {
  if (error instanceof GravixLayerRateLimitError) {
    console.error(`Retry after ${error.retryAfterSeconds ?? 'a while'}s.`);
  } else if (error instanceof GravixLayerError) {
    console.error(error.status, error.message, error.requestId);
  } else {
    throw error;
  }
}
```

Any call also takes a per-request timeout and an `AbortSignal`:

```ts
const controller = new AbortController();
await client.runtime.list({ signal: controller.signal, timeout: 10_000 });
```

## Observability

Spans are emitted when `@opentelemetry/api` is installed and tracing is on
(`enableTelemetry()`, or `GRAVIXLAYER_ENABLE_TELEMETRY=1`). The SDK never
configures an exporter, so its spans join the traces your application already
produces. See
[examples/runtimes/21-tracing.ts](examples/runtimes/21-tracing.ts).

## Examples

Runnable scripts for every surface live in [examples/](examples/). Start with
[examples/README.md](examples/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Support

- [docs.gravixlayer.ai](https://docs.gravixlayer.ai)
- [GitHub Issues](https://github.com/gravixlayer/gravixlayer-ts/issues)
- support@gravixlayer.ai

## License

Apache 2.0 — see [LICENSE](LICENSE).
