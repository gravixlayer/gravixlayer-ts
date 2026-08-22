/** Multipart body construction and file-mode formatting. */

import { toBytes, type BinaryLike } from './binary.js';
import { GravixLayerInvalidArgumentError } from './errors.js';

const OCTET_STREAM = 'application/octet-stream';

/** A Unix permission mode, as an octal string (`'0755'`) or a number (`0o755`). */
export type FileMode = string | number;

/**
 * Render a permission mode as four octal digits.
 *
 * The API accepts `644`, `0755`, and `0o755`; this always emits the four-digit
 * form, where the leading digit carries the setuid, setgid, and sticky bits.
 * Numbers are treated as the octal value they represent, so the natural
 * `0o755` literal round-trips correctly.
 */
export function formatMode(mode: FileMode): string {
  if (typeof mode === 'number') {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new GravixLayerInvalidArgumentError(
        `Invalid file mode: ${mode}. Expected an integer between 0 and 0o7777.`,
      );
    }
    return mode.toString(8).padStart(4, '0');
  }

  const trimmed = mode.trim();
  if (trimmed === '') {
    throw new GravixLayerInvalidArgumentError('File mode must not be empty.');
  }
  const digits = /^0[oO]/.test(trimmed) ? trimmed.slice(2) : trimmed;
  if (!/^[0-7]{1,4}$/.test(digits)) {
    throw new GravixLayerInvalidArgumentError(
      `Invalid file mode: "${mode}". Expected octal digits such as "644" or "0755".`,
    );
  }
  return digits.padStart(4, '0');
}

/** The final path segment, used as the multipart filename. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Wrap arbitrary binary input as a `Blob` suitable for `FormData`. */
export async function toBlob(data: BinaryLike, contentType = OCTET_STREAM): Promise<Blob> {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  const bytes = await toBytes(data);
  // A fresh copy keeps the Blob independent of any caller-owned buffer that may
  // be reused or detached before the request is sent.
  return new Blob([new Uint8Array(bytes)], { type: contentType });
}

/** Append one file part to a form. */
export async function appendFile(
  form: FormData,
  field: string,
  filename: string,
  data: BinaryLike,
  contentType = OCTET_STREAM,
): Promise<void> {
  form.append(field, await toBlob(data, contentType), filename);
}
