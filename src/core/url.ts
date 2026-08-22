/** URL and query-string construction shared by every resource. */

import { assertNonEmpty } from './validate.js';

/** A value that can appear in a query string. `undefined` and `null` are dropped. */
export type QueryValue = string | number | boolean | undefined | null;

/** Named API services. Each maps to a versioned path segment on the base URL. */
export const SERVICES = {
  inference: 'v1/inference',
  agents: 'v1/agents',
  vectors: 'v1/vectors',
  files: 'v1/files',
  deployments: 'v1/deployments',
  identity: 'v1/identity',
  networkPolicies: 'v1/network-policies',
} as const;

export type ServiceName = (typeof SERVICES)[keyof typeof SERVICES];

const ABSOLUTE = /^https?:\/\//i;

/**
 * Resolve an endpoint against a service base.
 *
 * - An absolute `http(s)` endpoint is returned unchanged, which lets a resource
 *   call a deployed agent's own URL through the same transport.
 * - An empty endpoint resolves to the service base itself.
 * - An endpoint starting with `?` is appended without a separator.
 * - Anything else is joined with a single `/`.
 */
export function buildUrl(endpoint: string, service: string, baseUrl: string): string {
  if (endpoint && ABSOLUTE.test(endpoint)) return endpoint;

  const serviceBase = service ? `${baseUrl}/${service}` : baseUrl;
  if (!endpoint) return serviceBase;
  if (endpoint.startsWith('?')) return `${serviceBase}${endpoint}`;

  return `${serviceBase}/${endpoint.replace(/^\/+/, '')}`;
}

/**
 * Encode a query string, dropping entries whose value is `undefined` or `null`.
 * Returns an empty string when nothing survives, so callers can concatenate it
 * unconditionally.
 */
export function encodeQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/** Append a query string to an endpoint, preserving any query already present. */
export function withQuery(endpoint: string, params: Record<string, QueryValue>): string {
  const query = encodeQuery(params);
  if (!query) return endpoint;
  return endpoint.includes('?') ? `${endpoint}&${query.slice(1)}` : `${endpoint}${query}`;
}

/** Options accepted by every paginated `list` method. */
export interface ListParams {
  /** Maximum number of items to return. Defaults to 100. */
  limit?: number;
  /** Number of items to skip. Defaults to 0. */
  offset?: number;
}

/**
 * Build a paginated list endpoint.
 *
 * `limit` and `offset` default to 100 and 0. Pass `null` for either to omit it
 * from the query string entirely.
 */
export function buildListEndpoint(
  resource: string,
  params: {
    limit?: number | null;
    offset?: number | null;
    extra?: Record<string, QueryValue>;
  } = {},
): string {
  const { limit = 100, offset = 0, extra } = params;
  return withQuery(resource, { limit, offset, ...extra });
}

/**
 * Percent-encode one path segment per RFC 3986.
 *
 * `encodeURIComponent` leaves `!'()*` untouched even though RFC 3986 reserves
 * them, so those are escaped explicitly. `/` is encoded, which keeps a value
 * containing a slash from silently splitting into two path segments.
 */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Validate an identifier and encode it as exactly one path segment.
 *
 * Identifiers reach the SDK from application code as often as from a previous
 * response, so an id carrying a slash or a query character must not be able to
 * rewrite the endpoint it is interpolated into.
 */
export function pathSegment(value: string, label: string): string {
  return encodePathSegment(assertNonEmpty(value, label));
}
