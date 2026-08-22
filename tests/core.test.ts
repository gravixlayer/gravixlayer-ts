import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  concatBytes,
  fromBase64,
  toBase64,
  toBytes,
  utf8Decode,
  utf8Encode,
} from '../src/core/binary.js';
import {
  GravixLayerBadRequestError,
  GravixLayerError,
  GravixLayerInvalidArgumentError,
  errorFromStatus,
} from '../src/core/errors.js';
import { iterSSE, iterSSEJson } from '../src/core/sse.js';
import { createTar, createTarGz } from '../src/core/tar.js';
import {
  buildListEndpoint,
  buildUrl,
  encodePathSegment,
  encodeQuery,
  pathSegment,
  withQuery,
} from '../src/core/url.js';
import { basename, formatMode, toBlob } from '../src/core/uploads.js';
import {
  assertNonEmpty,
  assertOneOf,
  assertPath,
  assertPort,
  assertPositiveInt,
  assertRuntimeId,
} from '../src/core/validate.js';
import {
  compact,
  firstStr,
  num,
  optNum,
  optStr,
  parseList,
  str,
  strMap,
} from '../src/core/parse.js';
import { collect, RUNTIME_ID } from './helpers.js';

/** Turn text into a byte stream, optionally split at fixed boundaries. */
function textStream(text: string, chunkSize = text.length): ReadableStream<Uint8Array> {
  const bytes = utf8Encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe('server-sent events', () => {
  it('parses a simple stream', async () => {
    const events = await collect(iterSSE(textStream('data: one\n\ndata: two\n\n')));
    expect(events.map((event) => event.data)).toEqual(['one', 'two']);
    expect(events.every((event) => event.event === 'message')).toBe(true);
  });

  it('reads the event, id, and retry fields', async () => {
    const events = await collect(
      iterSSE(textStream('event: stdout\nid: 7\nretry: 2500\ndata: hello\n\n')),
    );
    expect(events[0]).toEqual({ event: 'stdout', data: 'hello', id: '7', retry: 2500 });
  });

  it('joins multi-line data with newlines', async () => {
    const events = await collect(iterSSE(textStream('data: first\ndata: second\n\n')));
    expect(events[0]?.data).toBe('first\nsecond');
  });

  it('accepts a field with no space after the colon', async () => {
    const events = await collect(iterSSE(textStream('data:tight\n\n')));
    expect(events[0]?.data).toBe('tight');
  });

  it('keeps a leading space when two are present', async () => {
    const events = await collect(iterSSE(textStream('data:  padded\n\n')));
    expect(events[0]?.data).toBe(' padded');
  });

  it('ignores comment lines used as keep-alives', async () => {
    const events = await collect(iterSSE(textStream(': ping\ndata: real\n\n: ping\n')));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('real');
  });

  it('ignores unknown fields', async () => {
    const events = await collect(iterSSE(textStream('unknown: x\ndata: kept\n\n')));
    expect(events[0]?.data).toBe('kept');
  });

  it('dispatches nothing for a block with no data field', async () => {
    const events = await collect(iterSSE(textStream('id: 1\n\nid: 2\n\n')));
    expect(events).toEqual([]);
  });

  it('handles CRLF and bare CR line endings', async () => {
    const crlf = await collect(iterSSE(textStream('data: a\r\n\r\n')));
    expect(crlf[0]?.data).toBe('a');

    const cr = await collect(iterSSE(textStream('data: b\r\r')));
    expect(cr[0]?.data).toBe('b');
  });

  it('strips a leading byte-order mark', async () => {
    const events = await collect(iterSSE(textStream('\uFEFFdata: clean\n\n')));
    expect(events[0]?.data).toBe('clean');
  });

  it('reassembles events split across chunk boundaries', async () => {
    const events = await collect(iterSSE(textStream('data: split across chunks\n\n', 3)));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('split across chunks');
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    const events = await collect(iterSSE(textStream('data: héllo → 世界\n\n', 1)));
    expect(events[0]?.data).toBe('héllo → 世界');
  });

  it('dispatches a final event with no trailing blank line', async () => {
    const events = await collect(iterSSE(textStream('data: last')));
    expect(events[0]?.data).toBe('last');
  });

  it('releases the stream when the consumer stops early', async () => {
    const stream = textStream('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    for await (const event of iterSSE(stream)) {
      if (event.data === '1') break;
    }
    expect(stream.locked).toBe(false);
  });

  it('decodes JSON payloads', async () => {
    const events = await collect(
      iterSSEJson<{ n: number }>(textStream('data: {"n":1}\n\ndata: {"n":2}\n\n')),
    );
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('stops at the [DONE] sentinel', async () => {
    const events = await collect(
      iterSSEJson(textStream('data: {"n":1}\n\ndata: [DONE]\n\ndata: {"n":2}\n\n')),
    );
    expect(events).toEqual([{ n: 1 }]);
  });

  it('yields unparseable frames as raw text rather than failing', async () => {
    const events = await collect(iterSSEJson(textStream('data: not json\n\n')));
    expect(events).toEqual([{ raw: 'not json' }]);
  });
});

describe('binary helpers', () => {
  it('round-trips UTF-8', () => {
    const text = 'ünïcödé — 世界 🌍';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it('round-trips base64, including bytes outside ASCII', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('encodes a payload larger than the chunking window', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17).map((_, index) => index % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('normalizes every accepted binary input', async () => {
    const expected = new Uint8Array([104, 105]);

    expect(await toBytes('hi')).toEqual(expected);
    expect(await toBytes(expected)).toEqual(expected);
    expect(await toBytes(expected.buffer.slice(0) as ArrayBuffer)).toEqual(expected);
    expect(await toBytes(new Blob(['hi']))).toEqual(expected);
  });

  it('respects the offset of a typed-array view', async () => {
    const backing = new Uint8Array([9, 9, 104, 105, 9]);
    const view = new Uint8Array(backing.buffer, 2, 2);
    expect(await toBytes(view)).toEqual(new Uint8Array([104, 105]));
  });

  it('rejects an unsupported input', async () => {
    await expect(toBytes(42 as never)).rejects.toBeInstanceOf(GravixLayerInvalidArgumentError);
  });

  it('concatenates chunks', () => {
    expect(concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(concatBytes([])).toEqual(new Uint8Array(0));
  });
});

describe('archives', () => {
  /** Read the fields the SDK writes into one USTAR header block. */
  function readHeader(tar: Uint8Array, offset = 0) {
    const text = (start: number, length: number) =>
      utf8Decode(tar.slice(offset + start, offset + start + length)).replace(/\0.*$/, '');
    return {
      name: text(0, 100),
      mode: text(100, 8),
      size: parseInt(text(124, 12).trim() || '0', 8),
      magic: text(257, 6),
      typeflag: tar[offset + 156],
      prefix: text(345, 155),
      checksum: parseInt(text(148, 8).trim() || '0', 8),
    };
  }

  it('writes a valid header', async () => {
    const tar = await createTar([{ path: 'app/main.py', content: 'print("hi")\n', mode: 0o755 }]);
    const header = readHeader(tar);

    expect(header.name).toBe('app/main.py');
    expect(header.magic).toBe('ustar');
    expect(header.typeflag).toBe(0x30);
    expect(header.mode).toBe('0000755');
    expect(header.size).toBe(12);
  });

  it('writes a checksum that matches the block', async () => {
    const tar = await createTar([{ path: 'a.txt', content: 'x' }]);
    const block = tar.slice(0, 512);

    let expected = 0;
    for (let i = 0; i < 512; i += 1) {
      expected += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
    }
    expect(readHeader(tar).checksum).toBe(expected);
  });

  it('pads content to a block boundary and ends with two empty blocks', async () => {
    const tar = await createTar([{ path: 'a.txt', content: 'x' }]);
    // One header, one padded content block, two terminator blocks.
    expect(tar.length).toBe(512 * 4);
    expect(tar.slice(1024).every((byte) => byte === 0)).toBe(true);
  });

  it('does not pad content that already fills a block', async () => {
    const tar = await createTar([{ path: 'a.bin', content: new Uint8Array(512) }]);
    expect(tar.length).toBe(512 * 4);
  });

  it('splits a long path across the prefix and name fields', async () => {
    const deep = `${'nested/'.repeat(20)}file.txt`;
    const header = readHeader(await createTar([{ path: deep, content: '' }]));

    expect(header.prefix).not.toBe('');
    expect(`${header.prefix}/${header.name}`).toBe(deep);
  });

  it('splits at the only separator a long path has', async () => {
    // One separator, nowhere near the end, with both halves comfortably within
    // their fields. A search that only looks at the tail would miss it.
    const path = `${'a'.repeat(60)}/${'b'.repeat(60)}`;
    const header = readHeader(await createTar([{ path, content: '' }]));

    expect(header.prefix).toBe('a'.repeat(60));
    expect(header.name).toBe('b'.repeat(60));
  });

  it('rejects a path longer than the format allows', async () => {
    await expect(createTar([{ path: 'x'.repeat(300), content: '' }])).rejects.toBeInstanceOf(
      GravixLayerInvalidArgumentError,
    );
  });

  it('rejects a long path whose final segment cannot fit', async () => {
    await expect(
      createTar([{ path: `dir/${'x'.repeat(120)}`, content: '' }]),
    ).rejects.toBeInstanceOf(GravixLayerInvalidArgumentError);
  });

  it('normalizes leading dot-slash and backslashes', async () => {
    const header = readHeader(await createTar([{ path: './src\\main.py', content: '' }]));
    expect(header.name).toBe('src/main.py');
  });

  it('rejects an empty path', async () => {
    await expect(createTar([{ path: './', content: '' }])).rejects.toBeInstanceOf(
      GravixLayerInvalidArgumentError,
    );
  });

  it('produces a gzip stream a standard decoder can read', async () => {
    const original = await createTar([{ path: 'hello.txt', content: 'hello world' }]);
    const compressed = await createTarGz([{ path: 'hello.txt', content: 'hello world' }]);

    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);

    const restored = new Uint8Array(gunzipSync(compressed));
    // The mtime is written from the clock, so compare everything else.
    expect(restored.length).toBe(original.length);
    expect(utf8Decode(restored.slice(512, 523))).toBe('hello world');
  });

  it('archives several files in order', async () => {
    const tar = await createTar([
      { path: 'a.txt', content: 'aaa' },
      { path: 'b.txt', content: 'bbb' },
    ]);
    expect(readHeader(tar, 0).name).toBe('a.txt');
    expect(readHeader(tar, 1024).name).toBe('b.txt');
  });
});

describe('URLs', () => {
  it('joins a service and an endpoint', () => {
    expect(buildUrl('runtime', 'v1/agents', 'https://api.test')).toBe(
      'https://api.test/v1/agents/runtime',
    );
  });

  it('collapses duplicate separators', () => {
    expect(buildUrl('/runtime', 'v1/agents', 'https://api.test')).toBe(
      'https://api.test/v1/agents/runtime',
    );
  });

  it('returns the service base for an empty endpoint', () => {
    expect(buildUrl('', 'v1/agents', 'https://api.test')).toBe('https://api.test/v1/agents');
  });

  it('passes an absolute endpoint through untouched', () => {
    expect(buildUrl('https://agent.example/invoke', 'v1/agents', 'https://api.test')).toBe(
      'https://agent.example/invoke',
    );
  });

  it('appends a bare query without a separator', () => {
    expect(buildUrl('?limit=1', 'v1/agents', 'https://api.test')).toBe(
      'https://api.test/v1/agents?limit=1',
    );
  });

  it('drops undefined and null query values', () => {
    expect(encodeQuery({ a: 1, b: undefined, c: null, d: false })).toBe('?a=1&d=false');
    expect(encodeQuery({ a: undefined })).toBe('');
  });

  it('preserves an existing query when appending', () => {
    expect(withQuery('runtime?a=1', { b: 2 })).toBe('runtime?a=1&b=2');
    expect(withQuery('runtime', {})).toBe('runtime');
  });

  it('defaults list pagination and allows opting out', () => {
    expect(buildListEndpoint('runtime')).toBe('runtime?limit=100&offset=0');
    expect(buildListEndpoint('runtime', { limit: 5, offset: 10 })).toBe(
      'runtime?limit=5&offset=10',
    );
    expect(buildListEndpoint('runtime', { limit: null, offset: null })).toBe('runtime');
    expect(buildListEndpoint('runtime', { extra: { kind: 'hot' } })).toBe(
      'runtime?limit=100&offset=0&kind=hot',
    );
  });

  it('escapes every reserved character in a path segment', () => {
    expect(encodePathSegment('a/b')).toBe('a%2Fb');
    expect(encodePathSegment("it's (a) test!*")).toBe('it%27s%20%28a%29%20test%21%2A');
  });

  it('validates and encodes an identifier as one segment', () => {
    expect(pathSegment('policy-1', 'policyId')).toBe('policy-1');
    expect(pathSegment('../runtimes', 'policyId')).toBe('..%2Fruntimes');
    expect(() => pathSegment('  ', 'policyId')).toThrow(/policyId/);
  });
});

describe('file modes', () => {
  it('renders numbers as octal', () => {
    expect(formatMode(0o755)).toBe('0755');
    expect(formatMode(0o644)).toBe('0644');
    expect(formatMode(0)).toBe('0000');
  });

  it('accepts every string spelling the API allows', () => {
    expect(formatMode('755')).toBe('0755');
    expect(formatMode('0755')).toBe('0755');
    expect(formatMode('0o755')).toBe('0755');
    expect(formatMode(' 644 ')).toBe('0644');
  });

  it('keeps a four-digit mode with a setuid bit', () => {
    expect(formatMode('4755')).toBe('4755');
    expect(formatMode(0o4755)).toBe('4755');
  });

  it('rejects malformed modes', () => {
    for (const bad of ['', 'rwxr-xr-x', '999', '0o', '12345']) {
      expect(() => formatMode(bad)).toThrow(GravixLayerInvalidArgumentError);
    }
    for (const bad of [-1, 1.5, 0o10000]) {
      expect(() => formatMode(bad)).toThrow(GravixLayerInvalidArgumentError);
    }
  });

  it('takes the last segment as a filename', () => {
    expect(basename('/home/user/app.py')).toBe('app.py');
    expect(basename('app.py')).toBe('app.py');
    expect(basename('/home/user/')).toBe('user');
  });

  it('wraps binary input as a blob with a content type', async () => {
    const blob = await toBlob('hello', 'text/plain');
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('hello');
  });
});

describe('validation', () => {
  it('accepts a UUID runtime id', () => {
    expect(assertRuntimeId(RUNTIME_ID)).toBe(RUNTIME_ID);
    expect(assertRuntimeId(RUNTIME_ID.toUpperCase())).toBe(RUNTIME_ID.toUpperCase());
  });

  it('rejects anything that is not a UUID', () => {
    for (const bad of ['', 'not-a-uuid', RUNTIME_ID.slice(0, -1), `${RUNTIME_ID} `]) {
      expect(() => assertRuntimeId(bad)).toThrow(GravixLayerInvalidArgumentError);
    }
  });

  it('accepts ordinary guest paths', () => {
    expect(assertPath('/home/user/app.py')).toBe('/home/user/app.py');
    expect(assertPath('relative/file.txt')).toBe('relative/file.txt');
    expect(assertPath('..hidden')).toBe('..hidden');
  });

  it('accepts a ".." that resolves back inside the path', () => {
    // The guest resolves these to /etc and app/main.py, so refusing them would
    // reject paths that are perfectly valid once normalized.
    expect(assertPath('/home/../etc')).toBe('/home/../etc');
    expect(assertPath('app/build/../main.py')).toBe('app/build/../main.py');
    // A backslash is an ordinary character in a Linux filename, not a separator.
    expect(assertPath('a\\..\\b')).toBe('a\\..\\b');
  });

  it('rejects traversal, NUL bytes, and empty paths', () => {
    for (const bad of ['', '../etc/passwd', 'app/../../etc/passwd', 'a\0b']) {
      expect(() => assertPath(bad)).toThrow(GravixLayerInvalidArgumentError);
    }
  });

  it('names the offending argument in the message', () => {
    expect(() => assertPath('', 'destination')).toThrow(/destination/);
  });

  it('checks non-empty strings, ports, and positive integers', () => {
    expect(assertNonEmpty('x', 'name')).toBe('x');
    expect(() => assertNonEmpty('   ', 'name')).toThrow(GravixLayerInvalidArgumentError);

    expect(assertPort(8080)).toBe(8080);
    for (const bad of [0, -1, 65536, 1.5]) {
      expect(() => assertPort(bad)).toThrow(GravixLayerInvalidArgumentError);
    }

    expect(assertPositiveInt(1, 'cpu')).toBe(1);
    for (const bad of [0, -1, 2.5]) {
      expect(() => assertPositiveInt(bad, 'cpu')).toThrow(GravixLayerInvalidArgumentError);
    }
  });

  it('normalizes an enumerated value', () => {
    expect(assertOneOf(' TCP ', ['tcp', 'udp'], 'protocol')).toBe('tcp');
    expect(() => assertOneOf('sctp', ['tcp', 'udp'], 'protocol')).toThrow(
      /protocol must be one of tcp, udp/,
    );
  });
});

describe('response parsing', () => {
  it('coerces scalars to strings and numbers', () => {
    expect(str({ a: 'x' }, 'a')).toBe('x');
    expect(str({ a: 7 }, 'a')).toBe('7');
    expect(str({}, 'a', 'fallback')).toBe('fallback');
    expect(str({ a: null }, 'a')).toBe('');

    expect(num({ a: 3 }, 'a')).toBe(3);
    expect(num({ a: '3' }, 'a')).toBe(3);
    expect(num({ a: 'x' }, 'a', 9)).toBe(9);
    expect(optNum({}, 'a')).toBeUndefined();
  });

  it('treats an empty string as an absent optional', () => {
    expect(optStr({ a: '' }, 'a')).toBeUndefined();
    expect(optStr({ a: 'v' }, 'a')).toBe('v');
  });

  it('reads the first present alias', () => {
    expect(firstStr({ cloud: 'aws' }, ['cloud', 'provider'])).toBe('aws');
    expect(firstStr({ provider: 'gcp' }, ['cloud', 'provider'])).toBe('gcp');
    expect(firstStr({}, ['cloud', 'provider'])).toBeUndefined();
  });

  it('coerces map values and ignores nested structures', () => {
    expect(strMap({ env: { A: '1', B: 2, C: true, D: {} } }, 'env')).toEqual({
      A: '1',
      B: '2',
      C: 'true',
    });
    expect(strMap({ env: [] }, 'env')).toBeUndefined();
  });

  it('skips list entries that are not objects', () => {
    const parsed = parseList({ items: [{ id: 'a' }, 'nope', null, { id: 'b' }] }, 'items', (item) =>
      str(item, 'id'),
    );
    expect(parsed).toEqual(['a', 'b']);
  });

  it('drops undefined keys from a request body', () => {
    expect(compact({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });
});

describe('errors', () => {
  it('maps status codes to the documented classes', () => {
    expect(errorFromStatus(400, 'x')).toBeInstanceOf(GravixLayerBadRequestError);
    expect(errorFromStatus(418, 'x')).toBeInstanceOf(GravixLayerError);
  });

  it('keeps the status, body, and headers for inspection', () => {
    const error = errorFromStatus(404, 'missing', {
      headers: { 'x-request-id': 'abc' },
      body: { error: 'missing' },
    });
    expect(error.status).toBe(404);
    expect(error.requestId).toBe('abc');
    expect(error.body).toEqual({ error: 'missing' });
  });

  it('is catchable as a plain Error', () => {
    const error = errorFromStatus(500, 'boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GravixLayerServerError');
    expect(String(error)).toContain('boom');
  });
});
