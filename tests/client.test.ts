import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  enableTelemetry,
  GravixLayer,
  GravixLayerInvalidArgumentError,
  telemetryEnabled,
} from '../src/index.js';
import { resetTelemetry } from '../src/core/telemetry.js';
import { VERSION } from '../src/version.js';
import { emptyResponse, jsonResponse, mockFetch, testClient } from './helpers.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('construction', () => {
  it('requires an API key', () => {
    delete process.env['GRAVIXLAYER_API_KEY'];
    expect(() => new GravixLayer()).toThrow(GravixLayerInvalidArgumentError);
  });

  it('reads the API key from the environment', () => {
    process.env['GRAVIXLAYER_API_KEY'] = 'from-env';
    expect(() => new GravixLayer()).not.toThrow();
  });

  it('defaults the base URL, cloud, and region', () => {
    const client = new GravixLayer({ apiKey: 'k' });
    expect(client.baseUrl).toBe('https://api.gravixlayer.ai');
    expect(client.cloud).toBe('aws');
    expect(client.region).toBe('us-east-1');
  });

  it('reads the base URL, cloud, and region from the environment', () => {
    process.env['GRAVIXLAYER_BASE_URL'] = 'https://api.example.test/';
    process.env['GRAVIXLAYER_CLOUD'] = 'gcp';
    process.env['GRAVIXLAYER_REGION'] = 'europe-west1';

    const client = new GravixLayer({ apiKey: 'k' });
    expect(client.baseUrl).toBe('https://api.example.test');
    expect(client.cloud).toBe('gcp');
    expect(client.region).toBe('europe-west1');
  });

  it('strips trailing slashes from the base URL', () => {
    const client = new GravixLayer({ apiKey: 'k', baseUrl: 'https://api.example.test///' });
    expect(client.baseUrl).toBe('https://api.example.test');
  });

  it('rejects a base URL without a scheme', () => {
    expect(() => new GravixLayer({ apiKey: 'k', baseUrl: 'api.example.test' })).toThrow(
      GravixLayerInvalidArgumentError,
    );
  });

  it('rejects a negative timeout and a fractional retry budget', () => {
    expect(() => new GravixLayer({ apiKey: 'k', timeout: -1 })).toThrow(
      GravixLayerInvalidArgumentError,
    );
    expect(() => new GravixLayer({ apiKey: 'k', maxRetries: 1.5 })).toThrow(
      GravixLayerInvalidArgumentError,
    );
  });

  it('accepts http2 as an opt-in constructor flag', () => {
    expect(() => new GravixLayer({ apiKey: 'k', http2: true })).not.toThrow();
    expect(() => new GravixLayer({ apiKey: 'k', http2: false })).not.toThrow();
  });

  it('exposes every resource namespace', () => {
    const client = new GravixLayer({ apiKey: 'k' });
    expect(client.runtime).toBeDefined();
    expect(client.runtime.file).toBeDefined();
    expect(client.runtime.pty).toBeDefined();
    expect(client.runtime.git).toBeDefined();
    expect(client.runtime.service).toBeDefined();
    expect(client.runtime.templates).toBeDefined();
    expect(client.templates).toBeDefined();
    expect(client.snapshots).toBeDefined();
    expect(client.agents).toBeDefined();
    expect(client.identity.providers).toBeDefined();
    expect(client.networkPolicies).toBeDefined();
    expect((client.runtime as { files?: unknown }).files).toBeUndefined();
    expect((client.runtime as { services?: unknown }).services).toBeUndefined();
  });

  it('refuses to construct in a browser unless explicitly allowed', () => {
    const originalWindow = (globalThis as Record<string, unknown>)['window'];
    const originalDocument = (globalThis as Record<string, unknown>)['document'];

    (globalThis as Record<string, unknown>)['window'] = { document: {} };
    (globalThis as Record<string, unknown>)['document'] = {};

    try {
      expect(() => new GravixLayer({ apiKey: 'k' })).toThrow(/browser/i);
      expect(() => new GravixLayer({ apiKey: 'k', dangerouslyAllowBrowser: true })).not.toThrow();
    } finally {
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>)['window'];
      else (globalThis as Record<string, unknown>)['window'] = originalWindow;
      if (originalDocument === undefined)
        delete (globalThis as Record<string, unknown>)['document'];
      else (globalThis as Record<string, unknown>)['document'] = originalDocument;
    }
  });
});

