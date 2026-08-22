/**
 * The guest filesystem API.
 *
 * Every method operates inside a runtime's own filesystem. Paths are absolute
 * within the guest, and the guest's default working directory is `/workspace`.
 */

import { utf8Encode, type BinaryLike } from '../../core/binary.js';
import { GravixLayerError, GravixLayerInvalidArgumentError } from '../../core/errors.js';
import { asRecord, bool, optNum, optStr, parseList, str } from '../../core/parse.js';
import { iterSSEJson } from '../../core/sse.js';
import type { RequestOptions } from '../../core/transport.js';
import { SERVICES } from '../../core/url.js';
import { appendFile, basename, formatMode, toBlob, type FileMode } from '../../core/uploads.js';
import {
  assertNonEmpty,
  assertPath,
  assertPositiveInt,
  assertRuntimeId,
} from '../../core/validate.js';
import {
  parseFileFindResponse,
  parseFileInfo,
  parseFileReplaceResponse,
  parseWatchEvent,
  parseWriteResult,
  type ChangeOwnerResponse,
  type DirectoryCreateResponse,
  type FileCopyResponse,
  type FileDeleteResponse,
  type FileFindResponse,
  type FileGetInfoResponse,
  type FileListResponse,
  type FileMoveResponse,
  type FileReadResponse,
  type FileReplaceResponse,
  type FileUploadResponse,
  type FileWriteResponse,
  type SetPermissionsResponse,
  type WatchEvent,
  type WriteFilesResponse,
  type WriteResult,
} from '../../types/runtime.js';
import { APIResource } from '../resource.js';

/** Default directory used when a listing does not specify a path. */
export const DEFAULT_WORKING_DIR = '/workspace';

/** How many files {@link RuntimeFile.writeMany} sends at the same time. */
const DEFAULT_WRITE_CONCURRENCY = 8;

/** One file in a batch write. */
export interface WriteEntry {
  /** Absolute destination path in the guest. */
  path: string;
  /** File contents. */
  data: BinaryLike;
  /** Permission bits for this file, for example `'0644'` or `0o644`. */
  mode?: FileMode;
  /** Owning user inside the guest. Takes precedence over the batch-wide user. */
  user?: string;
}

/** Options for {@link RuntimeFile.upload}. */
export interface UploadOptions extends RequestOptions {
  /** Owning user inside the guest. */
  user?: string;
  /** Permission bits, for example `'0644'` or `0o644`. */
  mode?: FileMode;
}

/** Options for {@link RuntimeFile.writeMany}. */
export interface WriteManyOptions extends UploadOptions {
  /** How many files to send at the same time. Defaults to 8. */
  concurrency?: number;
}

/** Options for {@link RuntimeFile.createDirectory}. */
export interface CreateDirectoryOptions extends RequestOptions {
  /** Create missing parent directories. Defaults to `true`. */
  recursive?: boolean;
  /** Permission bits for the new directory. */
  mode?: FileMode;
}

/** Options for {@link RuntimeFile.copy}. */
export interface CopyOptions extends RequestOptions {
  /** Copy directories and their contents. Defaults to `false`. */
  recursive?: boolean;
  /** Replace the destination if it exists. Defaults to `false`. */
  overwrite?: boolean;
}

/** Options for {@link RuntimeFile.move}. */
export interface MoveOptions extends RequestOptions {
  /** Replace the destination if it exists. Defaults to `false`. */
  overwrite?: boolean;
}

/** Options for {@link RuntimeFile.chown}. */
export interface ChownOptions extends RequestOptions {
  /** New owning user. At least one of `user` or `group` is required. */
  user?: string;
  /** New owning group. */
  group?: string;
  /** Apply to directory contents. Defaults to `false`. */
  recursive?: boolean;
}

/** Options for {@link RuntimeFile.watch}. */
export interface WatchOptions extends RequestOptions {
  /** Watch subdirectories too. Defaults to `false`. */
  recursive?: boolean;
}

