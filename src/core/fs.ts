/**
 * Reading a project directory from disk.
 *
 * Everything else in the SDK runs on web standards alone. Packaging an agent
 * from a local folder inherently needs a filesystem, so this module is the one
 * place that reaches for Node's, and it does so through a dynamic import that
 * only runs when a directory path is actually passed. Bundlers targeting edge
 * runtimes therefore never pull `node:fs` into the output.
 */

import { GravixLayerInvalidArgumentError } from './errors.js';
import type { TarEntry } from './tar.js';

/** Directories and files left out of an agent source archive. */
export const DEFAULT_EXCLUDES: ReadonlySet<string> = new Set([
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  'env',
  '.env',
  'node_modules',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  'dist',
  'build',
  '.DS_Store',
]);

/** Suffixes left out of an agent source archive. */
const EXCLUDED_SUFFIXES: readonly string[] = ['.egg-info', '.pyc', '.pyo'];

/** The subset of `node:fs/promises` this module needs. */
interface FsModule {
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ isDirectory(): boolean; mode: number }>;
}

/**
 * Load `node:fs/promises`.
 *
 * The specifier is held in a variable so bundlers treat it as dynamic and
 * leave it alone, which keeps the module out of browser and edge builds.
 */
async function loadFs(): Promise<FsModule> {
  const specifier = 'node:fs/promises';
  try {
    return (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as FsModule;
  } catch (cause) {
    throw new GravixLayerInvalidArgumentError(
      'Reading a project directory requires a filesystem, which this runtime does not provide. ' +
        'Pass the project as an explicit list of files instead.',
      { cause },
    );
  }
}

/** True when a path component should be skipped. */
function isExcluded(name: string, excludes: ReadonlySet<string>): boolean {
  if (excludes.has(name)) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Read a directory tree into archive entries.
 *
 * Entries come back sorted by path so the same source always produces a
 * byte-identical archive, which keeps build caching effective. Symbolic links
 * are not followed.
 *
 * @param directory absolute or relative path to the project root
 * @param excludes names to skip; defaults to {@link DEFAULT_EXCLUDES}
 */
export async function readProjectDirectory(
  directory: string,
  excludes: ReadonlySet<string> = DEFAULT_EXCLUDES,
): Promise<TarEntry[]> {
  const fs = await loadFs();

  let root: { isDirectory(): boolean };
  try {
    root = await fs.stat(directory);
  } catch (cause) {
    throw new GravixLayerInvalidArgumentError(`Source directory not found: ${directory}`, {
      cause,
    });
  }
  if (!root.isDirectory()) {
    throw new GravixLayerInvalidArgumentError(`Source must be a directory: ${directory}`);
  }

  const entries: TarEntry[] = [];

  const walk = async (absolute: string, relative: string): Promise<void> => {
    const listing = await fs.readdir(absolute, { withFileTypes: true });

    for (const item of listing) {
      if (isExcluded(item.name, excludes)) continue;

      const childAbsolute = `${absolute}/${item.name}`;
      const childRelative = relative ? `${relative}/${item.name}` : item.name;

      if (item.isDirectory()) {
        await walk(childAbsolute, childRelative);
      } else if (item.isFile()) {
        const [content, stats] = await Promise.all([
          fs.readFile(childAbsolute),
          fs.stat(childAbsolute),
        ]);
        // Only the permission bits are meaningful in a tar header; the rest of
        // the mode describes the file type, which tar records separately.
        entries.push({ path: childRelative, content, mode: stats.mode & 0o777 });
      }
    }
  };

  await walk(directory.replace(/\/+$/, ''), '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Read one text file, returning `undefined` when it does not exist.
 *
 * Used for optional project metadata such as `.env` and `requirements.txt`.
 */
export async function readTextFileIfPresent(path: string): Promise<string | undefined> {
  try {
    const fs = await loadFs();
    return new TextDecoder('utf-8').decode(await fs.readFile(path));
  } catch {
    return undefined;
  }
}
