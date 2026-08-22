# GravixLayer TypeScript SDK

[![npm](https://img.shields.io/npm/v/gravixlayer.svg)](https://www.npmjs.com/package/gravixlayer)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Official TypeScript client for [GravixLayer](https://gravixlayer.ai). Start
isolated cloud runtimes, run code and commands in them, build reusable images,
and deploy agents that serve traffic on their own URL.

```bash
npm install gravixlayer
```

```ts
import { GravixLayer } from 'gravixlayer';

const client = new GravixLayer();

const runtime = await client.runtimes.create({ template: 'base-small' });
const result = await runtime.runCode('print("Hello from GravixLayer")');
console.log(result.stdout);
await runtime.kill();
```

Set `GRAVIXLAYER_API_KEY` first. Everything else has a sensible default.

- **Docs**: [docs.gravixlayer.ai](https://docs.gravixlayer.ai)
- **Examples**: [examples/](examples/) — every feature, as a script you can run

## Requirements

Node 18 or newer. The SDK is built on `fetch` and web streams, so it also runs
unmodified on Deno, Bun, and edge runtimes such as Cloudflare Workers and
Vercel Edge. It has no runtime dependencies.

Browsers are refused by default, because a browser build hands your API key to
every visitor. Call the API from your own server.

## Configuration

```bash
export GRAVIXLAYER_API_KEY="your-api-key"
export GRAVIXLAYER_CLOUD="aws"          # default
export GRAVIXLAYER_REGION="us-east-1"   # default
```

Or in code:

```ts
const client = new GravixLayer({
  apiKey: process.env.GRAVIXLAYER_API_KEY,
  cloud: 'aws',
  region: 'us-east-1',
  timeout: 60_000, // milliseconds; 0 disables
  maxRetries: 3,
});
```

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `GRAVIXLAYER_API_KEY` | Required. |
| `baseUrl` | `GRAVIXLAYER_BASE_URL` | Points at the public API. |
| `cloud` | `GRAVIXLAYER_CLOUD`, then `aws` | Where runtimes are placed. |
| `region` | `GRAVIXLAYER_REGION`, then `us-east-1` | Where runtimes are placed. |
| `timeout` | `60000` | Per request, in milliseconds. |
| `maxRetries` | `3` | Transient failures only. |
| `defaultHeaders` | — | Sent with every request. |
| `fetch` | global `fetch` | For a proxy, a custom agent, or tests. |

Construct the client once and reuse it. Each instance keeps its connections
warm; building a new one per request throws that away.

## Runtimes

A runtime is an isolated virtual machine that boots from a template. It runs
until you stop it, or until a timeout you set expires.

```ts
const runtime = await client.runtimes.create({
  template: 'base-small',
  envVars: { APP_ENV: 'staging' },
  timeoutSeconds: 600,
});
```

### Running code and commands

```ts
// Code, through the guest's interpreter.
const result = await runtime.runCode('print(sum(range(100)))');
console.log(result.stdout, result.exitCode);

// Shell commands. Pass `args` when any part comes from user input, since
// nothing in the list is interpreted by a shell.
await runtime.runCmd('pip', { args: ['install', 'pandas', '--quiet'] });
```

Failures are reported, not thrown: check `success` and `exitCode`. An error
raised by the code is on `result.error`, with the traceback intact.

### Streaming

Pass callbacks to keep the aggregated result, or iterate the events yourself:

```ts
await runtime.runCmd('npm test', {
  onStdout: (chunk) => process.stdout.write(chunk),
  onExit: (code) => console.log('exit', code),
});

for await (const event of runtime.streamCmd('npm run build')) {
  if (event.type === 'stdout') process.stdout.write(event.data);
}
```

### Files

```ts
await runtime.files.write('/workspace/data.csv', csv);
const { content } = await runtime.files.read('/workspace/out.txt');

const bytes = await runtime.files.download('/workspace/report.pdf');
await runtime.files.writeMany([
  { path: '/workspace/a.txt', data: 'a' },
  { path: '/workspace/b.txt', data: 'b' },
]);

for await (const event of runtime.files.watch('/workspace')) {
  console.log(event.type, event.name);
}
```

Also: `list`, `getInfo`, `setPermissions`, `move`, `copy`, `chown`, `find`,
`replace`, `upload`, `delete`.

### Keeping state between executions

Each `runCode` call is independent. A context is a live interpreter session, so
variables and imports persist:

```ts
const context = await runtime.createContext();
await runtime.runCode('import pandas as pd; df = pd.read_csv("/workspace/data.csv")', {
  contextId: context.contextId,
});
const shape = await runtime.runCode('print(df.shape)', { contextId: context.contextId });
```

### Publishing a port

A port inside the guest is unreachable until you publish it:

```ts
const api = await runtime.service(8000);
console.log(api.url); // https://…
const response = await api.get('/items');
```

### Terminals, git, SSH

```ts
const session = await runtime.pty.create({ shell: '/bin/bash' });
const terminal = runtime.pty.handle(session.sessionId).connect({
  onData: (chunk) => process.stdout.write(new TextDecoder().decode(chunk)),
});
await terminal.sendInput('ls -la\n');

await runtime.git.clone('https://github.com/org/repo.git', '/workspace/repo', { depth: 1 });

const ssh = await runtime.enableSsh();
console.log(ssh.connectCmd);
```

### Cleaning up

```ts
await using runtime = await client.runtimes.create({ template: 'base-small' });
// stopped when the block exits, however it exits
```

`await using` needs TypeScript 5.2 and Node 20. Elsewhere, `try`/`finally` with
`runtime.kill()` does the same job.

## Templates

Build an image once so runtimes start with everything already installed:

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

const status = await client.templates.buildAndWait(template, {
  onPhase: (s) => console.log(s.phase, `${s.progressPercent}%`),
});
```

Then `client.runtimes.create({ template: 'data-science' })`.

## Snapshots

Capture a configured runtime and start new ones from it:

```ts
await client.snapshots.create(runtime.runtimeId, 'ready-to-work', { kind: 'cold' });
const restored = await client.runtimes.create({ snapshot: 'ready-to-work' });
```

A `cold` snapshot stores the filesystem; a `hot` snapshot stores memory too, so
the restored runtime resumes mid-process.

## Agents

An agent is deployed once and then serves requests on its own hostname:

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

Reading the directory tells the SDK what the project needs — its framework, its
interpreter version, and any `.env` it ships. Anything you pass explicitly wins.

## Network policies

A runtime starts fail-closed. Grant access explicitly:

```ts
const policy = await client.networkPolicies.create('model-access', {
  egressMode: 'allowlist',
  rules: [{ destination: 'api.example.com', port: 443 }],
});

const runtime = await client.runtimes.create({
  template: 'base-small',
  networkPolicyIds: [policy.id],
});
```

Attaching several policies applies the most restrictive of them, so adding one
can only narrow access.

## Secrets

Inject credentials without putting them in code or in an image:

```ts
const provider = await client.identity.providers.create('Model API', {
  secrets: [{ key: 'MODEL_API_KEY', value: process.env.MODEL_API_KEY! }],
});

const runtime = await client.runtimes.create({
  template: 'base-small',
  providers: [provider.id],
});
```

Values are write-only. What comes back is masked.

## Errors

Every failure extends `GravixLayerError`, so one `catch` covers the surface,
with a subclass per category for the ones you can act on.

```ts
import {
  GravixLayerError,
  GravixLayerRateLimitError,
  GravixLayerTimeoutError,
} from 'gravixlayer';

try {
  await client.runtimes.create({ template: 'base-small' });
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

| | |
| --- | --- |
| `GravixLayerAuthenticationError` | 401. |
| `GravixLayerBadRequestError` | Other 4xx. |
| `GravixLayerRateLimitError` | 429, after retries were exhausted. |
| `GravixLayerServerError` | 5xx. |
| `GravixLayerConnectionError` | No response: DNS, TCP, TLS, socket. |
| `GravixLayerTimeoutError` | The request ran past its timeout. |
| `GravixLayerAbortError` | You cancelled it. |
| `GravixLayerInvalidArgumentError` | Rejected before anything was sent. |

Connection failures and 429, 502, 503, and 504 are retried automatically with
exponential backoff and jitter, honouring `Retry-After` when the API sends one.

## Timeouts and cancellation

Any call takes a per-request timeout and an `AbortSignal`:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

await client.runtimes.list({ signal: controller.signal, timeout: 10_000 });
```

## Speed

Latency is the point of the platform, so the client stays out of the way:

- **One client, warm connections.** Reuse a single instance. Call
  `await client.warmup()` at startup to pay TCP and TLS setup before the first
  request that matters — and to verify the key while you are at it.
- **Streaming everywhere.** Command and code output, file watches, terminal
  sessions, and agent responses all arrive incrementally rather than after the
  work finishes.
- **Snapshots over setup.** Capture a prepared runtime once instead of
  installing on every start.
- **Contexts over restarts.** Keep an interpreter alive rather than paying
  process startup per call.

## Observability

Spans are emitted for every request when `@opentelemetry/api` is installed and
tracing is turned on, either by calling `enableTelemetry()` or by setting
`GRAVIXLAYER_ENABLE_TELEMETRY=1`. Setting that variable to `0` keeps tracing off
whatever the code asks for. The SDK never configures an exporter, so its spans
join the traces your application already produces.

```ts
import { enableTelemetry, runtimeSpan, trace, traced } from 'gravixlayer';

await enableTelemetry();

// Span a block of your own work.
await trace('prepare-dataset', async () => runtime.runCode(script));

// Tag a span with the runtime it acts on.
await runtimeSpan('run-tests', runtime.runtimeId, () => runtime.runCmd('npm test'));

// Or wrap a function so every call is traced.
const summarize = traced(function summarize(text: string) {
  return runtime.runCode(`summarize(${JSON.stringify(text)})`);
});
```

With telemetry off, the instrumentation costs one boolean check per call.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Support

- [docs.gravixlayer.ai](https://docs.gravixlayer.ai)
- [GitHub Issues](https://github.com/gravixlayer/gravixlayer-ts/issues)
- support@gravixlayer.ai

## License

Apache 2.0 — see [LICENSE](LICENSE).