/** Options for {@link RuntimeFile.find}. */
export interface FindOptions extends RequestOptions {
  /** Text or regular expression to search file contents for. */
  pattern?: string;
  /** Filename glob to match, for example `*.ts`. */
  glob?: string;
  /** Treat `pattern` as a regular expression. Defaults to `false`. */
  regex?: boolean;
  /** Match case exactly. Defaults to `false`. */
  caseSensitive?: boolean;
  /** Include dotfiles. Defaults to `false`. */
  includeHidden?: boolean;
  /** Stop after this many matches. */
  maxResults?: number;
  /** Limit how deep to descend. */
  maxDepth?: number;
}

/** Options for {@link RuntimeFile.replace}. */
export interface ReplaceOptions extends RequestOptions {
  /** Restrict the replacement to filenames matching this glob. */
  glob?: string;
  /** Treat `pattern` as a regular expression. Defaults to `false`. */
  regex?: boolean;
  /** Match case exactly. Defaults to `false`. */
  caseSensitive?: boolean;
  /** Include dotfiles. Defaults to `false`. */
  includeHidden?: boolean;
  /** Limit how deep to descend. */
  maxDepth?: number;
  /** Report what would change without writing anything. Defaults to `false`. */
  dryRun?: boolean;
}

/** Split request options away from operation-specific fields. */
function requestOptions(options: RequestOptions): RequestOptions {
  const out: RequestOptions = {};
  if (options.signal) out.signal = options.signal;
  if (options.timeout !== undefined) out.timeout = options.timeout;
  if (options.maxRetries !== undefined) out.maxRetries = options.maxRetries;
  if (options.headers) out.headers = options.headers;
  return out;
}

/**
 * Read, write, and manage files inside a runtime.
 *
 * Reached through `client.runtime.file` or, with the runtime already bound,
 * through `runtime.file`.
 */
