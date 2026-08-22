/**
 * Network policies: what a runtime is allowed to reach.
 *
 * A policy has an egress mode and a set of rules. Attach one or more to a
 * runtime and the platform compiles them with most-restrictive-wins
 * precedence, so adding a policy can only ever narrow access.
 *
 * A fail-closed baseline policy is always attached and cannot be detached.
 */

import { GravixLayerInvalidArgumentError } from '../core/errors.js';
import { asRecord, bool, num, parseList } from '../core/parse.js';
import type { RequestOptions } from '../core/transport.js';
import {
  buildListEndpoint,
  pathSegment,
  SERVICES,
  withQuery,
  type QueryValue,
} from '../core/url.js';
import { assertNonEmpty, assertOneOf, assertRuntimeId } from '../core/validate.js';
import {
  EGRESS_MODES,
  EgressMode,
  isSystemDefaultPolicy,
  parseNetworkPolicy,
  parseNetworkPolicyRule,
  Protocol,
  PROTOCOLS,
  type NetworkPolicy,
  type NetworkPolicyList,
  type NetworkPolicyRule,
  type NetworkPolicyRuleList,
  type SuccessResponse,
} from '../types/network-policies.js';
import { APIResource } from './resource.js';

/** Highest page size the API accepts. */
const MAX_PAGE_SIZE = 100;

/** A rule to create alongside a policy. */
export interface NetworkRuleInput {
  /** Hostname, IP address, or CIDR block. */
  destination: string;
  /** Destination port. `0`, the default, means any port. */
  port?: number;
  /** Transport protocol. Defaults to `tcp`. */
  protocol?: Protocol | string;
  /** Human-readable note about why the rule exists. */
  description?: string;
}

/** Options common to writes, which may be scoped to a project. */
export interface ProjectScopedOptions extends RequestOptions {
  /** Project to scope the operation to. Defaults to the account's default. */
  projectId?: string;
}

/** Options for {@link NetworkPolicies.create}. */
export interface CreateNetworkPolicyOptions extends ProjectScopedOptions {
  /** How traffic not covered by a rule is treated. Defaults to `allowlist`. */
  egressMode?: EgressMode | string;
  /** Human-readable description. */
  description?: string;
  /** Make this the default policy for new runtimes. */
  isDefault?: boolean;
  /** Rules to add immediately after the policy is created. */
  rules?: readonly NetworkRuleInput[];
}

/** Options for {@link NetworkPolicies.list}. */
export interface ListNetworkPoliciesOptions extends ProjectScopedOptions {
  /** Maximum number of policies to return, between 1 and 100. Defaults to 100. */
  limit?: number;
  /** Number of policies to skip. Defaults to 0. */
  offset?: number;
  /** Filter by name. */
  search?: string;
}

/** Options for {@link NetworkPolicies.update}. */
export interface UpdateNetworkPolicyOptions extends ProjectScopedOptions {
  /** New display name. */
  name?: string;
  /** New egress mode. */
  egressMode?: EgressMode | string;
  /** New description. */
  description?: string;
  /** Whether the policy is enforced. */
  isActive?: boolean;
  /** Whether the policy is applied to new runtimes by default. */
  isDefault?: boolean;
}

/** Options for {@link NetworkPolicies.addRule}. */
export interface AddRuleOptions extends ProjectScopedOptions {
  /** Destination port. `0`, the default, means any port. */
  port?: number;
  /** Transport protocol. Defaults to `tcp`. */
  protocol?: Protocol | string;
  /** Human-readable note about why the rule exists. */
  description?: string;
}

/** Options for {@link NetworkPolicies.updateRule}. */
export interface UpdateRuleOptions extends ProjectScopedOptions {
  /** New destination. */
  destination?: string;
  /** New port. */
  port?: number;
  /** New protocol. */
  protocol?: Protocol | string;
  /** New description. */
  description?: string;
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

/** Validate a port that may be `0`, which the API reads as "any port". */
function assertRulePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new GravixLayerInvalidArgumentError(
      `A rule port must be an integer between 0 and 65535, where 0 means any port. Received ${port}.`,
    );
  }
  return port;
}

