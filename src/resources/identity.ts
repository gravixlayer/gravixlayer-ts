/**
 * Secret providers.
 *
 * A provider is a named bundle of key/value secrets. Attaching one to a
 * runtime injects its secrets into the guest environment at execution time,
 * which keeps credentials out of your code and out of template images.
 *
 * Values are write-only: they go up, and everything that comes back is masked.
 */

import { asRecord, bool, parseList } from '../core/parse.js';
import type { RequestOptions } from '../core/transport.js';
import {
  buildListEndpoint,
  pathSegment,
  SERVICES,
  withQuery,
  type QueryValue,
} from '../core/url.js';
import { assertNonEmpty, assertRuntimeId } from '../core/validate.js';
import type { SuccessResponse } from '../types/network-policies.js';
import {
  parseSecretInfo,
  parseSecretProvider,
  type SecretInfo,
  type SecretList,
  type SecretProvider,
  type SecretProviderList,
} from '../types/secret-providers.js';
import { APIResource, type ClientContext } from './resource.js';

/** Default authentication kind for a provider. */
const DEFAULT_PROVIDER_TYPE = 'api_key';

/** A key/value pair to store on a provider. */
export interface SecretInput {
  /** Environment variable name the secret is exposed as. */
  key: string;
  /** Secret value. Sent once and never returned. */
  value: string;
}

/** Options common to every write, which may be scoped to a project. */
export interface ProjectScopedOptions extends RequestOptions {
  /** Project to scope the operation to. Defaults to the account's default. */
  projectId?: string;
}

/** Options for {@link SecretProviders.create}. */
export interface CreateProviderOptions extends ProjectScopedOptions {
  /** Authentication kind. Defaults to `api_key`. */
  providerType?: string;
  /** Secrets to store on the new provider. */
  secrets?: readonly SecretInput[];
}

/** Options for {@link SecretProviders.list}. */
export interface ListProvidersOptions extends ProjectScopedOptions {
  /** Maximum number of providers to return. Defaults to 100. */
  limit?: number;
  /** Number of providers to skip. Defaults to 0. */
  offset?: number;
  /** Filter by name. */
  search?: string;
}

/** Options for {@link SecretProviders.update}. */
export interface UpdateProviderOptions extends ProjectScopedOptions {
  /** New display name. */
  name?: string;
  /** New authentication kind. */
  providerType?: string;
  /** Whether the provider's secrets are injected. */
  isActive?: boolean;
}

/** Options for {@link SecretProviders.updateSecret}. */
export interface UpdateSecretOptions extends ProjectScopedOptions {
  /** New environment variable name. */
  key?: string;
  /** New value, which replaces the old one. */
  value?: string;
}

/** Strip operation-specific fields, leaving only per-request transport options. */
function requestOptions(options: RequestOptions): RequestOptions {
  const out: RequestOptions = {};
  if (options.signal) out.signal = options.signal;
  if (options.timeout !== undefined) out.timeout = options.timeout;
  if (options.maxRetries !== undefined) out.maxRetries = options.maxRetries;
  if (options.headers) out.headers = options.headers;
  return out;
}

/** Append the project scope when one was given. */
function scoped(path: string, projectId: string | undefined): string {
  const params: Record<string, QueryValue> = {};
  if (projectId) params['project_id'] = projectId;
  return withQuery(path, params);
}

