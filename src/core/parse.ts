/**
 * Defensive readers for JSON returned by the API.
 *
 * Response parsing never throws on a missing or unexpectedly typed field. A
 * server that adds a field, omits an optional one, or returns `null` where a
 * string was expected must not crash a running program, so each reader
 * coerces to a sensible default and unknown fields are ignored.
 */

/** Narrow an unknown JSON value to an object, or an empty object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Narrow an unknown JSON value to an array, or an empty array. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read a string field, falling back when absent, null, or empty. */
export function str(source: Record<string, unknown>, key: string, fallback = ''): string {
  const value = source[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** Read an optional string field. Empty strings become `undefined`. */
export function optStr(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Read a numeric field, tolerating numeric strings. */
export function num(source: Record<string, unknown>, key: string, fallback = 0): number {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Read an optional numeric field. */
export function optNum(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Read a boolean field, tolerating the strings `"true"` and `"false"`. */
export function bool(source: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallback;
}

/** Read an optional boolean field. */
export function optBool(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Read an array of strings, dropping non-string entries. */
export function strArray(source: Record<string, unknown>, key: string): string[] {
  return asArray(source[key]).filter((item): item is string => typeof item === 'string');
}

/** Read a flat string map, coercing scalar values and dropping the rest. */
export function strMap(
  source: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = source[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/** Read an arbitrary JSON object field without coercion. */
export function jsonMap(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Read and parse an array of objects, skipping entries that are not objects. */
export function parseList<T>(
  source: Record<string, unknown>,
  key: string,
  parse: (item: Record<string, unknown>) => T,
): T[] {
  return asArray(source[key])
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
    )
    .map(parse);
}

/**
 * Read the first present key from a list of aliases.
 *
 * The API has renamed fields over time (for example `provider` to `cloud`), and
 * some endpoints still return the older name.
 */
export function firstStr(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = optStr(source, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Drop `undefined` values so they never appear in a JSON request body. */
export function compact<T extends Record<string, unknown>>(source: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}