/** Create, edit, and attach network policies. */
export class NetworkPolicies extends APIResource {
  /**
   * Create a policy, optionally with its rules in the same call.
   *
   * When rules are given they are added one at a time after the policy
   * exists. If any rule fails, the policy is deleted, so a failed call never
   * leaves a half-configured policy behind.
   *
   * @example
   * ```ts
   * const policy = await client.networkPolicies.create('model-access', {
   *   egressMode: 'allowlist',
   *   rules: [{ destination: 'api.example.com', port: 443 }],
   * });
   * ```
   */
  async create(name: string, options: CreateNetworkPolicyOptions = {}): Promise<NetworkPolicy> {
    assertNonEmpty(name, 'name');
    const egressMode = assertOneOf(
      options.egressMode ?? EgressMode.Allowlist,
      EGRESS_MODES,
      'egressMode',
    );

    const rules = (options.rules ?? []).map((rule) => ({
      destination: assertNonEmpty(rule.destination, 'rule.destination'),
      port: assertRulePort(rule.port ?? 0),
      protocol: assertOneOf((rule.protocol ?? Protocol.Tcp).toLowerCase(), PROTOCOLS, 'protocol'),
      description: rule.description,
    }));

    const body: Record<string, unknown> = {
      name,
      egress_mode: egressMode,
      is_default: options.isDefault ?? false,
    };
    if (options.description !== undefined) body['description'] = options.description;

    const created = asRecord(
      await this.http.request({
        method: 'POST',
        path: scoped('', options.projectId),
        service: SERVICES.networkPolicies,
        body,
        options: requestOptions(options),
      }),
    );
    const policy = parseNetworkPolicy(asRecord(created['policy']));

    if (rules.length === 0) return policy;

    const added: NetworkPolicyRule[] = [];
    try {
      for (const rule of rules) {
        const ruleOptions: AddRuleOptions = { port: rule.port, protocol: rule.protocol };
        if (rule.description !== undefined) ruleOptions.description = rule.description;
        if (options.projectId !== undefined) ruleOptions.projectId = options.projectId;
        added.push(await this.addRule(policy.id, rule.destination, ruleOptions));
      }
    } catch (error) {
      const scope: ProjectScopedOptions = {};
      if (options.projectId !== undefined) scope.projectId = options.projectId;
      try {
        await this.delete(policy.id, scope);
      } catch {
        throw new GravixLayerInvalidArgumentError(
          `Adding rules failed and policy ${policy.id} could not be rolled back. ` +
            'Delete it manually and retry.',
          { cause: error },
        );
      }
      throw error;
    }

    return { ...policy, rules: added, ruleCount: added.length };
  }

