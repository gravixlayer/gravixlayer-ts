import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createSecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createPooledFetch } from '../src/core/http.js';
import { NodeHeaders } from '../src/core/node-http.js';
import { fetchDispatch, readAll } from '../src/core/wire.js';
import { GravixLayer } from '../src/index.js';

const decoder = new TextDecoder();

describe('fetchDispatch', () => {
  it('adapts a fetch call to the wire contract', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const reply = await fetchDispatch(async (url, init) => {
      seen.push({ url, init });
      return new Response(Uint8Array.from([123]).buffer, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    })({
      url: 'https://api.test.invalid/v1/x',
      method: 'POST',
      headers: { 'x-test': 'yes' },
      body: '{}',
      stream: false,
    });

    expect(seen[0]?.init.method).toBe('POST');
    expect(reply.status).toBe(200);
    expect(reply.statusText).toBe('OK');
    expect(reply.headers.get('content-type')).toBe('application/json');
    expect(decoder.decode(await reply.bytes())).toBe('{');
  });

  it('asks fetch not to cache a streamed response', async () => {
    const seen: Array<RequestInit> = [];
    await fetchDispatch(async (_url, init) => {
      seen.push(init);
      return new Response(new ReadableStream({ start: (c) => c.close() }));
    })({
      url: 'https://api.test.invalid/v1/x',
      method: 'GET',
      headers: {},
      stream: true,
    });
    expect(seen[0]?.cache).toBe('no-store');
  });

  it('cancels a body that is never read', async () => {
    let cancelled = false;
    const reply = await fetchDispatch(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    )({
      url: 'https://api.test.invalid/v1/x',
      method: 'GET',
      headers: {},
      stream: true,
    });
    reply.cancel();
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});

describe('readAll', () => {
  it('concatenates every chunk of a stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3]));
        controller.close();
      },
    });
    expect([...(await readAll(stream))]).toEqual([1, 2, 3]);
  });
});

describe('NodeHeaders', () => {
  it('looks headers up case-insensitively and joins repeated values', () => {
    const headers = new NodeHeaders({
      'content-type': 'application/json',
      'x-pair': ['a', 'b'],
      ':status': 200,
      'x-absent': undefined,
    });
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('x-pair')).toBe('a,b');
    expect(headers.get(':status')).toBeNull();
    expect(headers.get('x-absent')).toBeNull();
    expect(headers.get('missing')).toBeNull();

    const seen: Record<string, string> = {};
    headers.forEach((value, name) => {
      seen[name] = value;
    });
    expect(seen).toEqual({ 'content-type': 'application/json', 'x-pair': 'a,b' });
  });
});

describe('wire dispatch over HTTP/1.1', () => {
  it('returns status, headers, and owned bytes without a Response', async () => {
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: req.url }));
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const reply = await pooled.dispatch({
        url: `http://127.0.0.1:${port}/wire`,
        method: 'GET',
        headers: {},
        stream: false,
      });
      expect(reply.status).toBe(200);
      expect(reply.headers.get('content-type')).toMatch(/json/);
      expect(reply.body).toBeNull();
      const bytes = await reply.bytes();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(JSON.parse(decoder.decode(bytes))).toEqual({ method: 'GET', path: '/wire' });
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('shares one keep-alive pool across a first-request burst', async () => {
    let connections = 0;
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    server.on('connection', () => {
      connections += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const replies = await Promise.all(
        Array.from({ length: 32 }, () =>
          pooled.dispatch({
            url: `http://127.0.0.1:${port}/`,
            method: 'GET',
            headers: {},
            stream: false,
          }),
        ),
      );
      await Promise.all(replies.map((reply) => reply.bytes()));
      // A cold burst initializes its agent pair once; more than the 16-socket
      // cap would mean each request built its own pool.
      expect(connections).toBeLessThanOrEqual(16);
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('rejects bytes() when the body never completes', async () => {
    const server = createHttpServer((_req, res) => {
      res.on('error', () => undefined);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.flushHeaders();
      setTimeout(() => {
        res.write('{"partial":');
        res.socket?.destroy();
      }, 20);
    });
    server.on('clientError', () => undefined);
    server.on('connection', (socket) => socket.on('error', () => undefined));
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      const reply = await pooled.dispatch({
        url: `http://127.0.0.1:${port}/`,
        method: 'GET',
        headers: {},
        stream: false,
      });
      expect(reply.status).toBe(200);
      await expect(reply.bytes()).rejects.toThrow();
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });

  it('parses a real client request through the dispatch path', async () => {
    const server = createHttpServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runtimes: [], total: 0, auth: req.headers.authorization }));
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const client = new GravixLayer({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });

    try {
      const result = await client.runtime.list();
      expect(result.runtimes).toEqual([]);
    } finally {
      await client.close();
      await closeServer(server);
    }
  });
});

