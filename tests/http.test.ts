import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { constants as h2constants, createSecureServer, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPooledFetch, hostRuntime } from '../src/core/http.js';
import {
  createAddressBook,
  wrapIpv4Lookup,
  type DnsLookupCallback,
} from '../src/core/node-http.js';
import { GravixLayer } from '../src/index.js';
import { jsonResponse } from './helpers.js';

describe('host runtime', () => {
  it('identifies the test runner as Node', () => {
    expect(hostRuntime()).toBe('node');
  });
});

describe('pooled fetch', () => {
  it('closes a pooled Node client', async () => {
    const client = new GravixLayer({ apiKey: 'k', baseUrl: 'https://api.test.invalid' });
    await client.close();
    await expect(client.runtime.list()).rejects.toThrow(/closed/);
  });

  it('rejects further requests after close', async () => {
    const pooled = createPooledFetch();
    await pooled.close();
    await expect(pooled.fetch('https://api.test.invalid/', {})).rejects.toThrow(/closed/);
  });

  it('returns a fetch that can be closed more than once', async () => {
    const pooled = createPooledFetch({ http2: true });
    expect(typeof pooled.fetch).toBe('function');
    await pooled.preconnect();
    await pooled.close();
    await pooled.close();
  });

  it('still returns a fetch when HTTP/2 is disabled', async () => {
    const pooled = createPooledFetch({ http2: false });
    await pooled.preconnect();
    await pooled.close();
  });

  it('does not attach a dispatcher to an injected fetch', async () => {
    let sawDispatcher = false;
    const client = new GravixLayer({
      apiKey: 'k',
      baseUrl: 'https://api.test.invalid',
      fetch: async (_url, init) => {
        sawDispatcher = Object.prototype.hasOwnProperty.call(init, 'dispatcher');
        return jsonResponse({ runtimes: [], total: 0 });
      },
    });

    await client.runtime.list();
    expect(sawDispatcher).toBe(false);
    await client.close();
  });

  it('forces DNS lookup onto IPv4 A records', () => {
    const calls: Array<{ hostname: string; options: Record<string, unknown> }> = [];
    const wrapped = wrapIpv4Lookup((hostname, options, callback) => {
      const opts =
        typeof options === 'function' ? {} : ((options as Record<string, unknown>) ?? {});
      calls.push({ hostname, options: opts });
      if (typeof options === 'function') options(null, '1.2.3.4', 4);
      else callback?.(null, '1.2.3.4', 4);
    });
    expect(wrapped).toBeDefined();
    wrapped!('api.gravixlayer.ai', { all: true, family: 0 }, () => undefined);
    expect(calls).toEqual([
      {
        hostname: 'api.gravixlayer.ai',
        options: expect.objectContaining({ family: 4, all: false }),
      },
    ]);
  });

  it('uses the IPv4 lookup when opening a pooled socket', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const seen: Array<{ hostname: string; family?: unknown; all?: unknown }> = [];
    const { lookup } = await import('node:dns');
    const pooled = createPooledFetch({
      http2: false,
      lookup: (hostname, options, callback) => {
        const opts =
          typeof options === 'function' ? {} : ((options as Record<string, unknown>) ?? {});
        seen.push({ hostname, family: opts.family, all: opts.all });
        const cb = (typeof options === 'function' ? options : callback) as (
          err: NodeJS.ErrnoException | null,
          addresses: Array<{ address: string; family: number }>,
        ) => void;
        lookup(hostname, { family: 4, all: true }, cb);
      },
    });

    try {
      const response = await pooled.fetch(`http://localhost:${port}/`, {});
      expect(response.status).toBe(200);
      await response.body?.cancel().catch(() => undefined);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((entry) => entry.family === 4)).toBe(true);
      expect(seen.every((entry) => entry.all === true)).toBe(true);
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('opens parallel HTTP/1.1 sockets for concurrent requests', async () => {
    let connections = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const server = createHttpServer((req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: req.url }));
      }, 40);
    });
    server.on('connection', () => {
      connections += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const responses = await Promise.all([
        pooled.fetch(`http://127.0.0.1:${port}/a`, {}),
        pooled.fetch(`http://127.0.0.1:${port}/b`, {}),
        pooled.fetch(`http://127.0.0.1:${port}/c`, {}),
        pooled.fetch(`http://127.0.0.1:${port}/d`, {}),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
        await response.body?.cancel().catch(() => undefined);
      }
      expect(connections).toBeGreaterThanOrEqual(4);
      expect(maxInFlight).toBeGreaterThanOrEqual(4);
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('reuses a keep-alive HTTP/1.1 socket', async () => {
    let connections = 0;
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    server.on('connection', () => {
      connections += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const first = await pooled.fetch(`http://127.0.0.1:${port}/a`, {});
      expect(await first.json()).toEqual({ ok: true, path: '/a' });
      await first.body?.cancel().catch(() => undefined);
      const second = await pooled.fetch(`http://127.0.0.1:${port}/b`, {});
      expect(await second.json()).toEqual({ ok: true, path: '/b' });
      expect(connections).toBeLessThanOrEqual(2);
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('multiplexes two HTTPS requests on one HTTP/2 session', async () => {
    const certs = selfSignedCerts();

    let sessions = 0;
    const server = createSecureServer(certs);
    server.on('stream', (stream, headers) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ path: headers[':path'] }));
    });
    server.on('session', () => {
      sessions += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      const [a, b] = await Promise.all([
        pooled.fetch(`https://127.0.0.1:${port}/one`, {}),
        pooled.fetch(`https://127.0.0.1:${port}/two`, {}),
      ]);
      expect(await a.json()).toEqual({ path: '/one' });
      expect(await b.json()).toEqual({ path: '/two' });
      expect(sessions).toBe(1);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('uses HTTP/1.1 by default even when the origin speaks HTTP/2', async () => {
    const certs = selfSignedCerts();

    let sessions = 0;
    const server = createSecureServer({
      key: certs.key,
      cert: certs.cert,
      allowHTTP1: true,
    });
    server.on('request', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, version: req.httpVersion }));
    });
    server.on('session', () => {
      sessions += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ rejectUnauthorized: false });

    try {
      const [a, b] = await Promise.all([
        pooled.fetch(`https://127.0.0.1:${port}/one`, {}),
        pooled.fetch(`https://127.0.0.1:${port}/two`, {}),
      ]);
      expect(await a.json()).toEqual({ path: '/one', version: '1.1' });
      expect(await b.json()).toEqual({ path: '/two', version: '1.1' });
      expect(sessions).toBe(0);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('closes keep-alive sockets so the process is not held open', async () => {
    let open = 0;
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    server.on('connection', (socket) => {
      open += 1;
      socket.on('close', () => {
        open -= 1;
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const res = await pooled.fetch(`http://127.0.0.1:${port}/`, {});
      expect(await res.json()).toEqual({ ok: true });
      expect(open).toBeGreaterThan(0);
      await pooled.close();
      const deadline = Date.now() + 1000;
      while (open > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(open).toBe(0);
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('closes an HTTP/2 session without waiting for GOAWAY', async () => {
    const certs = selfSignedCerts();
    const server = createSecureServer(certs);
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ ok: true }));
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      const res = await pooled.fetch(`https://127.0.0.1:${port}/`, {});
      expect(await res.json()).toEqual({ ok: true });
      const started = Date.now();
      await pooled.close();
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('falls back to HTTP/1.1 when the origin does not speak HTTP/2', async () => {
    const certs = selfSignedCerts();
    const server = createHttpsServer({ key: certs.key, cert: certs.cert }, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, via: 'h1' }));
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      const res = await pooled.fetch(`https://127.0.0.1:${port}/fallback`, {});
      expect(await res.json()).toEqual({ path: '/fallback', via: 'h1' });
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('opens parallel HTTP/1.1 sockets after HTTP/2 is unavailable', async () => {
    const certs = selfSignedCerts();
    let connections = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const server = createHttpsServer({ key: certs.key, cert: certs.cert }, (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ via: 'h1' }));
      }, 40);
    });
    server.on('connection', () => {
      connections += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      const responses = await Promise.all([
        pooled.fetch(`https://127.0.0.1:${port}/a`, {}),
        pooled.fetch(`https://127.0.0.1:${port}/b`, {}),
        pooled.fetch(`https://127.0.0.1:${port}/c`, {}),
        pooled.fetch(`https://127.0.0.1:${port}/d`, {}),
      ]);
      for (const response of responses) {
        expect(await response.json()).toEqual({ via: 'h1' });
      }
      expect(connections).toBeGreaterThanOrEqual(4);
      expect(maxInFlight).toBeGreaterThanOrEqual(4);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('multiplexes four concurrent HTTPS requests on one HTTP/2 session', async () => {
    const certs = selfSignedCerts();
    let sessions = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const server = createSecureServer(certs);
    server.on('session', () => {
      sessions += 1;
    });
    server.on('stream', (stream) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ via: 'h2' }));
      }, 40);
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      const responses = await Promise.all([
        pooled.fetch(`https://127.0.0.1:${port}/a`, {}),
        pooled.fetch(`https://127.0.0.1:${port}/b`, {}),
        pooled.fetch(`https://127.0.0.1:${port}/c`, {}),
        pooled.fetch(`https://127.0.0.1:${port}/d`, {}),
      ]);
      for (const response of responses) {
        expect(await response.json()).toEqual({ via: 'h2' });
      }
      expect(sessions).toBe(1);
      expect(maxInFlight).toBeGreaterThanOrEqual(4);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('keeps HTTP/2 on one origin after another origin falls back to HTTP/1.1', async () => {
    const h1Certs = selfSignedCerts();
    const h2Certs = selfSignedCerts();

    const h1 = createHttpsServer({ key: h1Certs.key, cert: h1Certs.cert }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ via: 'h1' }));
    });
    let sessions = 0;
    const h2 = createSecureServer(h2Certs);
    h2.on('stream', (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ via: 'h2' }));
    });
    h2.on('session', () => {
      sessions += 1;
    });

    await listen(h1);
    await listen(h2);
    const h1Port = (h1.address() as AddressInfo).port;
    const h2Port = (h2.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      expect(await (await pooled.fetch(`https://127.0.0.1:${h1Port}/a`, {})).json()).toEqual({
        via: 'h1',
      });
      const [a, b] = await Promise.all([
        pooled.fetch(`https://127.0.0.1:${h2Port}/one`, {}),
        pooled.fetch(`https://127.0.0.1:${h2Port}/two`, {}),
      ]);
      expect(await a.json()).toEqual({ via: 'h2' });
      expect(await b.json()).toEqual({ via: 'h2' });
      expect(sessions).toBe(1);
    } finally {
      await pooled.close();
      await closeServer(h1);
      await closeServer(h2);
      rmSync(h1Certs.dir, { recursive: true, force: true });
      rmSync(h2Certs.dir, { recursive: true, force: true });
    }
  });
});

