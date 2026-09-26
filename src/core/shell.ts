/** Characters that never need quoting in a POSIX shell word. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one shell argument, using single quotes so nothing is interpreted. */
export function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