  /** List policies. The always-attached baseline policy is not included. */
  async list(options: ListNetworkPoliciesOptions = {}): Promise<NetworkPolicyList> {
    const limit = options.limit ?? MAX_PAGE_SIZE;
    const offset = options.offset ?? 0;

    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new GravixLayerInvalidArgumentError(
        `\`limit\` must be an integer between 1 and ${MAX_PAGE_SIZE}. Received ${limit}.`,
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new GravixLayerInvalidArgumentError(
        `\`offset\` must be an integer of 0 or more. Received ${offset}.`,
      );
    }

    const extra: Record<string, QueryValue> = {};
    if (options.projectId) extra['project_id'] = options.projectId;
    if (options.search) extra['search'] = options.search;

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: buildListEndpoint('', { limit, offset, extra }),
        service: SERVICES.networkPolicies,
        options: requestOptions(options),
      }),
    );

    const policies = parseList(data, 'policies', parseNetworkPolicy);
    return { policies, total: num(data, 'total', policies.length) };
  }

  /**
   * Fetch one policy.
   *
   * Pass `includeRules` to fetch its rules in the same call, which costs one
   * extra request.
   */
  async get(
    policyId: string,
    options: RequestOptions & { includeRules?: boolean } = {},
  ): Promise<NetworkPolicy> {
    const policyPath = pathSegment(policyId, 'policyId');

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: policyPath,
        service: SERVICES.networkPolicies,
        options: requestOptions(options),
      }),
    );
    const policy = parseNetworkPolicy(asRecord(data['policy']));

    if (!options.includeRules) return policy;

    const { rules } = await this.listRules(policyId, requestOptions(options));
    return { ...policy, rules, ruleCount: rules.length };
  }

  /** Change a policy's name, mode, description, or activation. */
  async update(policyId: string, options: UpdateNetworkPolicyOptions = {}): Promise<NetworkPolicy> {
    const policyPath = pathSegment(policyId, 'policyId');

    const body: Record<string, unknown> = {};
    if (options.name !== undefined) body['name'] = options.name;
    if (options.egressMode !== undefined) {
      body['egress_mode'] = assertOneOf(options.egressMode, EGRESS_MODES, 'egressMode');
    }
    if (options.description !== undefined) body['description'] = options.description;
    if (options.isActive !== undefined) body['is_active'] = options.isActive;
    if (options.isDefault !== undefined) body['is_default'] = options.isDefault;

    const data = asRecord(
      await this.http.request({
        method: 'PATCH',
        path: scoped(policyPath, options.projectId),
        service: SERVICES.networkPolicies,
        body,
        options: requestOptions(options),
      }),
    );
    return parseNetworkPolicy(asRecord(data['policy']));
  }

  /** Delete a policy and detach it from every runtime using it. */
  async delete(policyId: string, options: ProjectScopedOptions = {}): Promise<SuccessResponse> {
    const policyPath = pathSegment(policyId, 'policyId');

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: scoped(policyPath, options.projectId),
        service: SERVICES.networkPolicies,
        options: requestOptions(options),
      }),
    );
    return { success: bool(data, 'success', true) };
  }

  /** Add a rule to a policy. */
  async addRule(
    policyId: string,
    destination: string,
    options: AddRuleOptions = {},
  ): Promise<NetworkPolicyRule> {
    const policyPath = pathSegment(policyId, 'policyId');
    assertNonEmpty(destination, 'destination');

    const body: Record<string, unknown> = {
      destination,
      port: assertRulePort(options.port ?? 0),
      protocol: assertOneOf(
        (options.protocol ?? Protocol.Tcp).toLowerCase(),
        PROTOCOLS,
        'protocol',
      ),
    };
    if (options.description !== undefined) body['description'] = options.description;

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: scoped(`${policyPath}/rules`, options.projectId),
        service: SERVICES.networkPolicies,
        body,
        options: requestOptions(options),
      }),
    );
    return parseNetworkPolicyRule(asRecord(data['rule']));
  }

  /** List a policy's rules. */
  async listRules(policyId: string, options: RequestOptions = {}): Promise<NetworkPolicyRuleList> {
    const policyPath = pathSegment(policyId, 'policyId');

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `${policyPath}/rules`,
        service: SERVICES.networkPolicies,
        options,
      }),
    );
    return { rules: parseList(data, 'rules', parseNetworkPolicyRule) };
  }

  /** Change a rule's destination, port, protocol, or description. */
  async updateRule(
    policyId: string,
    ruleId: string,
    options: UpdateRuleOptions = {},
  ): Promise<NetworkPolicyRule> {
    const policyPath = pathSegment(policyId, 'policyId');
    const rulePath = pathSegment(ruleId, 'ruleId');

    const body: Record<string, unknown> = {};
    if (options.destination !== undefined) body['destination'] = options.destination;
    if (options.port !== undefined) body['port'] = assertRulePort(options.port);
    if (options.protocol !== undefined) {
      body['protocol'] = assertOneOf(options.protocol.toLowerCase(), PROTOCOLS, 'protocol');
    }
    if (options.description !== undefined) body['description'] = options.description;

    const data = asRecord(
      await this.http.request({
        method: 'PATCH',
        path: scoped(`${policyPath}/rules/${rulePath}`, options.projectId),
        service: SERVICES.networkPolicies,
        body,
        options: requestOptions(options),
      }),
    );
    return parseNetworkPolicyRule(asRecord(data['rule']));
  }

  /** Delete one rule from a policy. */
  async deleteRule(
    policyId: string,
    ruleId: string,
    options: ProjectScopedOptions = {},
  ): Promise<SuccessResponse> {
    const policyPath = pathSegment(policyId, 'policyId');
    const rulePath = pathSegment(ruleId, 'ruleId');

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: scoped(`${policyPath}/rules/${rulePath}`, options.projectId),
        service: SERVICES.networkPolicies,
        options: requestOptions(options),
      }),
    );
    return { success: bool(data, 'success', true) };
  }

  /**
   * Attach a policy to a runtime.
   *
   * Attaching at creation time, with `networkPolicyIds` on
   * `client.runtimes.create()`, applies the policy before the guest's first
   * packet rather than after.
   */
  async attach(
    policyId: string,
    runtimeId: string,
    options: ProjectScopedOptions = {},
  ): Promise<SuccessResponse> {
    const policyPath = pathSegment(policyId, 'policyId');
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'POST',
        path: scoped(`${policyPath}/attach`, options.projectId),
        service: SERVICES.networkPolicies,
        body: { runtime_id: runtimeId },
        options: requestOptions(options),
      }),
    );
    return { success: bool(data, 'success', true) };
  }

  /** Detach a policy from a runtime. The baseline policy cannot be detached. */
  async detach(
    policyId: string,
    runtimeId: string,
    options: ProjectScopedOptions = {},
  ): Promise<SuccessResponse> {
    const policyPath = pathSegment(policyId, 'policyId');
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'DELETE',
        path: scoped(`${policyPath}/attach/${runtimeId}`, options.projectId),
        service: SERVICES.networkPolicies,
        options: requestOptions(options),
      }),
    );
    return { success: bool(data, 'success', true) };
  }

  /**
   * List the policies attached to a runtime.
   *
   * The always-attached baseline policy is hidden unless `includeSystem` is
   * set, since it is on every runtime and is not something you manage.
   */
  async listForRuntime(
    runtimeId: string,
    options: RequestOptions & { includeSystem?: boolean } = {},
  ): Promise<NetworkPolicyList> {
    assertRuntimeId(runtimeId);

    const data = asRecord(
      await this.http.request({
        method: 'GET',
        path: `runtimes/${runtimeId}`,
        service: SERVICES.networkPolicies,
        options: requestOptions(options),
      }),
    );

    const all = parseList(data, 'policies', parseNetworkPolicy);
    const policies = options.includeSystem ? all : all.filter((p) => !isSystemDefaultPolicy(p));
    return { policies, total: policies.length };
  }
}
