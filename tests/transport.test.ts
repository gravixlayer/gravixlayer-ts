import { describe, expect, it, vi } from 'vitest';

import {
  GravixLayerAbortError,
  GravixLayerAuthenticationError,
  GravixLayerBadRequestError,
  GravixLayerConnectionError,
  GravixLayerError,
  GravixLayerRateLimitError,
  GravixLayerServerError,
  GravixLayerTimeoutError,
} from '../src/index.js';
import { backoffMs, parseRetryAfter } from '../src/core/transport.js';
import {
  errorResponse,
  expectRejection,
  jsonResponse,
  runtimePayload,
  RUNTIME_ID,
  testClient,
} from './helpers.js';

/**
 * Collapse the wait between retries so the suite runs at full speed.
 *
 * Paired with `timeout: 0` on the client, which is what keeps this from also
 * firing the request-timeout timer.
 */
function withoutBackoff() {
  return vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
}

/** Client settings used by every retry test: instant backoff, no timeout. */
const NO_TIMEOUT = { timeout: 0 } as const;

describe('error mapping', () => {
  const cases = [
    [400, GravixLayerBadRequestError],
    [402, GravixLayerBadRequestError],
    [403, GravixLayerBadRequestError],
    [404, GravixLayerBadRequestError],
    [409, GravixLayerBadRequestError],
    [422, GravixLayerBadRequestError],
    [500, GravixLayerServerError],
    [501, GravixLayerServerError],
  ] as const;

  for (const [status, errorClass] of cases) {
    it(`maps ${status} to ${errorClass.name}`, async () => {
      const { client } = testClient([errorResponse(status, 'nope')]);
      const error = await expectRejection(client.runtime.list(), errorClass);
      expect(error.status).toBe(status);
    });
  }

  it('maps 401 without echoing the response body', async () => {
    const { client } = testClient([errorResponse(401, 'key sk-secret-value is invalid')]);
    const error = await expectRejection(client.runtime.list(), GravixLayerAuthenticationError);

    expect(error.message).toBe('Authentication failed.');
    expect(error.message).not.toContain('sk-secret');
  });

  it('maps an exhausted 429 to a rate-limit error', async () => {
    const { client } = testClient([errorResponse(429, 'slow down')]);
    const error = await expectRejection(client.runtime.list(), GravixLayerRateLimitError);
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('reports the wait a rate-limit response asked for', async () => {
    const { client } = testClient([errorResponse(429, 'slow down', { 'retry-after': '30' })]);
    const error = await expectRejection(client.runtime.list(), GravixLayerRateLimitError);
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('reads a rate-limit wait given as a date', async () => {
    const when = new Date(Date.now() + 45_000).toUTCString();
    const { client } = testClient([errorResponse(429, 'slow down', { 'retry-after': when })]);
    const error = await expectRejection(client.runtime.list(), GravixLayerRateLimitError);

    // A whole second can elapse between the header being built and read.
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(43);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(45);
  });

  it('ignores a rate-limit wait it cannot make sense of', async () => {
    const { client } = testClient([errorResponse(429, 'slow down', { 'retry-after': 'soon' })]);
    const error = await expectRejection(client.runtime.list(), GravixLayerRateLimitError);
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('surfaces the API message and keeps the parsed body', async () => {
    const { client } = testClient([
      new Response(JSON.stringify({ error: 'template not found', code: 'E_TEMPLATE' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    ]);

    const error = await expectRejection(client.runtime.list(), GravixLayerBadRequestError);
    expect(error.message).toBe('template not found');
    expect(error.code).toBe('E_TEMPLATE');
    expect(error.body).toEqual({ error: 'template not found', code: 'E_TEMPLATE' });
  });

  it('falls back to the raw body when it is not JSON', async () => {
    const { client } = testClient([new Response('upstream exploded', { status: 502 })]);
    const error = await expectRejection(client.runtime.list(), GravixLayerServerError);
    expect(error.message).toBe('upstream exploded');
  });

  it('reads a nested message field', async () => {
    const { client } = testClient([
      jsonResponse({ error: { message: 'quota exceeded', code: 7 } }, 400),
    ]);
    const error = await expectRejection(client.runtime.list(), GravixLayerBadRequestError);
    expect(error.message).toBe('quota exceeded');
  });

  it('prefers the product message over the error label', async () => {
    const { client } = testClient([
      jsonResponse(
        {
          error: 'Runtime quota exceeded',
          code: 'quota_exceeded',
          message: 'CPU quota exceeded. Reduce running runtimes or upgrade your tier.',
          exceeded: ['vcpu'],
        },
        403,
      ),
    ]);
    const error = await expectRejection(client.runtime.list(), GravixLayerBadRequestError);
    expect(error.message).toBe('CPU quota exceeded. Reduce running runtimes or upgrade your tier.');
    expect(error.status).toBe(403);
    expect(error.code).toBe('quota_exceeded');
    expect((error.body as { exceeded: string[] }).exceeded).toEqual(['vcpu']);
  });

  it('exposes response headers and a request id when present', async () => {
    const { client } = testClient([errorResponse(500, 'boom', { 'x-request-id': 'req-42' })]);
    const error = await expectRejection(client.runtime.list(), GravixLayerServerError);

    expect(error.headers?.['x-request-id']).toBe('req-42');
    expect(error.requestId).toBe('req-42');
  });

  it('reports malformed JSON on a successful status', async () => {
    const { client } = testClient([
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const error = await expectRejection(client.runtime.list(), GravixLayerError);
    expect(error.message).toMatch(/malformed JSON/i);
  });

  it('keeps every error under one base class', async () => {
    const { client } = testClient([errorResponse(400)]);
    await expect(client.runtime.list()).rejects.toBeInstanceOf(GravixLayerError);
  });
});

describe('retries', () => {
  it('retries a 503 and returns the eventual success', async () => {
    const timers = withoutBackoff();
    try {
      const { client, http } = testClient(
        [errorResponse(503), errorResponse(503), jsonResponse({ runtimes: [], total: 3 })],
        { maxRetries: 3, ...NO_TIMEOUT },
      );

      const result = await client.runtime.list();
      expect(result.total).toBe(3);
      expect(http.requests).toHaveLength(3);
    } finally {
      timers.mockRestore();
    }
  });

  it.each([429, 502, 503, 504])('retries %i', async (status) => {
    const timers = withoutBackoff();
    try {
      const { client, http } = testClient(
        [errorResponse(status), jsonResponse({ runtimes: [], total: 0 })],
        { maxRetries: 1, ...NO_TIMEOUT },
      );

      await client.runtime.list();
      expect(http.requests).toHaveLength(2);
    } finally {
      timers.mockRestore();
    }
  });

  it('does not retry 403', async () => {
    const { client, http } = testClient(
      [errorResponse(403, 'forbidden'), jsonResponse({ runtimes: [], total: 0 })],
      { maxRetries: 3 },
    );
    const error = await expectRejection(client.runtime.list(), GravixLayerBadRequestError);
    expect(error.status).toBe(403);
    expect(error.message).toBe('forbidden');
    expect(http.requests).toHaveLength(1);
  });

  it('retries 429 regardless of body', async () => {
    const timers = withoutBackoff();
    try {
      const { client, http } = testClient(
        [
          new Response(
            JSON.stringify({
              error: 'Runtime quota exceeded',
              exceeded: ['vcpu'],
            }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          ),
          jsonResponse({ runtimes: [], total: 0 }),
        ],
        { maxRetries: 1, ...NO_TIMEOUT },
      );
      await client.runtime.list();
      expect(http.requests).toHaveLength(2);
    } finally {
      timers.mockRestore();
    }
  });

  it.each([400, 401, 402, 403, 404, 409, 422, 500])('does not retry %i', async (status) => {
    const { client, http } = testClient([errorResponse(status)], { maxRetries: 3 });
    await expect(client.runtime.list()).rejects.toBeInstanceOf(GravixLayerError);
    expect(http.requests).toHaveLength(1);
  });

  it('stops after the configured number of attempts', async () => {
    const timers = withoutBackoff();
    try {
      const { client, http } = testClient([errorResponse(503)], {
        maxRetries: 2,
        ...NO_TIMEOUT,
      });
      await expect(client.runtime.list()).rejects.toBeInstanceOf(GravixLayerServerError);
      expect(http.requests).toHaveLength(3);
    } finally {
      timers.mockRestore();
    }
  });

  it('honours a per-request retry budget', async () => {
    const timers = withoutBackoff();
    try {
      const { client, http } = testClient([errorResponse(503)], {
        maxRetries: 5,
        ...NO_TIMEOUT,
      });
      await expect(client.runtime.list({ maxRetries: 0 })).rejects.toBeInstanceOf(
        GravixLayerServerError,
      );
      expect(http.requests).toHaveLength(1);
    } finally {
      timers.mockRestore();
    }
  });

  it('retries a connection failure', async () => {
    const timers = withoutBackoff();
    try {
      let attempts = 0;
      const { client } = testClient([], {
        maxRetries: 2,
        ...NO_TIMEOUT,
        fetch: async () => {
          attempts += 1;
          if (attempts < 3) throw new TypeError('socket hang up');
          return jsonResponse({ runtimes: [], total: 0 });
        },
      });

      await client.runtime.list();
      expect(attempts).toBe(3);
    } finally {
      timers.mockRestore();
    }
  });

  it('reports a connection failure once retries run out', async () => {
    const timers = withoutBackoff();
    try {
      const { client } = testClient([], {
        maxRetries: 1,
        ...NO_TIMEOUT,
        fetch: async () => {
          throw new TypeError('ECONNREFUSED');
        },
      });

      const error = await expectRejection(client.runtime.list(), GravixLayerConnectionError);
      expect(error.message).toContain('ECONNREFUSED');
    } finally {
      timers.mockRestore();
    }
  });
});

describe('Retry-After', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '2' }))).toBe(2000);
  });

  it('reads the millisecond extension', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
  });

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const delay = parseRetryAfter(new Headers({ 'retry-after': future }));
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(4000);
  });

  it('clamps an unreasonable delay', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '99999' }))).toBe(60_000);
  });

  it('treats a past date as no delay', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(new Headers({ 'retry-after': past }))).toBe(0);
  });

  it('returns null when the header is absent or unparseable', () => {
    expect(parseRetryAfter(new Headers())).toBeNull();
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }))).toBeNull();
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter inside a one-second band', () => {
    for (const attempt of [0, 1, 2, 3]) {
      const base = 2 ** attempt * 1000;
      const delay = backoffMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThan(base + 1000);
    }
  });
});

