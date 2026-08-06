import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { getSessionById } from "./sessions.js";
import { isLegacyWrenStandardRuntime } from "./legacy-wren.js";
import {
  getProtectedArtifactReadRoots,
  getProtectedArtifactWriteRoots,
  getRestrictedAgentArtifactRoots,
  getSessionAttachmentRoot,
} from "./protected-artifacts.js";
import {
  authorizeProjectAction,
  canonicalizePolicyPath,
  pathIsWithin,
  projectAllowsAgentProfile,
} from "./policy.js";
import { listProjects } from "./projects.js";
import { type AgentProfileRow, type ProjectRow } from "./workspace-types.js";
import { WAYANG_RUNTIME_CONTEXT_TOOL_NAME } from "./wayang-runtime-context.js";
import { WAYANG_WORKSPACE_CHANGE_TOOL_NAME, WAYANG_WORKSPACE_READ_TOOL_NAME } from "./workspace-control.js";
import { RESTRICTED_MCP_TOOL_NAME, type RestrictedMcpRuntime } from "./restricted-mcp/index.js";
import { PROTECTED_BROWSER_TOOL_NAME, type ProtectedBrowserToolRuntime } from "./browser/protected-tools.js";
import { PROTECTED_AUTOMATION_TOOL_NAME, type ProtectedAutomationToolRuntime } from "./protected-automation/tool.js";
import {
  isSessionCapabilityEligible,
  resolveWorkspaceCapability,
  type WorkspaceCapabilityResolution,
} from "./workspace-capabilities.js";

export const STANDARD_RESOURCES_CAPABILITY_ID = "wayang.standard-resources.v1" as const;

export const WAYANG_INTERACTIVE_COMMUNICATION_APPENDIX = `## Wayang interactive communication

For substantive work, acknowledge the request before extended reasoning or tool use. During longer work, provide concise user-visible checkpoints when there are material findings, decisions, blockers, or useful opportunities to steer; do not narrate every command or add ceremony to quick mechanical tasks. Share conclusions and decision rationale, never hidden chain-of-thought.`;

function interactiveCommunicationAppendix(sourceSessionId: string | undefined): string[] {
  if (!sourceSessionId) return [];
  const row = getSessionById(sourceSessionId);
  return row && row.scheduled_job_id === null && row.scheduled_run_id === null
    ? [WAYANG_INTERACTIVE_COMMUNICATION_APPENDIX]
    : [];
}

export interface ExactStandardResourcesWitness {
  readonly capabilityId: typeof STANDARD_RESOURCES_CAPABILITY_ID;
  readonly projectId: string;
  readonly agentProfileId: string;
  readonly associationRevision: number;
  /** Omitted for a durable capability association. */
  readonly authoritySource?: "legacy-wren";
}

function standardResourcesWitnessFromResolution(
  resolution: WorkspaceCapabilityResolution,
): ExactStandardResourcesWitness | null {
  if (!resolution.authorized || resolution.capability.id !== STANDARD_RESOURCES_CAPABILITY_ID) return null;
  const { association, project, profile } = resolution;
  if (!association.active) return null;
  return Object.freeze({
    capabilityId: STANDARD_RESOURCES_CAPABILITY_ID,
    projectId: project.id,
    agentProfileId: profile.id,
    associationRevision: association.revision,
  });
}

function exactStandardResourcesWitnessEqual(left: ExactStandardResourcesWitness, right: ExactStandardResourcesWitness): boolean {
  return left.capabilityId === right.capabilityId
    && left.projectId === right.projectId
    && left.agentProfileId === right.agentProfileId
    && left.associationRevision === right.associationRevision
    && left.authoritySource === right.authoritySource;
}

function resolveCurrentStandardResourcesWitness(options: {
  sourceSessionId: string;
  project: ProjectRow;
  agentProfile: AgentProfileRow;
}): ExactStandardResourcesWitness | null {
  const row = getSessionById(options.sourceSessionId);
  if (!row || !isSessionCapabilityEligible(row) || row.pending_agent_switch !== null
    || row.agent_profile_id !== options.agentProfile.id || row.cwd !== options.project.cwd) return null;
  const associated = standardResourcesWitnessFromResolution(resolveWorkspaceCapability({
    capability_id: STANDARD_RESOURCES_CAPABILITY_ID,
    project_id: options.project.id,
    agent_profile_id: options.agentProfile.id,
  }));
  if (associated) return associated;
  return isLegacyWrenStandardRuntime({
    session: row,
    profile: options.agentProfile,
    project: options.project,
  }) ? Object.freeze({
      capabilityId: STANDARD_RESOURCES_CAPABILITY_ID,
      projectId: options.project.id,
      agentProfileId: options.agentProfile.id,
      associationRevision: 1,
      authoritySource: "legacy-wren" as const,
    }) : null;
}

