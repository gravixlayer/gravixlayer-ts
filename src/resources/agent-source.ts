/**
 * Reading an agent project so it can be built.
 *
 * Everything here is inference: given a project directory, work out which
 * framework it uses, which interpreter version it wants, which port it will
 * listen on, and what command should start it. Every inferred value is a
 * default that an explicit option overrides.
 */

import { readTextFileIfPresent } from '../core/fs.js';
import { AgentFramework, DEFAULT_AGENT_PORT, normalizeFramework } from '../types/agents.js';

/** What could be learned about a project by reading its files. */
export interface InferredAgentSource {
  /** Canonical framework name, empty when nothing recognizable was found. */
  framework: string;
  /** Interpreter version, for example `3.12`. */
  pythonVersion: string;
  /** Ports the project is expected to listen on. */
  ports: number[];
  /** Import path of the object the host should serve. */
  target: string;
}

/** Frameworks the platform can start without a custom command. */
const SELF_SERVING_FRAMEWORKS: ReadonlySet<string> = new Set([
  AgentFramework.LangGraph,
  AgentFramework.LangChain,
  AgentFramework.GoogleADK,
]);

/**
 * Command prefix for the hosted agent runtime.
 *
 * Invoked as a module so it resolves through the same interpreter that
 * installed the runtime package, with no shell wrapper and no reliance on the
 * executable being on `PATH`.
 */
const RUNTIME_COMMAND = ['python', '-m', 'gravixlayer.runtime.autoserve'];

/** Dependency names that identify a framework, most specific first. */
const FRAMEWORK_BY_DEPENDENCY: ReadonlyArray<readonly [string, string]> = [
  ['langgraph', AgentFramework.LangGraph],
  ['crewai', AgentFramework.CrewAI],
  ['google-adk', AgentFramework.GoogleADK],
  ['openai-agents', AgentFramework.OpenAIAgents],
  ['strands-agents', AgentFramework.Strands],
  ['claude-agent-sdk', AgentFramework.Anthropic],
];

/** Dependencies worth looking for in a project file that is not a plain list. */
const KNOWN_DEPENDENCIES: readonly string[] = [
  'langgraph',
  'langchain',
  'langchain-core',
  'crewai',
  'google-adk',
  'openai-agents',
  'anthropic',
  'claude-agent-sdk',
  'strands-agents',
];

/** Reduce a requirement line such as `langchain-core>=0.3,<0.4` to its name. */
function dependencyName(specifier: string): string {
  const [head = ''] = specifier.trim().split('[');
  const name = head.split(/[<>=!~; ]/)[0] ?? '';
  return name.toLowerCase().replace(/_/g, '-');
}

/** Collect the dependency names a project declares. */
async function readDependencies(directory: string): Promise<Set<string>> {
  const found = new Set<string>();

  const requirements = await readTextFileIfPresent(`${directory}/requirements.txt`);
  if (requirements) {
    for (const line of requirements.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const name = dependencyName(trimmed);
      if (name) found.add(name);
    }
  }

  // A project file can express dependencies many ways, so rather than parse it
  // fully, look for the names that would change the outcome.
  const projectFile = await readTextFileIfPresent(`${directory}/pyproject.toml`);
  if (projectFile) {
    const lowered = projectFile.toLowerCase();
    for (const dependency of KNOWN_DEPENDENCIES) {
      if (lowered.includes(dependency)) found.add(dependency);
    }
  }

  return found;
}

/** Pick a framework from a project's dependencies. */
function frameworkFromDependencies(dependencies: ReadonlySet<string>): string {
  for (const [dependency, framework] of FRAMEWORK_BY_DEPENDENCY) {
    if (dependencies.has(dependency)) return framework;
  }
  for (const dependency of dependencies) {
    if (dependency === 'langchain' || dependency.startsWith('langchain-')) {
      return AgentFramework.LangChain;
    }
  }
  return AgentFramework.Python;
}