describe('timeout and abort', () => {
  it('raises a timeout error when the request outlasts its budget', async () => {
    const { client } = testClient([], {
      timeout: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    });

    const error = await expectRejection(client.runtime.list(), GravixLayerTimeoutError);
    expect(error).toBeInstanceOf(GravixLayerConnectionError);
  });

  it('raises an abort error when the caller cancels', async () => {
    const controller = new AbortController();
    const { client } = testClient([], {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    });

    const pending = client.runtime.list({ signal: controller.signal });
    controller.abort();
    await expectRejection(pending, GravixLayerAbortError);
  });

  it('does not retry after the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();

    let calls = 0;
    const { client } = testClient([], {
      maxRetries: 3,
      fetch: async () => {
        calls += 1;
        return errorResponse(503);
      },
    });

    await expectRejection(
      client.runtime.list({ signal: controller.signal }),
      GravixLayerAbortError,
    );
    expect(calls).toBe(0);
  });

  it('treats a zero timeout as no timeout', async () => {
    const { client, http } = testClient([jsonResponse({ runtimes: [], total: 0 })], {
      timeout: 0,
    });
    await client.runtime.list();
    expect(http.requests).toHaveLength(1);
  });
});

describe('URL construction', () => {
  it('places the service prefix between the base URL and the path', async () => {
    const { client, http } = testClient([jsonResponse(runtimePayload())]);
    await client.runtime.retrieve(RUNTIME_ID);

    expect(http.last().url).toBe(`https://api.test.invalid/v1/agents/runtime/${RUNTIME_ID}`);
  });

  it('drops undefined query parameters', async () => {
    const { client, http } = testClient([jsonResponse({ snapshots: [], total: 0 })]);
    await client.snapshots.list({ kind: 'hot' });

    const query = http.query();
    expect(query.get('kind')).toBe('hot');
    expect(query.has('state')).toBe(false);
  });
});
