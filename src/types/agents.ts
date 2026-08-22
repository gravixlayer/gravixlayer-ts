/**
 * Agent types: building an agent image, deploying it, and describing it to
 * other agents through an agent card.
 */

import { GravixLayerInvalidArgumentError } from '../core/errors.js';
import { compact, num, optStr, str, strMap } from '../core/parse.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Lifecycle states of an agent build. */
export const AgentBuildStatus = {
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type AgentBuildStatus = (typeof AgentBuildStatus)[keyof typeof AgentBuildStatus];

/** Reported phases within an agent build. */
export const AgentBuildPhase = {
  Building: 'building',
  Uploading: 'uploading',
  Completed: 'completed',
  Initializing: 'initializing',
  Preparing: 'preparing',
  Finalizing: 'finalizing',
} as const;

export type AgentBuildPhase = (typeof AgentBuildPhase)[keyof typeof AgentBuildPhase];

/** Lifecycle states of a deployed agent. */
export const AgentDeployStatus = {
  Starting: 'starting',
  Active: 'active',
  Deleting: 'deleting',
  Deleted: 'deleted',
} as const;

export type AgentDeployStatus = (typeof AgentDeployStatus)[keyof typeof AgentDeployStatus];

/** Progress of DNS propagation for an agent's public hostname. */
export const AgentDNSStatus = {
  Pending: 'pending',
  Propagating: 'propagating',
  Active: 'active',
  Failed: 'failed',
} as const;

export type AgentDNSStatus = (typeof AgentDNSStatus)[keyof typeof AgentDNSStatus];

/** Health reported by an agent's own health endpoint. */
export const AgentHealthStatus = {
  Starting: 'starting',
  Healthy: 'healthy',
  Unhealthy: 'unhealthy',
  Unknown: 'unknown',
} as const;

export type AgentHealthStatus = (typeof AgentHealthStatus)[keyof typeof AgentHealthStatus];

/** Agent frameworks the platform can host. */
export const AgentFramework = {
  LangGraph: 'langgraph',
  LangChain: 'langchain',
  CrewAI: 'crewai',
  GoogleADK: 'google-adk',
  OpenAIAgents: 'openai-agents',
  Anthropic: 'anthropic',
  Strands: 'strands',
  /** A plain application that serves the agent HTTP contract itself. */
  Python: 'python',
} as const;

export type AgentFramework = (typeof AgentFramework)[keyof typeof AgentFramework];

/** Protocols an agent can expose. */
export const AgentProtocol = {
  /** Plain HTTP invoke and stream endpoints. */
  Http: 'http',
  /** Agent-to-agent protocol, for interoperating with other agents. */
  A2A: 'a2a',
  /** Model Context Protocol, for exposing tools. */
  MCP: 'mcp',
} as const;

export type AgentProtocol = (typeof AgentProtocol)[keyof typeof AgentProtocol];

/** Build states after which nothing further changes. */
const TERMINAL_BUILD_STATES: ReadonlySet<string> = new Set([
  AgentBuildStatus.Completed,
  AgentBuildStatus.Failed,
]);

/** True when an agent build has reached a state it will not leave. */
export function isTerminalAgentBuildStatus(status: string): boolean {
  return TERMINAL_BUILD_STATES.has(status);
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

/**
 * One capability an agent advertises.
 *
 * Skills let other agents discover what this one can do and how to call it.
 */
export interface AgentSkill {
  /** Stable identifier, unique within the agent. */
  id: string;
  /** Human-readable name. */
  name: string;
  description?: string;
  /** Free-form labels for discovery. */
  tags?: string[];
  /** Example prompts that exercise the skill. */
  examples?: string[];
  /** Accepted media types, for example `text/plain`. */
  inputModes?: string[];
  /** Produced media types. */
  outputModes?: string[];
  /** Security schemes a caller must satisfy. */
  securityRequirements?: Record<string, string[]>[];
}

/** Optional protocol features an agent supports. */
export interface AgentCapabilities {
  /** Incremental responses over a stream. */
  streaming?: boolean;
  /** Server-initiated notifications. */
  pushNotifications?: boolean;
  /** Exposes the history of a task's state changes. */
  stateTransitionHistory?: boolean;
  /** Serves an extended card with additional detail to authorized callers. */
  extendedAgentCard?: boolean;
}

/** Public description of an agent, served at its agent-card URL. */
export interface AgentCard {
  name: string;
  description: string;
  version?: string;
  skills?: AgentSkill[];
  capabilities?: AgentCapabilities;
  /** Media types accepted when a skill does not override them. */
  defaultInputModes?: string[];
  /** Media types produced when a skill does not override them. */
  defaultOutputModes?: string[];
}

/**
 * Serialize a skill.
 *
 * The agent card is defined by an open interoperability specification that
 * uses camelCase on the wire, so these keys pass through unchanged.
 */
export function serializeAgentSkill(skill: AgentSkill): Record<string, unknown> {
  const out: Record<string, unknown> = { id: skill.id, name: skill.name };
  if (skill.description) out['description'] = skill.description;
  if (skill.tags?.length) out['tags'] = skill.tags;
  if (skill.examples?.length) out['examples'] = skill.examples;
  if (skill.inputModes?.length) out['inputModes'] = skill.inputModes;
  if (skill.outputModes?.length) out['outputModes'] = skill.outputModes;
  if (skill.securityRequirements?.length) {
    out['securityRequirements'] = skill.securityRequirements;
  }
  return out;
}

/** Serialize capabilities, omitting anything not enabled. */
export function serializeAgentCapabilities(
  capabilities: AgentCapabilities = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (capabilities.streaming) out['streaming'] = true;
  if (capabilities.pushNotifications) out['pushNotifications'] = true;
  if (capabilities.stateTransitionHistory) out['stateTransitionHistory'] = true;
  if (capabilities.extendedAgentCard) out['extendedAgentCard'] = true;
  return out;
}

/** Serialize an agent card for the deploy request. */
export function serializeAgentCard(card: AgentCard): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: card.name,
    description: card.description,
  };
  if (card.version) out['version'] = card.version;
  if (card.skills?.length) out['skills'] = card.skills.map(serializeAgentSkill);
  // Always present, so a consumer can rely on the key existing.
  out['capabilities'] = serializeAgentCapabilities(card.capabilities);
  if (card.defaultInputModes?.length) out['defaultInputModes'] = card.defaultInputModes;
  if (card.defaultOutputModes?.length) out['defaultOutputModes'] = card.defaultOutputModes;
  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Resource and runtime settings baked into an agent image. */
export interface AgentBuildConfig {
  /** Name of the agent. Required. */
  name: string;
  description?: string;
  /** Module or callable the host imports to find the agent. */
  entrypoint?: string;
  /** Interpreter version to install, for example `3.12`. */
  pythonVersion?: string;
  /** One of {@link AgentFramework}. */
  framework?: string;
  /** Ports the agent listens on. Defaults to `[8000]`. */
  ports?: number[];
  vcpuCount?: number;
  memoryMb?: number;
  diskMb?: number;
  /** Environment variables available to the agent. */
  environment?: Record<string, string>;
  /** Command that starts the agent, when the default is not suitable. */
  startCmd?: string;
  /** Command polled until the agent is ready to serve. */
  readyCmd?: string;
  readyTimeoutSeconds?: number;
  /** Labels used to organize agents. */
  tags?: Record<string, string>;
}

/** Default port an agent serves on when none is given. */
export const DEFAULT_AGENT_PORT = 8000;

/** Serialize the build metadata that accompanies the uploaded archive. */
export function serializeAgentBuildConfig(config: AgentBuildConfig): Record<string, unknown> {
  const ports = config.ports?.length ? config.ports : [DEFAULT_AGENT_PORT];

  return compact({
    name: config.name,
    description: config.description || undefined,
    entrypoint: config.entrypoint || undefined,
    python_version: config.pythonVersion || undefined,
    framework: config.framework || undefined,
    ports,
    vcpu_count: config.vcpuCount || undefined,
    memory_mb: config.memoryMb || undefined,
    disk_mb: config.diskMb || undefined,
    environment: Object.keys(config.environment ?? {}).length ? config.environment : undefined,
    start_cmd: config.startCmd || undefined,
    ready_cmd: config.readyCmd || undefined,
    ready_timeout_secs: config.readyTimeoutSeconds || undefined,
    tags: Object.keys(config.tags ?? {}).length ? config.tags : undefined,
  });
}

/** Acknowledgement that an agent build was accepted. */
export interface AgentBuildResponse {
  buildId: string;
  templateId: string;
  status: string;
  message: string;
}

export function parseAgentBuildResponse(data: Record<string, unknown>): AgentBuildResponse {
  return {
    buildId: str(data, 'build_id'),
    templateId: str(data, 'template_id'),
    status: str(data, 'status'),
    message: str(data, 'message'),
  };
}

/** Progress of an agent build. */
export interface AgentBuildStatusResponse {
  buildId: string;
  templateId: string;
  /** One of {@link AgentBuildStatus}. */
  status: string;
  /** One of {@link AgentBuildPhase}. */
  phase: string;
  progressPercent: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export function parseAgentBuildStatus(data: Record<string, unknown>): AgentBuildStatusResponse {
  const status: AgentBuildStatusResponse = {
    buildId: str(data, 'build_id'),
    templateId: str(data, 'template_id'),
    status: str(data, 'status'),
    phase: str(data, 'phase'),
    progressPercent: num(data, 'progress_percent'),
  };
  const error = optStr(data, 'error');
  if (error !== undefined) status.error = error;
  const startedAt = optStr(data, 'started_at');
  if (startedAt !== undefined) status.startedAt = startedAt;
  const completedAt = optStr(data, 'completed_at');
  if (completedAt !== undefined) status.completedAt = completedAt;
  return status;
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

/** Settings applied when a built agent image is deployed. */
export interface AgentDeployConfig {
  /** One of {@link AgentFramework}. */
  framework?: string;
  /** Module or callable the host imports to find the agent. */
  entryPoint?: string;
  /** Port the HTTP interface listens on. */
  httpPort?: number;
  /** Port the agent-to-agent interface listens on. */
  a2aPort?: number;
  /** Port the tool interface listens on. */
  mcpPort?: number;
  /** Protocols to expose. See {@link AgentProtocol}. */
  protocols?: string[];
  /** True to serve the agent without authentication. */
  isPublic?: boolean;
  /** Environment variables available to the agent. */
  environment?: Record<string, string>;
  /** Seconds before the agent is automatically stopped. Omit to run indefinitely. */
  timeoutSeconds?: number;
  /** Public description served at the agent-card URL. */
  agentCard?: AgentCard;
}

/** Serialize the deploy request body. */
export function serializeAgentDeploy(
  templateId: string,
  config: AgentDeployConfig,
): Record<string, unknown> {
  const body = compact({
    template_id: templateId,
    framework: config.framework || undefined,
    entry_point: config.entryPoint || undefined,
    http_port: config.httpPort && config.httpPort > 0 ? config.httpPort : undefined,
    a2a_port: config.a2aPort || undefined,
    mcp_port: config.mcpPort || undefined,
    protocols: config.protocols?.length ? config.protocols : undefined,
    is_public: config.isPublic ? true : undefined,
    environment: Object.keys(config.environment ?? {}).length ? config.environment : undefined,
    timeout: config.timeoutSeconds || undefined,
  }) as Record<string, unknown>;

  if (config.agentCard) body['agent_card'] = serializeAgentCard(config.agentCard);
  return body;
}

/** Result of deploying an agent. */
export interface AgentDeployResponse {
  agentId: string;
  runtimeId: string;
  /** Public HTTP URL of the agent. */
  endpoint: string;
  /** Public agent-to-agent URL, when that protocol is enabled. */
  a2aEndpoint: string;
  /** Public tool-protocol URL, when that protocol is enabled. */
  mcpEndpoint: string;
  /** URL serving the agent card. */
  agentCardUrl: string;
  /** Private-network URL, usable from other workloads in the same network. */
  internalEndpoint: string;
  /** One of {@link AgentDeployStatus}. */
  status: string;
  /** One of {@link AgentDNSStatus}. */
  dnsStatus: string;
  name: string;
  framework: string;
  createdAt: string;
}

export function parseAgentDeployResponse(data: Record<string, unknown>): AgentDeployResponse {
  return {
    agentId: str(data, 'agent_id'),
    runtimeId: str(data, 'runtime_id'),
    endpoint: str(data, 'endpoint'),
    a2aEndpoint: str(data, 'a2a_endpoint'),
    mcpEndpoint: str(data, 'mcp_endpoint'),
    agentCardUrl: str(data, 'agent_card_url'),
    internalEndpoint: str(data, 'internal_endpoint'),
    status: str(data, 'status'),
    dnsStatus: str(data, 'dns_status'),
    name: str(data, 'name'),
    framework: str(data, 'framework'),
    createdAt: str(data, 'created_at'),
  };
}

/** Where and how to reach a deployed agent. */
export interface AgentEndpoint {
  agentId: string;
  /** Public HTTP URL. */
  endpoint: string;
  /** Private-network URL. */
  internalEndpoint: string;
  /** Protocol name to URL, for every protocol the agent exposes. */
  protocols: Record<string, string>;
  agentCardUrl: string;
  /** One of {@link AgentHealthStatus}. */
  health: string;
  /** One of {@link AgentDNSStatus}. */
  dnsStatus: string;
  name: string;
  framework: string;
  a2aEndpoint: string;
  mcpEndpoint: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function parseAgentEndpoint(data: Record<string, unknown>): AgentEndpoint {
  const protocols = strMap(data, 'protocols') ?? {};
  return {
    agentId: str(data, 'agent_id'),
    endpoint: str(data, 'endpoint'),
    internalEndpoint: str(data, 'internal_endpoint'),
    protocols,
    agentCardUrl: str(data, 'agent_card_url'),
    health: str(data, 'health'),
    dnsStatus: str(data, 'dns_status'),
    name: str(data, 'name'),
    framework: str(data, 'framework'),
    a2aEndpoint: str(data, 'a2a_endpoint') || (protocols['a2a'] ?? ''),
    mcpEndpoint: str(data, 'mcp_endpoint') || (protocols['mcp'] ?? ''),
    status: str(data, 'status'),
    createdAt: str(data, 'created_at'),
    updatedAt: str(data, 'updated_at'),
  };
}

/** Result of destroying an agent. */
export interface AgentDestroyResponse {
  agentId: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/** Body sent to a deployed agent's invoke and stream endpoints. */
export interface AgentInvokeParams {
  /** The request payload. Its shape is defined by the agent. */
  input?: unknown;
  /** Conversation identifier, so the agent can keep context across turns. */
  sessionId?: string;
  /** Caller-supplied metadata forwarded to the agent. */
  metadata?: Record<string, unknown>;
  /** Value that continues an agent paused awaiting input. */
  resume?: unknown;
}

/** Serialize an invocation body, omitting anything not supplied. */
export function serializeAgentInvoke(params: AgentInvokeParams): Record<string, unknown> {
  return compact({
    input: params.input,
    session_id: params.sessionId,
    resume: params.resume,
    metadata: params.metadata,
  }) as Record<string, unknown>;
}

/** Framework aliases accepted for convenience, mapped to canonical names. */
const FRAMEWORK_ALIASES: Record<string, string> = {
  openai: AgentFramework.OpenAIAgents,
  claude: AgentFramework.Anthropic,
  'claude-agent': AgentFramework.Anthropic,
  'claude-agent-sdk': AgentFramework.Anthropic,
  'strands-agents': AgentFramework.Strands,
};

/** Names that describe a protocol rather than a framework. */
const PROTOCOL_NOT_FRAMEWORK: ReadonlySet<string> = new Set(['a2a', 'a2a-native']);

/**
 * Normalize a framework name to its canonical form.
 *
 * Underscores become hyphens and a few common aliases are accepted, so
 * `google_adk`, `claude`, and `strands-agents` all resolve correctly.
 */
export function normalizeFramework(framework: string): string {
  const normalized = framework.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === '') return '';

  if (PROTOCOL_NOT_FRAMEWORK.has(normalized)) {
    throw new GravixLayerInvalidArgumentError(
      'Agent-to-agent is a protocol, not a framework. Choose a framework such as ' +
        '`langgraph`, `langchain`, `google-adk`, or `python`, and enable the `a2a` ' +
        'protocol separately.',
    );
  }

  return FRAMEWORK_ALIASES[normalized] ?? normalized;
}

/** Read a list of ports from a payload, ignoring anything that is not a port. */
export function readPorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}
