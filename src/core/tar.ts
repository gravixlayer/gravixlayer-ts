/**
 * A minimal USTAR archive writer plus gzip, used to package agent sources.
 *
 * Written from the format specification rather than pulled from a dependency
 * so the SDK stays dependency-free and runs unchanged on Node, Deno, Bun, and
 * edge runtimes. Compression uses the standard `CompressionStream`, which is
 * available on all of them.
 */

import { concatBytes, toBytes, utf8Encode, type BinaryLike } from './binary.js';
import { GravixLayerError, GravixLayerInvalidArgumentError } from './errors.js';

const BLOCK_SIZE = 512;

/** One file to place in the archive. */
export interface TarEntry {
  /** Path inside the archive, relative and using forward slashes. */
  path: string;
  /** File contents. */
  content: BinaryLike;
  /** Permission bits. Defaults to `0o644`. */
  mode?: number;
  /** Modification time in seconds since the Unix epoch. Defaults to now. */
  mtime?: number;
}

/** Write a NUL-terminated ASCII string into a header field. */
function writeString(header: Uint8Array, offset: number, size: number, value: string): void {
  const bytes = utf8Encode(value);
  if (bytes.length > size) {
    throw new GravixLayerInvalidArgumentError(
      `Archive field value is too long (${bytes.length} > ${size} bytes): ${value}`,
    );
  }
  header.set(bytes, offset);
}

/**
 * Write a numeric field as zero-padded octal followed by a NUL.
 *
 * `size - 1` digits are used because the trailing NUL is part of the field.
 */
function writeOctal(header: Uint8Array, offset: number, size: number, value: number): void {
  const digits = value.toString(8).padStart(size - 1, '0');
  if (digits.length > size - 1) {
    throw new GravixLayerInvalidArgumentError(
      `Archive numeric field overflows ${size - 1} octal digits: ${value}`,
    );
  }
  header.set(utf8Encode(digits), offset);
  header[offset + size - 1] = 0;
}

/**
 * Split a path into the 155-byte prefix and 100-byte name fields.
 *
 * USTAR stores long paths by splitting them at a directory separator, which
 * allows up to 255 characters in total.
 */
function splitPath(path: string): { name: string; prefix: string } {
  if (utf8Encode(path).length <= 100) return { name: path, prefix: '' };

  // Walk the separators from the end, which tries the longest prefix first.
  // Moving earlier lengthens the name and shortens the prefix, so a name that
  // no longer fits ends the search while a prefix that does not fit yet does
  // not.
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (utf8Encode(name).length > 100) break;
    if (utf8Encode(prefix).length <= 155) return { name, prefix };
  }

  throw new GravixLayerInvalidArgumentError(
    `Path is too long to store in an archive (limit is 255 bytes): ${path}`,
  );
}

/** Build the 512-byte header block for one entry. */
function buildHeader(path: string, size: number, mode: number, mtime: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const { name, prefix } = splitPath(path);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode & 0o7777);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header[156] = 0x30; // typeflag '0' — a regular file
  writeString(header, 257, 6, 'ustar');
  header[263] = 0x30; // version "00"
  header[264] = 0x30;
  writeString(header, 345, 155, prefix);

  // The checksum is computed with its own field filled with spaces, then
  // written back as six octal digits, a NUL, and a space.
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;

  header.set(utf8Encode(checksum.toString(8).padStart(6, '0')), 148);
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

/** Round a length up to the next 512-byte block boundary. */
function padding(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

/** Build an uncompressed tar archive. */
export async function createTar(entries: readonly TarEntry[]): Promise<Uint8Array> {
  const now = Math.floor(Date.now() / 1000);
  const blocks: Uint8Array[] = [];

  for (const entry of entries) {
    const normalized = entry.path.replace(/^\.?\/+/, '').replace(/\\/g, '/');
    if (normalized === '') {
      throw new GravixLayerInvalidArgumentError('Archive entry path must not be empty.');
    }

    const content = await toBytes(entry.content);
    blocks.push(buildHeader(normalized, content.length, entry.mode ?? 0o644, entry.mtime ?? now));
    blocks.push(content);

    const pad = padding(content.length);
    if (pad > 0) blocks.push(new Uint8Array(pad));
  }

  // An archive ends with two zero-filled blocks.
  blocks.push(new Uint8Array(BLOCK_SIZE * 2));
  return concatBytes(blocks);
}

/** Compress bytes with gzip using the platform's `CompressionStream`. */
export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream })
    .CompressionStream;

  if (!Compression) {
    throw new GravixLayerError(
      'This runtime does not provide CompressionStream, which is required to package an ' +
        'agent archive. Node 18 or newer, Deno, Bun, and modern edge runtimes all provide it.',
    );
  }

  const stream = new Compression('gzip');
  const writer = stream.writable.getWriter();

  // Writing and reading proceed together, since the compressor only accepts
  // more input once its output is being drained. A failure here also errors
  // the readable, so the loop below is what surfaces it; swallowing it here
  // only prevents a duplicate unhandled rejection.
  const written = writer
    .write(new Uint8Array(data))
    .then(() => writer.close())
    .catch(() => undefined);

  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await written;

  return concatBytes(chunks);
}

/** Build a gzipped tar archive from a set of files. */
export async function createTarGz(entries: readonly TarEntry[]): Promise<Uint8Array> {
  return gzip(await createTar(entries));
}