/** Create and manage secret providers. */
export class SecretProviders extends APIResource {
  /**
   * Create a provider, optionally with its secrets in the same call.
   *
   * @example
   * ```ts
   * const provider = await client.identity.providers.create('Model API', {
   *   secrets: [{ key: 'MODEL_API_KEY', value: process.env.MODEL_API_KEY! }],
   * });
   * ```
   */
  async create(name: string, options: CreateProviderOptions = {}): Promise<SecretProvider> {
    assertNonEmpty(name, 'name');

    const body: Record<string, unknown> = {
      name,
      provider_type: options.providerType ?? DEFAULT_PROVIDER_TYPE,
    };
    if (options.secrets?.length) {
      body['secrets'] = options.secrets.map((secret) => ({
        key: assertNonEmpty(secret.key, 'secret.key'),
        value: secret.value,
      }));
    }

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: scoped('providers', options.projectId),
        service: SERVICES.identity,
        body,
        options: requestOptions(options),
      }),
    );
    return parseSecretProvider(asRecord(data['provider']));
  }

  /** List providers. Secret values are always masked. */
  async list(options: ListProvidersOptions = {}): Promise<SecretProviderList> {
    const extra: Record<string, QueryValue> = {};
    if (options.projectId) extra['project_id'] = options.projectId;
    if (options.search) extra['search'] = options.search;

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: buildListEndpoint('providers', {
          limit: options.limit ?? 100,
          offset: options.offset ?? 0,
          extra,
        }),
        service: SERVICES.identity,
        options: requestOptions(options),
      }),
    );

    const providers = parseList(data, 'providers', parseSecretProvider);
    return { providers, total: Number(data['total'] ?? providers.length) };
  }

  /** Fetch one provider, including its masked secrets. */
  async get(providerId: string, options: RequestOptions = {}): Promise<SecretProvider> {
    const provider = pathSegment(providerId, 'providerId');

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `providers/${provider}`,
        service: SERVICES.identity,
        options,
      }),
    );
    return parseSecretProvider(asRecord(data['provider']));
  }

  /** Rename a provider, change its type, or enable and disable it. */
  async update(providerId: string, options: UpdateProviderOptions = {}): Promise<SecretProvider> {
    const provider = pathSegment(providerId, 'providerId');

    const body: Record<string, unknown> = {};
    if (options.name !== undefined) body['name'] = options.name;
    if (options.providerType !== undefined) body['provider_type'] = options.providerType;
    if (options.isActive !== undefined) body['is_active'] = options.isActive;

    const data = asRecord(
      await this.http.request({
        method: 'PATCH',
        path: scoped(`providers/${provider}`, options.projectId),
        service: SERVICES.identity,
        body,
        options: requestOptions(options),
      }),
    );
    return parseSecretProvider(asRecord(data['provider']));
  }

  /** Delete a provider and detach it from every runtime using it. */
  async delete(providerId: string, options: ProjectScopedOptions = {}): Promise<SuccessResponse> {
    const provider = pathSegment(providerId, 'providerId');

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: scoped(`providers/${provider}`, options.projectId),
        service: SERVICES.identity,
        options: requestOptions(options),
      }),
    );
    return { success: bool(data, 'success', true) };
  }

  /** Add a secret, replacing any existing secret with the same key. */
  async addSecret(
    providerId: string,
    key: string,
    value: string,
    options: ProjectScopedOptions = {},
  ): Promise<SecretInfo> {
    const provider = pathSegment(providerId, 'providerId');
    assertNonEmpty(key, 'key');

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: scoped(`providers/${provider}/secrets`, options.projectId),
        service: SERVICES.identity,
        body: { key, value },
        options: requestOptions(options),
      }),
    );
    return parseSecretInfo(asRecord(data['secret']));
  }

  /** List a provider's secrets. Values are masked. */
  async listSecrets(providerId: string, options: RequestOptions = {}): Promise<SecretList> {
    const provider = pathSegment(providerId, 'providerId');

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `providers/${provider}/secrets`,
        service: SERVICES.identity,
        options,
      }),
    );
    return { secrets: parseList(data, 'secrets', parseSecretInfo) };
  }

  /** Rename a secret, replace its value, or both. */
  async updateSecret(
    providerId: string,
    secretId: string,
    options: UpdateSecretOptions = {},
  ): Promise<SecretInfo> {
    const provider = pathSegment(providerId, 'providerId');
    const secret = pathSegment(secretId, 'secretId');

    const body: Record<string, unknown> = {};
    if (options.key !== undefined) body['key'] = options.key;
    if (options.value !== undefined) body['value'] = options.value;

    const data = asRecord(
      await this.http.request({
        method: 'PATCH',
        path: scoped(`providers/${provider}/secrets/${secret}`, options.projectId),
        service: SERVICES.identity,
        body,
        options: requestOptions(options),
      }),
    );
    return parseSecretInfo(asRecord(data['secret']));
  }

  /** Delete one secret from a provider. */
  async deleteSecret(
    providerId: string,
    secretId: string,
    options: ProjectScopedOptions = {},
  ): Promise<SuccessResponse> {
    const provider = pathSegment(providerId, 'providerId');
    const secret = pathSegment(secretId, 'secretId');

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: scoped(`providers/${provider}/secrets/${secret}`, options.projectId),
        service: SERVICES.identity,
        options: requestOptions(options),
      }),
    );
    return { success: bool(data, 'success', true) };
  }

  /**
   * Attach a provider to a runtime.
   *
   * Secrets appear in the environment of the next execution. To have them
   * present from the first instruction, pass `providers` to
   * `client.runtimes.create()` instead.
   */
  async attach(
    providerId: string,
    runtimeId: string,
    options: ProjectScopedOptions = {},
  ): Promise<SuccessResponse> {
    const provider = pathSegment(providerId, 'providerId');
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: scoped(`providers/${provider}/attach`, options.projectId),
        service: SERVICES.identity,
        body: { runtime_id: runtimeId },
        options: requestOptions(options),
      }),
    );
    return { success: bool(data, 'success', true) };
  }

  /** Detach a provider from a runtime. */
  async detach(
    providerId: string,
    runtimeId: string,
    options: ProjectScopedOptions = {},
  ): Promise<SuccessResponse> {
    const provider = pathSegment(providerId, 'providerId');
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: scoped(`providers/${provider}/attach/${runtimeId}`, options.projectId),
        service: SERVICES.identity,
        options: requestOptions(options),
      }),
    );
    return { success: bool(data, 'success', true) };
  }

  /** List the providers currently attached to a runtime. */
  async listForRuntime(
    runtimeId: string,
    options: RequestOptions = {},
  ): Promise<SecretProviderList> {
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtimes/${runtimeId}/providers`,
        service: SERVICES.identity,
        options,
      }),
    );

    const providers = parseList(data, 'providers', parseSecretProvider);
    return { providers, total: providers.length };
  }
}

/**
 * The identity namespace.
 *
 * Reached through `client.identity`, with providers under
 * `client.identity.providers`.
 */
export class Identity {
  /** Secret providers. */
  readonly providers: SecretProviders;

  constructor(context: ClientContext) {
    this.providers = new SecretProviders(context);
  }
}
