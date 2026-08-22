import { describe, expect, it } from 'vitest';

import { GravixLayerInvalidArgumentError } from '../src/index.js';
import {
  bytesResponse,
  collect,
  expectRejection,
  jsonResponse,
  RUNTIME_ID,
  sseJson,
  testClient,
} from './helpers.js';

/** Pull the parts out of a multipart body the SDK built. */
async function formParts(body: unknown): Promise<{ names: string[]; contents: string[] }> {
  if (!(body instanceof FormData)) throw new Error('The request body was not multipart.');

  const names: string[] = [];
  const contents: string[] = [];
  for (const [, value] of body.entries()) {
    if (value instanceof File) {
      names.push(value.name);
      contents.push(await value.text());
    } else {
      contents.push(String(value));
    }
  }
  return { names, contents };
}

describe('read and write', () => {
  it('reads a file', async () => {
    const { client, http } = testClient([
      jsonResponse({ content: 'hello', path: '/home/user/a.txt', size: 5 }),
    ]);
    const result = await client.runtimes.files.read(RUNTIME_ID, '/home/user/a.txt');

    expect(http.last().url).toContain('/files/read');
    expect(http.jsonBody()).toEqual({ path: '/home/user/a.txt' });
    expect(result.content).toBe('hello');
    expect(result.size).toBe(5);
  });

  it('measures the content when the API omits the size', async () => {
    const { client } = testClient([jsonResponse({ content: 'héllo' })]);
    const result = await client.runtimes.files.read(RUNTIME_ID, '/a.txt');
    // Six bytes, five characters: the size is in bytes.
    expect(result.size).toBe(6);
  });

  it('writes a file', async () => {
    const { client, http } = testClient([
      jsonResponse({ message: 'written', path: '/a.txt', bytes_written: 8 }),
    ]);
    const result = await client.runtimes.files.write(RUNTIME_ID, '/a.txt', 'contents');

    expect(http.jsonBody()).toEqual({ path: '/a.txt', content: 'contents' });
    expect(result.bytesWritten).toBe(8);
  });

  it('deletes a file', async () => {
    const { client, http } = testClient([jsonResponse({ message: 'deleted' })]);
    const result = await client.runtimes.files.delete(RUNTIME_ID, '/a.txt');

    expect(http.last().url).toContain('/files/delete');
    expect(result.path).toBe('/a.txt');
  });

  it('lists a directory, defaulting to the guest home', async () => {
    const { client, http } = testClient([
      jsonResponse({
        files: [
          { name: 'a.txt', path: '/home/user/a.txt', type: 'file', size: 3 },
          { name: 'src', path: '/home/user/src', type: 'dir' },
        ],
      }),
    ]);
    const result = await client.runtimes.files.list(RUNTIME_ID);

    expect(http.jsonBody()).toEqual({ path: '/home/user' });
    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.name).toBe('a.txt');
  });

  it('rejects a traversal path before sending anything', async () => {
    const { client, http } = testClient([jsonResponse({})]);
    await expectRejection(
      client.runtimes.files.read(RUNTIME_ID, '../../etc/passwd'),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });
});

