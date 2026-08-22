/**
 * Trace SDK calls with OpenTelemetry.
 *
 * The SDK emits spans for every request when `@opentelemetry/api` is installed
 * and tracing is turned on, either by the `enableTelemetry()` call below or by
 * setting `GRAVIXLAYER_ENABLE_TELEMETRY=1`. It never configures an exporter of
 * its own: spans go to whichever tracer provider your application registered,
 * so they sit inside your existing traces rather than beside them. With
 * telemetry off, the instrumentation costs one boolean check per call.
 *
 * Anything the guest prints is collected separately and appears under the
 * sandbox's id in the dashboard, so you get application traces and process
 * output for the same piece of work.
 *
 * Run:
 *   npm install @opentelemetry/api @opentelemetry/sdk-node \
 *               @opentelemetry/exporter-trace-otlp-http
 *   export GRAVIXLAYER_API_KEY="your-api-key"
 *   npx tsx examples/runtimes/21-tracing.ts
 */

import { GravixLayer, enableTelemetry, trace, traced } from 'gravixlayer';

// Register a provider before creating the client if you want the spans
// exported. Without one they are recorded and dropped, which is enough to
// confirm the wiring but shows nothing in a backend:
//
//   import { NodeSDK } from '@opentelemetry/sdk-node';
//   import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
//   new NodeSDK({ traceExporter: new OTLPTraceExporter() }).start();

const active = await enableTelemetry();
console.log(`Tracing    : ${active ? 'on' : 'off (install @opentelemetry/api to turn it on)'}`);

const client = new GravixLayer();

const TEMPLATE = process.env['GRAVIXLAYER_TEMPLATE'] ?? 'base-small';
const MARKER = `trace-demo-${Date.now()}`;

// `traced` wraps a function so every call becomes a span. Spans the SDK emits
// while it runs nest underneath, which is what makes a trace readable.
const analyze = traced(
  async (rows: number) => {
    const sandbox = await client.runtime.create({ template: TEMPLATE });
    console.log(`Runtime    : ${sandbox.runtimeId}`);

    try {
      // `trace` is the inline form, for a step that does not deserve its own
      // named function.
      const total = await trace('sum-rows', async () => {
        const result = await sandbox.runCode(
          `import sys
total = sum(range(${rows}))
print(f"${MARKER} computed {total}")
print("${MARKER} done", file=sys.stderr)
print(total)`,
        );
        return Number(result.stdout.trim().split('\n').at(-1));
      });

      console.log(`Total      : ${total}`);
      return total;
    } finally {
      await sandbox.kill();
    }
  },
  { name: 'analyze', attributes: { 'app.component': 'tracing-example' } },
);

await analyze(1_000_000);

// An exporter batches before sending, so give it a moment on the way out of a
// short-lived process.
await new Promise((resolve) => setTimeout(resolve, 3000));

console.log('\nRuntime terminated.');
console.log(`Look for spans named analyze, sum-rows, and the SDK's HTTP calls.`);
console.log(`Guest output is tagged with ${MARKER}.`);
