/**
 * Tracing.
 *
 * The SDK emits spans against whichever tracer provider the application
 * registered, and never configures an exporter of its own. These tests register
 * a recording provider in place of a real one and check what the SDK reports:
 * the span names, the attributes, and that a span is always ended.
 */

import { trace as otelTrace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enableTelemetry, runtimeSpan, trace, traced } from '../src/index.js';
import { resetTelemetry } from '../src/core/telemetry.js';
import { jsonResponse, RUNTIME_ID, runtimePayload, testClient } from './helpers.js';

/** One span, as the recording provider saw it. */
interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: unknown[];
  ended: boolean;
}

const spans: RecordedSpan[] = [];

/** A tracer provider that keeps every span in memory. */
const provider = {
  getTracer: () => ({
    startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
      const span: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        exceptions: [],
        ended: false,
      };
      spans.push(span);

      return {
        setAttribute(key: string, value: unknown) {
          span.attributes[key] = value;
        },
        setStatus(status: { code: number; message?: string }) {
          span.status = status;
        },
        recordException(error: unknown) {
          span.exceptions.push(error);
        },
        end() {
          span.ended = true;
        },
      };
    },
  }),
};

beforeEach(async () => {
  spans.length = 0;
  process.env['GRAVIXLAYER_ENABLE_TELEMETRY'] = '1';
  otelTrace.setGlobalTracerProvider(provider as never);
  await enableTelemetry();
});

afterEach(() => {
  delete process.env['GRAVIXLAYER_ENABLE_TELEMETRY'];
  resetTelemetry();
  otelTrace.disable();
});

describe('tracing', () => {
  it('records a span around a successful call', async () => {
    const result = await trace('prepare', () => 42, { attributes: { step: 'one' } });

    expect(result).toBe(42);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('prepare');
    expect(spans[0]?.attributes['step']).toBe('one');
    expect(spans[0]?.ended).toBe(true);
  });

  it('records the failure and still ends the span', async () => {
    const boom = new Error('boom');

    await expect(
      trace('prepare', () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(spans[0]?.exceptions).toEqual([boom]);
    expect(spans[0]?.status?.message).toBe('boom');
    expect(spans[0]?.ended).toBe(true);
  });

  it('names a wrapped function after itself', async () => {
    async function summarize(text: string) {
      return text.length;
    }

    await expect(traced(summarize)('hello')).resolves.toBe(5);
    expect(spans[0]?.name).toBe('summarize');
  });

  it('falls back to a placeholder name for an anonymous function', async () => {
    await traced(() => undefined)();
    expect(spans[0]?.name).toBe('anonymous');
  });

  it('takes an explicit name for a wrapped function', async () => {
    await traced(() => undefined, { name: 'custom' })();
    expect(spans[0]?.name).toBe('custom');
  });

  it('tags a runtime operation with the runtime it acts on', async () => {
    await runtimeSpan('run-code', RUNTIME_ID, () => undefined);

    expect(spans[0]?.name).toBe('runtime.run-code');
    expect(spans[0]?.attributes['gravixlayer.runtime.id']).toBe(RUNTIME_ID);
    expect(spans[0]?.attributes['gravixlayer.operation']).toBe('run-code');
  });

  it('spans every API request the client makes', async () => {
    const { client } = testClient([jsonResponse(runtimePayload())]);
    await client.runtimes.retrieve(RUNTIME_ID);

    const request = spans.find((span) => span.name.startsWith('GET '));
    expect(request?.attributes['http.request.method']).toBe('GET');
    expect(request?.attributes['url.path']).toContain(RUNTIME_ID);
    expect(request?.ended).toBe(true);
  });

  it('marks a failed request on its span', async () => {
    const { client } = testClient([jsonResponse({ error: 'nope' }, 500)]);
    await expect(client.runtimes.retrieve(RUNTIME_ID)).rejects.toThrow();

    const request = spans.find((span) => span.name.startsWith('GET '));
    expect(request?.exceptions).toHaveLength(1);
    expect(request?.ended).toBe(true);
  });

  it('costs nothing once tracing is turned off', async () => {
    resetTelemetry();
    delete process.env['GRAVIXLAYER_ENABLE_TELEMETRY'];

    await expect(trace('prepare', () => 7)).resolves.toBe(7);
    expect(spans).toHaveLength(0);
  });
});
