/**
 * Shared test harness.
 *
 * Tests never touch the network. Each one installs a fake `fetch` that records
 * the requests it receives and replies from a queue, so assertions cover both
 * what the SDK sent and how it handled what came back.
 */

import { expect } from 'vitest';

import { GravixLayer, type ClientOptions, type FetchLike } from '../src/index.js';

/** One request the SDK made, captured for assertion. */
export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
}

/** A queued reply, or a function that produces one per attempt. */
export type Reply = Response | ((attempt: number) => Response | Promise<Response>);

/** A fake `fetch` plus the log of what it saw. */
export interface MockFetch {
  fetch: FetchLike;
  requests: CapturedRequest[];
  /** The most recent request. Fails the test when nothing was sent. */
  last(): CapturedRequest;
  /** The JSON body of the request at `index`, defaulting to the last. */
  jsonBody(index?: number): unknown;
  /** The parsed query string of the request at `index`, defaulting to the last. */
  query(index?: number): URLSearchParams;
}

/**
 * Build a fake `fetch` that answers with the given replies, in order.
 *
 * Once the queue runs out the last reply repeats, which is what lets a retry
 * test queue a single failure and watch the SDK give up. Replies are replayed
 * by snapshotting the body and rebuilding a fresh `Response` each time rather
 * than by cloning, because a cloned body is teed and cannot be discarded
 * independently of its sibling.
 */
export function mockFetch(replies: readonly Reply[]): MockFetch {
  const requests: CapturedRequest[] = [];
  const snapshots = new Map<Response, ResponseSnapshot>();
  let attempt = 0;

  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method ?? 'GET',
      headers: normalizeHeaders(init.headers),
      body: init.body,
    });

    const reply = replies[Math.min(attempt, replies.length - 1)];
    attempt += 1;

    if (reply === undefined) {
      throw new Error(`No reply queued for request ${attempt} to ${url}`);
    }
    if (typeof reply === 'function') return reply(attempt - 1);

    let snapshot = snapshots.get(reply);
    if (!snapshot) {
      snapshot = await snapshotResponse(reply);
      snapshots.set(reply, snapshot);
    }
    return replay(snapshot);
  };

  return {
    fetch,
    requests,
    last() {
      const request = requests.at(-1);
      if (!request) throw new Error('No request was sent.');
      return request;
    },
    jsonBody(index) {
      const request = index === undefined ? this.last() : requests[index];
      if (!request) throw new Error(`No request at index ${index}.`);
      if (typeof request.body !== 'string') {
        throw new Error('The request body was not JSON.');
      }
      return JSON.parse(request.body);
    },
    query(index) {
      const request = index === undefined ? this.last() : requests[index];
      if (!request) throw new Error(`No request at index ${index}.`);
      return new URL(request.url).searchParams;
    },
  };
}

/** A reply captured so it can be served more than once. */
interface ResponseSnapshot {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

async function snapshotResponse(response: Response): Promise<ResponseSnapshot> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, key) => headers.push([key, value]));
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: response.body ? new Uint8Array(await response.arrayBuffer()) : null,
  };
}

function replay(snapshot: ResponseSnapshot): Response {
  return new Response(snapshot.body ? (snapshot.body.slice() as BodyInit) : null, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

/** Collect headers from any of the shapes `fetch` accepts. */
function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
  } else {
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  }
  return out;
}

/** A JSON response. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An empty `204 No Content` response. */
export function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

/** An error response carrying the API's usual `{ error }` envelope. */
export function errorResponse(
  status: number,
  message = 'boom',
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A server-sent event stream built from already-encoded frames. */
export function sseResponse(frames: readonly string[], status = 200): Response {
  const body = frames.map((frame) => (frame.endsWith('\n\n') ? frame : `${frame}\n\n`)).join('');
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A server-sent event stream whose frames are JSON payloads. */
export function sseJson(events: readonly unknown[], status = 200): Response {
  return sseResponse(
    events.map((event) => `data: ${JSON.stringify(event)}`),
    status,
  );
}

/** A binary response. */
export function bytesResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes as BodyInit, {
    status,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

/** Build a client wired to a fake `fetch`, with retries off unless asked. */
export function testClient(
  replies: readonly Reply[],
  options: Partial<ClientOptions> = {},
): { client: GravixLayer; http: MockFetch } {
  const http = mockFetch(replies);
  const client = new GravixLayer({
    apiKey: 'test-key',
    baseUrl: 'https://api.test.invalid',
    maxRetries: 0,
    fetch: http.fetch,
    ...options,
  });
  return { client, http };
}

/** A syntactically valid runtime id, since the SDK validates the shape. */
export const RUNTIME_ID = '11111111-2222-4333-8444-555555555555';

/** A second runtime id, for tests that need two. */
export const OTHER_RUNTIME_ID = '99999999-8888-4777-8666-555555555555';

/** A minimal runtime payload in the API's wire format. */
export function runtimePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtime_id: RUNTIME_ID,
    status: 'running',
    template: 'base-small',
    cloud: 'aws',
    region: 'us-east-1',
    cpu_count: 2,
    memory_mb: 2048,
    disk_size_mb: 8192,
    started_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Drain an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** Assert that a promise rejects with the given error class. */
export async function expectRejection<T extends Error>(
  promise: Promise<unknown>,
  errorClass: new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass);
    return error as T;
  }
  throw new Error(`Expected the promise to reject with ${errorClass.name}, but it resolved.`);
}
