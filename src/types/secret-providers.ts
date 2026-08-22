/**
 * Secret provider types.
 *
 * A provider is a named bundle of secrets. Attaching one to a runtime injects
 * its secrets as environment variables, so credentials reach the guest without
 * being written into a template or passed on a command line.
 */

import { bool, num, optStr, parseList, str } from '../core/parse.js';

/** A secret's metadata. The value itself is never returned by the API. */
export interface SecretInfo {
  id: string;
  /** Environment variable name the secret is exposed as. */
  key: string;
  /** True when a value is stored. */
  valueSet: boolean;
  /** Placeholder shown in place of the value. */
  masked: string;
  createdAt?: string;
  updatedAt?: string;
}

export function parseSecretInfo(data: Record<string, unknown>): SecretInfo {
  const info: SecretInfo = {
    id: str(data, 'id'),
    key: str(data, 'key'),
    valueSet: bool(data, 'value_set', true),
    masked: str(data, 'masked', '••••••••'),
  };
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) info.createdAt = createdAt;
  const updatedAt = optStr(data, 'updated_at');
  if (updatedAt !== undefined) info.updatedAt = updatedAt;
  return info;
}

/** A named bundle of secrets. */
export interface SecretProvider {
  id: string;
  name: string;
  /** Category of credential, for example `api_key`. */
  providerType: string;
  accountId?: string;
  projectId?: string;
  isActive: boolean;
  /** True for platform-managed providers. */
  isSystem: boolean;
  secretCount: number;
  /** Secret metadata, when the response included it. */
  secrets: SecretInfo[];
  createdAt?: string;
  updatedAt?: string;
}

export function parseSecretProvider(data: Record<string, unknown>): SecretProvider {
  const secrets = parseList(data, 'secrets', parseSecretInfo);
  const provider: SecretProvider = {
    id: str(data, 'id'),
    name: str(data, 'name'),
    providerType: str(data, 'provider_type', 'api_key'),
    isActive: bool(data, 'is_active', true),
    isSystem: bool(data, 'is_system'),
    secretCount: num(data, 'secret_count', secrets.length),
    secrets,
  };
  const accountId = optStr(data, 'account_id');
  if (accountId !== undefined) provider.accountId = accountId;
  const projectId = optStr(data, 'project_id');
  if (projectId !== undefined) provider.projectId = projectId;
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) provider.createdAt = createdAt;
  const updatedAt = optStr(data, 'updated_at');
  if (updatedAt !== undefined) provider.updatedAt = updatedAt;
  return provider;
}

/** One page of providers. */
export interface SecretProviderList {
  providers: SecretProvider[];
  total: number;
}

/** A list of secret metadata. */
export interface SecretList {
  secrets: SecretInfo[];
}