/** Past the address book's reuse window. */
const PAST_TTL_MS = 30_001;

/** Let queued lookups and their continuations run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** An address book over scripted answers, each delivered asynchronously. */
function scriptedBook(answers: unknown[]) {
  const calls: string[] = [];
  const addresses = createAddressBook((hostname: string, callback: DnsLookupCallback) => {
    calls.push(hostname);
    const answer = answers.shift();
    queueMicrotask(() => {
      if (answer instanceof Error) callback(answer, undefined);
      else callback(null, answer);
    });
  });
  return { addresses, calls };
}

describe('address book', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an IPv4 literal without a lookup', async () => {
    const { addresses, calls } = scriptedBook([]);
    await expect(addresses.resolveIpv4('10.0.0.7')).resolves.toBe('10.0.0.7');
    expect(calls).toEqual([]);
  });

  it('reuses a fresh answer', async () => {
    const { addresses, calls } = scriptedBook([['10.0.0.1', '10.0.0.2']]);
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    expect(calls).toEqual(['api.test']);
  });

  it('looks a hostname up once for concurrent requests', async () => {
    const { addresses, calls } = scriptedBook([[{ address: '10.0.0.1', family: 4 }]]);
    const resolved = await Promise.all([
      addresses.resolveIpv4('api.test'),
      addresses.resolveIpv4('api.test'),
      addresses.resolveIpv4('api.test'),
    ]);
    expect(resolved).toEqual(['10.0.0.1', '10.0.0.1', '10.0.0.1']);
    expect(calls).toHaveLength(1);
  });

  it('accepts a single-address answer', async () => {
    const { addresses } = scriptedBook(['10.0.0.9']);
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.9');
  });

  it('rejects an empty answer and looks the host up again next time', async () => {
    const { addresses, calls } = scriptedBook([[], ['', { address: 7 }], ['10.0.0.1']]);
    await expect(addresses.resolveIpv4('api.test')).rejects.toThrow(/Could not resolve api.test/);
    await expect(addresses.resolveIpv4('api.test')).rejects.toThrow(/Could not resolve/);
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    expect(calls).toHaveLength(3);
  });

  it('does not cache a failed lookup', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const { addresses, calls } = scriptedBook([failure, ['10.0.0.1']]);
    await expect(addresses.resolveIpv4('api.test')).rejects.toBe(failure);
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    expect(calls).toHaveLength(2);
  });

  it('serves the last answer while refreshing, keeping the address in use first', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { addresses, calls } = scriptedBook([
      ['10.0.0.1', '10.0.0.2'],
      ['10.0.0.3', '10.0.0.1'],
    ]);
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');

    now.mockReturnValue(1_000 + PAST_TTL_MS);
    // The stale answer is returned at once; the refresh runs behind it.
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    expect(calls).toHaveLength(2);
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    expect(calls).toHaveLength(2);

    await flush();
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    addresses.demote('api.test', '10.0.0.1');
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.3');
  });

  it('moves off an address DNS no longer publishes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { addresses } = scriptedBook([['10.0.0.1'], ['10.0.0.2']]);
    await addresses.resolveIpv4('api.test');

    now.mockReturnValue(1_000 + PAST_TTL_MS);
    await addresses.resolveIpv4('api.test');
    await flush();
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.2');
  });

  it('keeps the last good answer for another TTL when a refresh fails', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { addresses, calls } = scriptedBook([['10.0.0.1'], new Error('SERVFAIL')]);
    await addresses.resolveIpv4('api.test');

    now.mockReturnValue(1_000 + PAST_TTL_MS);
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    await flush();
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    expect(calls).toHaveLength(2);

    now.mockReturnValue(1_000 + 2 * PAST_TTL_MS);
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    expect(calls).toHaveLength(3);
  });

  it('rotates a demoted address to the back and refreshes on next use', async () => {
    const { addresses, calls } = scriptedBook([
      ['10.0.0.1', '10.0.0.2'],
      ['10.0.0.1', '10.0.0.2'],
    ]);
    await addresses.resolveIpv4('api.test');

    addresses.demote('api.test', '10.0.0.1');
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.2');
    expect(calls).toHaveLength(2);
    await flush();
    // The refreshed list still has the demoted address, but the one now in
    // use stays first.
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.2');
  });

  it('ignores a demotion for an address that is not in use', async () => {
    const { addresses, calls } = scriptedBook([['10.0.0.1', '10.0.0.2']]);
    await addresses.resolveIpv4('api.test');

    addresses.demote('api.test', '10.0.0.2');
    addresses.demote('other.test', '10.0.0.1');
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.1');
    expect(calls).toHaveLength(1);
  });

  it('forgets every answer on clear', async () => {
    const { addresses, calls } = scriptedBook([['10.0.0.1'], ['10.0.0.2']]);
    await addresses.resolveIpv4('api.test');
    addresses.clear();
    await expect(addresses.resolveIpv4('api.test')).resolves.toBe('10.0.0.2');
    expect(calls).toHaveLength(2);
  });
});

