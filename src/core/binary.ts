/**
 * Binary and base64 helpers that work on every supported runtime.
 *
 * `Buffer` is Node-only, so everything here is built on `TextEncoder`,
 * `TextDecoder`, `atob`, and `btoa`, which exist in Node 18+, Deno, Bun,
 * Cloudflare Workers, and Vercel Edge.
 */

import { GravixLayerInvalidArgumentError } from './errors.js';

/** Any value the SDK accepts where raw bytes are expected. */
export type BinaryLike = string | Uint8Array | ArrayBuffer | ArrayBufferView | Blob;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** Encode a string as UTF-8 bytes. */
export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decode UTF-8 bytes to a string. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Normalize any accepted binary input to a `Uint8Array`.
 *
 * Strings are encoded as UTF-8. A `Blob` is read asynchronously, which is why
 * this returns a promise.
 */
export async function toBytes(data: BinaryLike): Promise<Uint8Array> {
  if (typeof data === 'string') return utf8Encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new GravixLayerInvalidArgumentError(
    'Expected a string, Uint8Array, ArrayBuffer, typed array, or Blob.',
  );
}

// `String.fromCharCode(...bytes)` blows the call stack on large inputs, so the
// conversion runs in fixed-size windows.
const CHUNK = 0x8000;

/** Encode bytes as a standard (non-URL-safe) base64 string. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode a standard base64 string to bytes. */
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Concatenate byte arrays into a single buffer. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