export const RESTRICTED_BUILTIN_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "bash"] as const;
const RESTRICTED_BUILTIN_TOOL_SET = new Set<string>(RESTRICTED_BUILTIN_TOOLS);
const READ_PATH_TOOLS = new Set(["read", "grep", "find", "ls"]);
const RECURSIVE_PATH_TOOLS = new Set(["grep", "find", "ls"]);
const MUTATION_PATH_TOOLS = new Set(["edit", "write"]);
const SUBAGENT_TOOLS = new Set(["subagent", "subagent_spawn", "agent_team_spawn", "agent_teams"]);

function isSubagentToolName(name: string): boolean {
  const normalized = normalizeToolName(name);
  return SUBAGENT_TOOLS.has(normalized)
    || normalized.includes("subagent")
    || normalized.startsWith("agent_team")
    || normalized.startsWith("team_spawn");
}

export type MemoryToolCapability = "read" | "mutation" | null;

const MEMORY_READ_TOOLS = new Set([
  "mempalace_status",
  "mempalace_taxonomy",
  "mempalace_list_taxonomy",
  "mempalace_kg_query",
  "mempalace_knowledge_graph_query",
  "mempalace_timeline",
  "mempalace_stats",
  "mempalace_traverse",
  "mempalace_traversal",
  "mempalace_tunnels",
  "mempalace_semantic_search",
  "mempalace_duplicate_check",
  "mempalace_diary_read",
  "memoriki_search",
  "memoriki_read",
]);
const MEMORY_MUTATION_TOOLS = new Set([
  "mempalace_kg_add",
  "mempalace_knowledge_graph_add",
  "mempalace_kg_invalidate",
  "mempalace_knowledge_graph_invalidate",
  "mempalace_drawer_add",
  "mempalace_drawer_delete",
  "mempalace_diary_write",
  "memoriki_write",
  "memoriki_capture",
]);

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function classifyMemoryTool(name: string): MemoryToolCapability {
  const normalized = normalizeToolName(name);
  const candidates = [normalized, normalized.replace(/^(?:mcp|tool)_/, "")];
  if (candidates.some((candidate) => MEMORY_READ_TOOLS.has(candidate))) return "read";
  if (candidates.some((candidate) => MEMORY_MUTATION_TOOLS.has(candidate))) return "mutation";
  return null;
}