describe('system resolver', () => {
  it('resolves a hostname through the system resolver when none is injected', async () => {
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host }));
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const response = await pooled.fetch(`http://localhost:${port}/`, {});
      expect(await response.json()).toEqual({ host: `localhost:${port}` });
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });
});

describe('connect failures', () => {
  it('looks a host up again after its address refuses a connection', async () => {
    const port = await freePort();
    let lookups = 0;
    const pooled = createPooledFetch({
      http2: false,
      lookup: (_hostname, _options, callback) => {
        lookups += 1;
        callback?.(null, [{ address: '127.0.0.1', family: 4 }]);
      },
    });

    try {
      await expect(pooled.fetch(`http://svc.test:${port}/`, {})).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
      expect(lookups).toBe(1);
      await expect(pooled.fetch(`http://svc.test:${port}/`, {})).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
      expect(lookups).toBe(2);
    } finally {
      await pooled.close();
    }
  });

  it('looks a host up again after an HTTP/2 connect is refused', async () => {
    const port = await freePort();
    let lookups = 0;
    const pooled = createPooledFetch({
      http2: true,
      rejectUnauthorized: false,
      lookup: (_hostname, _options, callback) => {
        lookups += 1;
        callback?.(null, [{ address: '127.0.0.1', family: 4 }]);
      },
    });

    try {
      await expect(pooled.fetch(`https://svc.test:${port}/`, {})).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
      const afterFirst = lookups;
      expect(afterFirst).toBeGreaterThanOrEqual(1);
      await expect(pooled.fetch(`https://svc.test:${port}/`, {})).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
      expect(lookups).toBeGreaterThan(afterFirst);
    } finally {
      await pooled.close();
    }
  });

  it('tries HTTP/2 again after a connect failure instead of giving it up', async () => {
    const certs = selfSignedCerts();
    const port = await freePort();
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });
    const server = createSecureServer(certs);
    let sessions = 0;
    server.on('session', () => {
      sessions += 1;
    });
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ via: 'h2' }));
    });

    try {
      await expect(pooled.fetch(`https://127.0.0.1:${port}/`, {})).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
      await listenOn(server, port);
      const response = await pooled.fetch(`https://127.0.0.1:${port}/`, {});
      expect(await response.json()).toEqual({ via: 'h2' });
      expect(sessions).toBe(1);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('stays on HTTP/1.1 once an origin has declined HTTP/2', async () => {
    const certs = selfSignedCerts();
    let probes = 0;
    const server = createHttpsServer(
      {
        key: certs.key,
        cert: certs.cert,
        ALPNCallback: ({ protocols }) => {
          if (protocols.includes('h2')) probes += 1;
          return 'http/1.1';
        },
      },
      (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: req.url }));
      },
    );
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      for (const path of ['/a', '/b', '/c']) {
        const response = await pooled.fetch(`https://127.0.0.1:${port}${path}`, {});
        expect(await response.json()).toEqual({ path });
      }
      expect(probes).toBe(1);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });
});

