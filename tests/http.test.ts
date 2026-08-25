import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createSecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPooledFetch, hostRuntime } from '../src/core/http.js';
import { wrapIpv4Lookup } from '../src/core/node-http.js';
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
          address: string,
          family: number,
        ) => void;
        lookup(hostname, { family: 4, all: false }, cb);
      },
    });

    try {
      const response = await pooled.fetch(`http://localhost:${port}/`, {});
      expect(response.status).toBe(200);
      await response.body?.cancel().catch(() => undefined);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((entry) => entry.family === 4)).toBe(true);
      expect(seen.every((entry) => entry.all === false)).toBe(true);
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

  it('multiplexes HTTPS on one HTTP/2 session by default', async () => {
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
    const pooled = createPooledFetch({ rejectUnauthorized: false });

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

function listen(server: {
  listen: (port: number, host: string, cb: () => void) => void;
}): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