/** Read the graph configuration a LangGraph project ships, when present. */
async function readGraphConfig(
  directory: string,
): Promise<{ pythonVersion?: string; target?: string } | undefined> {
  const raw = await readTextFileIfPresent(`${directory}/langgraph.json`);
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;

  const config = parsed as Record<string, unknown>;
  const result: { pythonVersion?: string; target?: string } = {};

  const version = String(config['python_version'] ?? '').trim();
  if (version) result.pythonVersion = version.split('.').slice(0, 2).join('.');

  const graphs = config['graphs'];
  if (graphs !== null && typeof graphs === 'object' && !Array.isArray(graphs)) {
    const entries = graphs as Record<string, unknown>;
    const selected = 'agent' in entries ? entries['agent'] : Object.values(entries)[0];
    const target =
      typeof selected === 'string'
        ? selected.trim()
        : selected !== null && typeof selected === 'object'
          ? String((selected as Record<string, unknown>)['path'] ?? '').trim()
          : '';
    if (target) result.target = target;
  }

  return result;
}

/**
 * Read a project directory and infer how it should be built.
 *
 * Never throws for a missing or malformed file: anything that cannot be read
 * simply contributes nothing.
 */
export async function inferAgentSource(directory: string): Promise<InferredAgentSource> {
  const inferred: InferredAgentSource = {
    framework: '',
    pythonVersion: '',
    ports: [],
    target: '',
  };

  const graphConfig = await readGraphConfig(directory);
  if (graphConfig) {
    inferred.framework = AgentFramework.LangGraph;
    if (graphConfig.pythonVersion) inferred.pythonVersion = graphConfig.pythonVersion;
    if (graphConfig.target) inferred.target = graphConfig.target;
  }

  if (!inferred.framework) {
    inferred.framework = frameworkFromDependencies(await readDependencies(directory));
  }
  if (inferred.ports.length === 0 && SELF_SERVING_FRAMEWORKS.has(inferred.framework)) {
    inferred.ports = [DEFAULT_AGENT_PORT];
  }

  return inferred;
}

/**
 * Parse a `.env` file's contents.
 *
 * Accepts `KEY=VALUE` lines with optional quotes, and skips blanks and
 * comments. Nothing is written to the current process's environment.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;

    let value = trimmed.slice(separator + 1).trim();
    const first = value[0];
    if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

/** Read the environment files a project may ship, later files winning. */
export async function loadProjectEnv(directory: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  for (const path of [`${directory}/.env`, `${directory}/gravixlayer/.env.local`]) {
    const contents = await readTextFileIfPresent(path);
    if (contents) Object.assign(merged, parseDotEnv(contents));
  }

  return merged;
}

/** Return a usable ports list, falling back to the default. */
export function normalizePorts(ports: readonly number[] | undefined): number[] {
  return ports?.length ? [...ports] : [DEFAULT_AGENT_PORT];
}

/** Resolve the port the agent's HTTP interface should listen on. */
export function resolveHttpPort(httpPort: number | undefined, ports: readonly number[]): number {
  if (httpPort && httpPort > 0) return httpPort;
  for (const port of ports) {
    if (port > 0) return port;
  }
  return DEFAULT_AGENT_PORT;
}

/** Quote one shell argument, using single quotes so nothing is interpreted. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the command that starts an agent the platform knows how to serve.
 *
 * Returns an empty string for frameworks that must supply their own start
 * command, which tells the API to use whatever the project defines.
 */
export function autoserveEntrypoint(
  framework: string,
  ports: readonly number[],
  target = '',
  protocols: readonly string[] = [],
): string {
  const canonical = normalizeFramework(framework);
  if (!SELF_SERVING_FRAMEWORKS.has(canonical)) return '';

  const command = [
    ...RUNTIME_COMMAND,
    '--framework',
    canonical,
    '--root',
    '/app',
    '--host',
    '0.0.0.0',
    '--port',
    String(resolveHttpPort(0, ports)),
  ];

  const unique = [...new Set(protocols.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (unique.length > 0) command.push('--protocols', unique.join(','));
  if (canonical === AgentFramework.LangGraph && target) command.push('--target', target);

  return command.map(shellQuote).join(' ');
}