describe('HTTP/2 aborts', () => {
  /** An HTTP/2 server that answers every stream with `respond`, recording how each one closed. */
  async function h2Server(respond: (stream: ServerHttp2Stream) => void) {
    const certs = selfSignedCerts();
    const closed: number[] = [];
    let opened = 0;
    const server = createSecureServer(certs);
    server.on('stream', (stream) => {
      opened += 1;
      stream.on('close', () => closed.push(stream.rstCode));
      respond(stream);
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });
    return {
      url: `https://127.0.0.1:${port}/events`,
      pooled,
      closed,
      opened: () => opened,
      async stop() {
        await pooled.close();
        await closeServer(server);
        rmSync(certs.dir, { recursive: true, force: true });
      },
    };
  }

  const EVENT_STREAM = { accept: 'text/event-stream' };

  it('fails a streaming body and cancels the stream on an abort after the headers', async () => {
    const h2 = await h2Server((stream) => {
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
      stream.write('data: one\n\n');
    });
    const controller = new AbortController();

    try {
      const response = await h2.pooled.fetch(h2.url, {
        headers: EVENT_STREAM,
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      const next = reader.read();
      controller.abort();

      await expect(next).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(h2.closed).toEqual([h2constants.NGHTTP2_CANCEL]));
    } finally {
      await h2.stop();
    }
  });

  it('rejects and cancels the stream on an abort before the headers', async () => {
    const h2 = await h2Server(() => undefined);
    const controller = new AbortController();

    try {
      const pending = h2.pooled.fetch(h2.url, { signal: controller.signal });
      await vi.waitFor(() => expect(h2.opened()).toBe(1));
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(h2.closed).toEqual([h2constants.NGHTTP2_CANCEL]));
    } finally {
      await h2.stop();
    }
  });

  it('releases the signal once a streaming body is read to the end', async () => {
    const h2 = await h2Server((stream) => {
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
      stream.end('data: done\n\n');
    });
    const controller = new AbortController();

    try {
      const response = await h2.pooled.fetch(h2.url, {
        headers: EVENT_STREAM,
        signal: controller.signal,
      });
      expect(await response.text()).toBe('data: done\n\n');
      await vi.waitFor(() => expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0));
    } finally {
      await h2.stop();
    }
  });
});

