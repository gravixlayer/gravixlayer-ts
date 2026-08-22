/**
 * Git operations executed inside a runtime.
 *
 * Every call runs `git` in the guest and reports the process result rather
 * than throwing on a non-zero exit, so inspect `result.success` and
 * `result.exitCode` the way you would after running the command yourself.
 */

import { asRecord } from '../../core/parse.js';
import type { RequestOptions } from '../../core/transport.js';
import { SERVICES } from '../../core/url.js';
import { assertNonEmpty, assertPath, assertRuntimeId } from '../../core/validate.js';
import { parseGitOperationResult, type GitOperationResult } from '../../types/runtime.js';
import { APIResource } from '../resource.js';

/** Which branches {@link RuntimeGit.branchList} reports. */
export type BranchScope = 'local' | 'remote' | 'all';

/** Options for {@link RuntimeGit.clone}. */
export interface GitCloneOptions extends RequestOptions {
  /** Branch, tag, or commit to check out. */
  branch?: string;
  /** Truncate history to this many commits. */
  depth?: number;
  /** Token for a private repository. */
  authToken?: string;
}

/** Options for {@link RuntimeGit.pull} and {@link RuntimeGit.fetch}. */
export interface GitFetchOptions extends RequestOptions {
  /** Remote name. Defaults to `origin`. */
  remote?: string;
  /** Branch to pull. Defaults to the current branch's upstream. */
  branch?: string;
  /** Token for a private repository. */
  authToken?: string;
}

/** Options for {@link RuntimeGit.push}. */
export interface GitPushOptions extends RequestOptions {
  /** Remote name. Defaults to `origin`. */
  remote?: string;
  /** Refspec to push, for example `HEAD:main`. */
  refspec?: string;
  /** Username for basic authentication. */
  username?: string;
  /** Password or token for basic authentication. */
  password?: string;
  /** Token authentication, which takes precedence over username and password. */
  authToken?: string;
}

/** Options for {@link RuntimeGit.commit}. */
export interface GitCommitOptions extends RequestOptions {
  /** Author name recorded on the commit. */
  authorName?: string;
  /** Author email recorded on the commit. */
  authorEmail?: string;
  /** Create the commit even when nothing is staged. */
  allowEmpty?: boolean;
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

/** Run git commands inside a runtime. */
export class RuntimeGit extends APIResource {
  /** Clone a repository into the guest. */
  async clone(
    runtimeId: string,
    url: string,
    path: string,
    options: GitCloneOptions = {},
  ): Promise<GitOperationResult> {
    assertNonEmpty(url, 'url');
    assertPath(path);

    const body: Record<string, unknown> = { url, path };
    if (options.branch !== undefined) body['branch'] = options.branch;
    if (options.depth !== undefined) body['depth'] = options.depth;
    if (options.authToken !== undefined) body['auth_token'] = options.authToken;

    return this.run(runtimeId, 'clone', body, options);
  }

  /** Report the working tree status. */
  async status(
    runtimeId: string,
    repositoryPath: string,
    options: RequestOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');
    return this.run(runtimeId, 'status', { repository_path: repositoryPath }, options);
  }

  /** List branches. */
  async branchList(
    runtimeId: string,
    repositoryPath: string,
    scope: BranchScope = 'local',
    options: RequestOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');
    return this.run(runtimeId, 'branches', { repository_path: repositoryPath, scope }, options);
  }

  /** Check out a branch, tag, or commit. */
  async checkout(
    runtimeId: string,
    repositoryPath: string,
    ref: string,
    options: RequestOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');
    assertNonEmpty(ref, 'ref');
    return this.run(
      runtimeId,
      'checkout',
      { repository_path: repositoryPath, ref_name: ref },
      options,
    );
  }

  /** Fetch and merge from a remote. */
  async pull(
    runtimeId: string,
    repositoryPath: string,
    options: GitFetchOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');

    const body: Record<string, unknown> = { repository_path: repositoryPath };
    if (options.remote !== undefined) body['remote'] = options.remote;
    if (options.branch !== undefined) body['branch'] = options.branch;
    if (options.authToken !== undefined) body['auth_token'] = options.authToken;

    return this.run(runtimeId, 'pull', body, options);
  }

  /** Fetch from a remote without merging. */
  async fetch(
    runtimeId: string,
    repositoryPath: string,
    options: GitFetchOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');

    const body: Record<string, unknown> = { repository_path: repositoryPath };
    if (options.remote !== undefined) body['remote'] = options.remote;
    if (options.authToken !== undefined) body['auth_token'] = options.authToken;

    return this.run(runtimeId, 'fetch', body, options);
  }

  /** Push to a remote. */
  async push(
    runtimeId: string,
    repositoryPath: string,
    options: GitPushOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');

    const body: Record<string, unknown> = { repository_path: repositoryPath };
    if (options.remote !== undefined) body['remote'] = options.remote;
    if (options.refspec !== undefined) body['refspec'] = options.refspec;
    if (options.username !== undefined) body['username'] = options.username;
    if (options.password !== undefined) body['password'] = options.password;
    if (options.authToken !== undefined) body['auth_token'] = options.authToken;

    return this.run(runtimeId, 'push', body, options);
  }

  /** Stage paths. Omit `paths` to stage everything. */
  async add(
    runtimeId: string,
    repositoryPath: string,
    paths?: readonly string[],
    options: RequestOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');

    const body: Record<string, unknown> = { repository_path: repositoryPath };
    if (paths !== undefined) body['paths'] = [...paths];

    return this.run(runtimeId, 'add', body, options);
  }

  /** Commit staged changes. */
  async commit(
    runtimeId: string,
    repositoryPath: string,
    message: string,
    options: GitCommitOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');
    assertNonEmpty(message, 'message');

    const body: Record<string, unknown> = { repository_path: repositoryPath, message };
    if (options.authorName !== undefined) body['author_name'] = options.authorName;
    if (options.authorEmail !== undefined) body['author_email'] = options.authorEmail;
    if (options.allowEmpty !== undefined) body['allow_empty'] = options.allowEmpty;

    return this.run(runtimeId, 'commit', body, options);
  }

  /** Create a branch. */
  async createBranch(
    runtimeId: string,
    repositoryPath: string,
    branchName: string,
    startPoint?: string,
    options: RequestOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');
    assertNonEmpty(branchName, 'branchName');

    const body: Record<string, unknown> = {
      repository_path: repositoryPath,
      branch_name: branchName,
    };
    if (startPoint !== undefined) body['start_point'] = startPoint;

    return this.run(runtimeId, 'branch/create', body, options);
  }

  /** Delete a branch. */
  async deleteBranch(
    runtimeId: string,
    repositoryPath: string,
    branchName: string,
    force = false,
    options: RequestOptions = {},
  ): Promise<GitOperationResult> {
    assertPath(repositoryPath, 'repositoryPath');
    assertNonEmpty(branchName, 'branchName');

    return this.run(
      runtimeId,
      'branch/delete',
      { repository_path: repositoryPath, branch_name: branchName, force },
      options,
    );
  }

  /** Issue one git request and parse the result. */
  private async run(
    runtimeId: string,
    operation: string,
    body: Record<string, unknown>,
    options: RequestOptions,
  ): Promise<GitOperationResult> {
    assertRuntimeId(runtimeId);

    return parseGitOperationResult(
      asRecord(
        await this.http.request({
          method: 'POST',
          path: `runtime/${runtimeId}/git/${operation}`,
          service: SERVICES.agents,
          body,
          options: requestOptions(options),
        }),
      ),
    );
  }
}