describe('uploads', () => {
  it('sends one file as multipart with the path in the query', async () => {
    const { client, http } = testClient([
      jsonResponse([{ path: '/home/user/data.bin', name: 'data.bin', type: 'file' }]),
    ]);
    const result = await client.runtimes.files.upload(
      RUNTIME_ID,
      '/home/user/data.bin',
      new Uint8Array([1, 2, 3]),
      { user: 'root', mode: 0o600 },
    );

    const query = http.query();
    expect(query.get('path')).toBe('/home/user/data.bin');
    expect(query.get('username')).toBe('root');
    expect(query.get('mode')).toBe('0600');
    expect(http.last().headers['content-type']).toBeUndefined();

    const { names } = await formParts(http.last().body);
    expect(names).toEqual(['data.bin']);
    expect(result.path).toBe('/home/user/data.bin');
  });

  it('synthesises a result when the API answers with an empty body', async () => {
    const { client } = testClient([jsonResponse({})]);
    const result = await client.runtimes.files.upload(RUNTIME_ID, '/tmp/x.txt', 'hi');
    expect(result).toEqual({ path: '/tmp/x.txt', name: 'x.txt', type: 'file', size: 2 });
  });

  it('reports the number of bytes sent even when the API omits it', async () => {
    const { client } = testClient([
      jsonResponse([{ path: '/tmp/x.bin', name: 'x.bin', type: 'file' }]),
    ]);
    const result = await client.runtimes.files.upload(
      RUNTIME_ID,
      '/tmp/x.bin',
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(result.size).toBe(4);
  });

  it('sends a batch as one multipart request', async () => {
    const { client, http } = testClient([
      jsonResponse([
        { path: '/a.txt', name: 'a.txt', type: 'file' },
        { path: '/b.txt', name: 'b.txt', type: 'file' },
      ]),
    ]);

    const result = await client.runtimes.files.writeMany(RUNTIME_ID, [
      { path: '/a.txt', data: 'first' },
      { path: '/b.txt', data: 'second' },
    ]);

    const { names, contents } = await formParts(http.last().body);
    expect(names).toEqual(['/a.txt', '/b.txt']);
    expect(contents).toEqual(['first', 'second']);
    expect(result.files).toHaveLength(2);
    expect(result.partialFailure).toBe(false);
  });

  it('flags a partial failure from the 207 status', async () => {
    const { client } = testClient([
      jsonResponse(
        [
          { path: '/a.txt', name: 'a.txt', type: 'file' },
          { path: '/b.txt', name: 'b.txt', type: 'file', error: 'permission denied' },
        ],
        207,
      ),
    ]);

    const result = await client.runtimes.files.writeMany(RUNTIME_ID, [
      { path: '/a.txt', data: 'ok' },
      { path: '/b.txt', data: 'no' },
    ]);

    expect(result.partialFailure).toBe(true);
    expect(result.files[1]?.error).toBe('permission denied');
  });

  it('short-circuits an empty batch', async () => {
    const { client, http } = testClient([jsonResponse([])]);
    const result = await client.runtimes.files.writeMany(RUNTIME_ID, []);

    expect(result).toEqual({ files: [], partialFailure: false });
    expect(http.requests).toHaveLength(0);
  });

  it('reads a batch wrapped in a files envelope', async () => {
    const { client } = testClient([
      jsonResponse({ files: [{ path: '/a.txt', name: 'a.txt', type: 'file' }] }),
    ]);
    const result = await client.runtimes.files.writeMany(RUNTIME_ID, [
      { path: '/a.txt', data: 'ok' },
    ]);
    expect(result.files).toHaveLength(1);
  });

  it('downloads raw bytes and decoded text', async () => {
    const bytes = new Uint8Array([104, 105]);
    const { client, http } = testClient([bytesResponse(bytes), bytesResponse(bytes)]);

    expect(await client.runtimes.files.download(RUNTIME_ID, '/a.bin')).toEqual(bytes);
    expect(http.query().get('path')).toBe('/a.bin');
    expect(await client.runtimes.files.downloadText(RUNTIME_ID, '/a.bin')).toBe('hi');
  });

  it('uses the legacy single-file endpoint when asked', async () => {
    const { client, http } = testClient([jsonResponse({ message: 'ok', size: 2 })]);
    const result = await client.runtimes.files.uploadFile(RUNTIME_ID, 'hi', '/tmp/a.txt');

    expect(http.last().url).toContain('/upload');
    const { names, contents } = await formParts(http.last().body);
    expect(names).toEqual(['a.txt']);
    expect(contents).toContain('/tmp/a.txt');
    expect(result.size).toBe(2);
  });
});

describe('metadata and structure', () => {
  it('creates a directory recursively by default', async () => {
    const { client, http } = testClient([jsonResponse({ message: 'created', success: true })]);
    const result = await client.runtimes.files.createDirectory(RUNTIME_ID, '/a/b/c');

    expect(http.jsonBody()).toEqual({ path: '/a/b/c', recursive: true });
    expect(result.success).toBe(true);
  });

  it('passes a directory mode as an octal string', async () => {
    const { client, http } = testClient([jsonResponse({ message: 'created' })]);
    await client.runtimes.files.createDirectory(RUNTIME_ID, '/a', {
      recursive: false,
      mode: 0o700,
    });
    expect(http.jsonBody()).toEqual({ path: '/a', recursive: false, mode: '0700' });
  });

  it('reports a missing path without inventing metadata', async () => {
    const { client } = testClient([jsonResponse({ exists: false })]);
    expect(await client.runtimes.files.getInfo(RUNTIME_ID, '/nope')).toEqual({ exists: false });
  });

  it('returns metadata for an existing path', async () => {
    const { client } = testClient([
      jsonResponse({
        exists: true,
        info: { name: 'a.txt', path: '/a.txt', type: 'file', size: 3 },
      }),
    ]);
    const result = await client.runtimes.files.getInfo(RUNTIME_ID, '/a.txt');

    expect(result.exists).toBe(true);
    expect(result.info?.size).toBe(3);
  });

  it('changes permissions', async () => {
    const { client, http } = testClient([jsonResponse({ message: 'ok', success: true })]);
    await client.runtimes.files.setPermissions(RUNTIME_ID, '/run.sh', '755');

    expect(http.last().url).toContain('/files/set-mode');
    expect(http.jsonBody()).toEqual({ path: '/run.sh', mode: '0755' });
  });

  it('moves and copies', async () => {
    const { client, http } = testClient([
      jsonResponse({ success: true, source: '/a', destination: '/b' }),
      jsonResponse({ success: true, source: '/a', destination: '/c' }),
    ]);

    await client.runtimes.files.move(RUNTIME_ID, '/a', '/b', { overwrite: true });
    expect(http.jsonBody(0)).toEqual({ source: '/a', destination: '/b', overwrite: true });

    await client.runtimes.files.copy(RUNTIME_ID, '/a', '/c', { recursive: true });
    expect(http.jsonBody(1)).toEqual({
      source: '/a',
      destination: '/c',
      recursive: true,
      overwrite: false,
    });
  });

  it('changes ownership and requires a target', async () => {
    const { client, http } = testClient([jsonResponse({ success: true, message: 'ok' })]);

    await client.runtimes.files.chown(RUNTIME_ID, '/a', { user: 'root', recursive: true });
    expect(http.jsonBody()).toEqual({ path: '/a', recursive: true, user: 'root' });

    await expectRejection(
      client.runtimes.files.chown(RUNTIME_ID, '/a'),
      GravixLayerInvalidArgumentError,
    );
  });
});

describe('search', () => {
  it('requires a pattern or a glob', async () => {
    const { client, http } = testClient([jsonResponse({})]);
    await expectRejection(
      client.runtimes.files.find(RUNTIME_ID, '/src'),
      GravixLayerInvalidArgumentError,
    );
    expect(http.requests).toHaveLength(0);
  });

  it('searches file contents', async () => {
    const { client, http } = testClient([
      jsonResponse({
        matches: [{ path: '/src/a.ts', line: 3, column: 1, content: 'TODO: fix' }],
        files_scanned: 12,
        truncated: false,
      }),
    ]);
    const result = await client.runtimes.files.find(RUNTIME_ID, '/src', {
      pattern: 'TODO',
      glob: '*.ts',
      regex: true,
      caseSensitive: true,
      includeHidden: true,
      maxResults: 50,
      maxDepth: 3,
    });

    expect(http.jsonBody()).toEqual({
      path: '/src',
      regex: true,
      case_sensitive: true,
      include_hidden: true,
      pattern: 'TODO',
      glob: '*.ts',
      max_results: 50,
      max_depth: 3,
    });
    expect(result.filesScanned).toBe(12);
    expect(result.truncated).toBe(false);
    expect(result.matches[0]).toEqual({
      path: '/src/a.ts',
      line: 3,
      column: 1,
      content: 'TODO: fix',
    });
  });

  it('replaces text, with a dry run available', async () => {
    const { client, http } = testClient([
      jsonResponse({ files: [{ path: '/a.ts', replacements: 2 }], total_replacements: 2 }),
    ]);
    const result = await client.runtimes.files.replace(RUNTIME_ID, '/src', 'old', 'new', {
      dryRun: true,
    });

    expect(http.jsonBody()).toMatchObject({
      path: '/src',
      pattern: 'old',
      replacement: 'new',
      dry_run: true,
    });
    expect(result.totalReplacements).toBe(2);
  });

  it('rejects an empty replace pattern', async () => {
    const { client } = testClient([jsonResponse({})]);
    await expectRejection(
      client.runtimes.files.replace(RUNTIME_ID, '/src', '', 'new'),
      GravixLayerInvalidArgumentError,
    );
  });
});

describe('watch', () => {
  it('yields change events', async () => {
    const { client, http } = testClient([
      sseJson([
        { type: 'start', path: '/home/user' },
        { type: 'write', path: '/home/user/a.txt', name: 'a.txt' },
      ]),
    ]);

    const events = await collect(
      client.runtimes.files.watch(RUNTIME_ID, '/home/user', { recursive: true }),
    );

    expect(http.jsonBody()).toEqual({ path: '/home/user', recursive: true });
    expect(events.map((event) => event.type)).toEqual(['start', 'write']);
    expect(events[1]?.path).toBe('/home/user/a.txt');
  });

  it('raises when the watcher itself fails', async () => {
    const { client } = testClient([sseJson([{ type: 'error', message: 'path vanished' }])]);
    await expectRejection(
      collect(client.runtimes.files.watch(RUNTIME_ID, '/gone')),
      GravixLayerInvalidArgumentError,
    );
  });
});
