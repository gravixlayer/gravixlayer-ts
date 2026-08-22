/**
 * Network policy types.
 *
 * Runtimes start with no outbound network access. A policy grants egress, and
 * policies are attached to a runtime at creation time or afterwards.
 */

import { bool, num, optStr, parseList, str } from '../core/parse.js';

/** How a policy decides which outbound connections are allowed. */
export const EgressMode = {
  /** Block everything. */
  DenyAll: 'deny_all',
  /** Allow everything. Convenient for development, broad for production. */
  AllowAll: 'allow_all',
  /** Block by default; permit only what the rules list. */
  Allowlist: 'allowlist',
  /** Allow by default; block what the rules list. */
  Denylist: 'denylist',
} as const;

export type EgressMode = (typeof EgressMode)[keyof typeof EgressMode];

/** Every valid egress mode. */
export const EGRESS_MODES: readonly EgressMode[] = [
  EgressMode.DenyAll,
  EgressMode.AllowAll,
  EgressMode.Allowlist,
  EgressMode.Denylist,
];

/** Transport protocol a rule applies to. */
export const Protocol = {
  Tcp: 'tcp',
  Udp: 'udp',
  /** Both TCP and UDP. */
  Any: 'any',
} as const;

export type Protocol = (typeof Protocol)[keyof typeof Protocol];

/** Every valid protocol. */
export const PROTOCOLS: readonly Protocol[] = [Protocol.Tcp, Protocol.Udp, Protocol.Any];

/**
 * Name of the built-in policy attached to every runtime.
 *
 * It is an empty allowlist, which is what makes runtimes deny egress by
 * default. It cannot be edited or removed.
 */
export const SYSTEM_DEFAULT_POLICY_NAME = 'System Default';

/**
 * Order in which modes win when a runtime has several policies attached.
 *
 * The strictest attached mode applies: a single `deny_all` overrides every
 * other policy on the runtime.
 */
export const EGRESS_MODE_PRECEDENCE: readonly EgressMode[] = [
  EgressMode.DenyAll,
  EgressMode.Allowlist,
  EgressMode.Denylist,
  EgressMode.AllowAll,
];

/** A single egress rule. */
export interface NetworkPolicyRule {
  id: string;
  policyId: string;
  /** Hostname, IP address, or CIDR block the rule matches. */
  destination: string;
  /** Port the rule matches. `0` matches any port. */
  port: number;
  /** One of {@link Protocol}. */
  protocol: string;
  accountId?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function parseNetworkPolicyRule(data: Record<string, unknown>): NetworkPolicyRule {
  const rule: NetworkPolicyRule = {
    id: str(data, 'id'),
    policyId: str(data, 'policy_id'),
    destination: str(data, 'destination'),
    port: num(data, 'port'),
    protocol: str(data, 'protocol', Protocol.Tcp),
  };
  const accountId = optStr(data, 'account_id');
  if (accountId !== undefined) rule.accountId = accountId;
  const description = optStr(data, 'description');
  if (description !== undefined) rule.description = description;
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) rule.createdAt = createdAt;
  const updatedAt = optStr(data, 'updated_at');
  if (updatedAt !== undefined) rule.updatedAt = updatedAt;
  return rule;
}

/** A network policy. */
export interface NetworkPolicy {
  id: string;
  name: string;
  /** One of {@link EgressMode}. */
  egressMode: string;
  accountId?: string;
  projectId?: string;
  description?: string;
  /** True when the policy is attached to new runtimes automatically. */
  isDefault: boolean;
  /** True for platform-managed policies, which cannot be edited. */
  isSystem: boolean;
  isActive: boolean;
  /** Number of rules attached to the policy. */
  ruleCount: number;
  createdAt?: string;
  updatedAt?: string;
  /** Rules, when the request asked for them. */
  rules?: NetworkPolicyRule[];
}

export function parseNetworkPolicy(data: Record<string, unknown>): NetworkPolicy {
  const policy: NetworkPolicy = {
    id: str(data, 'id'),
    name: str(data, 'name'),
    egressMode: str(data, 'egress_mode', EgressMode.Allowlist),
    isDefault: bool(data, 'is_default'),
    isSystem: bool(data, 'is_system'),
    isActive: bool(data, 'is_active', true),
    ruleCount: num(data, 'rule_count'),
  };
  const accountId = optStr(data, 'account_id');
  if (accountId !== undefined) policy.accountId = accountId;
  const projectId = optStr(data, 'project_id');
  if (projectId !== undefined) policy.projectId = projectId;
  const description = optStr(data, 'description');
  if (description !== undefined) policy.description = description;
  const createdAt = optStr(data, 'created_at');
  if (createdAt !== undefined) policy.createdAt = createdAt;
  const updatedAt = optStr(data, 'updated_at');
  if (updatedAt !== undefined) policy.updatedAt = updatedAt;
  if (Array.isArray(data['rules'])) {
    policy.rules = parseList(data, 'rules', parseNetworkPolicyRule);
  }
  return policy;
}

/** True for the built-in policy that every runtime carries. */
export function isSystemDefaultPolicy(policy: NetworkPolicy): boolean {
  return (policy.isSystem && policy.isDefault) || policy.name === SYSTEM_DEFAULT_POLICY_NAME;
}

/** One page of policies. */
export interface NetworkPolicyList {
  policies: NetworkPolicy[];
  total: number;
}

/** A list of rules. */
export interface NetworkPolicyRuleList {
  rules: NetworkPolicyRule[];
}

/** A bare acknowledgement returned by delete, attach, and detach. */
export interface SuccessResponse {
  success: boolean;
}