describe('request bodies', () => {
  it('sends a string body over HTTP/1.1 with its length', async () => {
    let seen: { length: string | undefined; body: string } | undefined;
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen = { length: req.headers['content-length'], body: Buffer.concat(chunks).toString() };
        res.end();
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const body = JSON.stringify({ command: 'echo', note: 'héllo' });
      const response = await pooled.fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body });
      await response.arrayBuffer();
      expect(seen).toEqual({ length: String(Buffer.byteLength(body)), body });
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('sends a byte body over HTTP/2', async () => {
    const certs = selfSignedCerts();
    let seen: Buffer | undefined;
    const server = createSecureServer(certs);
    server.on('stream', (stream) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        seen = Buffer.concat(chunks);
        stream.respond({ ':status': 204 });
        stream.end();
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      const body = Uint8Array.from({ length: 70_000 }, (_, i) => i & 0xff);
      const response = await pooled.fetch(`https://127.0.0.1:${port}/`, { method: 'PUT', body });
      expect(response.status).toBe(204);
      expect(seen?.equals(body)).toBe(true);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });
});

describe('multipart bodies', () => {
  /** A form exercising every encoding rule `fetch` applies. */
  function sampleForm(): FormData {
    const form = new FormData();
    form.append('text', 'line one\nline two\r\nline three\rend');
    form.append('we"ird\nname', 'value');
    form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    form.append('bytes', new Blob([Uint8Array.from({ length: 256 }, (_, i) => i)]), 'data.bin');
    form.append('anonymous', new Blob(['no name']));
    form.append('quoted', new File(['q'], 'a"b\nc.txt', { type: 'text/plain' }));
    return form;
  }

  /** What `fetch` would send for `form`, rewritten to use `boundary`. */
  async function fetchEncoding(form: FormData, boundary: string): Promise<Buffer> {
    const request = new Request('http://127.0.0.1/', { method: 'POST', body: form });
    const reference = /boundary=(.+)$/.exec(request.headers.get('content-type') ?? '')?.[1];
    const bytes = Buffer.from(await request.arrayBuffer()).toString('latin1');
    return Buffer.from(bytes.split(reference ?? '').join(boundary), 'latin1');
  }

  function boundaryOf(contentType: string | undefined): string {
    const boundary = /^multipart\/form-data; boundary=(-{4}formdata-[0-9a-f]{32})$/.exec(
      contentType ?? '',
    )?.[1];
    expect(boundary).toBeDefined();
    return boundary as string;
  }

  it('streams the same bytes fetch would send, with an exact length', async () => {
    let seen: { headers: NodeJS.Dict<string | string[]>; body: Buffer } | undefined;
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen = { headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const form = sampleForm();
      const response = await pooled.fetch(`http://127.0.0.1:${port}/upload`, {
        method: 'POST',
        body: form,
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();

      const boundary = boundaryOf(seen?.headers['content-type'] as string);
      expect(seen?.headers['transfer-encoding']).toBeUndefined();
      expect(Number(seen?.headers['content-length'])).toBe(seen?.body.length);
      expect(seen?.body.equals(await fetchEncoding(form, boundary))).toBe(true);
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('streams a large file part intact over HTTP/2', async () => {
    const certs = selfSignedCerts();
    let seen: { headers: Record<string, unknown>; body: Buffer } | undefined;
    const server = createSecureServer(certs);
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        seen = { headers, body: Buffer.concat(chunks) };
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end('{}');
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      const payload = Uint8Array.from({ length: 3 * 1024 * 1024 + 7 }, (_, i) => (i * 31) & 0xff);
      const form = new FormData();
      form.append('meta', '{"kind":"archive"}');
      form.append('file', new Blob([payload], { type: 'application/gzip' }), 'source.tar.gz');

      const response = await pooled.fetch(`https://127.0.0.1:${port}/upload`, {
        method: 'POST',
        body: form,
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();

      const boundary = boundaryOf(seen?.headers['content-type'] as string);
      expect(Number(seen?.headers['content-length'])).toBe(seen?.body.length);
      expect(seen?.body.equals(await fetchEncoding(form, boundary))).toBe(true);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('stops writing a file part once the request is aborted', async () => {
    let received = 0;
    const server = createHttpServer((req) => {
      req.once('data', (chunk: Buffer) => {
        received += chunk.length;
        // Stop reading so the client's buffers fill and it has to wait.
        req.pause();
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });
    const controller = new AbortController();

    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(32 * 1024 * 1024)]), 'big.bin');
      const pending = pooled.fetch(`http://127.0.0.1:${port}/upload`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      while (received === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      // Give the client time to fill its buffers and block on backpressure.
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await flush();
    } finally {
      await pooled.close();
      server.closeAllConnections();
      await closeServer(server);
    }
  });
});

function listen(server: {
  listen: (port: number, host: string, cb: () => void) => void;
}): Promise<void> {
  return listenOn(server, 0);
}

function listenOn(
  server: { listen: (port: number, host: string, cb: () => void) => void },
  port: number,
): Promise<void> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

/** A local port with nothing listening on it. */
async function freePort(): Promise<number> {
  const probe = createHttpServer();
  await listen(probe);
  const { port } = probe.address() as AddressInfo;
  await closeServer(probe);
  return port;
}

function closeServer(server: { close: (cb: (err?: Error) => void) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function selfSignedCerts(): { dir: string; key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'gravixlayer-h2-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'pipe' },
  );
  return { dir, key: readFileSync(key), cert: readFileSync(cert) };
}