export class RuntimeFile extends APIResource {
  /** Read a text file. */
  async read(
    runtimeId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<FileReadResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/read`,
        service: SERVICES.agents,
        body: { path },
        options,
      }),
    );

    const content = str(data, 'content');
    const response: FileReadResponse = { content };
    const responsePath = optStr(data, 'path') ?? path;
    response.path = responsePath;
    response.size = optNum(data, 'size') ?? utf8Encode(content).length;
    return response;
  }

  /** Write a text file, creating or replacing it. */
  async write(
    runtimeId: string,
    path: string,
    content: string,
    options: RequestOptions = {},
  ): Promise<FileWriteResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/write`,
        service: SERVICES.agents,
        body: { path, content },
        options,
      }),
    );

    const response: FileWriteResponse = { message: str(data, 'message') };
    const responsePath = optStr(data, 'path') ?? path;
    response.path = responsePath;
    const bytesWritten = optNum(data, 'bytes_written');
    if (bytesWritten !== undefined) response.bytesWritten = bytesWritten;
    return response;
  }

  /** Delete a file or directory. */
  async delete(
    runtimeId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<FileDeleteResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/delete`,
        service: SERVICES.agents,
        body: { path },
        options,
      }),
    );

    const response: FileDeleteResponse = { message: str(data, 'message') };
    response.path = optStr(data, 'path') ?? path;
    return response;
  }

  /** List the entries in a directory. */
  async list(
    runtimeId: string,
    path: string = DEFAULT_WORKING_DIR,
    options: RequestOptions = {},
  ): Promise<FileListResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/list`,
        service: SERVICES.agents,
        body: { path },
        options,
      }),
    );

    return { files: parseList(data, 'files', parseFileInfo) };
  }

  /**
   * Upload binary or text content to a path.
   *
   * Unlike {@link write}, this streams the body as multipart form data, which
   * makes it the right choice for binary files and large payloads.
   */
  async upload(
    runtimeId: string,
    path: string,
    data: BinaryLike,
    options: UploadOptions = {},
  ): Promise<WriteResult> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const name = basename(path);
    const blob = await toBlob(data);
    const form = new FormData();
    form.append('file', blob, name);

    const query: Record<string, string> = { path };
    if (options.user !== undefined) query['username'] = options.user;
    if (options.mode !== undefined) query['mode'] = formatMode(options.mode);

    const body = await this.http.request<unknown>({
      method: 'POST',
      path: `runtime/${runtimeId}/files`,
      service: SERVICES.agents,
      query,
      form,
      options: requestOptions(options),
    });

    const first = Array.isArray(body) ? body[0] : body;
    const record = asRecord(first);
    if (Object.keys(record).length === 0) {
      return { path, name, type: 'file', size: blob.size };
    }

    // The number of bytes sent is known here, so it is reported even when the
    // response omits it.
    return { ...parseWriteResult(record), size: blob.size };
  }

  /**
   * Upload several files, each to its own destination path.
   *
   * Every entry names its own absolute destination, and may carry its own mode
   * and owner. Entries are sent concurrently, `concurrency` at a time, and the
   * results come back in the order the entries were given.
   *
   * The API can accept some files and reject others; when it does, the
   * response reports `partialFailure` and each rejected entry carries its own
   * `error`. When every entry is rejected, the first failure is thrown, since
   * that means the batch as a whole did not apply.
   */
  async writeMany(
    runtimeId: string,
    entries: readonly WriteEntry[],
    options: WriteManyOptions = {},
  ): Promise<WriteFilesResponse> {
    assertRuntimeId(runtimeId);
    if (entries.length === 0) return { files: [], partialFailure: false };
    for (const entry of entries) assertPath(entry.path);

    const workers = Math.min(
      entries.length,
      options.concurrency === undefined
        ? DEFAULT_WRITE_CONCURRENCY
        : assertPositiveInt(options.concurrency, 'concurrency'),
    );

    const files = new Array<WriteResult>(entries.length);
    const failures = new Array<GravixLayerError | undefined>(entries.length);
    let next = 0;

    const run = async (): Promise<void> => {
      for (let index = next++; index < entries.length; index = next++) {
        const entry = entries[index] as WriteEntry;

        const upload: UploadOptions = requestOptions(options);
        const user = entry.user ?? options.user;
        if (user !== undefined) upload.user = user;
        const mode = entry.mode ?? options.mode;
        if (mode !== undefined) upload.mode = mode;

        try {
          files[index] = await this.upload(runtimeId, entry.path, entry.data, upload);
        } catch (error) {
          // Only a rejection carrying a status is specific to one file. A
          // connection, timeout, or abort failure applies to the whole batch
          // and is left to propagate.
          if (!(error instanceof GravixLayerError) || error.status === undefined) throw error;
          failures[index] = error;
          files[index] = {
            path: entry.path,
            name: basename(entry.path),
            type: 'file',
            error: error.message,
          };
        }
      }
    };

    await Promise.all(Array.from({ length: workers }, run));

    const firstFailure = failures.find((error) => error !== undefined);
    const failed = failures.reduce<number>((count, error) => count + (error ? 1 : 0), 0);
    if (firstFailure && failed === entries.length) throw firstFailure;
    return { files, partialFailure: failed > 0 };
  }

  /** Create a directory. */
  async createDirectory(
    runtimeId: string,
    path: string,
    options: CreateDirectoryOptions = {},
  ): Promise<DirectoryCreateResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const body: Record<string, unknown> = { path, recursive: options.recursive ?? true };
    if (options.mode !== undefined) body['mode'] = formatMode(options.mode);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/create-directory`,
        service: SERVICES.agents,
        body,
        options: requestOptions(options),
      }),
    );

    const response: DirectoryCreateResponse = { message: str(data, 'message') };
    response.path = optStr(data, 'path') ?? path;
    const success = data['success'];
    if (typeof success === 'boolean') response.success = success;
    return response;
  }

  /** Look up metadata for a path, reporting whether it exists. */
  async getInfo(
    runtimeId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<FileGetInfoResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/info`,
        service: SERVICES.agents,
        body: { path },
        options,
      }),
    );

    const exists = bool(data, 'exists');
    if (!exists) return { exists: false };

    const info = data['info'];
    return info ? { exists: true, info: parseFileInfo(asRecord(info)) } : { exists: true };
  }

  /** Change a path's permission bits. */
  async setPermissions(
    runtimeId: string,
    path: string,
    mode: FileMode,
    options: RequestOptions = {},
  ): Promise<SetPermissionsResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/set-mode`,
        service: SERVICES.agents,
        body: { path, mode: formatMode(mode) },
        options,
      }),
    );

    return { message: str(data, 'message'), success: bool(data, 'success', true) };
  }

  /** Move or rename a path. */
  async move(
    runtimeId: string,
    source: string,
    destination: string,
    options: MoveOptions = {},
  ): Promise<FileMoveResponse> {
    assertRuntimeId(runtimeId);
    assertPath(source, 'source');
    assertPath(destination, 'destination');

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/move`,
        service: SERVICES.agents,
        body: { source, destination, overwrite: options.overwrite ?? false },
        options: requestOptions(options),
      }),
    );

    const response: FileMoveResponse = {
      success: bool(data, 'success', true),
      source: str(data, 'source', source),
      destination: str(data, 'destination', destination),
    };
    if (data['entry']) response.entry = parseFileInfo(asRecord(data['entry']));
    return response;
  }

  /** Copy a path. */
  async copy(
    runtimeId: string,
    source: string,
    destination: string,
    options: CopyOptions = {},
  ): Promise<FileCopyResponse> {
    assertRuntimeId(runtimeId);
    assertPath(source, 'source');
    assertPath(destination, 'destination');

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/copy`,
        service: SERVICES.agents,
        body: {
          source,
          destination,
          recursive: options.recursive ?? false,
          overwrite: options.overwrite ?? false,
        },
        options: requestOptions(options),
      }),
    );

    const response: FileCopyResponse = {
      success: bool(data, 'success', true),
      source: str(data, 'source', source),
      destination: str(data, 'destination', destination),
    };
    if (data['entry']) response.entry = parseFileInfo(asRecord(data['entry']));
    return response;
  }

  /** Change a path's owner, group, or both. */
  async chown(
    runtimeId: string,
    path: string,
    options: ChownOptions = {},
  ): Promise<ChangeOwnerResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    if (options.user === undefined && options.group === undefined) {
      throw new GravixLayerInvalidArgumentError(
        'chown requires at least one of `user` or `group`.',
      );
    }

    const body: Record<string, unknown> = { path, recursive: options.recursive ?? false };
    if (options.user !== undefined) body['user'] = options.user;
    if (options.group !== undefined) body['group'] = options.group;

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/files/chown`,
        service: SERVICES.agents,
        body,
        options: requestOptions(options),
      }),
    );

    return {
      success: bool(data, 'success', true),
      path: str(data, 'path', path),
      message: str(data, 'message'),
    };
  }

  /**
   * Watch a path for changes.
   *
   * Returns an async iterable that yields events as they happen. The first
   * event is always of type `start`, which confirms the watcher is active.
   * Break out of the loop, or abort the signal, to stop watching.
   *
   * @example
   * ```ts
   * for await (const event of client.runtime.file.watch(id, '/workspace')) {
   *   console.log(event.type, event.path);
   *   if (event.type === 'write') break;
   * }
   * ```
   */
  async *watch(
    runtimeId: string,
    path: string,
    options: WatchOptions = {},
  ): AsyncGenerator<WatchEvent, void, undefined> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    const stream = await this.http.requestStream({
      method: 'POST',
      path: `runtime/${runtimeId}/files/watch`,
      service: SERVICES.agents,
      body: { path, recursive: options.recursive ?? false },
      options: requestOptions(options),
    });

    for await (const payload of iterSSEJson<Record<string, unknown>>(stream)) {
      const event = parseWatchEvent(asRecord(payload));
      if (event.type === 'error') {
        throw new GravixLayerInvalidArgumentError(
          str(asRecord(payload), 'message', 'The file watcher reported an error.'),
        );
      }
      yield event;
    }
  }

  /**
   * Search for files by name or content.
   *
   * At least one of `pattern` (searches file contents) or `glob` (matches
   * filenames) is required.
   */
  async find(
    runtimeId: string,
    path: string,
    options: FindOptions = {},
  ): Promise<FileFindResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    if (!options.pattern && !options.glob) {
      throw new GravixLayerInvalidArgumentError(
        'find requires at least one of `pattern` (content search) or `glob` (filename match).',
      );
    }

    const body: Record<string, unknown> = {
      path,
      regex: options.regex ?? false,
      case_sensitive: options.caseSensitive ?? false,
      include_hidden: options.includeHidden ?? false,
    };
    if (options.pattern !== undefined) body['pattern'] = options.pattern;
    if (options.glob !== undefined) body['glob'] = options.glob;
    if (options.maxResults !== undefined) {
      body['max_results'] = assertPositiveInt(options.maxResults, 'maxResults');
    }
    if (options.maxDepth !== undefined) {
      body['max_depth'] = assertPositiveInt(options.maxDepth, 'maxDepth');
    }

    return parseFileFindResponse(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/files/find`,
          service: SERVICES.agents,
          body,
          options: requestOptions(options),
        }),
      ),
    );
  }

  /**
   * Replace text across files under a path.
   *
   * Pass `dryRun: true` first to see what would change without writing.
   */
  async replace(
    runtimeId: string,
    path: string,
    pattern: string,
    replacement: string,
    options: ReplaceOptions = {},
  ): Promise<FileReplaceResponse> {
    assertRuntimeId(runtimeId);
    assertPath(path);
    assertNonEmpty(pattern, 'pattern');

    const body: Record<string, unknown> = {
      path,
      pattern,
      replacement,
      regex: options.regex ?? false,
      case_sensitive: options.caseSensitive ?? false,
      include_hidden: options.includeHidden ?? false,
      dry_run: options.dryRun ?? false,
    };
    if (options.glob !== undefined) body['glob'] = options.glob;
    if (options.maxDepth !== undefined) {
      body['max_depth'] = assertPositiveInt(options.maxDepth, 'maxDepth');
    }

    return parseFileReplaceResponse(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/files/replace`,
          service: SERVICES.agents,
          body,
          options: requestOptions(options),
        }),
      ),
    );
  }

  /** Upload through the legacy single-file endpoint. */
  async uploadFile(
    runtimeId: string,
    data: BinaryLike,
    path?: string,
    options: RequestOptions = {},
  ): Promise<FileUploadResponse> {
    assertRuntimeId(runtimeId);

    const form = new FormData();
    await appendFile(form, 'file', path ? basename(path) : 'upload', data);
    if (path !== undefined) form.append('path', path);

    const body = asRecord(
      await this.http.request({
        method: 'POST',
        path: `runtime/${runtimeId}/upload`,
        service: SERVICES.agents,
        form,
        options,
      }),
    );

    const response: FileUploadResponse = { message: str(body, 'message') };
    const responsePath = optStr(body, 'path') ?? path;
    if (responsePath !== undefined) response.path = responsePath;
    const size = optNum(body, 'size');
    if (size !== undefined) response.size = size;
    return response;
  }

  /** Download a file's raw bytes. */
  async download(
    runtimeId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Uint8Array> {
    assertRuntimeId(runtimeId);
    assertPath(path);

    return this.http.requestBytes({
      method: 'GET',
      path: `runtime/${runtimeId}/download`,
      service: SERVICES.agents,
      query: { path },
      options,
    });
  }

  /** Download a file and decode it as UTF-8 text. */
  async downloadText(
    runtimeId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<string> {
    const bytes = await this.download(runtimeId, path, options);
    return new TextDecoder('utf-8').decode(bytes);
  }
}
