/**
 * GravixLayer TypeScript SDK.
 *
 * ```ts
 * import { GravixLayer } from 'gravixlayer';
 *
 * const client = new GravixLayer();
 * const runtime = await client.runtimes.create();
 *
 * const result = await runtime.runCode('print("hello")');
 * console.log(result.stdout);
 *
 * await runtime.kill();
 * ```
 */

export { GravixLayer, type ClientOptions } from './client.js';
export { VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
  GravixLayerAbortError,
  GravixLayerAuthenticationError,
  GravixLayerBadRequestError,
  GravixLayerConnectionError,
  GravixLayerError,
  GravixLayerInvalidArgumentError,
  GravixLayerRateLimitError,
  GravixLayerServerError,
  GravixLayerTimeoutError,
  type GravixLayerErrorContext,
} from './core/errors.js';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type { FetchLike, RequestOptions } from './core/transport.js';
export type { BinaryLike } from './core/binary.js';
export type { FileMode } from './core/uploads.js';
export type { TarEntry } from './core/tar.js';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export {
  enableTelemetry,
  runtimeSpan,
  telemetryEnabled,
  trace,
  traced,
  type TraceOptions,
} from './core/telemetry.js';

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

export {
  Runtimes,
  RuntimeTemplates,
  type CodeCallbacks,
  type CodeStreamEvent,
  type CommandCallbacks,
  type CommandStreamEvent,
  type CreateContextOptions,
  type CreateRuntimeOptions,
  type ListRuntimesOptions,
  type RunCodeOptions,
  type RunCommandOptions,
} from './resources/runtimes/runtimes.js';

export {
  BoundFiles,
  BoundGit,
  BoundPty,
  BoundServices,
  Runtime,
} from './resources/runtimes/runtime.js';

export {
  DEFAULT_WORKING_DIR,
  RuntimeFiles,
  type ChownOptions,
  type CopyOptions,
  type CreateDirectoryOptions,
  type FindOptions,
  type MoveOptions,
  type ReplaceOptions,
  type UploadOptions,
  type WatchOptions,
  type WriteEntry,
  type WriteManyOptions,
} from './resources/runtimes/files.js';

export {
  PtyHandle,
  PTY_BUFFER_LIMIT_BYTES,
  RuntimePty,
  type CreatePtyOptions,
  type PtyHandleCallbacks,
  type PtyStreamEvent,
} from './resources/runtimes/pty.js';

export {
  RuntimeGit,
  type BranchScope,
  type GitCloneOptions,
  type GitCommitOptions,
  type GitFetchOptions,
  type GitPushOptions,
} from './resources/runtimes/git.js';

export {
  RuntimeServices,
  ServiceHandle,
  type PublishOptions,
  type ServiceRequestInit,
} from './resources/runtimes/services.js';

export {
  Execution,
  type ChangeOwnerResponse,
  type CodeContext,
  type CodeContextDeleteResponse,
  type CodeRunResponse,
  type CommandRunResponse,
  type DirectoryCreateResponse,
  type ExecutionError,
  type ExecutionLogs,
  type ExecutionResult,
  type FileCopyResponse,
  type FileDeleteResponse,
  type FileFindResponse,
  type FileGetInfoResponse,
  type FileInfo,
  type FileListResponse,
  type FileMoveResponse,
  type FileReadResponse,
  type FileReplaceEntry,
  type FileReplaceResponse,
  type FileSearchMatch,
  type FileUploadResponse,
  type FileWriteResponse,
  type GitOperationResult,
  type PtyInputResponse,
  type PtySession,
  type RuntimeInfo,
  type RuntimeKillResponse,
  type RuntimeList,
  type RuntimeMetrics,
  type RuntimeTimeoutResponse,
  type RuntimeWebService,
  type SetPermissionsResponse,
  type SSHInfo,
  type SSHStatus,
  type WatchEvent,
  type WriteFilesResponse,
  type WriteResult,
} from './types/runtime.js';

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export {
  Templates,
  TemplateBuildError,
  TemplateBuildTimeoutError,
  type BuildAndWaitOptions,
  type ListTemplatesOptions,
} from './resources/templates.js';

export {
  BuildStepType,
  TemplateBuilder,
  TemplateBuildPhase,
  TemplateBuildState,
  isSuccessfulBuildState,
  isTerminalBuildState,
  type AddFileOptions,
  type BuildLogEntry,
  type BuildStep,
  type TemplateBuildResponse,
  type TemplateBuildStatus,
  type TemplateDeleteResponse,
  type TemplateFileEntry,
  type TemplateGitCloneOptions,
  type TemplateInfo,
  type TemplateListResponse,
  type TemplateSnapshot,
} from './types/templates.js';

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export {
  Snapshots,
  type CreateSnapshotOptions,
  type ListSnapshotsOptions,
} from './resources/snapshots.js';

export {
  SnapshotKind,
  type Snapshot,
  type SnapshotDeleteResponse,
  type SnapshotListResponse,
} from './types/snapshots.js';

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export {
  Agents,
  AgentBuildError,
  AgentBuildTimeoutError,
  type AgentSource,
  type BuildAgentOptions,
  type DeployAgentOptions,
  type ListAgentTemplatesOptions,
  type WaitForBuildOptions,
} from './resources/agents.js';

export {
  AgentBuildPhase,
  AgentBuildStatus,
  AgentDeployStatus,
  AgentDNSStatus,
  AgentFramework,
  AgentHealthStatus,
  AgentProtocol,
  DEFAULT_AGENT_PORT,
  isTerminalAgentBuildStatus,
  normalizeFramework,
  type AgentBuildConfig,
  type AgentBuildResponse,
  type AgentBuildStatusResponse,
  type AgentCapabilities,
  type AgentCard,
  type AgentDeployConfig,
  type AgentDeployResponse,
  type AgentDestroyResponse,
  type AgentEndpoint,
  type AgentInvokeParams,
  type AgentSkill,
} from './types/agents.js';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export {
  Identity,
  SecretProviders,
  type CreateProviderOptions,
  type ListProvidersOptions,
  type SecretInput,
  type UpdateProviderOptions,
  type UpdateSecretOptions,
} from './resources/identity.js';

export type {
  SecretInfo,
  SecretList,
  SecretProvider,
  SecretProviderList,
} from './types/secret-providers.js';

// ---------------------------------------------------------------------------
// Network policies
// ---------------------------------------------------------------------------

export {
  NetworkPolicies,
  type AddRuleOptions,
  type CreateNetworkPolicyOptions,
  type ListNetworkPoliciesOptions,
  type NetworkRuleInput,
  type ProjectScopedOptions,
  type UpdateNetworkPolicyOptions,
  type UpdateRuleOptions,
} from './resources/network-policies.js';

export {
  EGRESS_MODES,
  EgressMode,
  isSystemDefaultPolicy,
  PROTOCOLS,
  Protocol,
  SYSTEM_DEFAULT_POLICY_NAME,
  type NetworkPolicy,
  type NetworkPolicyList,
  type NetworkPolicyRule,
  type NetworkPolicyRuleList,
  type SuccessResponse,
} from './types/network-policies.js';