describe('request headers', () => {
  it('sends bearer auth and a versioned user agent', async () => {
    const { client, http } = testClient([jsonResponse({ runtimes: [], total: 0 })]);
    await client.runtime.list();

    const headers = http.last().headers;
    expect(headers['authorization']).toBe('Bearer test-key');
    expect(headers['user-agent']).toBe(`gravixlayer-ts/${VERSION}`);
  });

  it('merges client default headers, letting the caller win', async () => {
    const { client, http } = testClient([jsonResponse({ runtimes: [], total: 0 })], {
      defaultHeaders: { 'X-Tenant': 'acme', accept: 'application/json' },
    });
    await client.runtime.list({ headers: { 'X-Tenant': 'other' } });

    expect(http.last().headers['x-tenant']).toBe('other');
  });

  it('sets a JSON content type only when there is a JSON body', async () => {
    const { client, http } = testClient([
      jsonResponse({ runtimes: [], total: 0 }),
      jsonResponse({ message: 'ok' }),
    ]);

    await client.runtime.list();
    expect(http.requests[0]?.headers['content-type']).toBeUndefined();

    await client.runtime.setTimeout('11111111-2222-4333-8444-555555555555', 60);
    expect(http.requests[1]?.headers['content-type']).toBe('application/json');
  });
});

describe('warmup', () => {
  it('issues one minimal list request', async () => {
    const { client, http } = testClient([jsonResponse({ runtimes: [], total: 0 })]);
    await client.warmup();

    expect(http.requests).toHaveLength(1);
    expect(http.query().get('limit')).toBe('1');
    expect(http.last().url).toContain('/v1/agents/runtime');
  });

  it('surfaces an authentication failure', async () => {
    const { client } = testClient([new Response('nope', { status: 401 })]);
    await expect(client.warmup()).rejects.toThrow('Authentication failed.');
  });
});

describe('close', () => {
  it('is a no-op when fetch is injected', async () => {
    const { client } = testClient([jsonResponse({ runtimes: [], total: 0 })]);
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe('telemetry opt-in', () => {
  afterEach(() => {
    resetTelemetry();
  });

  it('stays off until something asks for it', () => {
    delete process.env['GRAVIXLAYER_ENABLE_TELEMETRY'];
    expect(telemetryEnabled()).toBe(false);
  });

  it('turns on for the process when enableTelemetry is called', async () => {
    delete process.env['GRAVIXLAYER_ENABLE_TELEMETRY'];
    await enableTelemetry();
    expect(telemetryEnabled()).toBe(true);
  });

  it('turns on from the environment alone', () => {
    process.env['GRAVIXLAYER_ENABLE_TELEMETRY'] = '1';
    expect(telemetryEnabled()).toBe(true);
  });

  it('lets the environment veto a programmatic opt-in', async () => {
    process.env['GRAVIXLAYER_ENABLE_TELEMETRY'] = 'false';
    await expect(enableTelemetry()).resolves.toBe(false);
    expect(telemetryEnabled()).toBe(false);
  });
});

describe('fetch resolution', () => {
  it('uses the injected fetch rather than the global one', async () => {
    const spy = vi.fn(async () => jsonResponse({ runtimes: [], total: 0 }));
    const client = new GravixLayer({
      apiKey: 'k',
      baseUrl: 'https://api.test.invalid',
      fetch: spy,
    });

    await client.runtime.list();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('accepts a 204 with no body', async () => {
    const http = mockFetch([emptyResponse()]);
    const client = new GravixLayer({
      apiKey: 'k',
      baseUrl: 'https://api.test.invalid',
      fetch: http.fetch,
    });

    await expect(
      client.runtime.pause('11111111-2222-4333-8444-555555555555'),
    ).resolves.toBeUndefined();
  });
});
