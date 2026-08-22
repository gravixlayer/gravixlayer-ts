/**
 * Environment access that works on every supported runtime.
 *
 * Node, Bun, and most edge runtimes expose `process.env`. Deno exposes
 * `Deno.env` and throws unless the program was granted `--allow-env`. Browsers
 * expose neither. Every lookup here degrades to `undefined` rather than
 * throwing, so constructing a client never fails because of the host.
 */

interface ProcessLike {
  env?: Record<string, string | undefined>;
}

interface DenoLike {
  env?: { get(key: string): string | undefined };
}

/** Read an environment variable, or `undefined` when unset or unreadable. */
export function readEnv(key: string): string | undefined {
  const proc = (globalThis as { process?: ProcessLike }).process;
  const fromProcess = proc?.env?.[key];
  if (fromProcess !== undefined) return fromProcess;

  const deno = (globalThis as { Deno?: DenoLike }).Deno;
  if (deno?.env) {
    try {
      return deno.env.get(key);
    } catch {
      // Deno without --allow-env. Treated the same as an unset variable.
      return undefined;
    }
  }

  return undefined;
}

/** Read an environment variable, returning `fallback` when unset or empty. */
export function readEnvOr(key: string, fallback: string): string {
  const value = readEnv(key);
  return value !== undefined && value !== '' ? value : fallback;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Interpret an environment variable as a boolean flag, or `undefined` when it
 * is unset.
 *
 * Distinguishing "unset" from "set to false" matters where an explicit `false`
 * has to win over an in-process opt-in.
 */
export function readEnvFlagOrUndefined(key: string): boolean | undefined {
  const value = readEnv(key)?.trim();
  if (value === undefined || value === '') return undefined;
  return TRUTHY.has(value.toLowerCase());
}

/** Interpret an environment variable as a boolean flag. */
export function readEnvFlag(key: string, fallback = false): boolean {
  return readEnvFlagOrUndefined(key) ?? fallback;
}

/**
 * True when the SDK appears to be running in a browser.
 *
 * Browsers cannot hold an API key safely: any key shipped to a page is
 * readable by the user and by any script on that page. The client refuses to
 * start here unless the caller opts in explicitly.
 */
export function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown; Deno?: unknown };
  // Deno defines neither, and edge runtimes may define a partial `window`;
  // requiring both narrows this to real DOM environments.
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
}