describe('wire dispatch over HTTP/2', () => {
  it('multiplexes requests on one session and returns bytes', async () => {
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
        pooled.dispatch({
          url: `https://127.0.0.1:${port}/a`,
          method: 'GET',
          headers: {},
          stream: false,
        }),
        pooled.dispatch({
          url: `https://127.0.0.1:${port}/b`,
          method: 'GET',
          headers: {},
          stream: false,
        }),
      ]);
      expect(JSON.parse(decoder.decode(await a.bytes()))).toEqual({ path: '/a' });
      expect(JSON.parse(decoder.decode(await b.bytes()))).toEqual({ path: '/b' });
      expect(sessions).toBe(1);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('shares one session across clients and keeps it open until the last close', async () => {
    const certs = selfSignedCerts();
    let sessions = 0;
    const server = createSecureServer(certs);
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end('{"ok":true}');
    });
    server.on('session', () => {
      sessions += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;

    const a = createPooledFetch({ http2: true, rejectUnauthorized: false });
    const b = createPooledFetch({ http2: true, rejectUnauthorized: false });
    const request = {
      url: `https://127.0.0.1:${port}/`,
      method: 'GET',
      headers: {},
      stream: false,
    };

    try {
      await (await a.dispatch(request)).bytes();
      await (await b.dispatch(request)).bytes();
      expect(sessions).toBe(1);

      // Closing one client must not drop the session the other still uses.
      await a.close();
      const reply = await b.dispatch(request);
      expect(JSON.parse(decoder.decode(await reply.bytes()))).toEqual({ ok: true });
      expect(sessions).toBe(1);
    } finally {
      await a.close();
      await b.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('opens the session pool from preconnect(origin) before any request', async () => {
    const certs = selfSignedCerts();
    let sessions = 0;
    const server = createSecureServer(certs);
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200 });
      stream.end('{}');
    });
    server.on('session', () => {
      sessions += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });

    try {
      await pooled.preconnect(`https://127.0.0.1:${port}`);
      await vi.waitFor(() => expect(sessions).toBe(4));
      const reply = await pooled.dispatch({
        url: `https://127.0.0.1:${port}/`,
        method: 'GET',
        headers: {},
        stream: false,
      });
      expect(reply.status).toBe(200);
      expect(sessions).toBe(4);
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it('rejects bytes() when the request aborts mid-body', async () => {
    const certs = selfSignedCerts();
    const server = createSecureServer(certs);
    server.on('stream', (stream) => {
      stream.on('error', () => undefined);
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      // Body intentionally never completes.
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: true, rejectUnauthorized: false });
    const controller = new AbortController();

    try {
      const reply = await pooled.dispatch({
        url: `https://127.0.0.1:${port}/`,
        method: 'GET',
        headers: {},
        signal: controller.signal,
        stream: false,
      });
      const reading = reply.bytes();
      controller.abort(new Error('stop'));
      await expect(reading).rejects.toThrow();
    } finally {
      await pooled.close();
      await closeServer(server);
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });
});

describe('preconnect without HTTP/2', () => {
  it('warms DNS without opening a socket', async () => {
    let connections = 0;
    const server = createHttpServer((_req, res) => {
      res.end('{}');
    });
    server.on('connection', () => {
      connections += 1;
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;
    const pooled = createPooledFetch({ http2: false });

    try {
      await pooled.preconnect(`http://127.0.0.1:${port}`);
      expect(connections).toBe(0);
      const reply = await pooled.dispatch({
        url: `http://127.0.0.1:${port}/`,
        method: 'GET',
        headers: {},
        stream: false,
      });
      expect(reply.status).toBe(200);
      await reply.bytes();
    } finally {
      await pooled.close();
      await closeServer(server);
    }
  });
});

describe('legacy module loading', () => {
  it('falls back to dynamic import when getBuiltinModule is unavailable', async () => {
    const describe_ = process.getBuiltinModule;
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;

    Object.defineProperty(process, 'getBuiltinModule', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    vi.resetModules();
    try {
      const { createPooledFetch: freshPooledFetch } = await import('../src/core/http.js');
      const pooled = freshPooledFetch({ http2: false });
      try {
        const reply = await pooled.dispatch({
          url: `http://127.0.0.1:${port}/`,
          method: 'GET',
          headers: {},
          stream: false,
        });
        expect(reply.status).toBe(200);
        expect(JSON.parse(decoder.decode(await reply.bytes()))).toEqual({ ok: true });
      } finally {
        await pooled.close();
      }
    } finally {
      Object.defineProperty(process, 'getBuiltinModule', {
        value: describe_,
        configurable: true,
        writable: true,
      });
      vi.resetModules();
      await closeServer(server);
    }
  });
});

describe('fetch facade', () => {
  it('rejects a body type the wire cannot carry', async () => {
    const pooled = createPooledFetch({ http2: false });
    try {
      await expect(
        pooled.fetch('https://api.test.invalid/', {
          method: 'POST',
          body: new ReadableStream(),
        }),
      ).rejects.toThrow(/not supported/);
    } finally {
      await pooled.close();
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
  const dir = mkdtempSync(join(tmpdir(), 'gravixlayer-wire-'));
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