export function getRegisteredMemoryRoots(): string[] {
  const configured = (process.env.WAYANG_MEMORY_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const defaults = [path.join(os.homedir(), "src", "memoriki")];
  return [...new Set([...configured, ...defaults].map((root) => path.resolve(root)))];
}

function canonicalMemoryRoot(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

export interface ToolAuthorizationDecision {
  allowed: boolean;
  reason?: string;
  canonicalPath?: string;
}

export function authorizeAgentToolCall(options: {
  cwd: string;
  project: ProjectRow;
  agentProfile: AgentProfileRow;
  toolName: string;
  params: unknown;
  memoryRoots?: string[];
  /** Trusted Wayang row id; only the live runtime supplies this. */
  sourceSessionId?: string;
  /** Exact current standard-resources authorization, never profile intent. */
  standardResourcesAuthorized?: boolean;
}): ToolAuthorizationDecision {
  const { agentProfile, project } = options;
  const toolName = normalizeToolName(options.toolName);
  const restricted = options.standardResourcesAuthorized !== true;

  if (project.access_policy.privacy_mode === "protected" && isSubagentToolName(toolName)) {
    return { allowed: false, reason: "Subagent tools are unavailable in protected projects" };
  }

  // Restricted profiles may use `mcp` only through the exact backend-issued
  // source-bound runtime object checked below by the installed live guard.
  // Exact standard-resources-authorized profiles retain Pi's ordinary MCP
  // adapter; reserving the name for every profile would regress normal global
  // extension access.
  if (toolName === RESTRICTED_MCP_TOOL_NAME) {
    return restricted
      ? { allowed: false, reason: "The restricted MCP proxy requires a source-bound runtime object" }
      : { allowed: true };
  }
  if (toolName === PROTECTED_BROWSER_TOOL_NAME) {
    return { allowed: false, reason: "The protected browser requires its exact source-bound runtime object" };
  }
  if (toolName === PROTECTED_AUTOMATION_TOOL_NAME) {
    return { allowed: false, reason: "Protected automation requires its exact source-bound runtime object" };
  }

  // This SDK-injected tool is immutable, read-only, and session-bound. It is
  // intentionally available even when restricted profiles reject all other
  // unknown/custom tools.
  if (toolName === WAYANG_RUNTIME_CONTEXT_TOOL_NAME) return { allowed: true };

  // These immutable SDK-owned control-plane tools are Standard-only. They are
  // excluded before restricted runtime construction and denied again here if a
  // later extension or active-tool refresh attempts to manufacture either name.
  if (toolName === WAYANG_WORKSPACE_READ_TOOL_NAME || toolName === WAYANG_WORKSPACE_CHANGE_TOOL_NAME) {
    return restricted
      ? { allowed: false, reason: "Workspace control tools are unavailable for restricted agents" }
      : { allowed: true };
  }

  const memoryCapability = classifyMemoryTool(toolName);
  if (memoryCapability) {
    if (agentProfile.memory_access === "none") return { allowed: false, reason: "Memory tools are disabled for this agent" };
    if (memoryCapability === "mutation" && agentProfile.memory_access !== "read_write") {
      return { allowed: false, reason: "Memory mutations are disabled for this agent" };
    }
    return { allowed: true };
  }

  const isRead = READ_PATH_TOOLS.has(toolName);
  const isMutation = MUTATION_PATH_TOOLS.has(toolName);
  if (restricted && !RESTRICTED_BUILTIN_TOOL_SET.has(toolName)) {
    return { allowed: false, reason: `Tool ${options.toolName} is not classified for restricted agents` };
  }
  if (!isRead && !isMutation) return { allowed: true };

  const rawPath = (options.params as Record<string, unknown> | undefined)?.path;
  const target = typeof rawPath === "string" && rawPath.trim() ? rawPath : options.cwd;
  let canonicalPath: string;
  try {
    canonicalPath = canonicalizePolicyPath(target, { cwd: options.cwd, forMutation: isMutation });
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const traverses = RECURSIVE_PATH_TOOLS.has(toolName);
  const intersects = (root: string): boolean => (
    pathIsWithin(canonicalPath, root) || (traverses && pathIsWithin(root, canonicalPath))
  );

  // Wayang state and Pi transcripts are backend-owned. The sole direct-tool
  // exception is read access to this exact source session's upload subtree.
  const ownAttachmentRoot = options.sourceSessionId
    ? getSessionAttachmentRoot(options.sourceSessionId)
    : undefined;
  const inOwnAttachments = Boolean(ownAttachmentRoot && pathIsWithin(canonicalPath, ownAttachmentRoot));
  if (isMutation) {
    if (getProtectedArtifactWriteRoots().some((root) => pathIsWithin(canonicalPath, root))) {
      return { allowed: false, reason: "Agent writes to protected transcript/Wayang/attachment storage are denied", canonicalPath };
    }
  } else if (!inOwnAttachments && getProtectedArtifactReadRoots().some(intersects)) {
    return { allowed: false, reason: "Agent access to protected transcript/Wayang/attachment storage is denied", canonicalPath };
  }

  if (restricted && !(inOwnAttachments && !isMutation) && getRestrictedAgentArtifactRoots().some(intersects)) {
    return { allowed: false, reason: "Restricted agents cannot access global Pi or control-plane storage", canonicalPath };
  }

  const projectPiRoot = canonicalMemoryRoot(path.join(project.cwd, ".pi"));
  if (restricted && isMutation && pathIsWithin(canonicalPath, projectPiRoot)) {
    return { allowed: false, reason: "Restricted agents cannot modify project-local Pi control-plane files", canonicalPath };
  }

  const memoryRoots = (options.memoryRoots ?? getRegisteredMemoryRoots()).map(canonicalMemoryRoot);
  const memoryRoot = memoryRoots.find(intersects);
  if (memoryRoot) {
    if (agentProfile.memory_access === "none") {
      return { allowed: false, reason: "This agent cannot access registered memory roots", canonicalPath };
    }
    if (isMutation && agentProfile.memory_access !== "read_write") {
      return { allowed: false, reason: "This agent has read-only memory access", canonicalPath };
    }
  }

  const sourceProtected = project.access_policy.privacy_mode === "protected";
  if (restricted && (!sourceProtected || isMutation)) {
    const canonicalProjectRoot = canonicalMemoryRoot(project.cwd);
    const inProject = pathIsWithin(canonicalPath, canonicalProjectRoot);
    const inPermittedMemory = Boolean(memoryRoot && pathIsWithin(canonicalPath, memoryRoot));
    const inPermittedAttachments = !isMutation && inOwnAttachments;
    if (!inProject && !inPermittedMemory && !inPermittedAttachments) {
      return {
        allowed: false,
        reason: sourceProtected
          ? "Protected agents may write only their project and permitted memory roots"
          : "Restricted agents are confined to their project, permitted memory roots, and own attachments",
        canonicalPath,
      };
    }
  }

  for (const targetProject of listProjects().filter((candidate) => intersects(candidate.cwd))) {
    if (targetProject.access_policy.privacy_mode === "protected" && targetProject.id !== project.id) {
      return { allowed: false, reason: "Agents outside a Protected project cannot access its path", canonicalPath };
    }
    const protectedReadFromStandard = sourceProtected && isRead
      && targetProject.access_policy.privacy_mode === "standard";
    if (!protectedReadFromStandard && !projectAllowsAgentProfile(targetProject, agentProfile.id)) {
      return { allowed: false, reason: "Agent is not allowed to access the project path", canonicalPath };
    }
  }

  return { allowed: true, canonicalPath };
}

export interface StandardResourcesRuntimeFence {
  runtimeGeneration: string;
  processBootNonce: string;
  /** Backend-owned current-handle check; false is permanent for this wrapper. */
  isCurrent(): boolean;
}

interface LiveToolDecisionOptions {
  candidateTool?: unknown;
  restrictedMcpRuntime?: RestrictedMcpRuntime;
  trustedRestrictedMcpTool?: unknown;
  skipRestrictedMcpPreflight?: boolean;
  standardResourcesWitness?: ExactStandardResourcesWitness;
  standardResourcesRuntimeFence?: StandardResourcesRuntimeFence;
  protectedBrowserRuntime?: ProtectedBrowserToolRuntime;
  trustedProtectedBrowserTool?: unknown;
  protectedAutomationRuntime?: ProtectedAutomationToolRuntime;
  trustedProtectedAutomationTool?: unknown;
}

function exactTrustedToolObject(candidate: unknown, trusted: unknown): boolean {
  const isToolObject = (value: unknown): value is object => value !== null
    && (typeof value === "object" || typeof value === "function");
  return isToolObject(candidate) && isToolObject(trusted) && candidate === trusted;
}

const driftClosedPrivilegedRuntimes = new WeakSet<object>();

function closeRuntimeOnToolObjectDrift(runtime: { close(): Promise<void> } | undefined): void {
  if (!runtime || driftClosedPrivilegedRuntimes.has(runtime)) return;
  driftClosedPrivilegedRuntimes.add(runtime);
  try { void runtime.close().catch(() => undefined); }
  catch { /* the failed-closed decision remains authoritative */ }
}

function liveToolDecision(
  sessionId: string,
  toolName: string,
  params: unknown,
  options: LiveToolDecisionOptions = {},
): ToolAuthorizationDecision {
  const row = getSessionById(sessionId);
  if (!row) return { allowed: false, reason: "Wayang session no longer exists" };
  const normalizedToolName = normalizeToolName(toolName);
  const scheduled = row.scheduled_job_id !== null || row.scheduled_run_id !== null;
  const workspaceControl = normalizedToolName === WAYANG_WORKSPACE_READ_TOOL_NAME || normalizedToolName === WAYANG_WORKSPACE_CHANGE_TOOL_NAME;
  if (workspaceControl && scheduled) {
    return { allowed: false, reason: "Workspace control tools are unavailable for scheduled sessions" };
  }
  if (normalizedToolName === RESTRICTED_MCP_TOOL_NAME && scheduled && options.restrictedMcpRuntime) {
    return { allowed: false, reason: "The restricted MCP proxy is unavailable for scheduled sessions" };
  }
  if (workspaceControl && (typeof row.agent_profile_id !== "string" || !row.agent_profile_id)) {
    return { allowed: false, reason: "Workspace control source profile is missing" };
  }
  const authorization = authorizeProjectAction({ cwd: row.cwd, actor: "interactive", agentProfileId: row.agent_profile_id });
  if (!authorization.allowed || !authorization.project || !authorization.agentProfile) {
    return { allowed: false, reason: authorization.reason ?? "Session is no longer authorized" };
  }

  if (normalizedToolName === PROTECTED_BROWSER_TOOL_NAME) {
    if (!options.protectedBrowserRuntime
      || !exactTrustedToolObject(options.candidateTool, options.trustedProtectedBrowserTool)) {
      closeRuntimeOnToolObjectDrift(options.protectedBrowserRuntime);
      return { allowed: false, reason: "The protected browser tool object is not authorized for this runtime" };
    }
    try {
      const decision = options.protectedBrowserRuntime.preflight();
      return decision.allowed ? { allowed: true } : decision;
    } catch {
      return { allowed: false, reason: "Protected browser preflight is unavailable" };
    }
  }
  if (normalizedToolName === PROTECTED_AUTOMATION_TOOL_NAME) {
    if (!options.protectedAutomationRuntime
      || !exactTrustedToolObject(options.candidateTool, options.trustedProtectedAutomationTool)) {
      closeRuntimeOnToolObjectDrift(options.protectedAutomationRuntime);
      return { allowed: false, reason: "The protected automation tool object is not authorized for this runtime" };
    }
    try {
      const decision = options.protectedAutomationRuntime.preflight();
      return decision.allowed ? { allowed: true } : decision;
    } catch {
      return { allowed: false, reason: "Protected automation preflight is unavailable" };
    }
  }

  const expectedStandard = options.standardResourcesWitness;
  if (expectedStandard) {
    const runtimeFence = options.standardResourcesRuntimeFence;
    if (!runtimeFence || !runtimeFence.runtimeGeneration || !runtimeFence.processBootNonce) {
      return { allowed: false, reason: "Standard resource runtime identity is unavailable" };
    }
    try {
      if (!runtimeFence.isCurrent()) {
        return { allowed: false, reason: "Standard resource runtime generation is stale; a fresh runtime is required" };
      }
    } catch {
      return { allowed: false, reason: "Standard resource runtime identity is unavailable" };
    }
    const current = resolveCurrentStandardResourcesWitness({
      sourceSessionId: sessionId,
      project: authorization.project,
      agentProfile: authorization.agentProfile,
    });
    if (!current || !exactStandardResourcesWitnessEqual(current, expectedStandard)) {
      return { allowed: false, reason: "Standard resource authority was revoked or changed; a fresh runtime is required" };
    }
  }

  if (normalizedToolName === RESTRICTED_MCP_TOOL_NAME && options.restrictedMcpRuntime) {
    const runtime = options.restrictedMcpRuntime;
    if (!options.trustedRestrictedMcpTool || options.candidateTool !== options.trustedRestrictedMcpTool) {
      return { allowed: false, reason: "The restricted MCP proxy object is not authorized for this runtime" };
    }
    if (options.skipRestrictedMcpPreflight) return { allowed: true };
    try {
      const decision = runtime.preflight(params);
      return decision.allowed
        ? { allowed: true }
        : { allowed: false, reason: decision.reason ?? "Restricted MCP preflight denied the request" };
    } catch {
      return { allowed: false, reason: "Restricted MCP preflight is unavailable" };
    }
  }

  return authorizeAgentToolCall({
    cwd: row.cwd,
    project: authorization.project,
    agentProfile: authorization.agentProfile,
    toolName,
    params,
    sourceSessionId: sessionId,
    standardResourcesAuthorized: Boolean(expectedStandard),
  });
}

const policyWrappedToolExecutes = new WeakSet<object>();
const policyWrappedSessions = new WeakSet<object>();
const policyWrappedAgents = new WeakSet<object>();

function resolveRegisteredTool(session: AgentSession, toolName: string): unknown {
  const anySession = session as any;
  const registry = anySession._toolRegistry;
  if (registry instanceof Map) {
    const exact = registry.get(toolName);
    if (exact !== undefined) return exact;
    for (const tool of registry.values()) {
      if (tool && typeof tool.name === "string" && normalizeToolName(tool.name) === normalizeToolName(toolName)) return tool;
    }
  }
  for (const tool of anySession.agent?.state?.tools ?? []) {
    if (tool && typeof tool.name === "string" && normalizeToolName(tool.name) === normalizeToolName(toolName)) return tool;
  }
  return undefined;
}

function wrapToolExecute(
  tool: any,
  sessionId: string,
  restrictedMcpRuntime: RestrictedMcpRuntime | undefined,
  trustedRestrictedMcpTool: unknown,
  standardResourcesWitness: ExactStandardResourcesWitness | undefined,
  standardResourcesRuntimeFence: StandardResourcesRuntimeFence | undefined,
  protectedBrowserRuntime: ProtectedBrowserToolRuntime | undefined,
  trustedProtectedBrowserTool: unknown,
  protectedAutomationRuntime: ProtectedAutomationToolRuntime | undefined,
  trustedProtectedAutomationTool: unknown,
): void {
  if (!tool || (typeof tool !== "object" && typeof tool !== "function") || typeof tool.name !== "string"
    || typeof tool.execute !== "function" || policyWrappedToolExecutes.has(tool)) return;
  const previousExecute = tool.execute.bind(tool);
  const policyToolName = tool.name;
  const protectedAutomationReleaseFence = normalizeToolName(policyToolName) === PROTECTED_AUTOMATION_TOOL_NAME;
  let standardRuntimeRevoked = false;
  const decideWrappedCall = (params: unknown): ToolAuthorizationDecision => {
    if (standardResourcesWitness && standardRuntimeRevoked) {
      return { allowed: false, reason: "Standard resource runtime was permanently revoked; a fresh runtime is required" };
    }
    const decision = liveToolDecision(sessionId, policyToolName, params, {
      candidateTool: tool,
      restrictedMcpRuntime,
      trustedRestrictedMcpTool,
      standardResourcesWitness,
      standardResourcesRuntimeFence,
      protectedBrowserRuntime,
      trustedProtectedBrowserTool,
      protectedAutomationRuntime,
      trustedProtectedAutomationTool,
    });
    if (standardResourcesWitness && !decision.allowed && /^Standard resource (?:runtime|authority)/u.test(decision.reason ?? "")) {
      standardRuntimeRevoked = true;
    }
    return decision;
  };
  tool.execute = async (toolCallId: string, params: unknown, ...rest: unknown[]) => {
    const decision = decideWrappedCall(params);
    if (!decision.allowed) throw new Error(`Wayang policy blocked ${policyToolName}: ${decision.reason ?? "denied"}`);
    const guardedRest = [...rest];
    if ((standardResourcesWitness || protectedAutomationReleaseFence) && typeof guardedRest[1] === "function") {
      const previousUpdate = guardedRest[1] as (...args: unknown[]) => unknown;
      guardedRest[1] = (...args: unknown[]) => {
        const release = decideWrappedCall(params);
        if (!release.allowed) return undefined;
        return previousUpdate(...args);
      };
    }
    const result = await previousExecute(toolCallId, params, ...guardedRest);
    if (standardResourcesWitness || protectedAutomationReleaseFence) {
      const release = decideWrappedCall(params);
      if (!release.allowed) throw new Error(`Wayang policy suppressed ${policyToolName} result: ${release.reason ?? "denied"}`);
    }
    return result;
  };
  policyWrappedToolExecutes.add(tool);
}

function wrapCurrentTools(
  session: AgentSession,
  sessionId: string,
  restrictedMcpRuntime: RestrictedMcpRuntime | undefined,
  trustedRestrictedMcpTool: unknown,
  standardResourcesWitness: ExactStandardResourcesWitness | undefined,
  standardResourcesRuntimeFence: StandardResourcesRuntimeFence | undefined,
  protectedBrowserRuntime: ProtectedBrowserToolRuntime | undefined,
  trustedProtectedBrowserTool: unknown,
  protectedAutomationRuntime: ProtectedAutomationToolRuntime | undefined,
  trustedProtectedAutomationTool: unknown,
): void {
  const anySession = session as any;
  if (anySession._toolRegistry instanceof Map) {
    for (const tool of anySession._toolRegistry.values()) {
      wrapToolExecute(tool, sessionId, restrictedMcpRuntime, trustedRestrictedMcpTool, standardResourcesWitness, standardResourcesRuntimeFence, protectedBrowserRuntime, trustedProtectedBrowserTool, protectedAutomationRuntime, trustedProtectedAutomationTool);
    }
  }
  for (const tool of anySession.agent?.state?.tools ?? []) {
    wrapToolExecute(tool, sessionId, restrictedMcpRuntime, trustedRestrictedMcpTool, standardResourcesWitness, standardResourcesRuntimeFence, protectedBrowserRuntime, trustedProtectedBrowserTool, protectedAutomationRuntime, trustedProtectedAutomationTool);
  }
}

/** Install post-extension preflight plus final execute wrappers; dynamically refreshed tools are rewrapped. */
export function installAgentToolPolicyGuard(
  session: AgentSession,
  sessionId: string,
  options: {
    restrictedMcpRuntime?: RestrictedMcpRuntime;
    standardResourcesWitness?: ExactStandardResourcesWitness;
    standardResourcesRuntimeFence?: StandardResourcesRuntimeFence;
    protectedBrowserRuntime?: ProtectedBrowserToolRuntime;
    protectedAutomationRuntime?: ProtectedAutomationToolRuntime;
  } = {},
): void {
  const { restrictedMcpRuntime, standardResourcesWitness, standardResourcesRuntimeFence, protectedBrowserRuntime, protectedAutomationRuntime } = options;
  const anySession = session as any;
  const restrictedMcpDefinitionEntry = restrictedMcpRuntime && anySession._toolDefinitions instanceof Map
    ? anySession._toolDefinitions.get(RESTRICTED_MCP_TOOL_NAME)
    : undefined;
  const trustedRestrictedMcpTool = restrictedMcpDefinitionEntry?.definition === restrictedMcpRuntime?.tool
    ? resolveRegisteredTool(session, RESTRICTED_MCP_TOOL_NAME)
    : undefined;
  const protectedBrowserDefinitionEntry = protectedBrowserRuntime && anySession._toolDefinitions instanceof Map
    ? anySession._toolDefinitions.get(PROTECTED_BROWSER_TOOL_NAME)
    : undefined;
  const trustedProtectedBrowserTool = protectedBrowserDefinitionEntry?.definition === protectedBrowserRuntime?.tool
    ? resolveRegisteredTool(session, PROTECTED_BROWSER_TOOL_NAME)
    : undefined;
  const protectedAutomationDefinitionEntry = protectedAutomationRuntime && anySession._toolDefinitions instanceof Map
    ? anySession._toolDefinitions.get(PROTECTED_AUTOMATION_TOOL_NAME)
    : undefined;
  const trustedProtectedAutomationTool = protectedAutomationDefinitionEntry?.definition === protectedAutomationRuntime?.tool
    ? resolveRegisteredTool(session, PROTECTED_AUTOMATION_TOOL_NAME)
    : undefined;
  let standardAuthorityRevoked = false;
  const standardCurrent = (): boolean => {
    if (!standardResourcesWitness || standardAuthorityRevoked) return !standardResourcesWitness;
    if (!standardResourcesRuntimeFence) {
      standardAuthorityRevoked = true;
      return false;
    }
    try {
      if (!standardResourcesRuntimeFence.isCurrent()) {
        standardAuthorityRevoked = true;
        return false;
      }
    } catch {
      standardAuthorityRevoked = true;
      return false;
    }
    const row = getSessionById(sessionId);
    const authorization = row
      ? authorizeProjectAction({ cwd: row.cwd, actor: "interactive", agentProfileId: row.agent_profile_id })
      : { allowed: false as const };
    if (!authorization.allowed || !authorization.project || !authorization.agentProfile) {
      standardAuthorityRevoked = true;
      return false;
    }
    const current = resolveCurrentStandardResourcesWitness({
      sourceSessionId: sessionId,
      project: authorization.project,
      agentProfile: authorization.agentProfile,
    });
    if (!current || !exactStandardResourcesWitnessEqual(current, standardResourcesWitness)) {
      standardAuthorityRevoked = true;
      return false;
    }
    return true;
  };
  const filterActiveNames = (names: string[]) => {
    if (standardResourcesWitness && !standardCurrent()) return [];
    return names.filter((name) => liveToolDecision(sessionId, name, {}, {
      candidateTool: resolveRegisteredTool(session, name),
      restrictedMcpRuntime,
      trustedRestrictedMcpTool,
      skipRestrictedMcpPreflight: normalizeToolName(name) === RESTRICTED_MCP_TOOL_NAME,
      standardResourcesWitness,
      standardResourcesRuntimeFence,
      protectedBrowserRuntime,
      trustedProtectedBrowserTool,
      protectedAutomationRuntime,
      trustedProtectedAutomationTool,
    }).allowed);
  };
  wrapCurrentTools(session, sessionId, restrictedMcpRuntime, trustedRestrictedMcpTool, standardResourcesWitness, standardResourcesRuntimeFence, protectedBrowserRuntime, trustedProtectedBrowserTool, protectedAutomationRuntime, trustedProtectedAutomationTool);
  if (typeof anySession.setActiveToolsByName === "function" && !policyWrappedSessions.has(anySession)) {
    const previous = anySession.setActiveToolsByName.bind(anySession);
    anySession.setActiveToolsByName = (names: string[]) => {
      wrapCurrentTools(session, sessionId, restrictedMcpRuntime, trustedRestrictedMcpTool, standardResourcesWitness, standardResourcesRuntimeFence, protectedBrowserRuntime, trustedProtectedBrowserTool, protectedAutomationRuntime, trustedProtectedAutomationTool);
      const result = previous(filterActiveNames(names));
      wrapCurrentTools(session, sessionId, restrictedMcpRuntime, trustedRestrictedMcpTool, standardResourcesWitness, standardResourcesRuntimeFence, protectedBrowserRuntime, trustedProtectedBrowserTool, protectedAutomationRuntime, trustedProtectedAutomationTool);
      return result;
    };
    policyWrappedSessions.add(anySession);
    if (typeof anySession.getActiveToolNames === "function") anySession.setActiveToolsByName(anySession.getActiveToolNames());
  }

  const agent = anySession.agent;
  if (!agent || typeof agent.beforeToolCall !== "function" || policyWrappedAgents.has(agent)) return;
  const previousBefore = agent.beforeToolCall.bind(agent);
  agent.beforeToolCall = async (event: any) => {
    const result = await previousBefore(event);
    if (result?.block) return result;
    const name = event?.toolCall?.name ?? event?.toolName ?? event?.name;
    if (typeof name !== "string") return { block: true, reason: "Wayang could not identify the requested tool" };
    if (standardResourcesWitness && !standardCurrent()) {
      return { block: true, reason: "Standard resource authority was revoked; a fresh runtime is required" };
    }
    const candidateTool = resolveRegisteredTool(session, name);
    wrapToolExecute(candidateTool, sessionId, restrictedMcpRuntime, trustedRestrictedMcpTool, standardResourcesWitness, standardResourcesRuntimeFence, protectedBrowserRuntime, trustedProtectedBrowserTool, protectedAutomationRuntime, trustedProtectedAutomationTool);
    const decision = liveToolDecision(sessionId, name, event?.args ?? event?.input, {
      candidateTool,
      restrictedMcpRuntime,
      trustedRestrictedMcpTool,
      standardResourcesWitness,
      standardResourcesRuntimeFence,
      protectedBrowserRuntime,
      trustedProtectedBrowserTool,
      protectedAutomationRuntime,
      trustedProtectedAutomationTool,
    });
    return decision.allowed ? result : { block: true, reason: decision.reason ?? "Wayang policy denied the tool" };
  };
  policyWrappedAgents.add(agent);
}

function exactProjectAgentsFile(cwd: string): Array<{ path: string; content: string }> {
  const file = path.join(cwd, "AGENTS.md");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    return [{ path: file, content: fs.readFileSync(file, "utf8") }];
  } catch {
    return [];
  }
}

export function createInMemorySettingsSnapshot(cwd: string, agentDir: string): SettingsManager {
  const source = SettingsManager.create(cwd, agentDir);
  const memory = SettingsManager.inMemory(source.getGlobalSettings());
  memory.applyOverrides(source.getProjectSettings());
  memory.setProjectTrusted(source.isProjectTrusted());
  return memory;
}

export interface AgentResourceLoaderResult {
  resourceLoader: ResourceLoader;
  settingsManager: SettingsManager;
  restricted: boolean;
  standardResourcesWitness?: ExactStandardResourcesWitness;
  tools?: string[];
  excludeTools?: string[];
}

export async function buildAgentResourceLoader(options: {
  cwd: string;
  agentDir: string;
  agentProfile: AgentProfileRow;
  project: ProjectRow;
  sourceSessionId?: string;
  forceInMemorySettings?: boolean;
}): Promise<AgentResourceLoaderResult> {
  const communicationAppendix = interactiveCommunicationAppendix(options.sourceSessionId);
  const profileInstructions = options.agentProfile.instructions;
  const standardResourcesWitness = options.sourceSessionId
    ? resolveCurrentStandardResourcesWitness({
        sourceSessionId: options.sourceSessionId,
        project: options.project,
        agentProfile: options.agentProfile,
      }) ?? undefined
    : undefined;
  const restricted = !standardResourcesWitness;
  let settingsManager = restricted || options.forceInMemorySettings
    ? createInMemorySettingsSnapshot(options.cwd, options.agentDir)
    : SettingsManager.create(options.cwd, options.agentDir);

  if (standardResourcesWitness) {
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      appendSystemPromptOverride: (base) => [
        ...base,
        ...(profileInstructions ? [profileInstructions] : []),
        ...communicationAppendix,
      ],
    });
    await resourceLoader.reload();
    const releaseWitness = options.sourceSessionId
      ? resolveCurrentStandardResourcesWitness({
          sourceSessionId: options.sourceSessionId,
          project: options.project,
          agentProfile: options.agentProfile,
        })
      : null;
    if (releaseWitness && exactStandardResourcesWitnessEqual(releaseWitness, standardResourcesWitness)) {
      return {
        resourceLoader,
        settingsManager,
        restricted: false,
        standardResourcesWitness,
        excludeTools: options.project.access_policy.privacy_mode === "protected" ? [...SUBAGENT_TOOLS] : undefined,
      };
    }
    // Never publish resources loaded under a stale association. Construct a fresh
    // pre-load-excluded loader and permanently discard the loaded instance.
    settingsManager = createInMemorySettingsSnapshot(options.cwd, options.agentDir);
  }

  // noExtensions is a pre-load exclusion. No extension path or factory is
  // supplied here, so an excluded factory cannot execute before filtering.
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: exactProjectAgentsFile(options.cwd) }),
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [
      ...(profileInstructions ? [profileInstructions] : []),
      ...communicationAppendix,
    ],
  });
  await resourceLoader.reload();

  const reviewed = options.agentProfile.allowed_tools?.length
    ? RESTRICTED_BUILTIN_TOOLS.filter((name) => options.agentProfile.allowed_tools!.includes(name))
    : [...RESTRICTED_BUILTIN_TOOLS];
  return {
    resourceLoader,
    settingsManager,
    restricted: true,
    tools: [...reviewed],
  };
}
