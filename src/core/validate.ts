/**
 * Argument validation applied before a request leaves the process.
 *
 * Catching these locally turns a confusing server-side rejection into an
 * immediate, precise error and avoids spending a round trip on a request that
 * cannot succeed.
 */

import { GravixLayerInvalidArgumentError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Assert that a runtime identifier is a UUID. */
export function assertRuntimeId(runtimeId: string): string {
  if (typeof runtimeId !== 'string' || !UUID.test(runtimeId)) {
    throw new GravixLayerInvalidArgumentError(
      `Invalid runtimeId: expected a UUID, received ${JSON.stringify(runtimeId)}.`,
    );
  }
  return runtimeId;
}

/**
 * Assert that a guest filesystem path is well formed.
 *
 * Rejects empty paths, embedded NUL bytes, and traversal. A `..` that cancels
 * out against an earlier segment is fine, because the guest resolves the path
 * the same way; what is refused is a path that still climbs out of its base
 * once resolved. This is a client-side guard against a path built from
 * untrusted input escaping its intended directory, and the guest enforces its
 * own boundaries as well.
 */
export function assertPath(path: string, label = 'path'): string {
  if (typeof path !== 'string' || path === '') {
    throw new GravixLayerInvalidArgumentError(`${label} must be a non-empty string.`);
  }
  if (path.includes('\0')) {
    throw new GravixLayerInvalidArgumentError(`${label} must not contain a NUL byte.`);
  }
  if (resolvePosix(path).includes('..')) {
    throw new GravixLayerInvalidArgumentError(
      `${label} must not climb outside its directory with "..": ${JSON.stringify(path)}.`,
    );
  }
  return path;
}

/**
 * Resolve `.` and `..` the way the guest's Linux kernel would.
 *
 * Returns the surviving segments. A `..` remains only when it escapes: an
 * absolute path cannot climb above `/`, so those are dropped.
 */
function resolvePosix(path: string): string[] {
  const absolute = path.startsWith('/');
  const resolved: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;

    if (segment === '..') {
      const last = resolved[resolved.length - 1];
      if (last !== undefined && last !== '..') resolved.pop();
      else if (!absolute) resolved.push('..');
      continue;
    }
    resolved.push(segment);
  }

  return resolved;
}

/** Assert that a value is a non-empty string after trimming. */
export function assertNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GravixLayerInvalidArgumentError(`${label} must be a non-empty string.`);
  }
  return value;
}

/** Assert that a TCP port is in the valid range. */
export function assertPort(port: number, label = 'port'): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GravixLayerInvalidArgumentError(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

/** Assert that a value is a positive integer. */
export function assertPositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new GravixLayerInvalidArgumentError(`${label} must be a positive integer.`);
  }
  return value;
}

/** Assert that a value is one of an allowed set, returning the normalized form. */
export function assertOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  const normalized = value.trim().toLowerCase() as T;
  if (!allowed.includes(normalized)) {
    throw new GravixLayerInvalidArgumentError(
      `${label} must be one of ${allowed.join(', ')}; received ${JSON.stringify(value)}.`,
    );
  }
  return normalized;
}
