/**
 * pi-bridge.ts — Manages pi AgentSession instances.
 *
 * Each web session gets a pi AgentSession that handles the LLM interaction.
 * We use the pi SDK's structured events to relay messages to the frontend
 * via WebSocket, rather than raw PTY bytes.
 */

import type { AgentSession, AgentSessionEvent, LoadExtensionsResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel, isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fingerprintsEqual, type FileFingerprint } from "./session-metadata.js";
import { recordLatencyMetric } from "./latency-metrics.js";
import { getInterviewBridge } from "./interview-bridge.js";
import { resolveInterviewSubmissionEvidence, verifyInterviewSubmissionEntry, type InterviewRecord } from "./interviews.js";
import {
  beginAgentSwitch,
  completeAgentSwitch,
  getSessionById,
  normalizeProvisionalSessionTitle,
  rollbackAgentSwitch,
  setPiSessionTitle,
  setProvisionalSessionTitle,
  updatePiSessionFile,
  updateSessionAgentProfile,
  updateSessionError,
  updateSessionModel,
  type SessionRow,
} from "./sessions.js";
import { getAgentProfile } from "./agent-profiles.js";
import { getProjectByCwd } from "./projects.js";
import { authorizeProjectAction, resolveEffectiveSessionConfig } from "./policy.js";
import {
  buildAgentResourceLoader,
  installAgentToolPolicyGuard,
  resolveCurrentStandardResourcesWitness,
} from "./agent-runtime.js";
import {
  createPolicySandboxedBashToolDefinition,
  getBashSandboxAvailability,
  selectWayangBashMode,
} from "./sandbox-bash.js";
import {
  createHostBashToolDefinition,
  hostExecutionWitnessFromResolution,
  installHostBashRegistryGuard,
  resolveHostBashExecutable,
  resolveHostExecutionAuthorization,
  type ExactHostExecutionCapabilityWitness,
  type HostBashRegistryGuard,
  type HostExecutionMode,
} from "./host-execution.js";
import { isSessionCapabilityEligible, resolveWorkspaceCapability } from "./workspace-capabilities.js";
import { isLegacyWrenStandardRuntime } from "./legacy-wren.js";
import { WorkspaceStoreError, type AgentProfileRow, type PendingAgentSwitch, type ProjectRow } from "./workspace-types.js";
import {
  REVIEWED_EXTERNAL_MODELS,
  type ReviewedExternalModelEntry,
} from "./reviewed-provider-extensions.js";
import { registerReviewedProviders } from "./reviewed-provider-runtime.js";
import {
  CURATED_TOGETHER_MODELS,
  curateTogetherModelRecords,
  isCuratedTogetherModel,
} from "./together-model-catalog.js";
export { curateTogetherModelRecords, isCuratedTogetherModel } from "./together-model-catalog.js";
import { getSudoBridge } from "./sudo-bridge.js";
import { getCommandGuardIdentityBridge } from "./command-guard-bridge.js";
import {
  scheduleWayangAutoTitle,
  scheduleWayangAutoTitleOnInteraction,
  type AutoTitleActivationSnapshot,
} from "./session-title-service.js";
import { extractCompletedTitleExchanges, titleTextBlocks } from "./session-title-policy.js";
import { createWayangSessionCustomTools } from "./wayang-runtime-context.js";
import { createSessionInteropToolDefinitions } from "./session-interop.js";
import { createWorkspaceToolDefinitions, workspaceToolsAllowedForRuntime } from "./workspace-tools.js";
import { AgentSwitchAuthorityLifecycle } from "./agent-switch-authority-lifecycle.js";
import {
  PROTECTED_BROWSER_CAPABILITY_ID,
  STANDARD_BROWSER_CAPABILITY_ID,
  type ProtectedBrowserAuthoritySnapshot,
  type ProtectedBrowserBinding,
} from "./browser/types.js";
import {
  INTERACTIVE_BROWSER_TOOL_NAMES,
  PROTECTED_BROWSER_TOOL_NAME,
  isProtectedBrowserToolRuntime,
  type ProtectedBrowserToolRuntime,
} from "./browser/protected-tools.js";
import {
  assertInteractiveBrowserToolCatalog,
  type AgentLeaseDetachReason,
  type BrowserAuthorityRevokeReason,
  type CapabilityBoundInteractiveBrowserToolRuntime,
  type InteractiveBrowserAuthorityScope,
  type InteractiveBrowserSessionLifecyclePort,
  type SessionWorkspaceCloseReason,
} from "./browser/interactive-runtime.js";
import { exactProtectedBrowserBindingEqual } from "./browser/protected-browser.js";
import { getBrowserExecutableDiagnostic } from "./browser/manager.js";
import {
  exactProtectedAutomationBindingEqual,
  type ProtectedAutomationBinding,
} from "./protected-automation/authority.js";
import {
  createProtectedAutomationToolRuntime,
  PROTECTED_AUTOMATION_TOOL_NAME,
  type ProtectedAutomationToolRuntime,
} from "./protected-automation/tool.js";
import {
  createRestrictedMcpRuntime,
  includeRestrictedMcpActiveTool,
  type RestrictedMcpLiveContext,
  type RestrictedMcpRuntime,
} from "./restricted-mcp/index.js";
import {
  interactiveTurnSourceDetails,
  issueBrowserTurnProvenance,
  resolveBrowserTurnLedger,
  wayangInteractiveTurnSourceFromEntry,
  WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE,
  type BrowserTurnProvenance,
} from "./interactive-turn-provenance.js";
import { getActionApprovalBridge } from "./action-approval-bridge.js";
import {
  cancelCapturedQueuedChatMessage,
  captureQueuedChatMessage,
  isQueuedChatMessagePending,
  queuedChatMessageState,
  snapshotQueuedChatMessages,
  type QueuedChatMessageCapture,
} from "./queued-chat-messages.js";
import { getConfig } from "./config.js";
import {
  FILE_AUDIO_EXPERIMENT_TOOL_NAME,
  type FileAudioExperimentBinding,
  type FileAudioExperimentDependencies,
  type FileAudioExperimentRuntime,
} from "./audio-experiment/types.js";
import { createFileAudioExperimentRuntime } from "./audio-experiment/tools.js";
import {
  DELETED_EVENT_TOMBSTONE,
  INVALIDATED_DERIVED_EVENT_TOMBSTONE,
  trustedEditedMutationMarker,
} from "./transcript-mutation-markers.js";
import {
  acquireSessionRuntimeMutationLock,
  isSessionRuntimeMutationLocked,
  onSessionRuntimeMutationLockChanged,
  releaseSessionRuntimeMutationLock,
} from "./session-runtime-mutation-lock.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueuedBrowserMessageRecord {
  capture: QueuedChatMessageCapture;
  content: string;
  attachmentNames: string[];
  turnToken: string;
  clientVisible: boolean;
  startCorrelated: boolean;
}

interface DeferredBrowserMessageRecord {
  queueRecordId: string;
  clientMessageId?: string;
  content: string;
  images?: ImageContent[];
  queuedDisplay: {
    content: string;
    attachmentNames: string[];
    rawUserText?: string;
    provisionalTitleText?: string;
    acceptedAt?: number;
  };
  retainedBytes: number;
  clientVisible: boolean;
  startCorrelated: boolean;
}

export interface ManualCompactionMessageQueue {
  readonly runtimeGeneration: string;
  compactionLeaseHeld: boolean;
  records: DeferredBrowserMessageRecord[];
  dispatching?: DeferredBrowserMessageRecord;
  retainedBytes: number;
  draining: boolean;
  waitForUnlockUnsubscribe?: () => void;
}

export interface PiSessionHandle {
  id: string; // Same as our DB session ID
  session: AgentSession;
  cwd: string;
  model: string | undefined;
  subscriberCount: number;
  extensionsResult: LoadExtensionsResult;
  events: EventEmitter;
  sessionFile?: string;
  lastActivityAt: number;
  agentProfileId: string;
  runtimeGeneration: string;
  bashMode: HostExecutionMode;
  /** Exact backend-created host definition/executable, captured after guards. */
  trustedHostBashTool?: TrustedHostBashTool;
  /** In-flight bounded TERM/KILL teardown started by the denial latch. */
  hostBashTeardown?: Promise<void>;
  restrictedMcpRuntime?: RestrictedMcpRuntime;
  protectedBrowserRuntime?: CapabilityBoundInteractiveBrowserToolRuntime;
  protectedBrowserFactory?: CreatePiSessionRuntimeOptions["protectedBrowserFactory"];
  protectedAutomationRuntime?: ProtectedAutomationToolRuntime;
  protectedAutomationFactory?: CreatePiSessionRuntimeOptions["protectedAutomationFactory"];
  fileAudioExperimentRuntime?: FileAudioExperimentRuntime;
  fileAudioExperimentFactory?: CreatePiSessionRuntimeOptions["fileAudioExperimentFactory"];
  /** Accepted browser turns retained independently until exact settlement. */
  interactiveTurns: Map<string, BrowserTurnProvenance>;
  /** Current-turn mutation authority; non-browser continuations revoke only this token. */
  interactiveMutationTurnToken?: string;
  /** Browser-local IDs bound to exact pending pi steering message objects. */
  queuedBrowserMessages: Map<string, QueuedBrowserMessageRecord>;
  /** Bounded FIFO admitted only while this exact runtime owns manual compaction. */
  manualCompactionMessageQueue?: ManualCompactionMessageQueue;
  /** Latest in-progress Pi message, retained across the pre-persistence message_end gap. */
  liveStreamingMessage?: any;
  /** Successful overflow compaction awaiting a successful SDK continuation. */
  pendingOverflowRecovery?: { compactionEntryId: string; overflowEntryId: string; successObserved?: boolean };
  /** Lifecycle failure not represented by a final assistant message. */
  pendingSessionError?: string;
  liveStreamingMessageUnsubscribe?: () => void;
  /** Permanent process-local denial latch; only a fresh handle may regain authority. */
  capabilityAuthorityDenied?: boolean;
}

export interface SerializedMessage {
  type: string;
  mutation_status?: "edited" | "deleted";
  [key: string]: unknown;
}

export interface SerializedTodoItem {
  id: number;
  text: string;
  status: string;
  priority?: string;
  assignee?: string;
  notes?: string;
  dependencies?: number[];
}

export interface SerializedTodoState {
  type: "todo_state";
  todos: SerializedTodoItem[];
  nextId?: number;
  source: "todo-state" | "tool-result" | "todo-preseed" | "none";
}

export interface WebModelInfo {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  available: boolean;
}

export interface WebDefaultModelInfo {
  provider: string;
  id: string;
  name: string;
}

export type CommandGuardMode = "off" | "audit" | "balanced" | "strict";

export interface CommandGuardState {
  available: boolean;
  mode: CommandGuardMode | "unknown";
  source?: string;
  modelRoute?: string[];
  error?: string;
  pinRequired?: boolean;
  pinConfigured?: boolean;
}

export interface SlashArgumentSuggestion {
  value: string;
  label: string;
  description?: string;
}

export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface WebSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  source: SlashCommandSource;
  argumentSuggestions?: SlashArgumentSuggestion[];
}

interface CommandGuardBridgeController {
  getStatus: () => CommandGuardState;
  setMode: (mode: CommandGuardMode, options?: { announce?: boolean; pin?: string }) => CommandGuardState;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 50;
const MAX_MANUAL_COMPACTION_DEFERRED_MESSAGES = 32;
const MAX_MANUAL_COMPACTION_DEFERRED_BYTES = 32 * 1024 * 1024;
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_IDLE_CHECK_INTERVAL_MS = 30 * 1000;
const sessions = new Map<string, PiSessionHandle>();
const queuedBrowserClientMessageIds = new WeakMap<object, string>();
const sessionCreations = new Map<string, Promise<PiSessionHandle>>();
/** Monotonic process-local denial epoch. A creation may publish only while the
 * exact epoch captured before its first await remains current. */
const sessionCapabilityDenialGenerations = new Map<string, bigint>();
/** Strongest browser teardown requested for one exact denial generation. */
interface SessionBrowserTeardownIntent {
  generation: bigint;
  action: PiSessionBrowserTeardown;
}
const sessionBrowserTeardownIntents = new Map<string, SessionBrowserTeardownIntent>();
const agentSwitches = new Map<string, Promise<AgentSwitchResult>>();
const runtimeEvents = new EventEmitter();
onSessionRuntimeMutationLockChanged((sessionId) => {
  runtimeEvents.emit("event", {
    type: "runtime_state_changed",
    sessionId,
    bashMode: getPiSessionBashMode(sessionId),
  } satisfies PiSessionRuntimeEvent);
});
const runtimeUnavailableNotifiedHandles = new WeakSet<object>();
const PROCESS_BOOT_NONCE = randomUUID();
let idleCleanupTimer: NodeJS.Timeout | null = null;

/** Maps pi cwd → web sessionId for legacy web-mode extensions. */
const cwdToSessionId = new Map<string, string>();
/** Maps canonical pi SessionManager IDs/files → web sessionId for thread-scoped bridges. */
const piSessionToWebSessionId = new Map<string, string>();
const piSessionFileToWebSessionId = new Map<string, string>();
/** Exact SessionManager-object ownership survives duplicate ID/file collisions. */
const piSessionManagerToWebSessionId = new WeakMap<object, string>();
(globalThis as any).__pi_interview_cwd_sessions = cwdToSessionId;
(globalThis as any).__pi_interview_pi_sessions = piSessionToWebSessionId;
(globalThis as any).__pi_interview_session_files = piSessionFileToWebSessionId;
(globalThis as any).__pi_sudo_cwd_sessions = cwdToSessionId;
(globalThis as any).__pi_sudo_pi_sessions = piSessionToWebSessionId;
(globalThis as any).__pi_sudo_session_files = piSessionFileToWebSessionId;
(globalThis as any).__pi_sudo_session_managers = piSessionManagerToWebSessionId;
(globalThis as any).__pi_command_guard_cwd_sessions = cwdToSessionId;
(globalThis as any).__pi_command_guard_pi_sessions = piSessionToWebSessionId;
(globalThis as any).__pi_command_guard_session_files = piSessionFileToWebSessionId;
(globalThis as any).__wayang_command_guard_human_input_authority = Object.freeze({
  resolveInterviewSubmission: (sessionId: string, entry: unknown) => resolveInterviewSubmissionEvidence(sessionId, entry) ?? null,
});
// External-action approvals intentionally expose exact Pi session identities
// only. A cwd is shared by interactive and headless sessions and must never be
// accepted as approval-presence evidence.
(globalThis as any).__pi_action_pi_sessions = piSessionToWebSessionId;
(globalThis as any).__pi_action_session_files = piSessionFileToWebSessionId;

// Lazy-initialized singletons
let _agentDir: string | null = null;
let _modelListingRuntime: ModelRuntime | null = null;
let _modelListingRegistry: ModelRegistry | null = null;
let _modelListingRegistryPromise: Promise<{ runtime: ModelRuntime; registry: ModelRegistry; error?: string }> | null = null;
let _modelListingRegistryError: string | undefined;

const DYNAMIC_MODEL_REFRESH_MS = 5 * 60 * 1000;
const DYNAMIC_MODEL_FETCH_TIMEOUT_MS = 8 * 1000;

type DynamicModelCache = {
  fetchedAt: number;
  models: Model<Api>[];
  error?: string;
};

let _dynamicModelCache: DynamicModelCache = { fetchedAt: 0, models: [] };
let _dynamicModelRefreshPromise: Promise<DynamicModelCache> | null = null;

type ShellToken =
  | { type: "word"; value: string }
  | { type: "operator"; value: string };

function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let token = "";
  let atTokenBoundary = true;

  const flushWord = () => {
    if (token) tokens.push({ type: "word", value: token });
    token = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      token += ch;
      escaped = false;
      atTokenBoundary = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      atTokenBoundary = false;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else token += ch;
      atTokenBoundary = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      atTokenBoundary = false;
      continue;
    }
    if (ch === "#" && atTokenBoundary) {
      flushWord();
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      atTokenBoundary = true;
      if (ch === "\n") tokens.push({ type: "operator", value: ";" });
      continue;
    }
    if (";|&(){}".includes(ch)) {
      flushWord();
      if ((ch === "|" || ch === "&") && next === ch) {
        tokens.push({ type: "operator", value: ch + next });
        i++;
      } else {
        tokens.push({ type: "operator", value: ch });
      }
      atTokenBoundary = true;
      continue;
    }

    token += ch;
    atTokenBoundary = false;
  }

  flushWord();
  return tokens;
}

function isAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function basenameWord(word: string): string {
  return word.split("/").filter(Boolean).pop() ?? word;
}

function isShellInterpreter(base: string): boolean {
  return ["bash", "sh", "dash", "zsh", "fish", "ksh"].includes(base);
}

function shellCommandPayloadFrom(tokens: ShellToken[], shellIndex: number): string | undefined {
  for (let i = shellIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "operator") return undefined;
    const word = token.value;
    if (word === "--") continue;
    if (!word.startsWith("-")) return undefined;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
      const payload = tokens[i + 1];
      return payload?.type === "word" ? payload.value : undefined;
    }
  }
  return undefined;
}

function commandInvokesSudoInner(command: string, depth: number): boolean {
  if (depth > 3) return false;
  let expectCommand = true;
  const tokens = shellTokens(command);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "operator") {
      if ([";", "&&", "||", "|", "(", "{"].includes(token.value)) expectCommand = true;
      continue;
    }

    const word = token.value;
    const base = basenameWord(word);

    if (expectCommand) {
      if (isAssignmentWord(word)) continue;
      if (base === "sudo") return true;
      if (["env", "command", "time", "nohup", "nice"].includes(base)) continue;
      if (isShellInterpreter(base)) {
        const payload = shellCommandPayloadFrom(tokens, i);
        if (payload && commandInvokesSudoInner(payload, depth + 1)) return true;
      }
      if (["if", "while", "until", "then", "do", "else", "elif"].includes(word)) continue;
      expectCommand = false;
      continue;
    }

    if (["then", "do", "else", "elif"].includes(word) || ["-exec", "-execdir", "--exec"].includes(word)) {
      expectCommand = true;
    }
  }

  return false;
}

function commandInvokesSudo(command: string): boolean {
  return commandInvokesSudoInner(command, 0);
}

function bashCommandParam(params: unknown): string {
  return typeof (params as Record<string, unknown> | undefined)?.command === "string"
    ? (params as Record<string, unknown>).command as string
    : "";
}

function sudoCommandLogSummary(command: string): string {
  return command ? `raw-length-${command.length}` : "empty";
}

function wrapWayangBashToolExecute(tool: any, session: AgentSession, sessionId: string): void {
  if (!tool || tool.name !== "bash" || typeof tool.execute !== "function" || tool.__wayangRawSudoExecuteWrapped) return;
  const previousExecute = tool.execute.bind(tool);
  tool.execute = async (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: unknown, ...rest: unknown[]) => {
    const command = bashCommandParam(params);
    if (commandInvokesSudo(command)) {
      const reason = "Wayang blocked raw sudo at bash execute; use the structured sudo_exec tool";
      console.warn(`[pi-bridge] ${reason} (session=${sessionId}, toolCallId=${toolCallId}, command=${sudoCommandLogSummary(command)})`);
      throw new Error(reason);
    }
    return previousExecute(toolCallId, params, signal, onUpdate, ...rest);
  };
  tool.__wayangRawSudoExecuteWrapped = true;
}

function wrapWayangBashTools(session: AgentSession, sessionId: string): void {
  const anySession = session as any;
  const registry = anySession._toolRegistry;
  if (registry instanceof Map) wrapWayangBashToolExecute(registry.get("bash"), session, sessionId);
  const agentTools = anySession.agent?.state?.tools;
  if (Array.isArray(agentTools)) {
    for (const tool of agentTools) wrapWayangBashToolExecute(tool, session, sessionId);
  }
}

interface TrustedHostBashTool {
  definition: any;
  executable: any;
  execute: unknown;
  registryGuard?: HostBashRegistryGuard;
  expectedCapabilityWitness: ExactHostExecutionCapabilityWitness;
  revokeActiveExecutions: () => Promise<void>;
  revoked: boolean;
}

function hasExactHostBashDefinition(session: AgentSession, definition: any): boolean {
  const definitions = (session as any)._toolDefinitions;
  return definitions instanceof Map && definitions.get("bash")?.definition === definition;
}

/** @internal Exported for synthetic fail-closed guard regression tests. */
export function installWayangRawSudoFailClosedGuard(session: AgentSession, sessionId: string): void {
  wrapWayangBashTools(session, sessionId);

  const anySession = session as any;
  if (typeof anySession.setActiveToolsByName === "function" && !anySession.__wayangRawSudoSetActiveWrapped) {
    const previousSetActiveToolsByName = anySession.setActiveToolsByName.bind(anySession);
    anySession.setActiveToolsByName = (toolNames: string[]) => {
      const result = previousSetActiveToolsByName(toolNames);
      wrapWayangBashTools(session, sessionId);
      return result;
    };
    anySession.__wayangRawSudoSetActiveWrapped = true;
  }

  const agent = anySession.agent;
  if (!agent || typeof agent.beforeToolCall !== "function") return;
  const previousBeforeToolCall = agent.beforeToolCall.bind(agent);
  agent.beforeToolCall = async (event: { toolCall?: { name?: string }; args?: unknown }) => {
    const argsBefore = event.args as Record<string, unknown> | undefined;
    const commandBefore = typeof argsBefore?.command === "string" ? argsBefore.command : "";
    const sudoBefore = event.toolCall?.name === "bash" && commandInvokesSudo(commandBefore);

    const result = await previousBeforeToolCall(event);

    const argsAfter = event.args as Record<string, unknown> | undefined;
    const commandAfter = typeof argsAfter?.command === "string" ? argsAfter.command : "";
    const sudoAfter = event.toolCall?.name === "bash" && commandInvokesSudo(commandAfter);
    if (sudoBefore || sudoAfter) {
      console.info(
        `[pi-bridge] raw sudo post-check session=${sessionId} blocked=${Boolean(result?.block)} ` +
          `changed=${commandBefore !== commandAfter} command=${sudoCommandLogSummary(commandAfter)}`,
      );
    }

    if (result?.block) return result;

    if (sudoBefore || sudoAfter) {
      const reason = "Wayang blocked raw sudo after extension hooks; use the structured sudo_exec tool";
      console.warn(`[pi-bridge] ${reason} (session=${sessionId}, command=${sudoCommandLogSummary(commandAfter || commandBefore)})`);
      return { block: true, reason };
    }

    return result;
  };
}

export type ModelContext = { runtime: ModelRuntime; registry: ModelRegistry; error?: string };

/** @internal Exported for synthetic provider-isolation regression tests. */
export async function createModelContext(options: {
  agentDir?: string;
  includeReviewedProviders?: boolean;
  reviewedExternalModels?: readonly ReviewedExternalModelEntry[];
} = {}): Promise<ModelContext> {
  const agentDir = options.agentDir ?? getAgentDirPath();
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const context: ModelContext = { runtime, registry: new ModelRegistry(runtime) };
  if (options.includeReviewedProviders) {
    const errors = await registerReviewedProviders(
      context,
      agentDir,
      options.reviewedExternalModels ?? REVIEWED_EXTERNAL_MODELS,
    );
    context.error = errors.length > 0 ? errors.join("\n") : undefined;
  }
  return context;
}

/**
 * Freeze one per-session provider surface after Wayang resolves the selected
 * model. Resource extensions may still register tools, hooks, commands, and
 * other session resources, but their provider mutations are deliberately
 * ignored so project/global resource loading cannot reroute model traffic.
 */
export function sealSessionModelProviderRegistry(runtime: ModelRuntime): void {
  const ignoredProviderMutation = () => undefined;
  Object.defineProperties(runtime, {
    registerProvider: { value: ignoredProviderMutation, writable: false, configurable: false },
    registerNativeProvider: { value: ignoredProviderMutation, writable: false, configurable: false },
    unregisterProvider: { value: ignoredProviderMutation, writable: false, configurable: false },
  });
}

/** Refresh the side-effect-free listing/auth snapshot after an external credential write. */
export function reloadAuthStorage(): void {
  // Live sessions own fresh model runtimes. New sessions reopen the file-backed
  // auth store; the cached listing registry is the only shared snapshot here.
  if (_modelListingRuntime) {
    void _modelListingRuntime.refresh({ allowNetwork: false }).catch(() => undefined);
  }
}

function getAgentDirPath(): string {
  if (!_agentDir) _agentDir = getAgentDir();
  return _agentDir;
}

function ensureIdleCleanupTimer(): void {
  if (idleCleanupTimer || sessions.size === 0) return;
  idleCleanupTimer = setInterval(() => {
    stopIdlePiSessions().catch((err) => {
      console.error("[pi-bridge] Failed to stop idle sessions:", err);
    });
  }, SESSION_IDLE_CHECK_INTERVAL_MS);
  idleCleanupTimer.unref?.();
}

function maybeStopIdleCleanupTimer(): void {
  if (sessions.size > 0 || !idleCleanupTimer) return;
  clearInterval(idleCleanupTimer);
  idleCleanupTimer = null;
}

function markSessionActivity(id: string): void {
  const handle = sessions.get(id);
  if (!handle) return;
  handle.lastActivityAt = Date.now();
  ensureIdleCleanupTimer();
}

function assertCapabilityAuthorityAvailable(handle: PiSessionHandle): void {
  if (handle.capabilityAuthorityDenied) {
    throw new WorkspaceStoreError("Session runtime authority was denied; reconnect to create a fresh runtime", 409);
  }
}

function interactiveTurnLedger(handle: PiSessionHandle): Map<string, BrowserTurnProvenance> {
  return handle.interactiveTurns ??= new Map<string, BrowserTurnProvenance>();
}

export function beginInteractiveTurn(
  handle: PiSessionHandle,
  content: string,
  options: {
    rawUserText?: string;
    provisionalTitleText?: string;
    clientMessageId?: string;
    acceptedAt?: number;
  } = {},
): BrowserTurnProvenance {
  assertCapabilityAuthorityAvailable(handle);
  const project = getProjectByCwd(handle.cwd);
  const model = handle.session.model;
  const durable = getSessionById(handle.id);
  if (!project || !model) throw new WorkspaceStoreError("Interactive turn runtime binding is unavailable", 409);
  const turn = issueBrowserTurnProvenance({
    sourceSessionId: handle.id,
    runtimeGeneration: handle.runtimeGeneration,
    agentProfileId: handle.agentProfileId,
    projectId: project.id,
    projectCwd: project.cwd,
    provider: String(model.provider),
    model: model.id,
    acceptedEntryCount: handle.session.sessionManager.getEntries().length,
  }, content, options.acceptedAt ?? Date.now(), {
    rawUserText: options.rawUserText,
    provisionalTitleText: options.provisionalTitleText,
    clientMessageId: options.clientMessageId,
    sourceMarkerEligible: Boolean(
      durable
      && durable.project_id === project.id
      && durable.cwd === project.cwd
      && durable.agent_profile_id === handle.agentProfileId
      && durable.legacy_capability_ineligible === false
      && durable.scheduled_job_id === null
      && durable.scheduled_run_id === null
      && durable.pending_agent_switch === null
      && durable.legacy_private_session_quarantine === false
    ),
  });
  interactiveTurnLedger(handle).set(turn.token, turn);
  handle.interactiveMutationTurnToken = turn.token;
  return turn;
}

function resolveInteractiveTurnLedger(handle: PiSessionHandle): Map<string, BrowserTurnProvenance> {
  const manager = handle.session.sessionManager;
  const branchIds = new Set(manager.getBranch().map((entry: any) => entry?.id).filter((id: unknown): id is string => typeof id === "string"));
  const ledger = interactiveTurnLedger(handle);
  const resolved = resolveBrowserTurnLedger(ledger, manager.getEntries(), branchIds);
  for (const [token, turn] of resolved) ledger.set(token, turn);
  return resolved;
}

export function resolveInteractiveTurn(handle: PiSessionHandle): BrowserTurnProvenance | null {
  const token = handle.interactiveMutationTurnToken;
  if (!token) return null;
  return resolveInteractiveTurnLedger(handle).get(token) ?? null;
}

function resolveTurnAgainstCurrentBranch(
  handle: PiSessionHandle,
  turn: BrowserTurnProvenance,
): BrowserTurnProvenance | null {
  const manager = handle.session.sessionManager;
  const branchIds = new Set(manager.getBranch().map((entry: any) => entry?.id)
    .filter((id: unknown): id is string => typeof id === "string"));
  return resolveBrowserTurnLedger(new Map([[turn.token, turn]]), manager.getEntries(), branchIds).get(turn.token) ?? null;
}

function persistAcceptedProvisionalTitle(handle: PiSessionHandle, turn: BrowserTurnProvenance): void {
  if (!turn.sourceMarkerEligible || !turn.provisionalTitleText.trim()) return;
  if (!resolveTurnAgainstCurrentBranch(handle, turn)) return;
  try { setProvisionalSessionTitle(handle.id, turn.provisionalTitleText); }
  catch { /* title persistence never changes source-turn success */ }
}

/**
 * Persist every exactly-bound source marker, then retire the complete accepted
 * ledger for this top-level settlement. Unresolved template/command/hash turns
 * can never survive and bind to later coincidentally matching text.
 */
export function settleInteractiveTurns(handle: PiSessionHandle): BrowserTurnProvenance[] {
  const ledger = interactiveTurnLedger(handle);
  const allResolved = resolveInteractiveTurnLedger(handle);
  const readyTokens = new Set([...ledger]
    .filter(([, turn]) => turn.settlementReady)
    .map(([token]) => token));
  const resolved = new Map([...allResolved].filter(([token]) => readyTokens.has(token)));
  handle.interactiveMutationTurnToken = undefined;
  // Only turns claimed by this top-level run have an authoritative mismatch.
  // Accepted-but-unclaimed queued turns remain for their own later settlement.
  for (const token of readyTokens) {
    if (resolved.has(token)) continue;
    ledger.delete(token);
    for (const [clientMessageId, record] of handle.queuedBrowserMessages) {
      if (record.turnToken === token) handle.queuedBrowserMessages.delete(clientMessageId);
    }
  }
  const manager = handle.session.sessionManager;
  const markedUserEntryIds = new Set(manager.getEntries()
    .map((entry: unknown) => wayangInteractiveTurnSourceFromEntry(entry)?.user_entry_id)
    .filter((id: string | undefined): id is string => typeof id === "string"));
  const settled: BrowserTurnProvenance[] = [];
  for (const [token, turn] of resolved) {
    if (turn.provisionalTitleAccepted) persistAcceptedProvisionalTitle(handle, turn);
    const details = interactiveTurnSourceDetails(turn);
    if (!details || markedUserEntryIds.has(details.user_entry_id)) {
      ledger.delete(token);
      for (const [clientMessageId, record] of handle.queuedBrowserMessages) {
        if (record.turnToken === token) handle.queuedBrowserMessages.delete(clientMessageId);
      }
      settled.push(turn);
      continue;
    }
    // Delete only after Pi durably accepts the append. A throw leaves this
    // exact resolved turn in the ledger for the next settlement retry.
    manager.appendCustomEntry(WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE, details);
    markedUserEntryIds.add(details.user_entry_id);
    ledger.delete(token);
    for (const [clientMessageId, record] of handle.queuedBrowserMessages) {
      if (record.turnToken === token) handle.queuedBrowserMessages.delete(clientMessageId);
    }
    settled.push(turn);
  }
  return settled;
}

function settleInteractiveTurnsQuietly(handle: PiSessionHandle): BrowserTurnProvenance[] {
  try { return settleInteractiveTurns(handle); }
  catch { return []; /* source-marker persistence must never change source-turn settlement */ }
}

function deferWayangAutoTitleAfterInteraction(
  handle: PiSessionHandle,
  turns: readonly BrowserTurnProvenance[],
): void {
  const interactionIds = turns.map((turn) => turn.clientMessageId);
  setImmediate(() => {
    for (const interactionId of interactionIds) {
      try {
        scheduleWayangAutoTitleOnInteraction(handle.id, interactionId, {
          onCommitted: invalidateSessionFileSnapshot,
        });
      } catch {
        // Title repair/generation never changes source-turn success.
      }
    }
  });
}

function deferWayangAutoTitle(handle: PiSessionHandle): void {
  setImmediate(() => {
    try {
      scheduleWayangAutoTitle(handle.id, { onCommitted: invalidateSessionFileSnapshot });
    } catch {
      // Title generation never changes settlement success.
    }
  });
}

function queuedUserMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || (message as any).role !== "user") return undefined;
  const content = (message as any).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

/**
 * Mark a queued browser message accepted as soon as Pi starts its user turn.
 * Identity is authoritative when preserved. Pi 0.84.1 clones steering messages
 * before message_start, so the fallback mirrors the SDK's own FIFO exact-text
 * queue removal and considers only captures already claimed from Pi's queue.
 */
export function markQueuedBrowserMessageStarted(handle: PiSessionHandle, message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const deferred = manualCompactionQueueForHandle(handle)?.dispatching;
  if (deferred && !deferred.startCorrelated && (message as any).role === "user") {
    deferred.startCorrelated = true;
    deferred.clientVisible = false;
    if (deferred.clientMessageId) queuedBrowserClientMessageIds.set(message, deferred.clientMessageId);
    return deferred.clientMessageId;
  }
  let clientMessageId = queuedBrowserClientMessageIds.get(message);
  let matchedRecord: QueuedBrowserMessageRecord | undefined;
  if (clientMessageId) {
    const candidate = handle.queuedBrowserMessages.get(clientMessageId);
    if (candidate && !candidate.startCorrelated) matchedRecord = candidate;
  }
  if (!matchedRecord) {
    for (const [candidateId, record] of handle.queuedBrowserMessages) {
      if (record.startCorrelated || record.capture.message !== message) continue;
      clientMessageId = queuedBrowserClientMessageIds.get(record.capture.message)
        ?? (record.clientVisible ? candidateId : undefined);
      matchedRecord = record;
      break;
    }
  }
  if (!matchedRecord) {
    const startedText = queuedUserMessageText(message);
    if (startedText !== undefined) {
      for (const [candidateId, record] of handle.queuedBrowserMessages) {
        if (record.startCorrelated || queuedChatMessageState(record.capture) !== "claimed") continue;
        if (queuedUserMessageText(record.capture.message) !== startedText) continue;
        clientMessageId = queuedBrowserClientMessageIds.get(record.capture.message)
          ?? (record.clientVisible ? candidateId : undefined);
        matchedRecord = record;
        break;
      }
    }
  }
  if (!matchedRecord) return undefined;
  matchedRecord.startCorrelated = true;
  matchedRecord.clientVisible = false;
  if (clientMessageId) queuedBrowserClientMessageIds.set(message, clientMessageId);
  return clientMessageId;
}

/** @internal Synthetic lifecycle seam: mark exact claimed queued objects before settlement. */
export function markClaimedQueuedBrowserTurnsReady(handle: PiSessionHandle): void {
  for (const record of handle.queuedBrowserMessages.values()) {
    if (queuedChatMessageState(record.capture) !== "claimed") continue;
    const turn = interactiveTurnLedger(handle).get(record.turnToken);
    if (turn && !turn.settlementReady) {
      interactiveTurnLedger(handle).set(turn.token, Object.freeze({ ...turn, settlementReady: true }));
    }
  }
}

function retireInteractiveTurn(handle: PiSessionHandle, token?: string): void {
  if (token) interactiveTurnLedger(handle).delete(token);
  else interactiveTurnLedger(handle).clear();
  if (!token || handle.interactiveMutationTurnToken === token) {
    handle.interactiveMutationTurnToken = undefined;
  }
}

function revokeInteractiveMutationAuthority(handle: PiSessionHandle): void {
  handle.interactiveMutationTurnToken = undefined;
}

export type NonBrowserTurnSource = "resend" | "interview_submission" | "scheduled_prompt" | "messaging_prompt";

/** Non-browser continuations revoke mutation authority without erasing already accepted browser-source evidence. */
export function beginNonBrowserTurn(handle: PiSessionHandle, _source: NonBrowserTurnSource): void {
  revokeInteractiveMutationAuthority(handle);
}

export type PiSessionRuntimeEvent =
  | {
      type: "agent_switched";
      sessionId: string;
      switchId: string;
    }
  | {
      type: "runtime_state_changed";
      sessionId: string;
      bashMode: HostExecutionMode;
    };

function emitRuntimeUnavailableOnce(handle: PiSessionHandle): void {
  if (runtimeUnavailableNotifiedHandles.has(handle)) return;
  runtimeUnavailableNotifiedHandles.add(handle);
  runtimeEvents.emit("event", {
    type: "runtime_state_changed",
    sessionId: handle.id,
    bashMode: "unavailable",
  } satisfies PiSessionRuntimeEvent);
}

function permanentlyRevokeHostBash(
  sessionId: string,
  runtimeGeneration: string,
  trust: TrustedHostBashTool,
): void {
  if (trust.revoked) return;
  const handle = sessions.get(sessionId);
  if (handle && handle.runtimeGeneration === runtimeGeneration && handle.trustedHostBashTool === trust) {
    latchPiSessionHandleCapabilityDenial(handle);
    return;
  }
  trust.revoked = true;
  try { void trust.revokeActiveExecutions().catch(() => undefined); }
  catch { /* synchronous denial remains permanent */ }
}

export function onPiSessionRuntimeEvent(listener: (event: PiSessionRuntimeEvent) => void): () => void {
  runtimeEvents.on("event", listener);
  return () => runtimeEvents.off("event", listener);
}

export interface RuntimeMutationSessionState {
  session_id: string;
  runtime_status: "active" | "starting" | "stopped";
  streaming: boolean;
  queued: boolean;
  mutation_locked: boolean;
}

export function getRuntimeMutationSessionState(id: string): RuntimeMutationSessionState {
  const handle = sessions.get(id);
  const manualQueue = handle ? manualCompactionQueueForHandle(handle) : undefined;
  return {
    session_id: id,
    runtime_status: handle ? "active" : sessionCreations.has(id) ? "starting" : "stopped",
    streaming: Boolean(handle?.session.isStreaming),
    queued: Boolean(
      (handle?.session.pendingMessageCount ?? 0) > 0
      || (manualQueue && (manualQueue.records.length > 0 || manualQueue.dispatching)),
    ),
    mutation_locked: isSessionRuntimeMutationLocked(id),
  };
}

export function lockRuntimeMutationSession(id: string): boolean {
  return acquireSessionRuntimeMutationLock(id);
}

export function unlockRuntimeMutationSession(id: string): void {
  releaseSessionRuntimeMutationLock(id);
}

function assertRuntimeMutationUnlocked(id: string): void {
  if (isSessionRuntimeMutationLocked(id)) {
    throw new WorkspaceStoreError("Session runtime is rebuilding after a settings change", 409);
  }
}

export async function stopPiSessionIfIdle(id: string): Promise<boolean> {
  if (sessionCreations.has(id)) return false;
  const handle = sessions.get(id);
  if (!handle) return true;
  if (handle.session.isStreaming || handle.session.pendingMessageCount > 0
    || manualCompactionQueueForHandle(handle)) return false;
  await destroyPiSession(id);
  return true;
}

export interface PiSessionRuntimeState {
  runtime_status: "active" | "starting" | "stopped";
  runtime_is_streaming: boolean;
  runtime_is_compacting: boolean;
  runtime_mutation_locked: boolean;
  runtime_subscriber_count: number;
  runtime_last_activity_at: number | null;
}

export function getPiSessionRuntimeState(id: string): PiSessionRuntimeState {
  const handle = sessions.get(id);
  if (handle) {
    return {
      runtime_status: "active",
      runtime_is_streaming: Boolean(handle.session.isStreaming),
      runtime_is_compacting: Boolean(handle.session.isCompacting),
      runtime_mutation_locked: isSessionRuntimeMutationLocked(id),
      runtime_subscriber_count: handle.subscriberCount,
      runtime_last_activity_at: handle.lastActivityAt,
    };
  }
  if (sessionCreations.has(id)) {
    return {
      runtime_status: "starting",
      runtime_is_streaming: false,
      runtime_is_compacting: false,
      runtime_mutation_locked: isSessionRuntimeMutationLocked(id),
      runtime_subscriber_count: 0,
      runtime_last_activity_at: null,
    };
  }
  return {
    runtime_status: "stopped",
    runtime_is_streaming: false,
    runtime_is_compacting: false,
    runtime_mutation_locked: isSessionRuntimeMutationLocked(id),
    runtime_subscriber_count: 0,
    runtime_last_activity_at: null,
  };
}

export function protectedBrowserIdleRetentionIsRequired(
  runtime: CapabilityBoundInteractiveBrowserToolRuntime | Pick<ProtectedBrowserToolRuntime, "browser" | "preflight"> | undefined,
): boolean {
  if (!runtime) return false;
  if ("binding" in runtime && productionInteractiveBrowserSessionLifecycle) {
    try {
      if (productionInteractiveBrowserSessionLifecycle.blocksPiIdleDetach(runtime.binding)) return true;
    } catch {
      // An unavailable process-level owner cannot safely assert that a human
      // control lease is detachable. Explicit denial/shutdown still revokes it.
      return true;
    }
  }
  if (!("browser" in runtime) || runtime.browser.isRevoked || runtime.browser.mode === "agent") return false;
  try { return runtime.preflight().allowed; }
  catch { return false; }
}

export async function stopIdlePiSessions(now = Date.now()): Promise<string[]> {
  const stopped: string[] = [];
  for (const [id, handle] of [...sessions]) {
    if (handle.session.isStreaming || manualCompactionQueueForHandle(handle)) continue;
    // Protected human handoff intentionally spans chat turns and may take
    // longer than the ordinary idle timeout. Explicit denial, stop, model or
    // agent change, and shutdown paths still revoke it directly.
    if (protectedBrowserIdleRetentionIsRequired(handle.protectedBrowserRuntime)) continue;
    if (now - handle.lastActivityAt < SESSION_IDLE_TIMEOUT_MS) continue;
    await destroyPiSession(id, { kind: "detach", reason: "pi_idle" });
    stopped.push(id);
  }
  maybeStopIdleCleanupTimer();
  return stopped;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Default model IDs per provider when none is specified */
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.5",
  "openai-codex": "gpt-5.6-sol",
  together: "zai-org/GLM-5.3-Flash",
  deepseek: "deepseek-v4-pro",
  "github-copilot": "claude-sonnet-4-5",
};

/** Providers intentionally unavailable through Wayang, without deleting pi auth. */
const WAYANG_HIDDEN_PROVIDERS = new Set(["openrouter"]);

export function isWayangProviderVisible(provider: string): boolean {
  return !WAYANG_HIDDEN_PROVIDERS.has(provider);
}

/** Provider → env var name(s) mapping for auto-detection */
const PROVIDER_ENV_MAP: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
};

const WEB_SUPPORTED_BUILTIN_SLASH_COMMANDS: WebSlashCommand[] = [
  {
    name: "model",
    description: "Switch models. Use /model provider/model.",
    argumentHint: "<provider/model>",
    source: "builtin",
  },
  {
    name: "name",
    description: "Set this session's display name.",
    argumentHint: "<name>",
    source: "builtin",
  },
  {
    name: "session",
    description: "Show session info and stats.",
    source: "builtin",
  },
  {
    name: "compact",
    description: "Manually compact context, optionally with custom instructions.",
    argumentHint: "[instructions]",
    source: "builtin",
  },
  {
    name: "export",
    description: "Export the current branch to HTML or JSONL.",
    argumentHint: "[file.html|file.jsonl]",
    source: "builtin",
  },
  {
    name: "reload",
    description: "Reload keybindings, extensions, skills, prompts, and context files.",
    source: "builtin",
  },
];

const STORED_AUTH_PROVIDER_PREFERENCE = [
  "openai-codex",
  "openai",
  "anthropic",
  "together",
  "github-copilot",
  "deepseek",
  "google",
  "groq",
  "cerebras",
  "xai",
  "mistral",
  "fireworks",
];

function providerHasConfiguredModel(registry: ModelRegistry, provider: string): boolean {
  if (!isWayangProviderVisible(provider)) return false;
  return registry.getAll().some((model) => String(model.provider) === provider && registry.hasConfiguredAuth(model));
}

function resolveUsableModel(
  registry: ModelRegistry,
  provider: string | null | undefined,
  modelId: string | null | undefined,
): Model<Api> | undefined {
  if (!provider || !modelId) return undefined;
  const model = resolveModelFromRegistry(registry, provider, modelId);
  return model && isWayangProviderVisible(String(model.provider)) && registry.hasConfiguredAuth(model) ? model : undefined;
}

function resolveSettingsDefaultModel(settingsManager: SettingsManager, registry: ModelRegistry): Model<Api> | undefined {
  return resolveUsableModel(registry, settingsManager.getDefaultProvider(), settingsManager.getDefaultModel());
}

async function resolveWebDefaultModel(settingsManager: SettingsManager, context: ModelContext): Promise<Model<Api> | undefined> {
  const configured = resolveSettingsDefaultModel(settingsManager, context.registry);
  if (configured) return configured;
  const provider = await detectDefaultProvider(context);
  if (!provider) return undefined;
  return resolveUsableModel(context.registry, provider, DEFAULT_MODELS[provider])
    || context.registry.getAll().find((model) => isWayangProviderVisible(String(model.provider)) && String(model.provider) === provider && context.registry.hasConfiguredAuth(model));
}

function firstConfiguredProvider(registry: ModelRegistry, providers: Iterable<string>): string | null {
  for (const provider of providers) {
    if (providerHasConfiguredModel(registry, provider)) return provider;
  }
  return null;
}

/**
 * Detect the default provider from available credentials.
 *
 * Environment variables keep their historic precedence for web startup, but
 * unattended jobs also need providers configured by `/login` in auth.json. When
 * selecting from stored auth, prefer OAuth-backed OpenAI subscription creds.
 */
async function detectDefaultProvider({ runtime, registry }: ModelContext): Promise<string | null> {
  const credentials = await runtime.listCredentials();
  const configured = new Set(credentials.map((credential) => credential.providerId));
  const oauthProviders = new Set(
    credentials.filter((credential) => credential.type === "oauth").map((credential) => credential.providerId),
  );

  // Prefer subscription/OAuth providers for unattended web sessions. This keeps
  // scheduled jobs from accidentally using an unrelated API-key env var inherited
  // by the wayang process.
  const storedOAuthProvider = firstConfiguredProvider(
    registry,
    STORED_AUTH_PROVIDER_PREFERENCE.filter((provider) => configured.has(provider) && oauthProviders.has(provider)),
  );
  if (storedOAuthProvider) return storedOAuthProvider;

  for (const [provider, envVars] of Object.entries(PROVIDER_ENV_MAP)) {
    if (envVars.some((v) => process.env[v]) && providerHasConfiguredModel(registry, provider)) return provider;
  }

  return (
    firstConfiguredProvider(registry, STORED_AUTH_PROVIDER_PREFERENCE.filter((provider) => configured.has(provider))) ||
    firstConfiguredProvider(registry, configured)
  );
}

function formatLoadErrors(errors: string[]): string | undefined {
  return errors.length > 0 ? errors.join("\n") : undefined;
}

export function resolveReviewedExternalModels(
  agentDir: string,
  entries: readonly ReviewedExternalModelEntry[] = REVIEWED_EXTERNAL_MODELS,
): { models: WebModelInfo[]; errors: string[] } {
  const models: WebModelInfo[] = [];
  const errors: string[] = [];
  const homeDir = path.resolve(agentDir, "..", "..");

  for (const entry of entries) {
    const extensionPath = path.join(agentDir, "extensions", entry.extensionPath);
    let digest: string;
    let artifactFd: number | undefined;
    try {
      artifactFd = fs.openSync(
        extensionPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = fs.fstatSync(artifactFd);
      if (!stat.isFile()) {
        errors.push(`Reviewed provider artifact "${entry.extensionPath}" is unsafe; refusing to list it`);
        continue;
      }
      // Hash bytes from the same no-follow descriptor that was fstat-verified.
      digest = createHash("sha256").update(fs.readFileSync(artifactFd)).digest("hex");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code === "ELOOP") {
        errors.push(`Reviewed provider artifact "${entry.extensionPath}" is unsafe; refusing to list it`);
      } else if (code !== "ENOENT") {
        errors.push(`Reviewed provider artifact "${entry.extensionPath}" could not be verified`);
      }
      continue;
    } finally {
      if (artifactFd !== undefined) fs.closeSync(artifactFd);
    }
    if (digest !== entry.sha256) {
      errors.push(`Reviewed provider artifact "${entry.extensionPath}" hash mismatch; refusing to list it`);
      continue;
    }

    let available = true;
    if (entry.credentialRelativeToHome) {
      const credentialPath = path.join(homeDir, entry.credentialRelativeToHome);
      let credentialFd: number | undefined;
      try {
        credentialFd = fs.openSync(
          credentialPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        available = fs.fstatSync(credentialFd).isFile();
      } catch {
        available = false;
      } finally {
        if (credentialFd !== undefined) fs.closeSync(credentialFd);
      }
    }
    models.push({
      provider: entry.model.provider,
      id: entry.model.id,
      name: entry.model.name,
      api: entry.model.api,
      reasoning: entry.model.reasoning,
      input: [...entry.model.input],
      contextWindow: entry.model.contextWindow,
      available,
    });
  }
  return { models, errors };
}

async function createStaticModelListingRegistry(
  agentDir: string,
): Promise<{ runtime: ModelRuntime; registry: ModelRegistry; error?: string }> {
  return createModelContext({ agentDir });
}

async function getModelListingRegistry(options?: {
  cwd?: string;
  agentDir?: string;
}): Promise<{ runtime: ModelRuntime; registry: ModelRegistry; error?: string }> {
  if (options?.cwd || options?.agentDir) {
    return createStaticModelListingRegistry(options.agentDir ?? getAgentDirPath());
  }
  if (_modelListingRuntime && _modelListingRegistry) {
    return { runtime: _modelListingRuntime, registry: _modelListingRegistry, error: _modelListingRegistryError };
  }
  _modelListingRegistryPromise ??= createStaticModelListingRegistry(getAgentDirPath()).then((result) => {
    _modelListingRuntime = result.runtime;
    _modelListingRegistry = result.registry;
    _modelListingRegistryError = result.error;
    return result;
  }).finally(() => {
    _modelListingRegistryPromise = null;
  });
  return _modelListingRegistryPromise;
}

function dynamicModelKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}

function getCachedDynamicModel(provider: string, modelId: string): Model<Api> | undefined {
  return _dynamicModelCache.models.find(
    (model) => String(model.provider) === provider && model.id === modelId,
  );
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function pricePerMillion(value: unknown): number {
  const parsed = parseFiniteNumber(value);
  return parsed === undefined ? 0 : parsed * 1_000_000;
}

function modelNameFromAnthropicId(modelId: string): string {
  return modelId
    .replace(/^claude-/, "Claude ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function findProviderTemplate(registry: ModelRegistry, provider: string, preferredId?: string): Model<Api> | undefined {
  if (preferredId) {
    const preferred = registry.find(provider, preferredId) || getCachedDynamicModel(provider, preferredId);
    if (preferred) return preferred;
  }
  return registry.getAll().find((model) => String(model.provider) === provider);
}

function findAnthropicFamilyTemplate(registry: ModelRegistry, family: string, major: string, beforeMinor?: number): Model<Api> | undefined {
  const candidates = registry
    .getAll()
    .filter((model) => String(model.provider) === "anthropic")
    .map((model) => {
      const match = new RegExp(`^claude-${family}-${major}-(\\d+)(?:-|$)`).exec(model.id);
      return { model, minor: match ? Number(match[1]) : -1 };
    })
    .filter(({ minor }) => minor >= 0 && (beforeMinor === undefined || minor <= beforeMinor))
    .sort((a, b) => b.minor - a.minor);
  return candidates[0]?.model || findProviderTemplate(registry, "anthropic");
}

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DYNAMIC_MODEL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function openRouterModelToModel(registry: ModelRegistry, raw: Record<string, unknown>): Model<Api> | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;

  const template = findProviderTemplate(registry, "openrouter", id) || findProviderTemplate(registry, "openrouter");
  if (!template) return null;

  const pricing = (raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {}) as Record<string, unknown>;
  const architecture = (raw.architecture && typeof raw.architecture === "object" ? raw.architecture : {}) as Record<string, unknown>;
  const topProvider = (raw.top_provider && typeof raw.top_provider === "object" ? raw.top_provider : {}) as Record<string, unknown>;
  const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
  const supportedParameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];

  return {
    ...template,
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : id,
    reasoning:
      supportedParameters.includes("reasoning") ||
      supportedParameters.includes("include_reasoning") ||
      template.reasoning,
    input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: {
      input: pricePerMillion(pricing.prompt),
      output: pricePerMillion(pricing.completion),
      cacheRead: pricePerMillion(pricing.input_cache_read),
      cacheWrite: pricePerMillion(pricing.input_cache_write),
    },
    contextWindow:
      parseFiniteNumber(topProvider.context_length) ??
      parseFiniteNumber(raw.context_length) ??
      template.contextWindow,
    maxTokens:
      parseFiniteNumber(topProvider.max_completion_tokens) ??
      parseFiniteNumber((raw as Record<string, unknown>).max_completion_tokens) ??
      template.maxTokens,
  };
}

function togetherModelToModel(registry: ModelRegistry, raw: Record<string, unknown>): Model<Api> | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  const spec = CURATED_TOGETHER_MODELS[id];
  if (!id || !spec || (raw.type !== "chat" && raw.type !== "code")) return null;

  const existing = registry.find("together", id);
  const template = existing
    || findProviderTemplate(registry, "together", "zai-org/GLM-5.2")
    || findProviderTemplate(registry, "together");
  if (!template) return null;

  const pricing = (raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {}) as Record<string, unknown>;
  const inputPrice = parseFiniteNumber(pricing.input);
  const outputPrice = parseFiniteNumber(pricing.output);
  const cacheReadPrice = parseFiniteNumber(pricing.cached_input);

  return {
    ...template,
    id,
    name: typeof raw.display_name === "string" && raw.display_name ? raw.display_name : id,
    provider: "together",
    baseUrl: "https://api.together.ai/v1",
    reasoning: existing?.reasoning ?? spec.reasoning,
    thinkingLevelMap: spec.thinkingLevelMap ?? existing?.thinkingLevelMap,
    input: existing?.input ?? spec.input,
    cost: {
      input: inputPrice ?? existing?.cost.input ?? 0,
      output: outputPrice ?? existing?.cost.output ?? 0,
      cacheRead: cacheReadPrice ?? existing?.cost.cacheRead ?? 0,
      cacheWrite: 0,
    },
    contextWindow: parseFiniteNumber(raw.context_length) ?? existing?.contextWindow ?? template.contextWindow,
    maxTokens: existing?.maxTokens ?? spec.maxTokens,
    compat: {
      ...template.compat,
      ...existing?.compat,
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: spec.reasoning,
      maxTokensField: "max_tokens",
      thinkingFormat: "together",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
  } as Model<Api>;
}

async function fetchTogetherDynamicModels(registry: ModelRegistry): Promise<Model<Api>[]> {
  const template = findProviderTemplate(registry, "together", "zai-org/GLM-5.2")
    || findProviderTemplate(registry, "together");
  if (!template || !registry.hasConfiguredAuth(template)) return [];

  const auth = await registry.getApiKeyAndHeaders(template);
  if (!auth.ok || !auth.apiKey) return [];
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(auth.headers ?? {}),
  };
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }

  const json = await fetchJsonWithTimeout("https://api.together.ai/v1/models", { headers });
  const data = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
      ? (json as { data: unknown[] }).data
      : [];

  return curateTogetherModelRecords(data)
    .map((entry) => togetherModelToModel(registry, entry))
    .filter((model): model is Model<Api> => !!model);
}

function anthropicModelFromOpenRouterModel(registry: ModelRegistry, openRouterModel: Model<Api>): Model<Api> | null {
  const match = /^anthropic\/claude-(opus|sonnet|haiku)-(\d+)\.(\d+)$/.exec(openRouterModel.id);
  if (!match) return null;

  const [, family, major, minorText] = match;
  const minor = Number(minorText);
  const directId = `claude-${family}-${major}-${minorText}`;
  if (registry.find("anthropic", directId) || getCachedDynamicModel("anthropic", directId)) return null;

  const template = findAnthropicFamilyTemplate(registry, family, major, Number.isFinite(minor) ? minor - 1 : undefined);
  if (!template) return null;

  return {
    ...template,
    id: directId,
    name: openRouterModel.name.replace(/^Anthropic:\s*/i, "") || modelNameFromAnthropicId(directId),
    reasoning: openRouterModel.reasoning || template.reasoning,
    input: openRouterModel.input,
    cost: openRouterModel.cost,
    contextWindow: openRouterModel.contextWindow,
    maxTokens: openRouterModel.maxTokens,
  };
}

async function fetchOpenRouterDynamicModels(registry: ModelRegistry): Promise<Model<Api>[]> {
  const json = await fetchJsonWithTimeout("https://openrouter.ai/api/v1/models", {
    headers: { accept: "application/json" },
  });
  const data = json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
    ? ((json as { data: unknown[] }).data)
    : [];
  const openRouterModels = data
    .map((entry) => (entry && typeof entry === "object" ? openRouterModelToModel(registry, entry as Record<string, unknown>) : null))
    .filter((model): model is Model<Api> => !!model);

  const anthropicModels = openRouterModels
    .map((model) => anthropicModelFromOpenRouterModel(registry, model))
    .filter((model): model is Model<Api> => !!model);

  return [...openRouterModels, ...anthropicModels];
}

async function fetchAnthropicDynamicModels(registry: ModelRegistry): Promise<Model<Api>[]> {
  // Claude subscription/OAuth credentials can be valid for messages while the
  // public model-list endpoint rejects them. OpenRouter's public catalog still
  // lets us derive current canonical Anthropic model IDs for the picker.
  const template = findProviderTemplate(registry, "anthropic", "claude-opus-4-7");
  if (!template || registry.isUsingOAuth(template) || !registry.hasConfiguredAuth(template)) return [];

  const auth = await registry.getApiKeyAndHeaders(template);
  if (!auth.ok || !auth.apiKey) return [];

  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    ...(auth.headers ?? {}),
  };
  if (auth.apiKey.includes("sk-ant-oat")) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = auth.apiKey;
  }

  const json = await fetchJsonWithTimeout(new URL("/v1/models", template.baseUrl).toString(), { headers });
  const data = json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
    ? ((json as { data: unknown[] }).data)
    : [];

  return data
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id : "";
      if (!id) return null;
      const familyMatch = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/.exec(id);
      const familyTemplate = familyMatch
        ? findAnthropicFamilyTemplate(registry, familyMatch[1], familyMatch[2], Number(familyMatch[3]) - 1)
        : template;
      return {
        ...(familyTemplate || template),
        id,
        name:
          (typeof raw.display_name === "string" && raw.display_name) ||
          (typeof raw.name === "string" && raw.name) ||
          modelNameFromAnthropicId(id),
      } as Model<Api>;
    })
    .filter((model): model is Model<Api> => !!model);
}

async function refreshDynamicModels(registry: ModelRegistry, force = false): Promise<DynamicModelCache> {
  if (!force && Date.now() - _dynamicModelCache.fetchedAt < DYNAMIC_MODEL_REFRESH_MS) {
    return _dynamicModelCache;
  }
  if (_dynamicModelRefreshPromise) return _dynamicModelRefreshPromise;

  _dynamicModelRefreshPromise = (async () => {
    const errors: string[] = [];
    const modelGroups = await Promise.all([
      fetchTogetherDynamicModels(registry).catch((error) => {
        errors.push(`Together live model list failed: ${error instanceof Error ? error.message : String(error)}`);
        return [] as Model<Api>[];
      }),
      fetchOpenRouterDynamicModels(registry).catch((error) => {
        errors.push(`OpenRouter live model list failed: ${error instanceof Error ? error.message : String(error)}`);
        return [] as Model<Api>[];
      }),
      fetchAnthropicDynamicModels(registry).catch((error) => {
        errors.push(`Anthropic live model list failed: ${error instanceof Error ? error.message : String(error)}`);
        return [] as Model<Api>[];
      }),
    ]);
    const builtInKeys = new Set(registry.getAll().map((model) => dynamicModelKey(String(model.provider), model.id)));
    const dynamic = uniqueModels(modelGroups.flat()).filter(
      (model) => String(model.provider) === "together"
        || !builtInKeys.has(dynamicModelKey(String(model.provider), model.id)),
    );
    _dynamicModelCache = {
      fetchedAt: Date.now(),
      models: dynamic,
      error: errors.length > 0 && dynamic.length === 0 ? formatLoadErrors(errors) : undefined,
    };
    return _dynamicModelCache;
  })().finally(() => {
    _dynamicModelRefreshPromise = null;
  });

  return _dynamicModelRefreshPromise;
}

function resolveModelFromRegistry(registry: ModelRegistry, provider: string, modelId: string): Model<Api> | undefined {
  if (!isWayangProviderVisible(provider)) return undefined;
  return (
    getCachedDynamicModel(provider, modelId) ||
    registry.find(provider, modelId) ||
    (getModel(provider as any, modelId as any) as Model<Api> | undefined)
  );
}

function resolveRestrictedDefaultModel(settingsManager: SettingsManager, registry: ModelRegistry): Model<Api> | undefined {
  const settingsProvider = settingsManager.getDefaultProvider();
  const settingsModel = settingsManager.getDefaultModel();
  if (settingsProvider && settingsModel) {
    const selected = resolveModelFromRegistry(registry, settingsProvider, settingsModel);
    if (selected && registry.hasConfiguredAuth(selected)) return selected;
  }
  for (const provider of STORED_AUTH_PROVIDER_PREFERENCE) {
    const preferred = resolveModelFromRegistry(registry, provider, DEFAULT_MODELS[provider] ?? "");
    if (preferred && registry.hasConfiguredAuth(preferred)) return preferred;
    const fallback = registry.getAll().find((model) => isWayangProviderVisible(String(model.provider)) && String(model.provider) === provider && registry.hasConfiguredAuth(model));
    if (fallback) return fallback;
  }
  return registry.getAll().find((model) => isWayangProviderVisible(String(model.provider)) && registry.hasConfiguredAuth(model));
}

function combineModelErrors(...errors: Array<string | undefined>): string | undefined {
  return formatLoadErrors(errors.filter((error): error is string => !!error));
}

function modelToWebInfo(registry: ModelRegistry, model: Model<Api>): WebModelInfo {
  return {
    provider: String(model.provider),
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    available: registry.hasConfiguredAuth(model),
  };
}

function uniqueModels(models: Model<Api>[]): Model<Api>[] {
  const seen = new Set<string>();
  const result: Model<Api>[] = [];
  for (const model of models) {
    const key = dynamicModelKey(String(model.provider), model.id);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

export async function listModels(options: {
  refresh?: boolean;
  /** Synthetic-test/internal overrides; API callers use the safe defaults. */
  cwd?: string;
  agentDir?: string;
  includeDynamicModels?: boolean;
  reviewedExternalModels?: readonly ReviewedExternalModelEntry[];
} = {}): Promise<{ models: WebModelInfo[]; defaultModel: WebDefaultModelInfo | null; error?: string }> {
  const listing = await getModelListingRegistry(options);
  const registry = listing.registry;
  const dynamicModels = options.includeDynamicModels === false
    ? { fetchedAt: Date.now(), models: [] as Model<Api>[], error: undefined }
    : await refreshDynamicModels(registry, options.refresh ?? false);
  const reviewed = resolveReviewedExternalModels(
    options.agentDir ?? getAgentDirPath(),
    options.reviewedExternalModels ?? REVIEWED_EXTERNAL_MODELS,
  );
  const models = uniqueModels([...dynamicModels.models, ...registry.getAll()])
    .filter((model) => isWayangProviderVisible(String(model.provider)))
    .filter((model) => String(model.provider) !== "together" || isCuratedTogetherModel(model.id))
    .map((model) => modelToWebInfo(registry, model));
  const seenModelKeys = new Set(models.map((model) => dynamicModelKey(model.provider, model.id)));
  for (const model of reviewed.models) {
    const key = dynamicModelKey(model.provider, model.id);
    if (!seenModelKeys.has(key)) {
      models.push(model);
      seenModelKeys.add(key);
    }
  }
  const providerSelectable = new Map<string, boolean>();
  for (const model of models) {
    providerSelectable.set(
      model.provider,
      (providerSelectable.get(model.provider) ?? false) || model.available,
    );
  }
  models.sort((a, b) => {
    const providerAvailabilityCompare = Number(providerSelectable.get(b.provider)) - Number(providerSelectable.get(a.provider));
    if (providerAvailabilityCompare !== 0) return providerAvailabilityCompare;

    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) return providerCompare;

    const modelAvailabilityCompare = Number(b.available) - Number(a.available);
    if (modelAvailabilityCompare !== 0) return modelAvailabilityCompare;

    return a.name.localeCompare(b.name);
  });

  const settingsManager = SettingsManager.create(options.cwd ?? process.cwd(), options.agentDir ?? getAgentDirPath());
  const defaultModel = resolveRestrictedDefaultModel(settingsManager, registry);

  return {
    models,
    defaultModel: defaultModel
      ? { provider: String(defaultModel.provider), id: defaultModel.id, name: defaultModel.name }
      : null,
    error: combineModelErrors(
      registry.getError(),
      listing.error,
      dynamicModels.error,
      formatLoadErrors(reviewed.errors),
    ),
  };
}

async function getSessionModelSelectionRegistry(id: string): Promise<ModelRegistry> {
  if (!getSessionById(id)) throw new WorkspaceStoreError("Session not found", 404);
  // Provider/model availability is independent of Project/Profile authority.
  // Every selection uses the same declarative + reviewed provider bootstrap in
  // a fresh registry; resource extensions never pre-populate this surface.
  return (await createModelContext({ includeReviewedProviders: true })).registry;
}

async function getSessionModelContext(_restricted: boolean): Promise<ModelContext> {
  // Per-session runtimes prevent one Project's trusted resource extensions from
  // changing provider routing for a later session in another Project.
  return createModelContext({ includeReviewedProviders: true });
}

/** Deny the old runtime synchronously, then wait until every old surface and
 * independently active host child is gone. Durable pair associations are unchanged. */
async function stopRuntimeForModelChange(
  id: string,
  row: SessionRow,
  targetProvider: string | null,
  targetModel: string | null,
  forceLiveStop = false,
): Promise<boolean> {
  const handle = sessions.get(id);
  const liveModelMatches = !handle || (
    !handle.capabilityAuthorityDenied
    && targetProvider !== null && targetModel !== null
    && String(handle.session.model?.provider) === targetProvider
    && handle.session.model?.id === targetModel
  );
  if (row.provider === targetProvider && row.model === targetModel && liveModelMatches
    && !(forceLiveStop && (sessions.has(id) || sessionCreations.has(id)))) return false;
  if (handle && (
    handle.session.isStreaming
    || (handle.session.pendingMessageCount ?? 0) > 0
    || manualCompactionQueueForHandle(handle)
  )) {
    throw new WorkspaceStoreError("Live model changes require an idle session; stop the session and retry", 409);
  }
  const browserTeardown: PiSessionBrowserTeardown = { kind: "detach", reason: "model_or_agent_switch" };
  latchPiSessionCapabilityDenial([id], sessions, browserTeardown);
  await stopPiSession(id, browserTeardown);
  return true;
}

function assertModelSwitchIdle(id: string): void {
  const handle = sessions.get(id);
  if (handle && (
    handle.session.isStreaming
    || (handle.session.pendingMessageCount ?? 0) > 0
    || manualCompactionQueueForHandle(handle)
  )) {
    throw new WorkspaceStoreError("Live model changes require an idle session; stop the session and retry", 409);
  }
}

async function withModelMutationLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  if (!lockRuntimeMutationSession(id)) {
    throw new WorkspaceStoreError("Session runtime is rebuilding after a settings change", 409);
  }
  try {
    return await operation();
  } finally {
    unlockRuntimeMutationSession(id);
  }
}

export async function setSessionModel(
  id: string,
  provider: string,
  modelId: string,
): Promise<{ provider: string; model: string; name: string }> {
  return withModelMutationLock(id, async () => {
    const row = getSessionById(id);
    if (!row) throw new WorkspaceStoreError("Session not found", 404);
    assertModelSwitchIdle(id);
    const registry = await getSessionModelSelectionRegistry(id);
    let model = resolveModelFromRegistry(registry, provider, modelId);
    if (!model) {
      await refreshDynamicModels(registry);
      model = resolveModelFromRegistry(registry, provider, modelId);
    }
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    if (!registry.hasConfiguredAuth(model)) throw new Error(`No API key for ${model.provider}/${model.id}`);

    await stopRuntimeForModelChange(id, row, provider, modelId);
    // Persistence happens only after the old loader, hooks, tools, host process,
    // browser lease, and queues have been fully destroyed. Next use constructs
    // fresh surfaces from the unchanged Project-Agent associations.
    updateSessionModel(id, model.id, String(model.provider));
    return { provider: String(model.provider), model: model.id, name: model.name };
  });
}

export async function setSessionDefaultModel(
  id: string,
): Promise<{ provider: string; model: string; name: string }> {
  return withModelMutationLock(id, async () => {
    const row = getSessionById(id);
    if (!row) throw new WorkspaceStoreError("Session not found", 404);
    assertModelSwitchIdle(id);
    const registry = await getSessionModelSelectionRegistry(id);
    await refreshDynamicModels(registry);
    const settingsManager = SettingsManager.create(row.cwd, getAgentDirPath());
    const defaultModel = resolveRestrictedDefaultModel(settingsManager, registry);
    if (!defaultModel) throw new Error("No default model is available");
    if (!registry.hasConfiguredAuth(defaultModel)) {
      throw new Error(`No API key for ${defaultModel.provider}/${defaultModel.id}`);
    }
    await stopRuntimeForModelChange(id, row, null, null, true);
    updateSessionModel(id, null, null);
    return { provider: String(defaultModel.provider), model: defaultModel.id, name: defaultModel.name };
  });
}

function findAgentSwitchMarker(manager: SessionManager, switchId: string): any | undefined {
  return manager.getEntries().find((entry: any) => (
    entry.type === "custom"
    && entry.customType === "wayang-agent-change"
    && entry.data?.switch_id === switchId
  ));
}

/** Reconcile the JSON-store/JSONL transaction gap before opening a runtime. */
export function reconcilePendingAgentSwitch(sessionRow: SessionRow): SessionRow {
  const pending = sessionRow.pending_agent_switch;
  if (!pending) return sessionRow;
  if (sessionRow.pi_session_file && fs.existsSync(sessionRow.pi_session_file)) {
    const manager = SessionManager.open(sessionRow.pi_session_file, undefined, sessionRow.cwd);
    if (findAgentSwitchMarker(manager, pending.switch_id)) {
      return completeAgentSwitch(sessionRow.id, pending.switch_id);
    }
    const restored = manager.buildSessionContext().model;
    if (
      pending.from_provider && pending.from_model
      && (restored?.provider !== pending.from_provider || restored?.modelId !== pending.from_model)
    ) {
      manager.appendModelChange(pending.from_provider, pending.from_model);
    }
  }
  return rollbackAgentSwitch(sessionRow.id, pending.switch_id);
}

function resolveAuthorizedRuntimeIdentity(
  id: string,
  cwd: string,
  profileOverride?: AgentProfileRow,
): { row: SessionRow; project: ProjectRow; agentProfile: AgentProfileRow } {
  let row = getSessionById(id);
  if (!row) throw new WorkspaceStoreError("Session not found", 404);
  if (row.legacy_private_session_quarantine !== false) {
    throw new WorkspaceStoreError("Quarantined legacy sessions are runtime-ineligible", 403);
  }
  const project = getProjectByCwd(cwd);
  if (!project) throw new WorkspaceStoreError("Project is not registered", 403);

  let profile = profileOverride;
  if (!profile) {
    const profileId = row.agent_profile_id ?? project.default_agent_profile_id;
    profile = getAgentProfile(profileId);
    if (!profile) throw new WorkspaceStoreError("Session agent profile was not found", 409);
    if (!row.agent_profile_id) {
      updateSessionAgentProfile(id, profile.id);
      row = getSessionById(id)!;
    }
  }
  const authorization = authorizeProjectAction({ cwd, actor: "interactive", agentProfileId: profile.id });
  if (!authorization.allowed) throw new WorkspaceStoreError(authorization.reason ?? "Project action denied", 403);
  return { row, project, agentProfile: profile };
}

export interface AgentSwitchPreview {
  session_id: string;
  from_agent_profile_id: string | null;
  from_agent_name: string | null;
  to_agent_profile_id: string;
  to_agent_name: string;
  current_provider: string | null;
  current_model: string | null;
  target_provider: string;
  target_model: string;
  memory_access: AgentProfileRow["memory_access"];
  transcript_retained: true;
  warning: string;
}

async function resolveAgentSwitchTarget(sessionRow: SessionRow, targetProfileId: string): Promise<{
  project: ProjectRow;
  profile: AgentProfileRow;
  model: Model<Api>;
}> {
  const project = getProjectByCwd(sessionRow.cwd);
  if (!project) throw new WorkspaceStoreError("Project is not registered", 403);
  const profile = getAgentProfile(targetProfileId);
  if (!profile) throw new WorkspaceStoreError("Target agent profile not found", 404);
  if (!profile.enabled) throw new WorkspaceStoreError("Target agent profile is disabled", 409);
  const effective = resolveEffectiveSessionConfig({ project, agentProfile: profile, purpose: "switch" });

  // Model choice is not Project/Profile authority. Agent-switch preview uses
  // the same isolated deployment-global provider registry as runtime startup.
  const registry = (await createModelContext({ includeReviewedProviders: true })).registry;
  let model: Model<Api> | undefined;
  if (effective.provider && effective.model) {
    model = resolveModelFromRegistry(registry, effective.provider, effective.model);
    if (!model) {
      await refreshDynamicModels(registry);
      model = resolveModelFromRegistry(registry, effective.provider, effective.model);
    }
  } else {
    const settings = SettingsManager.create(sessionRow.cwd, getAgentDirPath());
    model = resolveRestrictedDefaultModel(settings, registry);
  }
  if (!model) throw new WorkspaceStoreError("Target agent has no usable default provider/model", 409);
  if (!registry.hasConfiguredAuth(model)) {
    throw new WorkspaceStoreError(`No API key for ${model.provider}/${model.id}`, 409);
  }
  return { project, profile, model };
}

export async function previewSessionAgentSwitch(id: string, targetProfileId: string): Promise<AgentSwitchPreview> {
  const row = getSessionById(id);
  if (!row) throw new WorkspaceStoreError("Session not found", 404);
  const target = await resolveAgentSwitchTarget(row, targetProfileId);
  const from = row.agent_profile_id ? getAgentProfile(row.agent_profile_id) : undefined;
  return {
    session_id: id,
    from_agent_profile_id: row.agent_profile_id ?? null,
    from_agent_name: from?.name ?? null,
    to_agent_profile_id: target.profile.id,
    to_agent_name: target.profile.name,
    current_provider: row.provider,
    current_model: row.model,
    target_provider: String(target.model.provider),
    target_model: target.model.id,
    memory_access: target.profile.memory_access,
    transcript_retained: true,
    warning: "The new agent retains the existing transcript; its identity, resources, tools, and model may change.",
  };
}

export interface AgentSwitchResult {
  switch_id: string;
  session: SessionRow;
  preview: AgentSwitchPreview;
}

export type InteractiveBrowserFactory = (
  binding: ProtectedBrowserBinding,
) => CapabilityBoundInteractiveBrowserToolRuntime | Promise<CapabilityBoundInteractiveBrowserToolRuntime>;
/** Protected production remains a concrete subtype of the neutral factory. */
export type ProtectedBrowserFactory = (binding: ProtectedBrowserBinding) => ProtectedBrowserToolRuntime | Promise<ProtectedBrowserToolRuntime>;
export type ProtectedAutomationFactory = (options: {
  binding: ProtectedAutomationBinding;
  isRuntimeCurrent(): boolean;
}) => ProtectedAutomationToolRuntime | Promise<ProtectedAutomationToolRuntime>;
export type FileAudioExperimentFactory = (options: {
  binding: FileAudioExperimentBinding;
  getCurrentTurn(): BrowserTurnProvenance | null;
  isRuntimeCurrent(): boolean;
  permitTtlMs: number;
}) => FileAudioExperimentRuntime | Promise<FileAudioExperimentRuntime>;

export function fileAudioExperimentRuntimeIsEligible(input: {
  enabled: boolean;
  session: SessionRow;
  profile: AgentProfileRow;
  project: ProjectRow;
}): boolean {
  return input.enabled
    && input.session.scheduled_job_id === null
    && input.session.scheduled_run_id === null
    && isLegacyWrenStandardRuntime(input);
}

export type PiSessionCreationPrivilegedEffect =
  | "resource_loader"
  | "restricted_mcp_runtime"
  | "protected_browser_runtime"
  | "protected_automation_runtime"
  | "file_audio_experiment_runtime"
  | "agent_session"
  | "extension_lifecycle"
  | "handle_publication";

export interface CreatePiSessionRuntimeOptions {
  profileOverride?: AgentProfileRow;
  skipPendingRecovery?: boolean;
  forceInMemorySettings?: boolean;
  /** Synthetic/internal override. Interactive production sessions normally use
   * the factory installed once during application bootstrap. */
  protectedBrowserFactory?: InteractiveBrowserFactory;
  /** Synthetic/internal exact-return factory seam. Production uses the inert built-in factory. */
  protectedAutomationFactory?: ProtectedAutomationFactory;
  /** Synthetic/internal seam. Production remains inert until dependencies are installed. */
  fileAudioExperimentFactory?: FileAudioExperimentFactory;
  /** Deterministic regression seam. Production callers must leave this unset. */
  testHooks?: {
    afterStandardResourcesResolution?: (authorized: boolean) => Promise<void>;
    onPrivilegedEffect?: (effect: PiSessionCreationPrivilegedEffect) => void;
  };
}

let productionProtectedBrowserFactory: InteractiveBrowserFactory | undefined;
let productionInteractiveBrowserSessionLifecycle: InteractiveBrowserSessionLifecyclePort | undefined;
const interactiveBrowserLifecycleCleanupTasks = new Set<Promise<void>>();
const pendingInteractiveBrowserAuthority = new Map<string, {
  binding: Readonly<ProtectedBrowserBinding>;
  isCurrent(): boolean;
}>();
let productionFileAudioExperimentDependencies: FileAudioExperimentDependencies | undefined;

/** Adapter/media/DSP integration seam. Installation performs no file read,
 * DSP work, or provider call; an eligible enabled runtime still must preview
 * and execute a valid same-current-turn permit. */
export function installProductionFileAudioExperimentDependencies(
  dependencies: FileAudioExperimentDependencies,
): () => void {
  if (!dependencies || typeof dependencies.media?.inspect !== "function"
    || typeof dependencies.wrenAdapter?.analyze !== "function"
    || typeof dependencies.neutralAdapter?.analyze !== "function"
    || typeof dependencies.dsp?.analyze !== "function") {
    throw new WorkspaceStoreError("File-audio experiment dependencies are invalid", 500);
  }
  if (productionFileAudioExperimentDependencies && productionFileAudioExperimentDependencies !== dependencies) {
    throw new WorkspaceStoreError("File-audio experiment production dependencies are already installed", 409);
  }
  productionFileAudioExperimentDependencies = dependencies;
  return () => {
    if (productionFileAudioExperimentDependencies === dependencies) productionFileAudioExperimentDependencies = undefined;
  };
}

/** Install the inert production composition seam. Installing a factory never
 * creates a runtime or starts Chromium; only an eligible interactive session
 * construction may invoke it. */
export function installProductionProtectedBrowserFactory(factory: InteractiveBrowserFactory): () => void {
  if (typeof factory !== "function") throw new WorkspaceStoreError("Protected browser factory is invalid", 500);
  if (productionProtectedBrowserFactory && productionProtectedBrowserFactory !== factory) {
    throw new WorkspaceStoreError("Protected browser production factory is already installed", 409);
  }
  productionProtectedBrowserFactory = factory;
  return () => {
    if (productionProtectedBrowserFactory === factory) productionProtectedBrowserFactory = undefined;
  };
}

/** Install the process-level owner for Standard workspaces that may outlive Pi. */
export function installInteractiveBrowserSessionLifecyclePort(
  port: InteractiveBrowserSessionLifecyclePort,
): () => void {
  if (!port || typeof port.closeSessionWorkspaces !== "function"
    || typeof port.revokeAuthority !== "function" || typeof port.blocksPiIdleDetach !== "function"
    || typeof port.close !== "function") {
    throw new WorkspaceStoreError("Interactive browser session lifecycle port is invalid", 500);
  }
  if (productionInteractiveBrowserSessionLifecycle && productionInteractiveBrowserSessionLifecycle !== port) {
    throw new WorkspaceStoreError("Interactive browser session lifecycle port is already installed", 409);
  }
  productionInteractiveBrowserSessionLifecycle = port;
  return () => {
    if (productionInteractiveBrowserSessionLifecycle === port) productionInteractiveBrowserSessionLifecycle = undefined;
  };
}

function trackInteractiveBrowserLifecycleCleanup(task: Promise<void>): Promise<void> {
  interactiveBrowserLifecycleCleanupTasks.add(task);
  void task.then(
    () => interactiveBrowserLifecycleCleanupTasks.delete(task),
    () => interactiveBrowserLifecycleCleanupTasks.delete(task),
  );
  return task;
}

function getPiSessionCapabilityDenialGeneration(id: string): bigint {
  return sessionCapabilityDenialGenerations.get(id) ?? 0n;
}

function currentBrowserTeardownIntent(id: string): PiSessionBrowserTeardown | undefined {
  const intent = sessionBrowserTeardownIntents.get(id);
  return intent?.generation === getPiSessionCapabilityDenialGeneration(id) ? intent.action : undefined;
}

function clearBrowserTeardownIntent(id: string, generation: bigint): void {
  if (sessionBrowserTeardownIntents.get(id)?.generation === generation) {
    sessionBrowserTeardownIntents.delete(id);
  }
}

function assertPiSessionCreationGeneration(id: string, captured: bigint): void {
  if (getPiSessionCapabilityDenialGeneration(id) !== captured) {
    throw new WorkspaceStoreError("Session runtime creation was revoked; retry to create a fresh runtime", 409);
  }
}

async function closeUnpublishedAgentSession(session: AgentSession | undefined): Promise<void> {
  if (!session) return;
  const runtime = session as any;
  try { runtime.clearQueue?.(); } catch { /* best effort after denial */ }
  try { runtime.setActiveToolsByName?.([]); } catch { /* best effort after denial */ }
  if (Array.isArray(runtime.agent?.state?.tools)) runtime.agent.state.tools = [];
  try {
    if (session.isStreaming) await session.abort();
  } catch { /* best effort after denial */ }
  try { session.dispose(); } catch { /* best effort after denial */ }
}

export function piSessionHandleRequiresFreshRuntime(
  handle: Pick<PiSessionHandle, "capabilityAuthorityDenied" | "protectedBrowserRuntime" | "protectedAutomationRuntime" | "fileAudioExperimentRuntime">,
): boolean {
  if (handle.capabilityAuthorityDenied) return true;
  const browser = handle.protectedBrowserRuntime;
  if (browser) {
    const protectedBrowser = (browser as { browser?: { isRevoked?: boolean } }).browser;
    if (protectedBrowser?.isRevoked) return true;
    try { if (!browser.preflight().allowed) return true; }
    catch { return true; }
  }
  const automation = handle.protectedAutomationRuntime;
  if (automation) {
    try { if (!automation.preflight().allowed) return true; }
    catch { return true; }
  }
  const audio = handle.fileAudioExperimentRuntime;
  if (!audio) return false;
  try { return !audio.preflight().allowed; }
  catch { return true; }
}

/** Preserve the SDK's intentional unrestricted `undefined` policy. */
export function composeRuntimeActiveTools(
  configured: readonly string[] | undefined,
  companions: readonly string[],
): string[] | undefined {
  return configured === undefined
    ? undefined
    : [...new Set([...configured, ...companions])];
}

export async function createPiSession(
  id: string,
  cwd: string,
  provider: string | null = null,
  modelId: string | null = null,
  sessionFile?: string | null,
  runtimeOptions: CreatePiSessionRuntimeOptions = {},
): Promise<PiSessionHandle> {
  assertRuntimeMutationUnlocked(id);
  const existing = sessions.get(id);
  if (existing && !piSessionHandleRequiresFreshRuntime(existing)) {
    markSessionActivity(id);
    return existing;
  }
  // A denied handle or permanently revoked Protected-browser lease can never
  // be resumed. A later prompt destroys it before lazily constructing fresh
  // authority. The pair-keyed browser profile remains backend-owned.
  if (existing) await destroyPiSession(id);

  const pending = sessionCreations.get(id);
  if (pending) return pending;

  // Capture before the creation's first await and before publishing its promise.
  // A synchronous denial latch can therefore invalidate even a starting-only id.
  const denialGeneration = getPiSessionCapabilityDenialGeneration(id);
  const assertCreationCurrent = () => assertPiSessionCreationGeneration(id, denialGeneration);
  const creationStartedAt = performance.now();
  let pendingRestrictedMcpRuntime: RestrictedMcpRuntime | undefined;
  let pendingProtectedBrowserRuntime: CapabilityBoundInteractiveBrowserToolRuntime | undefined;
  let pendingProtectedBrowserTools: readonly ToolDefinition[] = Object.freeze([]);
  let pendingProtectedAutomationRuntime: ProtectedAutomationToolRuntime | undefined;
  let pendingFileAudioExperimentRuntime: FileAudioExperimentRuntime | undefined;
  let pendingAgentSession: AgentSession | undefined;
  const assertPendingBrowserCatalogCurrent = () => {
    if (!pendingProtectedBrowserRuntime) return;
    assertInteractiveBrowserToolCatalog(pendingProtectedBrowserRuntime);
    if (pendingProtectedBrowserRuntime.tools.length !== pendingProtectedBrowserTools.length
      || pendingProtectedBrowserTools.some((tool, index) => pendingProtectedBrowserRuntime!.tools[index] !== tool
        || pendingProtectedBrowserRuntime!.toolForName(tool.name) !== tool)) {
      throw new WorkspaceStoreError("Interactive browser runtime tool catalog changed after validation", 409);
    }
    let allowed = false;
    try { allowed = pendingProtectedBrowserRuntime.preflight().allowed; } catch { /* denied below */ }
    if (!allowed) throw new WorkspaceStoreError("Interactive browser runtime was revoked before publication", 409);
  };
  const creation = (async () => {
    assertCreationCurrent();
    await stopIdlePiSessions();
    assertCreationCurrent();
    if (sessions.size + sessionCreations.size > MAX_SESSIONS) {
      throw new Error(`Max sessions (${MAX_SESSIONS}) reached`);
    }

    let durableRow = getSessionById(id);
    if (!durableRow) throw new WorkspaceStoreError("Session not found", 404);
    if (durableRow.pending_agent_switch && !runtimeOptions.skipPendingRecovery) {
      durableRow = reconcilePendingAgentSwitch(durableRow);
      provider = durableRow.provider;
      modelId = durableRow.model;
    }
    assertCreationCurrent();
    const runtimeIdentity = resolveAuthorizedRuntimeIdentity(id, cwd, runtimeOptions.profileOverride);
    assertCreationCurrent();

    const extensionsStartedAt = performance.now();
    const standardResourcesWitness = resolveCurrentStandardResourcesWitness({
      sourceSessionId: runtimeIdentity.row.id,
      project: runtimeIdentity.project,
      agentProfile: runtimeIdentity.agentProfile,
    });
    assertCreationCurrent();
    if (runtimeOptions.testHooks?.afterStandardResourcesResolution) {
      await runtimeOptions.testHooks.afterStandardResourcesResolution(Boolean(standardResourcesWitness));
      assertCreationCurrent();
    }
    assertCreationCurrent();
    runtimeOptions.testHooks?.onPrivilegedEffect?.("resource_loader");
    assertCreationCurrent();
    const runtimeResources = await buildAgentResourceLoader({
      cwd,
      agentDir: getAgentDirPath(),
      agentProfile: runtimeIdentity.agentProfile,
      project: runtimeIdentity.project,
      sourceSessionId: id,
      forceInMemorySettings: runtimeOptions.forceInMemorySettings,
    });
    assertCreationCurrent();
    recordLatencyMetric("lazy_extensions_ms", performance.now() - extensionsStartedAt);

    const settingsModelStartedAt = performance.now();
    // Exact standard-resources-authorized sessions retain normal merged
    // settings. Restricted and switching runtimes use a merged in-memory snapshot so setModel cannot
    // change Pi's global defaults.
    const settingsManager = runtimeResources.settingsManager;

    // Restricted runtimes use a fresh registry, so provider registrations from
    // arbitrary global extensions already loaded elsewhere in this process
    // cannot bleed into this session.
    const modelContext = await getSessionModelContext(runtimeResources.restricted);
    const modelRegistry = modelContext.registry;

    // Prefer explicit web session settings, then a fully usable pi settings
    // provider/model pair, then credential-based provider detection. A provider
    // with auth is not enough: if settings contain a stale or mismatched model
    // id, passing no resolved model lets the SDK restore the old session model
    // from JSONL (for example OpenRouter DeepSeek) instead of the current web
    // default.
    let model: Model<Api> | undefined;
    if (provider && modelId) {
      model = resolveModelFromRegistry(modelRegistry, provider, modelId);
      if (!model) {
        assertCreationCurrent();
        await refreshDynamicModels(modelRegistry);
        assertCreationCurrent();
        model = resolveModelFromRegistry(modelRegistry, provider, modelId);
      }
      if (!model) {
        const providerError = modelContext.error ? `\n${modelContext.error}` : "";
        throw new Error(`Unknown model: ${provider}/${modelId}${providerError}`);
      }
      if (!modelRegistry.hasConfiguredAuth(model)) throw new Error(`No API key for ${model.provider}/${model.id}`);
    } else if (provider) {
      const preferred = resolveModelFromRegistry(modelRegistry, provider, DEFAULT_MODELS[provider] ?? "");
      model = preferred && modelRegistry.hasConfiguredAuth(preferred) ? preferred : undefined;
      if (!model) throw new Error(`No usable default model is available for provider ${provider}`);
    } else {
      model = runtimeResources.restricted
        ? resolveRestrictedDefaultModel(settingsManager, modelRegistry)
        : await resolveWebDefaultModel(settingsManager, modelContext);
      if (!model) {
        throw new Error(
          "No usable default model found. Set an API key environment variable (e.g., OPENROUTER_API_KEY, ANTHROPIC_API_KEY), configure a valid default provider/model in pi settings, or use /login to log into a provider.",
        );
      }
    }
    recordLatencyMetric("lazy_settings_model_ms", performance.now() - settingsModelStartedAt);

    // Generate a fresh process-local runtime epoch before composing privileged tools.
    const runtimeGeneration = randomUUID();
    let standardResourcesRuntimePublished = false;
    let protectedAutomationRuntimePublished = false;
    let protectedAutomationRuntimeForFence: ProtectedAutomationToolRuntime | undefined;
    let fileAudioExperimentRuntimePublished = false;
    let fileAudioExperimentRuntimeForFence: FileAudioExperimentRuntime | undefined;

    const getRestrictedMcpLiveContext = (): RestrictedMcpLiveContext | null => {
      const currentRow = getSessionById(id);
      if (!currentRow || currentRow.cwd !== cwd || currentRow.pending_agent_switch) return null;
      if (currentRow.agent_profile_id !== runtimeIdentity.agentProfile.id) return null;
      const activeHandle = sessions.get(id);
      if (activeHandle && activeHandle.runtimeGeneration !== runtimeGeneration) return null;
      const currentProject = getProjectByCwd(cwd);
      const currentProfile = getAgentProfile(runtimeIdentity.agentProfile.id);
      if (!currentProject || !currentProfile) return null;
      const authorization = authorizeProjectAction({ cwd, actor: "interactive", agentProfileId: currentProfile.id });
      if (!authorization.allowed) return null;
      return {
        sourceSessionId: id,
        runtimeGeneration,
        scheduledJobId: currentRow.scheduled_job_id,
        scheduledRunId: currentRow.scheduled_run_id,
        isSubagent: false,
        agentProfile: {
          id: currentProfile.id,
          enabled: currentProfile.enabled,
          resourceMode: currentProfile.resource_mode,
          memoryAccess: currentProfile.memory_access,
        },
        project: {
          cwd: currentProject.cwd,
          privacyMode: currentProject.access_policy.privacy_mode,
          allowedAgentProfileIds: currentProject.access_policy.allowed_agent_profile_ids,
        },
      };
    };
    assertCreationCurrent();
    runtimeOptions.testHooks?.onPrivilegedEffect?.("restricted_mcp_runtime");
    assertCreationCurrent();
    pendingRestrictedMcpRuntime = createRestrictedMcpRuntime({
      sourceSessionId: id,
      cwd,
      agentProfileId: runtimeIdentity.agentProfile.id,
      runtimeGeneration,
      getCurrentRuntime: getRestrictedMcpLiveContext,
    }) ?? undefined;
    assertCreationCurrent();

    const selectedProtectedBrowserFactory = runtimeOptions.protectedBrowserFactory ?? productionProtectedBrowserFactory;
    if (selectedProtectedBrowserFactory && isSessionCapabilityEligible(runtimeIdentity.row)
      && runtimeIdentity.row.pending_agent_switch === null
      && runtimeIdentity.row.scheduled_job_id === null && runtimeIdentity.row.scheduled_run_id === null) {
      assertCreationCurrent();
      const browserCapabilityId = runtimeIdentity.project.access_policy.privacy_mode === "standard"
        ? STANDARD_BROWSER_CAPABILITY_ID
        : PROTECTED_BROWSER_CAPABILITY_ID;
      const protectedResolution = resolveWorkspaceCapability({
        capability_id: browserCapabilityId,
        project_id: runtimeIdentity.project.id,
        agent_profile_id: runtimeIdentity.agentProfile.id,
      });
      assertCreationCurrent();
      if (protectedResolution.authorized) {
        const protectedBinding: ProtectedBrowserBinding = {
          capabilityId: browserCapabilityId,
          sourceSessionId: id,
          projectId: runtimeIdentity.project.id,
          projectCwd: runtimeIdentity.project.cwd,
          agentProfileId: runtimeIdentity.agentProfile.id,
          associationRevision: protectedResolution.association.revision,
          runtimeGeneration,
          processBootNonce: PROCESS_BOOT_NONCE,
          controlGeneration: 1,
        };
        assertCreationCurrent();
        runtimeOptions.testHooks?.onPrivilegedEffect?.("protected_browser_runtime");
        assertCreationCurrent();
        pendingInteractiveBrowserAuthority.set(id, {
          binding: { ...protectedBinding },
          isCurrent: () => {
            try { assertCreationCurrent(); return true; } catch { return false; }
          },
        });
        // The exact pending witness must remain live through every factory,
        // tool-catalog, extension, and final pre-publication check. Standard
        // runtimes reauthorize through this resolver, and no live handle exists
        // until sessions.set() below. Removing the witness when the factory
        // merely returns makes the mandatory next preflight revoke every fresh
        // Standard browser runtime before it can publish.
        pendingProtectedBrowserRuntime = await selectedProtectedBrowserFactory(protectedBinding);
        assertCreationCurrent();
        if (pendingProtectedBrowserRuntime) {
          assertInteractiveBrowserToolCatalog(pendingProtectedBrowserRuntime);
          pendingProtectedBrowserTools = Object.freeze([...pendingProtectedBrowserRuntime.tools]);
        }
        const returnedBinding = pendingProtectedBrowserRuntime?.binding;
        const expectedRuntimeKind = browserCapabilityId === STANDARD_BROWSER_CAPABILITY_ID ? "standard" : "protected";
        if (!pendingProtectedBrowserRuntime || !returnedBinding
          || pendingProtectedBrowserRuntime.kind !== expectedRuntimeKind
          || !exactProtectedBrowserBindingEqual(returnedBinding, protectedBinding)) {
          const pendingAuthority = pendingInteractiveBrowserAuthority.get(id);
          if (pendingAuthority && exactProtectedBrowserBindingEqual(pendingAuthority.binding, protectedBinding)) {
            pendingInteractiveBrowserAuthority.delete(id);
          }
          await pendingProtectedBrowserRuntime?.revokeAuthority("project_or_profile_denied").catch(() => undefined);
          pendingProtectedBrowserRuntime = undefined;
          throw new WorkspaceStoreError("Protected browser factory returned a non-exact runtime lease", 409);
        }
      }
    }

    const selectedProtectedAutomationFactory = runtimeOptions.protectedAutomationFactory ?? createProtectedAutomationToolRuntime;
    if (isSessionCapabilityEligible(runtimeIdentity.row)
      && runtimeIdentity.row.pending_agent_switch === null
      && runtimeIdentity.row.scheduled_job_id === null && runtimeIdentity.row.scheduled_run_id === null) {
      assertCreationCurrent();
      const automationResolution = resolveWorkspaceCapability({
        capability_id: "wayang.protected-automation.v1",
        project_id: runtimeIdentity.project.id,
        agent_profile_id: runtimeIdentity.agentProfile.id,
      });
      assertCreationCurrent();
      if (automationResolution.authorized) {
        const automationBinding: ProtectedAutomationBinding = {
          capabilityId: "wayang.protected-automation.v1",
          sourceSessionId: id,
          projectId: runtimeIdentity.project.id,
          projectCwd: runtimeIdentity.project.cwd,
          agentProfileId: runtimeIdentity.agentProfile.id,
          associationRevision: automationResolution.association.revision,
          runtimeGeneration,
          processBootNonce: PROCESS_BOOT_NONCE,
        };
        assertCreationCurrent();
        runtimeOptions.testHooks?.onPrivilegedEffect?.("protected_automation_runtime");
        assertCreationCurrent();
        pendingProtectedAutomationRuntime = await selectedProtectedAutomationFactory({
          binding: automationBinding,
          isRuntimeCurrent: () => {
            if (!protectedAutomationRuntimePublished) {
              try { assertCreationCurrent(); } catch { return false; }
              return pendingProtectedAutomationRuntime?.binding.runtimeGeneration === runtimeGeneration;
            }
            const active = sessions.get(id);
            return Boolean(active && !active.capabilityAuthorityDenied
              && active.runtimeGeneration === runtimeGeneration
              && active.protectedAutomationRuntime === protectedAutomationRuntimeForFence);
          },
        });
        protectedAutomationRuntimeForFence = pendingProtectedAutomationRuntime;
        assertCreationCurrent();
        if (!pendingProtectedAutomationRuntime
          || !exactProtectedAutomationBindingEqual(pendingProtectedAutomationRuntime.binding, automationBinding)) {
          await pendingProtectedAutomationRuntime?.close().catch(() => undefined);
          pendingProtectedAutomationRuntime = undefined;
          throw new WorkspaceStoreError("Protected automation factory returned a non-exact runtime lease", 409);
        }
      }
    }

    const audioConfig = getConfig().fileAudioExperiment;
    const selectedFileAudioExperimentFactory: FileAudioExperimentFactory | undefined = runtimeOptions.fileAudioExperimentFactory
      ?? (productionFileAudioExperimentDependencies
        ? ((factoryOptions: Parameters<FileAudioExperimentFactory>[0]) => createFileAudioExperimentRuntime({
            ...factoryOptions,
            dependencies: productionFileAudioExperimentDependencies!,
          }))
        : undefined);
    if (selectedFileAudioExperimentFactory && fileAudioExperimentRuntimeIsEligible({
      enabled: audioConfig.enabled,
      session: runtimeIdentity.row,
      profile: runtimeIdentity.agentProfile,
      project: runtimeIdentity.project,
    })) {
      const audioBinding: FileAudioExperimentBinding = {
        sourceSessionId: id,
        runtimeGeneration,
        processBootNonce: PROCESS_BOOT_NONCE,
        projectId: runtimeIdentity.project.id,
        projectCwd: runtimeIdentity.project.cwd,
        agentProfileId: runtimeIdentity.agentProfile.id,
        provider: String(model.provider),
        model: model.id,
      };
      assertCreationCurrent();
      runtimeOptions.testHooks?.onPrivilegedEffect?.("file_audio_experiment_runtime");
      assertCreationCurrent();
      pendingFileAudioExperimentRuntime = await selectedFileAudioExperimentFactory({
        binding: audioBinding,
        permitTtlMs: audioConfig.permitTtlMs,
        getCurrentTurn: () => {
          if (!fileAudioExperimentRuntimePublished) return null;
          const active = sessions.get(id);
          if (!active || active.capabilityAuthorityDenied
            || active.runtimeGeneration !== runtimeGeneration
            || active.fileAudioExperimentRuntime !== fileAudioExperimentRuntimeForFence) return null;
          return resolveInteractiveTurn(active);
        },
        isRuntimeCurrent: () => {
          if (!fileAudioExperimentRuntimePublished) {
            try { assertCreationCurrent(); } catch { return false; }
            return pendingFileAudioExperimentRuntime?.binding.runtimeGeneration === runtimeGeneration;
          }
          const active = sessions.get(id);
          const currentRow = getSessionById(id);
          const currentProject = currentRow ? getProjectByCwd(currentRow.cwd) : undefined;
          const currentProfile = currentRow?.agent_profile_id ? getAgentProfile(currentRow.agent_profile_id) : undefined;
          let currentlyEnabled = false;
          try { currentlyEnabled = getConfig().fileAudioExperiment.enabled; } catch { return false; }
          return Boolean(active && currentRow && currentProject && currentProfile
            && fileAudioExperimentRuntimeIsEligible({
              enabled: currentlyEnabled,
              session: currentRow,
              profile: currentProfile,
              project: currentProject,
            })
            && !active.capabilityAuthorityDenied
            && currentProject.id === audioBinding.projectId
            && currentRow.cwd === audioBinding.projectCwd
            && active.runtimeGeneration === runtimeGeneration
            && active.agentProfileId === audioBinding.agentProfileId
            && active.cwd === audioBinding.projectCwd
            && String(active.session.model?.provider) === audioBinding.provider
            && active.session.model?.id === audioBinding.model
            && active.fileAudioExperimentRuntime === fileAudioExperimentRuntimeForFence);
        },
      });
      fileAudioExperimentRuntimeForFence = pendingFileAudioExperimentRuntime;
      assertCreationCurrent();
      const returned = pendingFileAudioExperimentRuntime?.binding;
      if (!returned
        || returned.sourceSessionId !== audioBinding.sourceSessionId
        || returned.runtimeGeneration !== audioBinding.runtimeGeneration
        || returned.processBootNonce !== audioBinding.processBootNonce
        || returned.projectId !== audioBinding.projectId
        || returned.projectCwd !== audioBinding.projectCwd
        || returned.agentProfileId !== audioBinding.agentProfileId
        || returned.provider !== audioBinding.provider
        || returned.model !== audioBinding.model) {
        await pendingFileAudioExperimentRuntime?.close().catch(() => undefined);
        pendingFileAudioExperimentRuntime = undefined;
        throw new WorkspaceStoreError("File-audio experiment factory returned a non-exact runtime lease", 409);
      }
    }

    const transcriptStartedAt = performance.now();
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined, cwd)
      : SessionManager.create(cwd, undefined, { id });
    recordLatencyMetric("lazy_transcript_open_ms", performance.now() - transcriptStartedAt);

    const agentCreateStartedAt = performance.now();
    assertCreationCurrent();
    const creationAuthorization = authorizeProjectAction({
      cwd,
      actor: "interactive",
      agentProfileId: runtimeIdentity.agentProfile.id,
    });
    assertCreationCurrent();
    const hostCreationResolution = resolveWorkspaceCapability({
      capability_id: "wayang.host-execution.v1",
      project_id: runtimeIdentity.project.id,
      agent_profile_id: runtimeIdentity.agentProfile.id,
    });
    assertCreationCurrent();
    const hostCreationWitness = hostExecutionWitnessFromResolution(hostCreationResolution);
    const hostCreationDecision = resolveHostExecutionAuthorization({
      capabilityWitness: hostCreationWitness,
      row: runtimeIdentity.row,
      profile: runtimeIdentity.agentProfile,
      project: runtimeIdentity.project,
      requestedCwd: cwd,
      authorization: {
        allowed: creationAuthorization.allowed,
        projectId: creationAuthorization.project?.id,
        agentProfileId: creationAuthorization.agentProfile?.id,
      },
      isInteractive: runtimeIdentity.row.scheduled_job_id === null && runtimeIdentity.row.scheduled_run_id === null,
      isSubagent: false,
    });
    assertCreationCurrent();
    const bashSandbox = getBashSandboxAvailability();
    const selectedBashMode = selectWayangBashMode(hostCreationDecision, bashSandbox);
    const bashMode: HostExecutionMode = selectedBashMode === "sandboxed"
      && isLegacyWrenStandardRuntime({
        session: runtimeIdentity.row,
        profile: runtimeIdentity.agentProfile,
        project: runtimeIdentity.project,
      })
      ? "sandboxed-wren"
      : selectedBashMode;
    const excludeTools = [
      ...(runtimeResources.excludeTools ?? []),
      ...(bashMode === "unavailable" ? ["bash"] : []),
    ];
    if (bashMode === "unavailable") {
      console.warn(`[pi-bridge] bash removed for session ${id}: ${bashSandbox.reason ?? "OS sandbox unavailable"}`);
    }

    let trustedHostBashTool: TrustedHostBashTool | undefined;
    const reauthorizeHostExecution = (request: { command: string; cwd: string }) => {
      try {
        const activeHandle = sessions.get(id);
        const currentRow = getSessionById(id);
        const currentProfile = activeHandle ? getAgentProfile(activeHandle.agentProfileId) : undefined;
        const currentProject = activeHandle ? getProjectByCwd(activeHandle.cwd) : undefined;
        const currentAuthorization = activeHandle && currentProfile
          ? authorizeProjectAction({ cwd: activeHandle.cwd, actor: "interactive", agentProfileId: currentProfile.id })
          : { allowed: false, project: undefined, agentProfile: undefined };
        const registryTool = activeHandle ? (activeHandle.session as any)._toolRegistry?.get?.("bash") : undefined;
        const trust = trustedHostBashTool;
        const trustCurrent = Boolean(trust && !trust.revoked && trust.registryGuard?.checkCurrent());
        const currentResolution = currentProject && currentProfile
          ? resolveWorkspaceCapability({
              capability_id: "wayang.host-execution.v1",
              project_id: currentProject.id,
              agent_profile_id: currentProfile.id,
            })
          : { authorized: false as const, reason: "association_missing" as const };
        return resolveHostExecutionAuthorization({
          capabilityWitness: hostExecutionWitnessFromResolution(currentResolution),
          row: currentRow,
          profile: currentProfile,
          project: currentProject,
          requestedCwd: cwd,
          authorization: {
            allowed: currentAuthorization.allowed,
            projectId: currentAuthorization.project?.id,
            agentProfileId: currentAuthorization.agentProfile?.id,
          },
          isInteractive: Boolean(currentRow && currentRow.scheduled_job_id === null && currentRow.scheduled_run_id === null),
          isSubagent: false,
          execution: trust ? {
            selectedBashMode: activeHandle?.bashMode ?? "unavailable",
            expectedCapabilityWitness: trust.expectedCapabilityWitness,
            expectedRuntimeGeneration: runtimeGeneration,
            activeRuntimeGeneration: activeHandle?.runtimeGeneration,
            expectedProcessBootNonce: PROCESS_BOOT_NONCE,
            activeProcessBootNonce: PROCESS_BOOT_NONCE,
            activeHandleSessionId: activeHandle?.id,
            activeHandleAgentProfileId: activeHandle?.agentProfileId,
            activeHandleCwd: activeHandle?.cwd,
            spawnCwd: request.cwd,
            trustedToolDefinition: Boolean(
              trustCurrent && activeHandle && activeHandle.trustedHostBashTool === trust
              && registryTool === trust.executable && hasExactHostBashDefinition(activeHandle.session, trust.definition)
            ),
            trustedToolExecutable: Boolean(trustCurrent && typeof trust.execute === "function" && registryTool?.execute === trust.execute),
          } : undefined,
        });
      } catch (error) {
        return { allowed: false as const, reason: `Live host authorization failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    };
    const hostBashTool = bashMode === "host" && hostCreationDecision.allowed
      ? createHostBashToolDefinition(cwd, { authorizeExecution: reauthorizeHostExecution })
      : undefined;

    const configuredActiveTools = includeRestrictedMcpActiveTool(runtimeResources.tools, pendingRestrictedMcpRuntime);
    const companionActiveTools = [
      ...pendingProtectedBrowserTools.map((tool) => tool.name),
      ...(pendingProtectedAutomationRuntime ? [PROTECTED_AUTOMATION_TOOL_NAME] : []),
      ...(pendingFileAudioExperimentRuntime ? [FILE_AUDIO_EXPERIMENT_TOOL_NAME] : []),
    ];
    // `undefined` is an intentional SDK policy: preserve Pi's normal built-ins,
    // configured defaults, and reviewed extension tools. Converting it to an
    // explicit companion-only allowlist filters out the exact trusted host
    // bash definition (and every other normal tool) during runtime creation.
    // Restricted profiles already carry an explicit reviewed list, so only
    // that case is widened by the exact backend-owned companion names.
    const activeTools = composeRuntimeActiveTools(configuredActiveTools, companionActiveTools);

    // Provider/model routing is deployment-global and was fully resolved above.
    // Seal this fresh per-session runtime before the SDK binds project/global
    // resource extensions, preventing them from overwriting reviewed endpoints.
    sealSessionModelProviderRegistry(modelContext.runtime);

    assertCreationCurrent();
    assertPendingBrowserCatalogCurrent();
    runtimeOptions.testHooks?.onPrivilegedEffect?.("agent_session");
    assertCreationCurrent();
    const created = await createAgentSession({
      cwd,
      agentDir: getAgentDirPath(),
      model: model,
      modelRuntime: modelContext.runtime,
      sessionManager,
      settingsManager,
      resourceLoader: runtimeResources.resourceLoader,
      tools: activeTools,
      excludeTools: excludeTools.length > 0 ? [...new Set(excludeTools)] : undefined,
      customTools: createWayangSessionCustomTools({
        webSessionId: id,
        cwd,
        scheduledJobId: runtimeIdentity.row.scheduled_job_id,
        scheduledRunId: runtimeIdentity.row.scheduled_run_id,
        agentProfileId: runtimeIdentity.agentProfile.id,
      }, [
        ...(runtimeIdentity.row.scheduled_job_id === null && runtimeIdentity.row.scheduled_run_id === null
          ? createSessionInteropToolDefinitions(id)
          : []),
        ...(workspaceToolsAllowedForRuntime({
          restricted: runtimeResources.restricted,
          scheduledJobId: runtimeIdentity.row.scheduled_job_id,
          scheduledRunId: runtimeIdentity.row.scheduled_run_id,
        }) ? createWorkspaceToolDefinitions({ sourceSessionId: id }) : []),
        ...(pendingRestrictedMcpRuntime ? [pendingRestrictedMcpRuntime.tool] : []),
        ...pendingProtectedBrowserTools,
        ...(pendingProtectedAutomationRuntime ? [pendingProtectedAutomationRuntime.tool] : []),
        ...(pendingFileAudioExperimentRuntime ? [pendingFileAudioExperimentRuntime.tool] : []),
        ...(hostBashTool ? [hostBashTool] : []),
        ...(bashMode === "sandboxed" || bashMode === "sandboxed-wren"
          ? [createPolicySandboxedBashToolDefinition(cwd, id, bashMode)]
          : []),
      ]),
    });
    pendingAgentSession = created.session;
    assertCreationCurrent();
    const { session, extensionsResult } = created;
    recordLatencyMetric("lazy_agent_create_ms", performance.now() - agentCreateStartedAt);

    // The SDK constructor loads extension handlers, but lifecycle hooks (including
    // session_start) only run after bindExtensions(). wayang has no TUI context,
    // but still needs those hooks so web-aware extensions can register bridge
    // controllers such as the command guard status/toggle bridge.
    const extensionBindStartedAt = performance.now();
    assertCreationCurrent();
    // Identity-neutral Pi auto-title extensions defer to Wayang for these exact
    // manager objects, avoiding duplicate provider calls in the web runtime.
    const ownershipKey = Symbol.for("wayang.owned-session-managers.v1");
    const globals = globalThis as any;
    (globals[ownershipKey] ??= new WeakSet<object>()).add(session.sessionManager);
    assertCreationCurrent();
    runtimeOptions.testHooks?.onPrivilegedEffect?.("extension_lifecycle");
    assertCreationCurrent();
    await session.bindExtensions({
      shutdownHandler: () => {
        void destroyPiSession(id).catch((error) => {
          console.warn(`[pi-bridge] extension shutdown failed for session ${id}:`, error);
        });
      },
      onError: (error) => {
        console.warn(`[pi-bridge] extension error in session ${id}:`, error);
      },
    });
    assertCreationCurrent();
    recordLatencyMetric("lazy_extension_bind_ms", performance.now() - extensionBindStartedAt);

    if (hostBashTool && !resolveHostBashExecutable(session, hostBashTool)) {
      throw new WorkspaceStoreError("The trusted host bash definition was replaced during runtime creation", 409);
    }

    // Defense in depth: recognized direct lexical sudo syntax is blocked in
    // bash, while sudo_exec remains the supported reviewed privilege path.
    // Normal host bash is not containment against indirect privilege mechanisms.
    assertCreationCurrent();
    installWayangRawSudoFailClosedGuard(session, id);
    installAgentToolPolicyGuard(session, id, {
      restrictedMcpRuntime: pendingRestrictedMcpRuntime,
      standardResourcesWitness: runtimeResources.standardResourcesWitness,
      standardResourcesRuntimeFence: runtimeResources.standardResourcesWitness ? {
        runtimeGeneration,
        processBootNonce: PROCESS_BOOT_NONCE,
        isCurrent: () => {
          if (!standardResourcesRuntimePublished) {
            try { assertCreationCurrent(); }
            catch { return false; }
            return pendingAgentSession === session;
          }
          const active = sessions.get(id);
          return Boolean(
            active
            && active.session === session
            && !active.capabilityAuthorityDenied
            && active.runtimeGeneration === runtimeGeneration
          );
        },
      } : undefined,
      protectedBrowserRuntime: pendingProtectedBrowserRuntime,
      protectedAutomationRuntime: pendingProtectedAutomationRuntime,
      fileAudioExperimentRuntime: pendingFileAudioExperimentRuntime,
    });
    assertCreationCurrent();
    if (hostBashTool && hostCreationDecision.allowed) {
      const executable = resolveHostBashExecutable(session, hostBashTool);
      if (!executable) throw new WorkspaceStoreError("The trusted host bash executable drifted during guard installation", 409);
      if (typeof hostBashTool.revokeActiveExecutions !== "function") {
        throw new WorkspaceStoreError("The trusted host bash cancellation controller is unavailable", 409);
      }
      trustedHostBashTool = {
        definition: hostBashTool,
        executable,
        execute: executable.execute,
        expectedCapabilityWitness: hostCreationDecision.witness,
        revokeActiveExecutions: hostBashTool.revokeActiveExecutions,
        revoked: false,
      };
      const trust = trustedHostBashTool;
      trust.registryGuard = installHostBashRegistryGuard({
        session,
        definition: trust.definition,
        executable: trust.executable,
        execute: trust.execute,
        onRevoke: () => permanentlyRevokeHostBash(id, runtimeGeneration, trust),
      });
      if (!trust.registryGuard.checkCurrent()) throw new WorkspaceStoreError("Host bash trust was revoked during runtime creation", 409);
      assertCreationCurrent();
    }

    assertCreationCurrent();
    // A title supplied before the Pi file existed is human intent. Seed it
    // canonically before automatic naming can observe this manager.
    const titleSeedRow = getSessionById(id);
    const titleSeedState = sessionManager.getSessionNameState();
    if (
      titleSeedRow?.title_source === "explicit"
      && titleSeedRow.title.trim()
      && titleSeedState.name === undefined
      && titleSeedState.entryId === undefined
    ) {
      session.setSessionName(titleSeedRow.title);
      setPiSessionTitle(id, titleSeedRow.title);
    }
    assertCreationCurrent();
    // Wayang durably publishes this path immediately after runtime creation.
    // Materialize first so restart/rebuild cannot reopen an absent proposed path
    // under a new Pi identity or lose buffered title/audit metadata.
    sessionManager.materialize();
    assertCreationCurrent();
    const handle: PiSessionHandle = {
      id,
      session,
      cwd,
      model: model?.id,
      subscriberCount: 0,
      extensionsResult,
      events: new EventEmitter(),
      sessionFile: sessionManager.getSessionFile(),
      lastActivityAt: Date.now(),
      agentProfileId: runtimeIdentity.agentProfile.id,
      runtimeGeneration,
      bashMode,
      ...(trustedHostBashTool ? { trustedHostBashTool } : {}),
      ...(pendingRestrictedMcpRuntime ? { restrictedMcpRuntime: pendingRestrictedMcpRuntime } : {}),
      ...(pendingProtectedBrowserRuntime ? { protectedBrowserRuntime: pendingProtectedBrowserRuntime } : {}),
      ...(selectedProtectedBrowserFactory ? { protectedBrowserFactory: selectedProtectedBrowserFactory } : {}),
      ...(pendingProtectedAutomationRuntime ? {
        protectedAutomationRuntime: pendingProtectedAutomationRuntime,
        protectedAutomationFactory: selectedProtectedAutomationFactory,
      } : {}),
      ...(pendingFileAudioExperimentRuntime ? {
        fileAudioExperimentRuntime: pendingFileAudioExperimentRuntime,
        fileAudioExperimentFactory: selectedFileAudioExperimentFactory,
      } : {}),
      interactiveTurns: new Map(),
      queuedBrowserMessages: new Map(),
    };
    handle.liveStreamingMessageUnsubscribe = session.subscribe((event: AgentSessionEvent) => {
      trackOverflowRecovery(handle, event);
      persistSettledSessionError(handle, event);
      if (event.type === "agent_settled") {
        markClaimedQueuedBrowserTurnsReady(handle);
        const settledBrowserTurns = settleInteractiveTurnsQuietly(handle);
        if (settledBrowserTurns.length > 0) {
          deferWayangAutoTitleAfterInteraction(handle, settledBrowserTurns);
        } else if (interactiveTurnLedger(handle).size === 0) {
          deferWayangAutoTitle(handle);
        }
      }
      if (event.type === "message_start" || event.type === "message_update") {
        if (event.type === "message_start") markQueuedBrowserMessageStarted(handle, event.message);
        handle.liveStreamingMessage = event.message;
        return;
      }
      if (event.type !== "message_end") return;
      const completedMessage = event.message;
      handle.liveStreamingMessage = completedMessage;
      // AgentSession persists message_end immediately after notifying all
      // listeners. Clear only afterward, and only if a newer message has not
      // already replaced this one.
      queueMicrotask(() => {
        if (handle.liveStreamingMessage === completedMessage) {
          handle.liveStreamingMessage = undefined;
        }
      });
    });

    // No await is permitted between this final fence and publication.
    assertCreationCurrent();
    assertPendingBrowserCatalogCurrent();
    runtimeOptions.testHooks?.onPrivilegedEffect?.("handle_publication");
    assertCreationCurrent();
    sessions.set(id, handle);
    // Publication transfers browser authorization from the exact pending
    // witness to this live handle. No await is permitted across the transfer.
    pendingInteractiveBrowserAuthority.delete(id);
    // Publish exact object ownership before advertising the runtime. The sudo
    // broker fails closed on an unmapped manager whenever this map exists, so
    // colliding legacy ID/file keys cannot redirect an approval to another
    // live Wayang thread.
    cwdToSessionId.set(cwd, id);
    piSessionManagerToWebSessionId.set(sessionManager, id);
    piSessionToWebSessionId.set(sessionManager.getSessionId(), id);
    const canonicalSessionFile = sessionManager.getSessionFile();
    if (canonicalSessionFile) piSessionFileToWebSessionId.set(canonicalSessionFile, id);
    standardResourcesRuntimePublished = true;
    protectedAutomationRuntimePublished = true;
    fileAudioExperimentRuntimePublished = true;
    pendingAgentSession = undefined;
    pendingRestrictedMcpRuntime = undefined;
    pendingProtectedBrowserRuntime = undefined;
    pendingProtectedAutomationRuntime = undefined;
    pendingFileAudioExperimentRuntime = undefined;
    // The live handle is now the committed authority owner. Observer/timer
    // failures must not reject creation while leaving that published handle
    // live behind a reported startup failure.
    try {
      runtimeEvents.emit("event", {
        type: "runtime_state_changed",
        sessionId: id,
        bashMode: handle.bashMode,
      } satisfies PiSessionRuntimeEvent);
    } catch {
      console.warn("[pi-bridge] Runtime state listener failed after session publication");
    }
    try { ensureIdleCleanupTimer(); }
    catch { console.warn("[pi-bridge] Idle cleanup timer failed after session publication"); }
    return handle;
  })().catch(async (error) => {
    // A stale creation owns all of its partial objects until this cleanup has
    // finished. Denial cleanup waits on this promise and therefore cannot race
    // a second destroy/publication path.
    pendingInteractiveBrowserAuthority.delete(id);
    await closeUnpublishedAgentSession(pendingAgentSession);
    pendingAgentSession = undefined;
    await pendingRestrictedMcpRuntime?.close().catch(() => undefined);
    pendingRestrictedMcpRuntime = undefined;
    const teardownIntent = sessionBrowserTeardownIntents.get(id);
    if (pendingProtectedBrowserRuntime) {
      const teardown = currentBrowserTeardownIntent(id) ?? DEFAULT_BROWSER_TEARDOWN;
      await invokeBrowserTeardown(pendingProtectedBrowserRuntime, teardown).catch(() => undefined);
    }
    pendingProtectedBrowserRuntime = undefined;
    if (teardownIntent) clearBrowserTeardownIntent(id, teardownIntent.generation);
    await pendingProtectedAutomationRuntime?.close().catch(() => undefined);
    pendingProtectedAutomationRuntime = undefined;
    await pendingFileAudioExperimentRuntime?.close().catch(() => undefined);
    pendingFileAudioExperimentRuntime = undefined;
    throw error;
  }).finally(() => {
    recordLatencyMetric("lazy_session_create_ms", performance.now() - creationStartedAt);
    sessionCreations.delete(id);
  });

  sessionCreations.set(id, creation);
  return creation;
}

export function isPiSessionAgentSwitchInProgress(id: string): boolean {
  return agentSwitches.has(id);
}

export async function switchSessionAgent(id: string, targetProfileId: string): Promise<AgentSwitchResult> {
  assertRuntimeMutationUnlocked(id);
  const inFlight = agentSwitches.get(id);
  if (inFlight) return inFlight;

  const operation = (async (): Promise<AgentSwitchResult> => {
    let row = getSessionById(id);
    if (!row) throw new WorkspaceStoreError("Session not found", 404);
    if (row.pending_agent_switch) row = reconcilePendingAgentSwitch(row);
    if (row.agent_profile_id === targetProfileId) throw new WorkspaceStoreError("Session already uses that agent profile", 409);
    if (sessionCreations.has(id)) throw new WorkspaceStoreError("Session runtime is still starting", 409);

    const currentHandle = sessions.get(id);
    if (currentHandle && (
      currentHandle.session.isStreaming
      || (currentHandle.session.pendingMessageCount ?? 0) > 0
      || manualCompactionQueueForHandle(currentHandle)
    )) {
      throw new WorkspaceStoreError("Agent switching is allowed only while the session is idle", 409);
    }

    const target = await resolveAgentSwitchTarget(row, targetProfileId);
    assertRuntimeMutationUnlocked(id);
    const from = row.agent_profile_id ? getAgentProfile(row.agent_profile_id) : undefined;
    const preview: AgentSwitchPreview = {
      session_id: id,
      from_agent_profile_id: row.agent_profile_id ?? null,
      from_agent_name: from?.name ?? null,
      to_agent_profile_id: target.profile.id,
      to_agent_name: target.profile.name,
      current_provider: row.provider,
      current_model: row.model,
      target_provider: String(target.model.provider),
      target_model: target.model.id,
      memory_access: target.profile.memory_access,
      transcript_retained: true,
      warning: "The new agent retains the existing transcript; its identity, resources, tools, and model may change.",
    };
    const pending: PendingAgentSwitch = {
      switch_id: randomUUID(),
      from_agent_profile_id: row.agent_profile_id ?? null,
      from_provider: row.provider,
      from_model: row.model,
      to_agent_profile_id: target.profile.id,
      target_provider: String(target.model.provider),
      target_model: target.model.id,
      changed_at: Date.now(),
    };
    const hadLiveRuntime = Boolean(currentHandle);
    const authorityLifecycle = new AgentSwitchAuthorityLifecycle();
    beginAgentSwitch(id, pending);

    const browserSwitchTeardown: PiSessionBrowserTeardown = { kind: "detach", reason: "model_or_agent_switch" };
    try {
      await destroyPiSession(id, browserSwitchTeardown);
      authorityLifecycle.oldRuntimeRevoked();
      authorityLifecycle.authorizeProvisionalTargetConstruction();
      const handle = await createPiSession(
        id,
        row.cwd,
        pending.target_provider,
        pending.target_model,
        row.pi_session_file,
        {
          profileOverride: target.profile,
          skipPendingRecovery: true,
          forceInMemorySettings: true,
          protectedBrowserFactory: currentHandle?.protectedBrowserFactory,
          protectedAutomationFactory: currentHandle?.protectedAutomationFactory,
          fileAudioExperimentFactory: currentHandle?.fileAudioExperimentFactory,
        },
      );
      authorityLifecycle.provisionalTargetConstructed({
        pending: getSessionById(id)?.pending_agent_switch?.switch_id === pending.switch_id,
        bashMode: handle.bashMode,
      });
      // Public Pi API deliberately records a durable model_change. Its settings
      // manager is an in-memory snapshot for this switch runtime.
      await handle.session.setModel(target.model);
      handle.model = target.model.id;
      handle.session.sessionManager.appendCustomEntry("wayang-agent-change", {
        switch_id: pending.switch_id,
        from_agent_profile_id: pending.from_agent_profile_id,
        to_agent_profile_id: pending.to_agent_profile_id,
        provider: pending.target_provider,
        model: pending.target_model,
        changed_at: pending.changed_at,
      });
      if (handle.sessionFile && !getSessionById(id)?.pi_session_file) {
        updatePiSessionFile(id, handle.sessionFile);
      }
      const completed = completeAgentSwitch(id, pending.switch_id);
      authorityLifecycle.durableSwitchCompleted({
        pending: completed.pending_agent_switch !== null,
        bashMode: handle.bashMode,
      });
      // The pending-switch runtime is deliberately ineligible for host bash.
      // Rebuild only after the durable target identity is committed so a
      // A restricted-to-standard transition cannot widen authority in the transaction gap.
      await destroyPiSession(id, browserSwitchTeardown);
      authorityLifecycle.provisionalTargetDestroyed();
      authorityLifecycle.authorizeFreshTargetConstruction();
      const freshHandle = await createPiSession(
        id,
        completed.cwd,
        completed.provider,
        completed.model,
        completed.pi_session_file,
        {
          profileOverride: target.profile,
          forceInMemorySettings: true,
          protectedBrowserFactory: currentHandle?.protectedBrowserFactory,
          protectedAutomationFactory: currentHandle?.protectedAutomationFactory,
          fileAudioExperimentFactory: currentHandle?.fileAudioExperimentFactory,
        },
      );
      const freshRow = getSessionById(id);
      authorityLifecycle.freshTargetConstructed({
        pending: !freshRow || freshRow.pending_agent_switch !== null,
        bashMode: freshHandle.bashMode,
      });
      runtimeEvents.emit("event", { type: "agent_switched", sessionId: id, switchId: pending.switch_id } satisfies PiSessionRuntimeEvent);
      return { switch_id: pending.switch_id, session: completed, preview };
    } catch (error) {
      await destroyPiSession(id, browserSwitchTeardown);
      let recovered = getSessionById(id);
      if (recovered?.pending_agent_switch?.switch_id === pending.switch_id) {
        recovered = reconcilePendingAgentSwitch(recovered);
      }
      if (recovered && hadLiveRuntime) {
        const restoredProfile = recovered.agent_profile_id ? getAgentProfile(recovered.agent_profile_id) : undefined;
        try {
          await createPiSession(
            id,
            recovered.cwd,
            recovered.provider,
            recovered.model,
            recovered.pi_session_file,
            {
              profileOverride: restoredProfile,
              forceInMemorySettings: true,
              protectedBrowserFactory: currentHandle?.protectedBrowserFactory,
              protectedAutomationFactory: currentHandle?.protectedAutomationFactory,
              fileAudioExperimentFactory: currentHandle?.fileAudioExperimentFactory,
            },
          );
        } catch (restoreError) {
          console.warn(`[pi-bridge] Failed to restore runtime after agent switch ${pending.switch_id}:`, restoreError);
        }
      }
      const recoveryHandle = sessions.get(id);
      authorityLifecycle.failureCleaned({
        pending: !recovered || recovered.pending_agent_switch !== null,
        bashMode: recoveryHandle?.bashMode ?? "unavailable",
      });
      if (recovered?.agent_profile_id === pending.to_agent_profile_id && !recovered.pending_agent_switch) {
        runtimeEvents.emit("event", { type: "agent_switched", sessionId: id, switchId: pending.switch_id } satisfies PiSessionRuntimeEvent);
        return { switch_id: pending.switch_id, session: recovered, preview };
      }
      throw error;
    }
  })().finally(() => {
    agentSwitches.delete(id);
  });

  agentSwitches.set(id, operation);
  return operation;
}

export function getPiSession(id: string): PiSessionHandle | undefined {
  return sessions.get(id);
}

/** Exact source/runtime registry access; durable pair metadata alone is never a live tool lease. */
export function getLiveProtectedAutomationRuntime(
  sourceSessionId: string,
  expectedBinding?: Readonly<ProtectedAutomationBinding>,
): ProtectedAutomationToolRuntime | undefined {
  const handle = sessions.get(sourceSessionId);
  const runtime = handle?.protectedAutomationRuntime;
  if (!handle || handle.capabilityAuthorityDenied || !runtime) return undefined;
  const current = runtime.binding;
  if (current.sourceSessionId !== sourceSessionId
    || current.runtimeGeneration !== handle.runtimeGeneration
    || current.processBootNonce !== PROCESS_BOOT_NONCE
    || current.agentProfileId !== handle.agentProfileId
    || current.projectCwd !== handle.cwd
    || (expectedBinding && !exactProtectedAutomationBindingEqual(current, expectedBinding))) return undefined;
  try { return runtime.preflight().allowed ? runtime : undefined; }
  catch { return undefined; }
}

/** Exact generic interactive-runtime registry access for diagnostics and
 * backend tool publication. It never falls back by pair/name/cwd. */
export function getLiveInteractiveBrowserRuntime(
  sourceSessionId: string,
  expectedBinding?: Readonly<ProtectedBrowserBinding>,
): CapabilityBoundInteractiveBrowserToolRuntime | undefined {
  const handle = sessions.get(sourceSessionId);
  const runtime = handle?.protectedBrowserRuntime;
  if (!handle || handle.capabilityAuthorityDenied || !runtime) return undefined;
  const current = runtime.binding;
  const expectedKind = current.capabilityId === STANDARD_BROWSER_CAPABILITY_ID ? "standard" : "protected";
  if (runtime.kind !== expectedKind
    || current.sourceSessionId !== sourceSessionId
    || current.runtimeGeneration !== handle.runtimeGeneration
    || current.processBootNonce !== PROCESS_BOOT_NONCE
    || current.agentProfileId !== handle.agentProfileId
    || current.projectCwd !== handle.cwd
    || (expectedBinding && !exactProtectedBrowserBindingEqual(current, expectedBinding))) return undefined;
  try { return runtime.preflight().allowed ? runtime : undefined; }
  catch { return undefined; }
}

/** Exact protected-runtime registry access for routes/composition. This never
 * falls back by cwd, project, profile, name, or another live session. */
export function getLiveProtectedBrowserRuntime(
  sourceSessionId: string,
  expectedBinding?: Readonly<ProtectedBrowserBinding>,
): ProtectedBrowserToolRuntime | undefined {
  const runtime = getLiveInteractiveBrowserRuntime(sourceSessionId, expectedBinding);
  if (!isProtectedBrowserToolRuntime(runtime) || runtime.kind !== "protected" || runtime.browser.isRevoked) return undefined;
  return runtime;
}

export interface ProtectedBrowserSurfaceScope {
  sourceSessionId: string;
  projectId: string;
  projectCwd: string;
  agentProfileId: string;
  capabilityId: ProtectedBrowserBinding["capabilityId"];
  associationRevision: number;
}

/** Durable scope for showing the Browser pane; never live agent/browser authority. */
export function resolveProtectedBrowserSurfaceScope(
  sourceSessionId: string,
  expectedProjectCwd?: string,
): ProtectedBrowserSurfaceScope | null {
  const row = getSessionById(sourceSessionId);
  if (!row || !isSessionCapabilityEligible(row) || row.pending_agent_switch !== null || !row.agent_profile_id
    || (expectedProjectCwd !== undefined && row.cwd !== expectedProjectCwd)) return null;
  const project = getProjectByCwd(row.cwd);
  if (!project) return null;
  const capabilityId = project.access_policy.privacy_mode === "standard"
    ? STANDARD_BROWSER_CAPABILITY_ID
    : PROTECTED_BROWSER_CAPABILITY_ID;
  const resolution = resolveWorkspaceCapability({
    capability_id: capabilityId,
    project_id: project.id,
    agent_profile_id: row.agent_profile_id,
  });
  if (!resolution.authorized || resolution.project.cwd !== row.cwd) return null;
  return {
    sourceSessionId,
    projectId: project.id,
    projectCwd: row.cwd,
    agentProfileId: row.agent_profile_id,
    capabilityId,
    associationRevision: resolution.association.revision,
  };
}

/** Durable pair-only check used by realm invalidation subscriptions. */
export function resolveProtectedBrowserPairAuthority(
  projectId: string,
  agentProfileId: string,
  associationRevision: number,
  capabilityId: ProtectedBrowserBinding["capabilityId"] = PROTECTED_BROWSER_CAPABILITY_ID,
): boolean {
  const resolution = resolveWorkspaceCapability({
    capability_id: capabilityId,
    project_id: projectId,
    agent_profile_id: agentProfileId,
  });
  return resolution.authorized && resolution.association.revision === associationRevision;
}

/** Closed generic authority resolver for app/routes protected-browser ports.
 * Call it at every coordinator checkpoint; a durable row alone never grants
 * browser authority. */
export function resolveInteractiveBrowserAuthority(
  binding: Readonly<ProtectedBrowserBinding>,
): ProtectedBrowserAuthoritySnapshot | null {
  const pending = pendingInteractiveBrowserAuthority.get(binding.sourceSessionId);
  if (pending && exactProtectedBrowserBindingEqual(pending.binding, binding) && pending.isCurrent()) {
    const resolution = resolveWorkspaceCapability({
      capability_id: binding.capabilityId,
      project_id: binding.projectId,
      agent_profile_id: binding.agentProfileId,
    });
    if (resolution.authorized && resolution.association.revision === binding.associationRevision
      && resolution.project.cwd === binding.projectCwd) {
      return {
        ...binding,
        authorized: true,
        privacyMode: resolution.project.access_policy.privacy_mode,
        sourceSessionDurable: true,
        sourceQuarantined: false,
        profileEnabled: resolution.profile.enabled,
        projectAllowsProfile: resolution.project.access_policy.allowed_agent_profile_ids === null
          || resolution.project.access_policy.allowed_agent_profile_ids.includes(resolution.profile.id),
      };
    }
  }
  return resolveProtectedBrowserAuthority(binding);
}

export function resolveProtectedBrowserAuthority(
  binding: Readonly<ProtectedBrowserBinding>,
): ProtectedBrowserAuthoritySnapshot | null {
  const row = getSessionById(binding.sourceSessionId);
  const handle = sessions.get(binding.sourceSessionId);
  if (!row || row.archived || !handle || handle.capabilityAuthorityDenied || !isSessionCapabilityEligible(row)
    || row.pending_agent_switch !== null || row.cwd !== binding.projectCwd
    || row.agent_profile_id !== binding.agentProfileId
    || handle.runtimeGeneration !== binding.runtimeGeneration
    || handle.agentProfileId !== binding.agentProfileId
    || handle.cwd !== binding.projectCwd
    || binding.processBootNonce !== PROCESS_BOOT_NONCE) return null;
  const resolution = resolveWorkspaceCapability({
    capability_id: binding.capabilityId,
    project_id: binding.projectId,
    agent_profile_id: binding.agentProfileId,
  });
  if (!resolution.authorized || resolution.association.revision !== binding.associationRevision
    || resolution.project.cwd !== binding.projectCwd) return null;
  return {
    ...binding,
    authorized: true,
    privacyMode: resolution.project.access_policy.privacy_mode,
    sourceSessionDurable: true,
    sourceQuarantined: false,
    profileEnabled: resolution.profile.enabled,
    projectAllowsProfile: resolution.project.access_policy.allowed_agent_profile_ids === null
      || resolution.project.access_policy.allowed_agent_profile_ids.includes(resolution.profile.id),
  };
}

export type BrowserSurfaceMode = "standard" | "protected" | "unavailable";

export type BrowserAgentReasonCode =
  | "approval_required"
  | "association_inactive"
  | "incompatible_project_mode"
  | "profile_disabled"
  | "profile_not_allowed"
  | "session_quarantined"
  | "interactive_session_required"
  | "fresh_runtime_required"
  | "browser_not_found"
  | "configured_path_invalid"
  | "transport_unavailable"
  | "tool_registration_failed";

export interface BrowserAgentDiagnostic {
  available: boolean;
  capability_id: ProtectedBrowserBinding["capabilityId"] | null;
  reason_code: BrowserAgentReasonCode | null;
  remediation: string | null;
  executable: ReturnType<typeof getBrowserExecutableDiagnostic>;
  tool_state: "registered" | "withheld" | "stale_runtime";
}

let browserExecutableDiagnosticCache: { key: string; value: ReturnType<typeof getBrowserExecutableDiagnostic> } | undefined;

function browserExecutableDiagnosticForProcess(): ReturnType<typeof getBrowserExecutableDiagnostic> {
  const key = [
    process.platform,
    process.arch,
    process.env.WAYANG_CHROMIUM_PATH ?? "",
    process.env.CHROME_PATH ?? "",
    process.env.CHROMIUM_PATH ?? "",
    process.env.WAYANG_BROWSER_TRANSPORT ?? "",
    process.env.PATH ?? "",
  ].join("\u0000");
  if (browserExecutableDiagnosticCache?.key === key) return browserExecutableDiagnosticCache.value;
  const value = getBrowserExecutableDiagnostic();
  browserExecutableDiagnosticCache = { key, value };
  return value;
}

const BROWSER_REMEDIATION: Readonly<Record<BrowserAgentReasonCode, string>> = Object.freeze({
  approval_required: "Approve the compatible Browser capability for this exact Project-Agent pair, then start a fresh session runtime.",
  association_inactive: "The Browser capability was revoked. Reapprove it only after reviewing the Project-Agent pair.",
  incompatible_project_mode: "Use the Browser capability compatible with the project's current privacy mode.",
  profile_disabled: "Enable the selected Agent Profile before using browser tools.",
  profile_not_allowed: "Allow the selected Agent Profile for this Project before using browser tools.",
  session_quarantined: "Legacy quarantined sessions cannot receive browser authority; create a fresh session.",
  interactive_session_required: "Managed browser tools are available only to interactive sessions, not scheduled/background runs.",
  fresh_runtime_required: "Start a fresh session runtime so the approved browser tools can be registered.",
  browser_not_found: "Install Chromium/Chrome or configure WAYANG_CHROMIUM_PATH, then restart Wayang.",
  configured_path_invalid: "Set WAYANG_CHROMIUM_PATH to an absolute executable Chromium/Chrome binary and restart Wayang.",
  transport_unavailable: "The requested VNC browser transport is unavailable; install Xvfb/x11vnc on Linux or configure the CDP transport.",
  tool_registration_failed: "Restart the session runtime; if this persists, review extension/tool-name collisions and backend logs.",
});

export function getPiSessionBrowserAgentDiagnostic(id: string, durableRow?: SessionRow): BrowserAgentDiagnostic {
  const uncheckedExecutable: BrowserAgentDiagnostic["executable"] = {
    platform: process.platform,
    transport: process.env.WAYANG_BROWSER_TRANSPORT === "vnc" ? "vnc" : "cdp-screencast",
    state: "unchecked",
  };
  const denied = (
    capabilityId: ProtectedBrowserBinding["capabilityId"] | null,
    reason: BrowserAgentReasonCode,
    tool_state: BrowserAgentDiagnostic["tool_state"] = "withheld",
    executable: BrowserAgentDiagnostic["executable"] = uncheckedExecutable,
  ): BrowserAgentDiagnostic => ({
    available: false,
    capability_id: capabilityId,
    reason_code: reason,
    remediation: BROWSER_REMEDIATION[reason],
    executable,
    tool_state,
  });
  const row = durableRow ?? getSessionById(id);
  if (!row || row.legacy_private_session_quarantine || row.legacy_capability_ineligible) return denied(null, "session_quarantined");
  const project = getProjectByCwd(row.cwd);
  if (!project || !row.agent_profile_id) return denied(null, "profile_not_allowed");
  const capabilityId = project.access_policy.privacy_mode === "standard"
    ? STANDARD_BROWSER_CAPABILITY_ID
    : PROTECTED_BROWSER_CAPABILITY_ID;
  if (row.scheduled_job_id !== null || row.scheduled_run_id !== null) return denied(capabilityId, "interactive_session_required");
  const resolution = resolveWorkspaceCapability({ capability_id: capabilityId, project_id: project.id, agent_profile_id: row.agent_profile_id });
  if (!resolution.authorized) {
    const reason: BrowserAgentReasonCode = resolution.reason === "association_inactive"
      ? "association_inactive"
      : resolution.reason === "incompatible_privacy_mode"
        ? "incompatible_project_mode"
        : resolution.reason === "profile_disabled"
          ? "profile_disabled"
          : resolution.reason === "profile_not_allowed"
            ? "profile_not_allowed"
            : "approval_required";
    return denied(capabilityId, reason);
  }
  const handle = sessions.get(id);
  const runtime = getLiveInteractiveBrowserRuntime(id);
  if (!handle || !runtime || row.pending_agent_switch) {
    return denied(capabilityId, "fresh_runtime_required", "stale_runtime", browserExecutableDiagnosticForProcess());
  }
  const anySession = handle.session as any;
  const registry = anySession._toolRegistry;
  const definitions = anySession._toolDefinitions;
  const registered = runtime.tools.every((tool) => definitions instanceof Map
    && definitions.get(tool.name)?.definition === tool
    && registry instanceof Map
    && registry.has(tool.name));
  if (!registered) return denied(capabilityId, "tool_registration_failed", "stale_runtime");
  const executable = browserExecutableDiagnosticForProcess();
  if (executable.state !== "resolved" || executable.reasonCode === "transport_unavailable") {
    const reason = executable.reasonCode === "configured_path_invalid"
      ? "configured_path_invalid"
      : executable.reasonCode === "transport_unavailable"
        ? "transport_unavailable"
        : "browser_not_found";
    return denied(capabilityId, reason, "registered", executable);
  }
  return { available: true, capability_id: capabilityId, reason_code: null, remediation: null, executable, tool_state: "registered" };
}

/** Backend-only projection for frontend gating; names and labels are never inputs.
 * `protected` may expose owner recovery UI from durable pair authority, but it
 * never implies a live agent/browser lease. Every browser operation still
 * resolves an exact current runtime binding independently. */
export function getPiSessionBrowserMode(id: string, durableRow?: SessionRow): BrowserSurfaceMode {
  const handle = sessions.get(id);
  const row = durableRow ?? getSessionById(id);
  if (!row) return "unavailable";
  let project: ReturnType<typeof getProjectByCwd>;
  try { project = getProjectByCwd(row.cwd); }
  catch { return "unavailable"; }
  if (!project) return "unavailable";
  if (project.access_policy.privacy_mode === "standard") return "standard";
  const surface = resolveProtectedBrowserSurfaceScope(id, row.cwd);
  if (!surface) return "unavailable";
  const mode: BrowserSurfaceMode = "protected";
  if (!handle || handle.capabilityAuthorityDenied) return mode;
  if (handle.agentProfileId !== row.agent_profile_id || handle.cwd !== row.cwd) return "unavailable";
  try {
    const runtime = getLiveProtectedBrowserRuntime(id);
    return !runtime || (runtime.browser.currentBinding.capabilityId === surface.capabilityId
      && runtime.browser.currentBinding.associationRevision === surface.associationRevision)
      ? mode
      : "unavailable";
  } catch { return mode; }
}

/** Authoritative live-handle projection; durable rows never imply host access. */
export function getPiSessionBashMode(id: string): HostExecutionMode {
  return sessions.get(id)?.bashMode ?? "unavailable";
}

function sourceLabel(sourceInfo: any): string | undefined {
  if (!sourceInfo) return undefined;
  if (typeof sourceInfo.label === "string") return sourceInfo.label;
  if (typeof sourceInfo.path === "string") return sourceInfo.path;
  return undefined;
}

async function collectArgumentSuggestions(command: any): Promise<SlashArgumentSuggestion[] | undefined> {
  if (typeof command?.getArgumentCompletions !== "function") return undefined;
  try {
    const suggestions = await command.getArgumentCompletions("");
    if (!Array.isArray(suggestions) || suggestions.length === 0) return undefined;
    return suggestions
      .filter((item: any) => item && typeof item.value === "string")
      .map((item: any) => ({
        value: item.value,
        label: typeof item.label === "string" ? item.label : item.value,
        description: typeof item.description === "string" ? item.description : undefined,
      }));
  } catch {
    return undefined;
  }
}

/**
 * Return the slash commands that make sense in wayang. Built-ins are limited
 * to commands this backend can faithfully execute; prompts, skills, and
 * extension commands are mirrored from the live AgentSession when available.
 */
export async function listSlashCommands(id: string): Promise<WebSlashCommand[]> {
  const handle = sessions.get(id);
  const commands = new Map<string, WebSlashCommand>();
  for (const command of WEB_SUPPORTED_BUILTIN_SLASH_COMMANDS) commands.set(command.name, { ...command });
  if (!handle) return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));

  for (const template of handle.session.promptTemplates) {
    if (!template?.name || commands.has(template.name)) continue;
    commands.set(template.name, {
      name: template.name,
      description: template.description || sourceLabel((template as any).sourceInfo),
      argumentHint: (template as any).argumentHint,
      source: "prompt",
    });
  }

  const extensionRunner = (handle.session as any)._extensionRunner;
  if (extensionRunner && typeof extensionRunner.getRegisteredCommands === "function") {
    const builtinNames = new Set(WEB_SUPPORTED_BUILTIN_SLASH_COMMANDS.map((command) => command.name));
    for (const command of extensionRunner.getRegisteredCommands()) {
      const name = command.invocationName || command.name;
      if (!name || builtinNames.has(name)) continue;
      commands.set(name, {
        name,
        description: command.description || sourceLabel(command.sourceInfo),
        source: "extension",
        argumentSuggestions: await collectArgumentSuggestions(command),
      });
    }
  }

  for (const skill of handle.session.resourceLoader.getSkills().skills) {
    const name = `skill:${skill.name}`;
    if (commands.has(name)) continue;
    commands.set(name, {
      name,
      description: skill.description || sourceLabel(skill.sourceInfo),
      source: "skill",
    });
  }

  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getCommandGuardRegistry(): Map<string, CommandGuardBridgeController> | undefined {
  const registry = (globalThis as typeof globalThis & {
    __pi_command_guard_sessions?: Map<string, CommandGuardBridgeController>;
  }).__pi_command_guard_sessions;
  return registry instanceof Map ? registry : undefined;
}

function commandGuardBridgeKeys(handle: PiSessionHandle): string[] {
  return [handle.sessionFile, handle.session.sessionFile, `cwd:${handle.cwd}`]
    .filter((key): key is string => typeof key === "string" && key.length > 0);
}

function getCommandGuardController(id: string): CommandGuardBridgeController | undefined {
  const handle = sessions.get(id);
  const registry = getCommandGuardRegistry();
  if (!handle || !registry) return undefined;
  for (const key of commandGuardBridgeKeys(handle)) {
    const controller = registry.get(key);
    if (controller) return controller;
  }
  return undefined;
}

export function getCommandGuardState(id: string): CommandGuardState {
  const handle = sessions.get(id);
  if (!handle) return { available: false, mode: "unknown", error: "Session is not live" };
  const controller = getCommandGuardController(id);
  if (!controller) return { available: false, mode: "unknown", error: "Command guard extension is not available" };
  try {
    return controller.getStatus();
  } catch (error) {
    return { available: false, mode: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}

export function setCommandGuardMode(
  id: string,
  mode: CommandGuardMode,
  options: { announce?: boolean; pin?: string } = {},
): CommandGuardState {
  const handle = sessions.get(id);
  if (!handle) return { available: false, mode: "unknown", error: "Session is not live" };
  const controller = getCommandGuardController(id);
  if (!controller) return { available: false, mode: "unknown", error: "Command guard extension is not available" };
  try {
    return controller.setMode(mode, options);
  } catch (error) {
    return { available: false, mode: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Wayang web sessions should not preserve a user-disabled guard across a
 * browser/session reactivation. Scheduled/non-web sessions may intentionally
 * start with the guard off; keep this helper scoped to WebSocket attach/send
 * paths so those jobs are not changed.
 */
export function ensureInteractiveCommandGuardEnabled(id: string, reason = "interactive session reactivation"): CommandGuardState {
  const state = getCommandGuardState(id);
  if (state.available && state.mode === "off") {
    console.info(`[pi-bridge] Re-enabling command guard for session ${id}: ${reason}`);
    return setCommandGuardMode(id, "balanced", { announce: false });
  }
  return state;
}

export type PiSessionBrowserTeardown =
  | { kind: "detach"; reason: AgentLeaseDetachReason }
  | { kind: "close_session"; reason: SessionWorkspaceCloseReason }
  | { kind: "revoke"; reason: BrowserAuthorityRevokeReason };

const DEFAULT_BROWSER_TEARDOWN: PiSessionBrowserTeardown = Object.freeze({
  kind: "detach",
  reason: "runtime_replaced",
});

interface CapabilityAuthorityCleanupState {
  browserRuntime?: CapabilityBoundInteractiveBrowserToolRuntime;
  browserSeverity: 0 | 1 | 2 | 3;
  promise: Promise<void>;
}

const capabilityAuthorityCleanup = new WeakMap<object, CapabilityAuthorityCleanupState>();

function browserTeardownSeverity(action: PiSessionBrowserTeardown): 1 | 2 | 3 {
  return action.kind === "detach" ? 1 : action.kind === "close_session" ? 2 : 3;
}

function invokeBrowserTeardown(
  runtime: CapabilityBoundInteractiveBrowserToolRuntime,
  action: PiSessionBrowserTeardown,
): Promise<void> {
  try {
    if (action.kind === "detach") return Promise.resolve(runtime.detachAgentLease(action.reason));
    if (action.kind === "close_session") return Promise.resolve(runtime.closeSessionWorkspaces(action.reason));
    return Promise.resolve(runtime.revokeAuthority(action.reason));
  } catch (error) {
    return Promise.reject(error);
  }
}

function beginPiSessionAuthorityCleanup(
  handle: PiSessionHandle,
  browserTeardown: PiSessionBrowserTeardown = DEFAULT_BROWSER_TEARDOWN,
): Promise<void> {
  let state = capabilityAuthorityCleanup.get(handle);
  if (!state) {
    // Invoke every revoker before returning. Their synchronous prefixes latch
    // agent/process/control denial; process, socket, and browser shutdown may finish later.
    const restricted = handle.restrictedMcpRuntime;
    const protectedBrowser = handle.protectedBrowserRuntime;
    const protectedAutomation = handle.protectedAutomationRuntime;
    const fileAudioExperiment = handle.fileAudioExperimentRuntime;
    const hostBashTeardown = handle.hostBashTeardown;
    handle.restrictedMcpRuntime = undefined;
    handle.protectedBrowserRuntime = undefined;
    handle.protectedAutomationRuntime = undefined;
    handle.fileAudioExperimentRuntime = undefined;
    handle.hostBashTeardown = undefined;
    const invokeClose = (runtime: { close(): Promise<void> } | undefined): Promise<void> => {
      try { return runtime ? Promise.resolve(runtime.close()) : Promise.resolve(); }
      catch (error) { return Promise.reject(error); }
    };
    const invokeAgentAbort = (): Promise<void> => {
      try {
        const abort = (handle.session as any)?.abort;
        return typeof abort === "function" ? Promise.resolve(abort.call(handle.session)) : Promise.resolve();
      } catch (error) { return Promise.reject(error); }
    };
    state = {
      browserRuntime: protectedBrowser,
      browserSeverity: 0,
      promise: Promise.allSettled([
        hostBashTeardown ?? Promise.resolve(),
        invokeAgentAbort(),
        invokeClose(restricted),
        invokeClose(protectedAutomation),
        invokeClose(fileAudioExperiment),
      ]).then(() => undefined),
    };
    capabilityAuthorityCleanup.set(handle, state);
  }

  const severity = browserTeardownSeverity(browserTeardown);
  if (state.browserRuntime && severity > state.browserSeverity) {
    state.browserSeverity = severity;
    const browserCleanup = invokeBrowserTeardown(state.browserRuntime, browserTeardown);
    state.promise = Promise.allSettled([state.promise, browserCleanup]).then(() => undefined);
  }
  return state.promise;
}

function latchPiSessionHandleCapabilityDenial(
  handle: PiSessionHandle,
  browserTeardown: PiSessionBrowserTeardown = DEFAULT_BROWSER_TEARDOWN,
): void {
  if (!handle.capabilityAuthorityDenied) {
    handle.capabilityAuthorityDenied = true;
    // Invalidate every creation-time closure and exact protected binding.
    handle.runtimeGeneration = randomUUID();
  }
  getActionApprovalBridge().cancelSession(handle.id, "runtime capability authority revoked");
  const trustedHostBashTool = handle.trustedHostBashTool;
  if (trustedHostBashTool) {
    trustedHostBashTool.revoked = true;
    try {
      handle.hostBashTeardown = typeof trustedHostBashTool.revokeActiveExecutions === "function"
        ? Promise.resolve(trustedHostBashTool.revokeActiveExecutions())
        : Promise.resolve();
    } catch (error) {
      handle.hostBashTeardown = Promise.reject(error);
    }
  }
  handle.bashMode = "unavailable";
  handle.trustedHostBashTool = undefined;
  dropManualCompactionMessageQueue(handle);
  retireInteractiveTurn(handle);

  const browserToolNames = handle.protectedBrowserRuntime?.tools?.map((tool) => tool.name) ?? [];
  const session = handle.session as any;
  if (session) {
    try { session.clearQueue?.(); } catch { /* synchronous denial remains latched */ }
    try { session.setActiveToolsByName?.([]); } catch { /* fall through to direct removal */ }
    if (Array.isArray(session.agent?.state?.tools)) session.agent.state.tools = [];
    // A queued/future tool call must not be able to reactivate a cached registry.
    if (typeof session.setActiveToolsByName === "function") {
      const denyAll = session.setActiveToolsByName.bind(session);
      session.setActiveToolsByName = () => denyAll([]);
    }
    if (session.agent && typeof session.agent.beforeToolCall === "function") {
      session.agent.beforeToolCall = async () => ({
        block: true,
        reason: "Workspace capability authority was denied; a fresh runtime is required",
      });
    }
    session._toolRegistry?.delete?.("bash");
    session._toolRegistry?.delete?.(PROTECTED_BROWSER_TOOL_NAME);
    for (const name of new Set([...INTERACTIVE_BROWSER_TOOL_NAMES, ...browserToolNames])) session._toolRegistry?.delete?.(name);
    session._toolRegistry?.delete?.(PROTECTED_AUTOMATION_TOOL_NAME);
    session._toolRegistry?.delete?.(FILE_AUDIO_EXPERIMENT_TOOL_NAME);
    session._toolDefinitions?.delete?.("bash");
    session._toolDefinitions?.delete?.(PROTECTED_BROWSER_TOOL_NAME);
    for (const name of new Set([...INTERACTIVE_BROWSER_TOOL_NAMES, ...browserToolNames])) session._toolDefinitions?.delete?.(name);
    session._toolDefinitions?.delete?.(PROTECTED_AUTOMATION_TOOL_NAME);
    session._toolDefinitions?.delete?.(FILE_AUDIO_EXPERIMENT_TOOL_NAME);
  }

  // Calling these async closers starts their synchronous denial prefixes now.
  void beginPiSessionAuthorityCleanup(handle, browserTeardown);
  emitRuntimeUnavailableOnce(handle);
}

export interface PiSessionCapabilityDenialLookup {
  get(runtimeId: string): PiSessionHandle | undefined;
}

/**
 * Synchronously and permanently deny every privileged surface on affected live
 * handles. The optional lookup is a synthetic-test seam; production uses the
 * private live runtime map.
 */
export function latchPiSessionCapabilityDenial(
  runtimeIds: readonly string[],
  lookup: PiSessionCapabilityDenialLookup = sessions,
  browserTeardown: PiSessionBrowserTeardown = DEFAULT_BROWSER_TEARDOWN,
  browserAuthorityScope?: Readonly<InteractiveBrowserAuthorityScope>,
): void {
  // Detached Standard workspaces have no Pi handle. Start pair-scoped denial
  // before per-runtime cleanup so revocation never depends on a live lease.
  if (browserTeardown.kind === "revoke" && browserAuthorityScope && productionInteractiveBrowserSessionLifecycle) {
    try {
      const cleanup = Promise.resolve(productionInteractiveBrowserSessionLifecycle.revokeAuthority(
        browserAuthorityScope,
        browserTeardown.reason,
      ));
      void trackInteractiveBrowserLifecycleCleanup(cleanup).catch(() => undefined);
    } catch { /* the durable denial remains authoritative */ }
  }
  for (const id of new Set(runtimeIds)) {
    // Advance first and without awaiting or requiring a published handle. This
    // is the authoritative starting-runtime revocation latch.
    const generation = getPiSessionCapabilityDenialGeneration(id) + 1n;
    sessionCapabilityDenialGenerations.set(id, generation);
    const priorTeardown = sessionBrowserTeardownIntents.get(id);
    const priorAction = priorTeardown?.action;
    const effectiveTeardown = priorAction
      && browserTeardownSeverity(priorAction) >= browserTeardownSeverity(browserTeardown)
      ? priorAction
      : browserTeardown;
    sessionBrowserTeardownIntents.set(id, { generation, action: effectiveTeardown });
    const handle = lookup.get(id);
    if (handle) latchPiSessionHandleCapabilityDenial(handle, effectiveTeardown);
    else getActionApprovalBridge().cancelSession(id, "runtime capability authority revoked");
  }
}

/** Post-latch cleanup. Starting runtimes are awaited and re-latched; live
 * agent work and host process groups are aborted before the denied runtime is destroyed. */
export async function cleanupPiSessionCapabilityDenial(runtimeIds: readonly string[]): Promise<void> {
  await Promise.allSettled([...new Set(runtimeIds)].map(async (id) => {
    const pending = sessionCreations.get(id);
    if (pending) await pending.catch(() => undefined);
    const handle = sessions.get(id);
    if (!handle) {
      clearBrowserTeardownIntent(id, getPiSessionCapabilityDenialGeneration(id));
      return;
    }
    const browserTeardown = currentBrowserTeardownIntent(id) ?? DEFAULT_BROWSER_TEARDOWN;
    latchPiSessionHandleCapabilityDenial(handle, browserTeardown);
    await beginPiSessionAuthorityCleanup(handle, browserTeardown);
    await stopPiSessionIfIdle(id).catch(() => false);
  }));
  await Promise.allSettled([...interactiveBrowserLifecycleCleanupTasks]);
}

export async function closePiSessionAuthorities(
  handle: PiSessionHandle,
  browserTeardown: PiSessionBrowserTeardown = DEFAULT_BROWSER_TEARDOWN,
): Promise<void> {
  latchPiSessionHandleCapabilityDenial(handle, browserTeardown);
  await beginPiSessionAuthorityCleanup(handle, browserTeardown);
}

export async function destroyPiSession(
  id: string,
  browserTeardown: PiSessionBrowserTeardown = DEFAULT_BROWSER_TEARDOWN,
): Promise<void> {
  // Resolve waiting external writes before abort/disposal can block on their
  // extension hooks. This is deliberately safe even when no live handle exists
  // (for example a stop/archive racing a just-finished session).
  getActionApprovalBridge().cancelSession(id, "session destroyed");
  const pendingCreation = sessionCreations.get(id);
  if (pendingCreation) {
    const generation = getPiSessionCapabilityDenialGeneration(id) + 1n;
    sessionCapabilityDenialGenerations.set(id, generation);
    sessionBrowserTeardownIntents.set(id, { generation, action: browserTeardown });
    await pendingCreation.catch(() => undefined);
  }
  const teardownIntentGeneration = sessionBrowserTeardownIntents.get(id)?.generation;
  const handle = sessions.get(id);
  if (!handle) {
    if (browserTeardown.kind === "close_session") {
      await productionInteractiveBrowserSessionLifecycle?.closeSessionWorkspaces(id, browserTeardown.reason);
    }
    if (teardownIntentGeneration !== undefined) clearBrowserTeardownIntent(id, teardownIntentGeneration);
    return;
  }
  const browserBinding = handle.protectedBrowserRuntime?.binding;
  await closePiSessionAuthorities(handle, browserTeardown);
  if (browserTeardown.kind === "close_session") {
    await productionInteractiveBrowserSessionLifecycle?.closeSessionWorkspaces(id, browserTeardown.reason);
  } else if (browserTeardown.kind === "revoke" && browserBinding) {
    await productionInteractiveBrowserSessionLifecycle?.revokeAuthority({
      capabilityId: browserBinding.capabilityId,
      projectId: browserBinding.projectId,
      agentProfileId: browserBinding.agentProfileId,
    }, browserTeardown.reason);
  }
  try {
    if (handle.session.isStreaming) {
      await handle.session.abort();
    }
  } catch {
    // ignore
  }
  try {
    handle.liveStreamingMessageUnsubscribe?.();
    handle.session.dispose();
  } catch {
    // ignore
  }
  getInterviewBridge().cancelSession(id);
  getSudoBridge().cancelSession(id);
  getCommandGuardIdentityBridge().cancelSession(id);
  handle.events.removeAllListeners();
  if (handle.sessionFile) invalidateSessionFileSnapshot(handle.sessionFile);
  sessions.delete(id);
  if (teardownIntentGeneration !== undefined) clearBrowserTeardownIntent(id, teardownIntentGeneration);
  maybeStopIdleCleanupTimer();
  // Clean up web-session lookup mappings. Exact object ownership is removed
  // synchronously so a stale tool context cannot fall through to colliding
  // legacy ID/file maps during teardown.
  piSessionManagerToWebSessionId.delete(handle.session.sessionManager);
  for (const [cwd, sid] of cwdToSessionId) {
    if (sid === id) cwdToSessionId.delete(cwd);
  }
  for (const [piSessionId, sid] of piSessionToWebSessionId) {
    if (sid === id) piSessionToWebSessionId.delete(piSessionId);
  }
  for (const [sessionFile, sid] of piSessionFileToWebSessionId) {
    if (sid === id) piSessionFileToWebSessionId.delete(sessionFile);
  }
}

export async function stopPiSession(
  id: string,
  browserTeardown: PiSessionBrowserTeardown = DEFAULT_BROWSER_TEARDOWN,
): Promise<void> {
  getActionApprovalBridge().cancelSession(id, "session stopped");
  const pending = sessionCreations.get(id);
  if (pending) {
    // Stop is itself a synchronous starting-runtime denial, not permission for
    // the old creation to publish briefly before being destroyed.
    latchPiSessionCapabilityDenial([id], sessions, browserTeardown);
    try {
      await pending;
    } catch {
      // A failed creation leaves no live session to stop.
    }
  }
  await destroyPiSession(id, browserTeardown);
}

export interface InterviewSubmissionDelivery {
  entryId: string;
  alreadyPresent: boolean;
}

export function interviewSubmissionContent(record: InterviewRecord): string {
  const submittedAt = record.submitted_at ? new Date(record.submitted_at).toISOString() : "unknown time";
  const answers = (record.answers ?? [])
    .map((answer) => `- ${answer.id}: ${answer.label}${answer.wasCustom ? " (custom)" : ""}`)
    .join("\n");
  return [
    "A previously requested interview/questionnaire has now been submitted.",
    "It may be stale; decide whether it remains relevant before acting.",
    `Request: ${record.request_id}; submission: ${record.submission_id ?? "unknown"}; originating tool: ${record.origin_tool_name}; submitted: ${submittedAt}`,
    "Answers:",
    answers || "- (no answers)",
  ].join("\n");
}

function findInterviewSubmissionEntry(handle: PiSessionHandle, record: InterviewRecord): string | undefined {
  return handle.session.sessionManager.getEntries().find((entry: any) => (
    entry.type === "custom_message" &&
    entry.customType === "wayang-interview-submission" &&
    entry.details?.request_id === record.request_id &&
    entry.details?.submission_id === record.submission_id &&
    verifyInterviewSubmissionEntry(record.session_id, entry)
  ))?.id;
}

export async function findInterviewToolResultEntry(sessionId: string, record: InterviewRecord): Promise<string | undefined> {
  if (record.session_id !== sessionId) throw new Error("Interview tool-result session mismatch");
  const sessionRow = getSessionById(sessionId);
  if (!sessionRow) throw new Error("Interview session no longer exists");
  const handle = getPiSession(sessionId) ?? await createPiSession(
    sessionId,
    sessionRow.cwd,
    sessionRow.provider,
    sessionRow.model,
    sessionRow.pi_session_file,
  );
  return handle.session.sessionManager.getEntries().find((entry: any) => {
    const evidence = resolveInterviewSubmissionEvidence(sessionId, entry);
    return evidence?.source === "tool_result"
      && evidence.requestId === record.request_id
      && evidence.submissionId === record.submission_id;
  })?.id;
}

/**
 * Inject an orphaned durable submission into its exact Wayang/pi session.
 * The caller marks the store record delivered only after this returns an entry
 * ID that is visible in the persisted pi session tree.
 */
export async function deliverInterviewSubmission(
  sessionId: string,
  record: InterviewRecord,
): Promise<InterviewSubmissionDelivery> {
  assertRuntimeMutationUnlocked(sessionId);
  if (record.session_id !== sessionId) throw new Error("Interview delivery session mismatch");
  const sessionRow = getSessionById(sessionId);
  if (!sessionRow) throw new Error("Interview session no longer exists");

  const handle = getPiSession(sessionId) ?? await createPiSession(
    sessionId,
    sessionRow.cwd,
    sessionRow.provider,
    sessionRow.model,
    sessionRow.pi_session_file,
  );
  if (handle.sessionFile && !sessionRow.pi_session_file) updatePiSessionFile(sessionId, handle.sessionFile);

  const existing = findInterviewSubmissionEntry(handle, record);
  if (existing) return { entryId: existing, alreadyPresent: true };
  assertRuntimeMutationUnlocked(sessionId);

  // Delayed interview delivery is not a fresh browser sendMessage turn and
  // cannot carry interactive-turn mutation provenance.
  beginNonBrowserTurn(handle, "interview_submission");
  const details = {
    request_id: record.request_id,
    submission_id: record.submission_id,
    session_id: record.session_id,
    origin_tool_name: record.origin_tool_name,
    origin_tool_call_id: record.origin_tool_call_id ?? null,
    created_at: record.created_at,
    submitted_at: record.submitted_at,
    questions: record.questions,
    answers: record.answers ?? [],
  };
  await handle.session.sendCustomMessage({
    customType: "wayang-interview-submission",
    content: interviewSubmissionContent(record),
    display: true,
    details,
  }, { deliverAs: "steer", triggerTurn: true });

  // When pi is streaming, sendCustomMessage queues steering work. Wait for the
  // SDK to persist its CustomMessageEntry before acknowledging delivery.
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const entryId = findInterviewSubmissionEntry(handle, record);
    if (entryId) return { entryId, alreadyPresent: false };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Interview submission was queued but not persisted before delivery timeout");
}

function manualCompactionQueueForHandle(handle: PiSessionHandle): ManualCompactionMessageQueue | undefined {
  const queue = handle.manualCompactionMessageQueue;
  return queue && queue.runtimeGeneration === handle.runtimeGeneration && !handle.capabilityAuthorityDenied
    ? queue
    : undefined;
}

function dropManualCompactionMessageQueue(handle: PiSessionHandle): void {
  const queue = handle.manualCompactionMessageQueue;
  if (!queue) return;
  queue.waitForUnlockUnsubscribe?.();
  queue.waitForUnlockUnsubscribe = undefined;
  queue.records.length = 0;
  queue.dispatching = undefined;
  queue.retainedBytes = 0;
  handle.manualCompactionMessageQueue = undefined;
}

/** Start only after the caller owns the existing transcript mutation lease. */
export function beginManualCompactionMessageQueue(handle: PiSessionHandle): void {
  assertCapabilityAuthorityAvailable(handle);
  if (handle.manualCompactionMessageQueue) {
    throw new WorkspaceStoreError("Manual compaction message admission is already active", 409);
  }
  handle.manualCompactionMessageQueue = {
    runtimeGeneration: handle.runtimeGeneration,
    compactionLeaseHeld: true,
    records: [],
    retainedBytes: 0,
    draining: false,
  };
}

export function isManualCompactionMessageQueueActive(id: string): boolean {
  const handle = sessions.get(id);
  return Boolean(handle && manualCompactionQueueForHandle(handle));
}

/** Call synchronously after releasing the exact manual-compaction mutation lease. */
export function markManualCompactionMutationLeaseReleased(handle: PiSessionHandle): void {
  const queue = manualCompactionQueueForHandle(handle);
  if (queue) queue.compactionLeaseHeld = false;
}

export function manualCompactionCanDeferBrowserMessage(
  id: string,
  rawContent: unknown,
  hasAttachments: boolean,
): boolean {
  const handle = sessions.get(id);
  const queue = handle && manualCompactionQueueForHandle(handle);
  if (!handle || !queue || typeof rawContent !== "string") return false;
  if (isSessionRuntimeMutationLocked(id) && !queue.compactionLeaseHeld) return false;
  const trimmed = rawContent.trim();
  return !trimmed.startsWith("/") && (trimmed.length > 0 || hasAttachments);
}

export function manualCompactionCanCancelQueuedBrowserMessage(id: string, clientMessageId: unknown): boolean {
  if (typeof clientMessageId !== "string") return false;
  const handle = sessions.get(id);
  const queue = handle && manualCompactionQueueForHandle(handle);
  if (!handle || !queue || (isSessionRuntimeMutationLocked(id) && !queue.compactionLeaseHeld)) return false;
  if (queue.dispatching?.clientMessageId === clientMessageId
    || queue.records.some((record) => record.clientMessageId === clientMessageId)) return true;
  const captured = handle.queuedBrowserMessages.get(clientMessageId);
  return Boolean(captured && isQueuedChatMessagePending(captured.capture));
}

export function manualCompactionCanInterrupt(id: string): boolean {
  const handle = sessions.get(id);
  const queue = handle && manualCompactionQueueForHandle(handle);
  return Boolean(queue && (!isSessionRuntimeMutationLocked(id) || queue.compactionLeaseHeld));
}

function deferredBrowserMessageBytes(
  content: string,
  images: readonly ImageContent[] | undefined,
  display: DeferredBrowserMessageRecord["queuedDisplay"],
): number {
  let bytes = Buffer.byteLength(content, "utf8")
    + Buffer.byteLength(display.content, "utf8")
    + Buffer.byteLength(display.rawUserText ?? "", "utf8")
    + Buffer.byteLength(display.provisionalTitleText ?? "", "utf8");
  for (const name of display.attachmentNames) bytes += Buffer.byteLength(name, "utf8");
  for (const image of images ?? []) {
    bytes += Buffer.byteLength(image.mimeType, "utf8") + Buffer.byteLength(image.data, "utf8");
  }
  return bytes;
}

/** @internal Exact handle seam used by focused FIFO tests. */
export function deferBrowserMessageDuringManualCompaction(
  handle: PiSessionHandle,
  content: string,
  images?: ImageContent[],
  clientMessageId?: string,
  queuedDisplay: {
    content: string;
    attachmentNames?: string[];
    rawUserText?: string;
    provisionalTitleText?: string;
    acceptedAt?: number;
  } = { content },
): BrowserMessageTurnResult {
  assertCapabilityAuthorityAvailable(handle);
  const queue = manualCompactionQueueForHandle(handle);
  if (!queue || queuedDisplay.content.trim().startsWith("/")) {
    throw new WorkspaceStoreError("Session transcript mutation is in progress", 409);
  }
  const queueRecordId = clientMessageId ?? randomUUID();
  if (clientMessageId && (
    queue.records.some((record) => record.clientMessageId === clientMessageId)
    || queue.dispatching?.clientMessageId === clientMessageId
    || handle.queuedBrowserMessages.has(clientMessageId)
    || [...interactiveTurnLedger(handle).values()].some((turn) => turn.clientMessageId === clientMessageId)
  )) throw new Error("Duplicate browser message ID");
  const display: DeferredBrowserMessageRecord["queuedDisplay"] = {
    content: queuedDisplay.content,
    attachmentNames: [...(queuedDisplay.attachmentNames ?? [])],
    ...(queuedDisplay.rawUserText !== undefined ? { rawUserText: queuedDisplay.rawUserText } : {}),
    ...(queuedDisplay.provisionalTitleText !== undefined
      ? { provisionalTitleText: queuedDisplay.provisionalTitleText }
      : {}),
    ...(queuedDisplay.acceptedAt !== undefined ? { acceptedAt: queuedDisplay.acceptedAt } : {}),
  };
  const retainedBytes = deferredBrowserMessageBytes(content, images, display);
  const retainedCount = queue.records.length + (queue.dispatching ? 1 : 0);
  if (retainedCount >= MAX_MANUAL_COMPACTION_DEFERRED_MESSAGES
    || retainedBytes > MAX_MANUAL_COMPACTION_DEFERRED_BYTES - queue.retainedBytes) {
    throw new WorkspaceStoreError("Manual compaction message queue is full", 409);
  }
  queue.records.push({
    queueRecordId,
    ...(clientMessageId ? { clientMessageId } : {}),
    content,
    ...(images && images.length > 0 ? { images: [...images] } : {}),
    queuedDisplay: display,
    retainedBytes,
    clientVisible: Boolean(clientMessageId),
    startCorrelated: false,
  });
  queue.retainedBytes += retainedBytes;
  markSessionActivity(handle.id);
  return { queued: true, cancellable: Boolean(clientMessageId) };
}

function boundedDeferredDispatchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = raw.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ").trim()
    || "Queued message dispatch failed";
  if (Buffer.byteLength(safe, "utf8") <= 448) return safe;
  let bounded = "";
  for (const character of safe) {
    if (Buffer.byteLength(`${bounded}${character}…`, "utf8") > 448) break;
    bounded += character;
  }
  return `${bounded}…`;
}

function manualCompactionRuntimeIsCurrent(handle: PiSessionHandle, queue: ManualCompactionMessageQueue): boolean {
  return sessions.get(handle.id) === handle
    && !handle.capabilityAuthorityDenied
    && handle.runtimeGeneration === queue.runtimeGeneration
    && handle.manualCompactionMessageQueue === queue;
}

/** Release the mutation lease before calling this; the phase remains active until its FIFO empties. */
export async function drainManualCompactionMessageQueue(
  handle: PiSessionHandle,
  options: { isRuntimeCurrent?: () => boolean } = {},
): Promise<void> {
  const queue = manualCompactionQueueForHandle(handle);
  if (!queue || queue.draining) return;
  const isCurrent = options.isRuntimeCurrent ?? (() => manualCompactionRuntimeIsCurrent(handle, queue));
  if (!isCurrent()) {
    dropManualCompactionMessageQueue(handle);
    return;
  }
  if (isSessionRuntimeMutationLocked(handle.id)) {
    if (!queue.waitForUnlockUnsubscribe) {
      const retry = () => {
        if (isSessionRuntimeMutationLocked(handle.id)) return;
        queue.waitForUnlockUnsubscribe?.();
        queue.waitForUnlockUnsubscribe = undefined;
        void drainManualCompactionMessageQueue(handle, options).catch(() => undefined);
      };
      queue.waitForUnlockUnsubscribe = onSessionRuntimeMutationLockChanged((sessionId) => {
        if (sessionId === handle.id) retry();
      });
      queueMicrotask(retry);
    }
    return;
  }

  queue.draining = true;
  try {
    while (queue.records.length > 0) {
      if (!isCurrent()) {
        dropManualCompactionMessageQueue(handle);
        return;
      }
      if (isSessionRuntimeMutationLocked(handle.id)) {
        queue.draining = false;
        await drainManualCompactionMessageQueue(handle, options);
        return;
      }
      const record = queue.records.shift()!;
      queue.dispatching = record;
      try {
        await sendBrowserMessageTurn(
          handle,
          record.content,
          record.images,
          record.clientMessageId,
          record.queuedDisplay,
        );
      } catch (error) {
        const bounded = boundedDeferredDispatchError(error);
        const errorMessage = `Queued message dispatch failed: ${bounded}`;
        try { updateSessionError(handle.id, errorMessage); } catch { /* runtime authority below remains decisive */ }
        if (record.clientMessageId) {
          try {
            handle.events.emit("message", {
              type: "queued_message_ack",
              client_message_id: record.clientMessageId,
              status: "rejected",
              error: errorMessage,
            } satisfies SerializedMessage);
          } catch { /* a failing observer cannot reorder or stop the FIFO */ }
        }
        try {
          handle.events.emit("message", {
            type: "error",
            code: "queued_message_dispatch_failed",
            ...(record.clientMessageId ? { client_message_id: record.clientMessageId } : {}),
            error: errorMessage,
          } satisfies SerializedMessage);
        } catch { /* a failing observer cannot reorder or stop the FIFO */ }
        try { await handle.session.waitForIdle(); } catch { /* authority/current checks below remain decisive */ }
      } finally {
        if (queue.dispatching === record) queue.dispatching = undefined;
        queue.retainedBytes = Math.max(0, queue.retainedBytes - record.retainedBytes);
      }
    }
  } finally {
    if (handle.manualCompactionMessageQueue === queue) {
      queue.draining = false;
      if (queue.records.length === 0 && !queue.dispatching) dropManualCompactionMessageQueue(handle);
    }
  }
}

export interface BrowserMessageTurnResult {
  queued: boolean;
  cancellable: boolean;
}

export interface QueuedBrowserMessageProjection {
  client_message_id: string;
  content: string;
  attachment_names: string[];
}

export async function sendBrowserMessageTurn(
  handle: PiSessionHandle,
  content: string,
  images?: ImageContent[],
  clientMessageId?: string,
  queuedDisplay?: {
    content: string;
    attachmentNames?: string[];
    rawUserText?: string;
    provisionalTitleText?: string;
    acceptedAt?: number;
  },
): Promise<BrowserMessageTurnResult> {
  assertCapabilityAuthorityAvailable(handle);
  if (clientMessageId && [...interactiveTurnLedger(handle).values()].some((candidate) => candidate.clientMessageId === clientMessageId)) {
    throw new Error("Duplicate browser message ID");
  }
  const turn = beginInteractiveTurn(handle, content, {
    rawUserText: queuedDisplay?.rawUserText ?? queuedDisplay?.content ?? content,
    provisionalTitleText: queuedDisplay?.provisionalTitleText ?? queuedDisplay?.content ?? content,
    clientMessageId,
    acceptedAt: queuedDisplay?.acceptedAt,
  });
  const isStreaming = handle.session.isStreaming;
  if (isStreaming) {
    try {
      const queueRecordId = clientMessageId ?? turn.clientMessageId;
      if (handle.queuedBrowserMessages.has(queueRecordId)) {
        throw new Error("Duplicate queued browser message ID");
      }
      const queueBefore = snapshotQueuedChatMessages(handle.session);
      // In pi 0.84.1 steer() mutates the queue synchronously before returning
      // its promise. Capture in this same event-loop turn so concurrent browser
      // messages cannot collapse two registrations into one ambiguous delta.
      // Provenance capture is required even for legacy clients that omit a
      // client_message_id; those internal records are never projected to the UI.
      const steering = handle.session.steer(content, images);
      const capture = captureQueuedChatMessage(handle.session, queueBefore);
      if (capture) {
        if (clientMessageId) queuedBrowserClientMessageIds.set(capture.message, clientMessageId);
        handle.queuedBrowserMessages.set(queueRecordId, {
          capture,
          content: queuedDisplay?.content ?? content,
          attachmentNames: [...(queuedDisplay?.attachmentNames ?? [])],
          turnToken: turn.token,
          clientVisible: Boolean(clientMessageId),
          startCorrelated: false,
        });
      }
      await steering;
      const pendingTurn = interactiveTurnLedger(handle).get(turn.token);
      if (pendingTurn) {
        interactiveTurnLedger(handle).set(turn.token, Object.freeze({
          ...pendingTurn,
          provisionalTitleAccepted: true,
        }));
      }
      return {
        queued: capture ? isQueuedChatMessagePending(capture) : handle.session.getSteeringMessages().includes(content),
        cancellable: Boolean(clientMessageId && capture && isQueuedChatMessagePending(capture)),
      };
    } catch (error) {
      retireInteractiveTurn(handle, turn.token);
      throw error;
    }
  } else {
    try {
      await handle.session.prompt(content, {
        expandPromptTemplates: true,
        images,
      });
      const completedTurn = Object.freeze({
        ...turn,
        provisionalTitleAccepted: true,
        settlementReady: true,
      });
      interactiveTurnLedger(handle).set(turn.token, completedTurn);
      persistAcceptedProvisionalTitle(handle, completedTurn);
      settleInteractiveTurnsQuietly(handle);
      // agent_settled fires before prompt() resolves, so idle browser sends do
      // not have their source marker yet in the lifecycle listener above.
      deferWayangAutoTitleAfterInteraction(handle, [completedTurn]);
      return { queued: false, cancellable: false };
    } catch (error) {
      retireInteractiveTurn(handle, turn.token);
      throw error;
    }
  }
}

export async function sendMessage(
  id: string,
  content: string,
  images?: ImageContent[],
  clientMessageId?: string,
  queuedDisplay?: {
    content: string;
    attachmentNames?: string[];
    rawUserText?: string;
    provisionalTitleText?: string;
    acceptedAt?: number;
  },
): Promise<BrowserMessageTurnResult> {
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  assertCapabilityAuthorityAvailable(handle);
  const manualQueue = manualCompactionQueueForHandle(handle);
  if (manualQueue) {
    if (isSessionRuntimeMutationLocked(id) && !manualQueue.compactionLeaseHeld) {
      assertRuntimeMutationUnlocked(id);
    }
    return deferBrowserMessageDuringManualCompaction(
      handle,
      content,
      images,
      clientMessageId,
      queuedDisplay ?? { content },
    );
  }
  assertRuntimeMutationUnlocked(id);
  markSessionActivity(id);
  return sendBrowserMessageTurn(handle, content, images, clientMessageId, queuedDisplay);
}

/** @internal Shared projection seam for live reconnect and focused queue tests. */
export function projectQueuedBrowserMessages(handle: PiSessionHandle): QueuedBrowserMessageProjection[] {
  const messages: QueuedBrowserMessageProjection[] = [];
  for (const [clientMessageId, record] of handle.queuedBrowserMessages) {
    const state = queuedChatMessageState(record.capture);
    if (state === "claimed") {
      record.clientVisible = false;
      continue;
    }
    if (record.clientVisible) {
      messages.push({
        client_message_id: clientMessageId,
        content: record.content,
        attachment_names: [...record.attachmentNames],
      });
    }
  }
  const deferred = manualCompactionQueueForHandle(handle);
  const deferredRecords = deferred
    ? [...(deferred.dispatching?.clientVisible ? [deferred.dispatching] : []), ...deferred.records]
    : [];
  for (const record of deferredRecords) {
    if (!record.clientVisible || !record.clientMessageId) continue;
    messages.push({
      client_message_id: record.clientMessageId,
      content: record.queuedDisplay.content,
      attachment_names: [...record.queuedDisplay.attachmentNames],
    });
  }
  return messages;
}

export function getQueuedBrowserMessages(id: string): QueuedBrowserMessageProjection[] {
  const handle = sessions.get(id);
  return handle ? projectQueuedBrowserMessages(handle) : [];
}

/** @internal Exact handle seam used by focused deferred-cancellation tests. */
export function cancelQueuedBrowserMessageForHandle(handle: PiSessionHandle, clientMessageId: string): boolean {
  assertCapabilityAuthorityAvailable(handle);
  const id = handle.id;
  const deferred = manualCompactionQueueForHandle(handle);
  if (deferred && isSessionRuntimeMutationLocked(id) && !deferred.compactionLeaseHeld) {
    assertRuntimeMutationUnlocked(id);
  }
  if (deferred?.dispatching?.clientMessageId === clientMessageId) return false;
  const deferredIndex = deferred?.records.findIndex((record) => record.clientMessageId === clientMessageId) ?? -1;
  if (deferred && deferredIndex >= 0) {
    const [cancelled] = deferred.records.splice(deferredIndex, 1);
    if (!cancelled) return false;
    deferred.retainedBytes = Math.max(0, deferred.retainedBytes - cancelled.retainedBytes);
    markSessionActivity(id);
    return true;
  }
  if (!deferred) assertRuntimeMutationUnlocked(id);
  const record = handle.queuedBrowserMessages.get(clientMessageId);
  if (!record) return false;
  const cancelled = cancelCapturedQueuedChatMessage(record.capture);
  if (cancelled) {
    handle.queuedBrowserMessages.delete(clientMessageId);
    retireInteractiveTurn(handle, record.turnToken);
    markSessionActivity(id);
    return true;
  }
  const state = queuedChatMessageState(record.capture);
  if (state === "claimed") {
    // Pi already claimed the exact object. Keep its source ledger record until
    // authoritative settlement; this browser item is simply not cancellable.
    record.clientVisible = false;
    return false;
  }
  throw new Error("The pi queued-message layout changed; cancellation was refused without changing the queue");
}

export function cancelQueuedBrowserMessage(id: string, clientMessageId: string): boolean {
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  return cancelQueuedBrowserMessageForHandle(handle, clientMessageId);
}

function extractReplayPayloadFromUserContent(content: unknown): { text: string; images: ImageContent[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };

  const textParts: string[] = [];
  const images: ImageContent[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (typeof value.text === "string") {
      textParts.push(value.text);
      continue;
    }
    if (value.type === "image" && typeof value.mimeType === "string" && typeof value.data === "string") {
      images.push({ type: "image", mimeType: value.mimeType, data: value.data });
    }
  }

  return { text: textParts.join(""), images };
}

export async function resendMessage(id: string, messageId: string, includeHistory = true): Promise<ResendMessageResult> {
  assertRuntimeMutationUnlocked(id);
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  assertCapabilityAuthorityAvailable(handle);
  if (handle.session.isStreaming) throw new Error("Cannot resend while the agent is running");

  const entry = handle.session.sessionManager.getEntry(messageId);
  if (!entry || entry.type !== "message" || entry.message?.role !== "user") {
    throw new Error("Can only resend a user message from the current session history");
  }

  const { text, images } = extractReplayPayloadFromUserContent(entry.message.content);
  if (!text.trim() && images.length === 0) {
    throw new Error("Selected user message has no replayable text or images");
  }

  markSessionActivity(id);
  const navigation = await handle.session.navigateTree(messageId, { summarize: false });
  if (navigation.cancelled) throw new Error("Resend was cancelled");

  // Resend replays a persisted entry and is not fresh browser-originated
  // provenance. It must never inherit or mint interactive-turn mutation authority.
  beginNonBrowserTurn(handle, "resend");
  const turn = handle.session.prompt(text, {
    expandPromptTemplates: true,
    images: images.length > 0 ? images : undefined,
  }).then(() => {
    markSessionActivity(id);
  });

  return {
    messages: includeHistory ? getMessageHistory(id) : [],
    turn,
  };
}

export interface RunPromptResult {
  resultSummary: string | null;
  /** Full final assistant text for connector delivery; never scheduler-truncated. */
  finalAssistantText: string | null;
  messages: SerializedMessage[];
}

/**
 * The small AgentSession surface needed by scheduled prompt execution. Exported
 * so lifecycle behavior can be regression-tested without a provider or a real
 * transcript.
 */
export interface ScheduledPromptSession {
  readonly isStreaming: boolean;
  readonly messages: any[];
  prompt(content: string, options: { expandPromptTemplates: true }): Promise<void>;
  steer(content: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface ResendMessageResult {
  messages: SerializedMessage[];
  turn: Promise<void>;
}

export async function waitForScheduledPrompt(
  session: ScheduledPromptSession,
  content: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  // AgentSession.prompt() resolves only after the complete agent run, including
  // tool calls, queued continuations, retries, compaction, and agent_settled.
  // waitForIdle() also covers the steer path and makes that lifecycle contract
  // explicit. In particular, turn_end/agent_end are intermediate events and
  // must never be used as scheduled-run completion signals.
  const completion = (async () => {
    if (session.isStreaming) {
      await session.steer(content);
    } else {
      await session.prompt(content, { expandPromptTemplates: true });
    }
    await session.waitForIdle();
  })();

  const timeoutMs = options.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    await completion;
    return;
  }

  let timer: NodeJS.Timeout | null = null;
  const timeoutError = new Error(`Prompt timed out after ${timeoutMs}ms`);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });

  try {
    await Promise.race([completion, timeout]);
  } catch (error) {
    if (error !== timeoutError) throw error;

    // A timed-out run remains active in scheduler bookkeeping until abort has
    // driven the SDK back to idle. Also await the original prompt promise: an
    // extension may still be in prompt preflight when abort is requested, and
    // marking the run failed before that promise settles would recreate the
    // overlap/bookkeeping bug this path is meant to prevent.
    let abortError: unknown;
    try {
      await session.abort();
    } catch (abortFailure) {
      abortError = abortFailure;
    }
    try {
      await completion;
    } catch {
      // Abort commonly rejects the in-flight prompt; timeout remains the
      // scheduler-facing classification.
    }
    if (abortError) {
      const abortMessage = abortError instanceof Error ? abortError.message : String(abortError);
      throw new Error(`${timeoutError.message}; abort failed: ${abortMessage}`, { cause: abortError });
    }
    throw timeoutError;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface MessagingPromptOrigin {
  connectorId: string;
  connectorEventId: string;
  endpointId: string;
  canonicalEventSha256: string;
}

function validMessagingPromptOrigin(origin: MessagingPromptOrigin): boolean {
  const ids = [origin.connectorId, origin.connectorEventId, origin.endpointId];
  return ids.every((value) => typeof value === "string" && value.length > 0
    && value.length <= 512 && value === value.normalize("NFC")
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value))
    && /^[a-f0-9]{64}$/u.test(origin.canonicalEventSha256);
}

function messagingOriginEntry(handle: PiSessionHandle, origin: MessagingPromptOrigin): any | undefined {
  return handle.session.sessionManager.getEntries().find((entry: any) => (
    entry?.type === "custom_message"
    && entry.customType === "wayang-messaging-input"
    && entry.details?.connector_id === origin.connectorId
    && entry.details?.connector_event_id === origin.connectorEventId
    && entry.details?.endpoint_id === origin.endpointId
    && entry.details?.canonical_event_sha256 === origin.canonicalEventSha256
  ));
}

export function hasMessagingPromptOrigin(id: string, origin: MessagingPromptOrigin): boolean {
  if (!validMessagingPromptOrigin(origin)) return false;
  const handle = sessions.get(id);
  return Boolean(handle && messagingOriginEntry(handle, origin));
}

/**
 * Run one connector-originated prompt without browser provenance, steering, or
 * approval-client presence. The custom message is the durable prompt and exact
 * origin marker, so a recovered event can fail closed instead of replaying it.
 */
export async function runMessagingPromptAndWait(
  id: string,
  content: string,
  origin: MessagingPromptOrigin,
  options: { timeoutMs?: number } = {},
): Promise<RunPromptResult> {
  assertRuntimeMutationUnlocked(id);
  if (!validMessagingPromptOrigin(origin)) throw new WorkspaceStoreError("Messaging prompt origin is invalid");
  if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content, "utf8") > 64 * 1024) {
    throw new WorkspaceStoreError("Messaging prompt content is invalid");
  }
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  assertCapabilityAuthorityAvailable(handle);
  if (handle.session.isStreaming || handle.session.pendingMessageCount > 0) {
    throw new WorkspaceStoreError("Wayang session is busy", 409);
  }
  const actionBridge = getActionApprovalBridge();
  if (actionBridge.hasClient(id)) {
    throw new WorkspaceStoreError("Wayang session has an interactive approval client; continue in Wayang or close it first", 409);
  }
  if (!lockRuntimeMutationSession(id)) throw new WorkspaceStoreError("Wayang session is already reserved", 409);
  let releaseHeadlessLease: (() => void) | null = null;
  let priorToolNames: string[] | null = null;

  try {
    releaseHeadlessLease = actionBridge.acquireHeadlessLease(id);
    const current = sessions.get(id);
    if (!releaseHeadlessLease || current !== handle || handle.session.isStreaming
      || handle.session.pendingMessageCount > 0) {
      throw new WorkspaceStoreError("Wayang session changed or has pending approval authority before messaging dispatch", 409);
    }
    if (messagingOriginEntry(handle, origin)) {
      throw new WorkspaceStoreError("Messaging event origin is already present in the Wayang session", 409);
    }
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined
      && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60 * 60 * 1000)) {
      throw new WorkspaceStoreError("Messaging prompt timeout is invalid");
    }
    priorToolNames = handle.session.getActiveToolNames();
    handle.session.setActiveToolsByName([]);
    const firstNewMessageIndex = handle.session.messages.length;
    markSessionActivity(id);
    beginNonBrowserTurn(handle, "messaging_prompt");
    const completion = (async () => {
      await handle.session.sendCustomMessage({
        customType: "wayang-messaging-input",
        content,
        display: true,
        details: {
          connector_id: origin.connectorId,
          connector_event_id: origin.connectorEventId,
          endpoint_id: origin.endpointId,
          canonical_event_sha256: origin.canonicalEventSha256,
        },
      }, { triggerTurn: true });
      await handle.session.waitForIdle();
    })();

    if (timeoutMs !== undefined) {
      let timer: NodeJS.Timeout | null = null;
      const timeoutError = new Error(`Messaging prompt timed out after ${timeoutMs}ms`);
      try {
        await Promise.race([
          completion,
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs); }),
        ]);
      } catch (error) {
        if (error !== timeoutError) throw error;
        try { await handle.session.abort(); } catch { /* timeout classification remains authoritative */ }
        try { await completion; } catch { /* abort may reject the in-flight custom turn */ }
        throw timeoutError;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      await completion;
    }

    const outcome = classifyScheduledPromptResult(handle.session.messages.slice(firstNewMessageIndex));
    if (outcome.error) throw new Error(outcome.error);
    return {
      resultSummary: outcome.resultSummary,
      finalAssistantText: extractLastAssistantText(handle.session.messages.slice(firstNewMessageIndex)),
      messages: getMessageHistory(id),
    };
  } finally {
    try {
      if (priorToolNames) handle.session.setActiveToolsByName(priorToolNames);
    } finally {
      releaseHeadlessLease?.();
      unlockRuntimeMutationSession(id);
    }
  }
}

export async function runPromptAndWait(
  id: string,
  content: string,
  options: { timeoutMs?: number } = {},
): Promise<RunPromptResult> {
  assertRuntimeMutationUnlocked(id);
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  assertCapabilityAuthorityAvailable(handle);
  markSessionActivity(id);
  beginNonBrowserTurn(handle, "scheduled_prompt");

  await waitForScheduledPrompt(handle.session, content, options);

  const outcome = classifyScheduledPromptResult(handle.session.messages);
  if (outcome.error) throw new Error(outcome.error);

  return {
    resultSummary: outcome.resultSummary,
    finalAssistantText: extractLastAssistantText(handle.session.messages),
    messages: getMessageHistory(id),
  };
}

export async function abortInteractiveTurn(
  handle: PiSessionHandle,
  options: { clearQueue?: boolean } = {},
): Promise<{ steering: string[]; followUp: string[] }> {
  retireInteractiveTurn(handle);
  const clearedQueue = options.clearQueue
    ? handle.session.clearQueue()
    : { steering: [], followUp: [] };
  if (options.clearQueue) dropManualCompactionMessageQueue(handle);
  if (handle.session.isCompacting) handle.session.abortCompaction();
  await handle.session.abort();
  return clearedQueue;
}

export async function abortSession(
  id: string,
  options: { clearQueue?: boolean } = {},
): Promise<{ steering: string[]; followUp: string[] }> {
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  markSessionActivity(id);
  getActionApprovalBridge().cancelSession(id, "session interrupted");
  return abortInteractiveTurn(handle, options);
}

/** @internal Exported for zero-subscriber lifecycle regression tests. */
export function trackOverflowRecovery(handle: PiSessionHandle, event: AgentSessionEvent): void {
  if (event.type === "compaction_end" && event.reason === "overflow") {
    handle.pendingOverflowRecovery = undefined;
    if (!event.result || !event.willRetry) return;
    const branch = handle.session.sessionManager.getBranch();
    const compaction = [...branch].reverse().find((entry: any) => (
      entry?.type === "compaction"
      && typeof entry.id === "string"
      && typeof entry.parentId === "string"
    )) as any;
    if (!compaction) return;
    handle.pendingOverflowRecovery = {
      compactionEntryId: compaction.id,
      overflowEntryId: compaction.parentId,
    };
    return;
  }
  if (event.type === "message_end" && event.message?.role === "assistant" && handle.pendingOverflowRecovery) {
    const assistant = event.message as any;
    if (assistant.stopReason !== "error" && assistant.stopReason !== "length") {
      handle.pendingOverflowRecovery.successObserved = true;
    }
    return;
  }
  if (event.type !== "agent_settled" || !handle.pendingOverflowRecovery) return;
  const recovery = handle.pendingOverflowRecovery;
  handle.pendingOverflowRecovery = undefined;
  if (!recovery.successObserved) return;
  handle.session.sessionManager.appendCustomEntry(OVERFLOW_RETRY_MARKER, {
    compactionEntryId: recovery.compactionEntryId,
    overflowEntryId: recovery.overflowEntryId,
  });
}

/** @internal Exported for lifecycle persistence regression tests. */
export function persistSettledSessionError(handle: PiSessionHandle, event: AgentSessionEvent): void {
  if (event.type === "compaction_end") {
    if (event.reason === "manual") {
      if (event.result) updateSessionError(handle.id, null);
      else if (event.errorMessage) updateSessionError(handle.id, event.errorMessage);
      return;
    }
    if (event.errorMessage) handle.pendingSessionError = event.errorMessage;
    return;
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const assistant = event.message as any;
    if (assistant.stopReason !== "error" && assistant.stopReason !== "length") {
      handle.pendingSessionError = undefined;
    }
    return;
  }
  if (event.type !== "agent_settled") return;
  const outcome = classifyScheduledPromptResult(handle.session.messages);
  updateSessionError(handle.id, outcome.error ?? handle.pendingSessionError ?? null);
  handle.pendingSessionError = undefined;
}

/**
 * Subscribe to pi session events and forward serialized messages
 * to a callback. Returns an unsubscribe function.
 */
export function subscribeToSession(
  id: string,
  onMessage: (msg: SerializedMessage) => void,
): () => void {
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);

  handle.subscriberCount++;
  markSessionActivity(id);

  const unsub = handle.session.subscribe((event: AgentSessionEvent) => {
    // No queued or future result is released from a denied handle. A fresh
    // runtime/handle is required after cleanup.
    if (handle.capabilityAuthorityDenied) return;
    const serialized = serializeEvent(event);
    if (serialized) {
      markSessionActivity(id);
      onMessage(serialized);
    }
  });
  const onRuntimeMessage = (message: SerializedMessage) => {
    if (!handle.capabilityAuthorityDenied) onMessage(message);
  };
  handle.events.on("message", onRuntimeMessage);

  return () => {
    handle.subscriberCount = Math.max(0, handle.subscriberCount - 1);
    handle.events.off("message", onRuntimeMessage);
    unsub();
  };
}

// ---------------------------------------------------------------------------
// Event serialization
// ---------------------------------------------------------------------------

export function serializeEvent(event: AgentSessionEvent): SerializedMessage | null {
  switch (event.type) {
    case "message_start": {
      const message = (event as any).message;
      const serialized = serializeMessage("message_start", message);
      const clientMessageId = message && typeof message === "object"
        ? queuedBrowserClientMessageIds.get(message)
        : undefined;
      return clientMessageId ? { ...serialized, client_message_id: clientMessageId } : serialized;
    }
    case "message_update": {
      const e = event as any;
      if (e.assistantMessageEvent?.type === "text_delta") {
        return { type: "text_delta", delta: e.assistantMessageEvent.delta };
      }
      if (e.assistantMessageEvent?.type === "thinking_delta") {
        return { type: "thinking_delta", delta: e.assistantMessageEvent.delta };
      }
      return null;
    }
    case "message_end": {
      return serializeMessage("message_end", (event as any).message);
    }
    case "tool_execution_start": {
      const e = event as any;
      return {
        type: "tool_execution_start",
        tool_call_id: e.toolCallId,
        tool_name: e.toolName,
        input: e.args,
      };
    }
    case "tool_execution_update": {
      const e = event as any;
      return {
        type: "tool_execution_update",
        tool_call_id: e.toolCallId,
        partial_result: e.partialResult,
      };
    }
    case "tool_execution_end": {
      const e = event as any;
      return {
        type: "tool_execution_end",
        tool_call_id: e.toolCallId,
        tool_name: e.toolName,
        result: e.result,
        is_error: e.isError,
      };
    }
    case "agent_start": {
      return { type: "agent_start" };
    }
    case "agent_end": {
      const e = event as any;
      return {
        type: "agent_end",
        messages: Array.isArray(e.messages)
          ? e.messages.map((m: any) => serializeMessageValue(m))
          : [],
        will_retry: Boolean(e.willRetry),
      };
    }
    case "agent_settled": {
      return { type: "agent_settled" };
    }
    case "turn_start": {
      return { type: "turn_start" };
    }
    case "turn_end": {
      const e = event as any;
      return {
        type: "turn_end",
        message: e.message ? serializeMessageValue(e.message) : null,
      };
    }
    case "queue_update": {
      const e = event as any;
      return {
        type: "queue_update",
        steering: Array.isArray(e.steering) ? e.steering : [],
        followUp: Array.isArray(e.followUp) ? e.followUp : [],
      };
    }
    case "compaction_start": {
      const e = event as any;
      return { type: "compaction_start", reason: e.reason };
    }
    case "compaction_end": {
      const e = event as any;
      return {
        type: "compaction_end",
        reason: e.reason,
        succeeded: Boolean(e.result),
        aborted: Boolean(e.aborted),
        will_retry: Boolean(e.willRetry),
        ...(e.result ? {
          tokens_before: e.result.tokensBefore,
          estimated_tokens_after: e.result.estimatedTokensAfter,
        } : {}),
        ...(e.errorMessage ? { error: e.errorMessage } : {}),
      };
    }
    case "auto_retry_start":
    case "auto_retry_end":
      return null;

    default:
      return null;
  }
}

function serializeMessage(
  type: string,
  message: any,
): SerializedMessage {
  return { type, message: serializeMessageValue(message) };
}

export function classifyAssistantErrorKind(errorMessage: string | null | undefined): "context_overflow" | null {
  if (!errorMessage) return null;
  return isContextOverflow({ role: "assistant", content: [], stopReason: "error", errorMessage } as any)
    ? "context_overflow"
    : null;
}

function serializeMessageValue(msg: any): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
  };

  if (msg.model) base.model = msg.model;
  if (msg.stopReason) base.stopReason = msg.stopReason;
  if (msg.usage) base.usage = msg.usage;
  if (msg.errorMessage) {
    base.errorMessage = msg.errorMessage;
    const errorKind = msg.role === "assistant" ? classifyAssistantErrorKind(msg.errorMessage) : null;
    if (errorKind) base.errorKind = errorKind;
  }
  if (msg.customType) base.customType = msg.customType;
  if (msg.toolCallId) base.toolCallId = msg.toolCallId;
  if (msg.toolName) base.toolName = msg.toolName;
  if (msg.isError !== undefined) base.isError = msg.isError;
  if (msg.display !== undefined) base.display = msg.display;
  if (msg.details !== undefined) base.details = msg.details;
  if (msg.command) base.command = msg.command;
  if (msg.output !== undefined) base.output = msg.output;
  if (msg.exitCode !== undefined) base.exitCode = msg.exitCode;
  if (msg.cancelled !== undefined) base.cancelled = msg.cancelled;
  if (msg.truncated !== undefined) base.truncated = msg.truncated;

  return base;
}

export function classifyScheduledPromptResult(messages: any[]): {
  error: string | null;
  resultSummary: string | null;
} {
  return {
    error: getLastAssistantError(messages),
    resultSummary: summarizeLastAssistantMessage(messages),
  };
}

function getLastAssistantError(messages: any[]): string | null {
  const assistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!assistant) return null;
  if (assistant.errorMessage) return String(assistant.errorMessage);
  if (assistant.stopReason === "error") return "Assistant turn ended with an error";
  return null;
}

function extractLastAssistantText(messages: any[]): string | null {
  const assistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!assistant) return null;
  const content = assistant.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  } else if (content !== undefined && content !== null) {
    text = String(content);
  }
  const trimmed = text.trim();
  return trimmed || null;
}

function summarizeLastAssistantMessage(messages: any[]): string | null {
  const normalized = extractLastAssistantText(messages)?.replace(/\s+/g, " ").trim() ?? "";
  return normalized ? normalized.slice(0, 500) : null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function normalizeTodo(raw: any, fallbackId: number): SerializedTodoItem | null {
  if (!raw || typeof raw.text !== "string" || raw.text.trim() === "") return null;
  return {
    id: typeof raw.id === "number" ? raw.id : fallbackId,
    text: raw.text.trim(),
    status: typeof raw.status === "string" ? raw.status : "pending",
    priority: typeof raw.priority === "string" ? raw.priority : undefined,
    assignee: typeof raw.assignee === "string" ? raw.assignee : undefined,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((n: unknown): n is number => typeof n === "number")
      : undefined,
  };
}

function extractTodoStateFromEntries(entries: any[]): SerializedTodoState {
  let todos: SerializedTodoItem[] = [];
  let nextId: number | undefined;
  let source: SerializedTodoState["source"] = "none";
  const preseedByText = new Map<string, SerializedTodoItem>();

  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "todo-preseed") {
      const rawTodos = Array.isArray(entry.data?.todos) ? entry.data.todos : [];
      for (const raw of rawTodos) {
        const todo = normalizeTodo(raw, preseedByText.size + 1);
        if (todo && !preseedByText.has(todo.text)) preseedByText.set(todo.text, todo);
      }
    }

    if (entry.type === "custom" && entry.customType === "todo-state") {
      const rawTodos = Array.isArray(entry.data?.todos) ? entry.data.todos : [];
      todos = rawTodos
        .map((todo: any, index: number) => normalizeTodo(todo, index + 1))
        .filter((todo: SerializedTodoItem | null): todo is SerializedTodoItem => !!todo);
      nextId = typeof entry.data?.nextId === "number" ? entry.data.nextId : undefined;
      source = "todo-state";
    }

    if (entry.type === "message") {
      const msg = entry.message;
      const rawTodos = msg?.role === "toolResult" && msg?.toolName === "todo" && Array.isArray(msg?.details?.todos)
        ? msg.details.todos
        : null;
      if (rawTodos) {
        todos = rawTodos
          .map((todo: any, index: number) => normalizeTodo(todo, index + 1))
          .filter((todo: SerializedTodoItem | null): todo is SerializedTodoItem => !!todo);
        nextId = typeof msg.details?.nextId === "number" ? msg.details.nextId : nextId;
        source = "tool-result";
      }
    }
  }

  if (todos.length === 0 && preseedByText.size > 0) {
    todos = [...preseedByText.values()];
    nextId = todos.length + 1;
    source = "todo-preseed";
  }

  return { type: "todo_state", todos, nextId, source };
}

function messageRoleToHistoryType(role: string | undefined): string {
  return role === "user"
    ? "user"
    : role === "assistant"
      ? "assistant"
      : role === "custom"
        ? "custom"
        : role || "custom";
}

function customHistoryMessage(customType: string, content: unknown, timestamp?: string, details?: unknown, display?: boolean): SerializedMessage {
  return {
    type: "custom",
    message: serializeMessageValue({
      role: "custom",
      customType,
      content,
      timestamp,
      details,
      display,
    }),
  };
}

const OVERFLOW_RETRY_MARKER = "wayang-overflow-retry-v1";

export function serializeHistoryEntries(entries: any[]): SerializedMessage[] {
  const serialized: SerializedMessage[] = [];
  const addMutationStatus = (row: SerializedMessage, entry: any): SerializedMessage => {
    if (trustedEditedMutationMarker(entry?.wayangMutation)) row.mutation_status = "edited";
    return row;
  };
  // Compaction entries do not persist their reason or retry outcome. Suppress a
  // provider overflow only when Wayang observed a successful assistant response
  // after Pi's compact-and-retry continuation. Markers carry validated IDs so
  // extension-appended entries between compaction and continuation are harmless.
  const compactionById = new Map(entries
    .filter((entry) => entry?.type === "compaction" && typeof entry.id === "string")
    .map((entry) => [entry.id, entry]));
  const recoveredOverflowEntryIds = new Set<string>();
  for (const marker of entries) {
    if (marker?.type !== "custom" || marker.customType !== OVERFLOW_RETRY_MARKER) continue;
    const compactionEntryId = marker.data?.compactionEntryId;
    const overflowEntryId = marker.data?.overflowEntryId;
    const compaction = typeof compactionEntryId === "string" ? compactionById.get(compactionEntryId) : undefined;
    if (
      compaction
      && typeof overflowEntryId === "string"
      && compaction.parentId === overflowEntryId
    ) {
      recoveredOverflowEntryIds.add(overflowEntryId);
    }
  }

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (
        recoveredOverflowEntryIds.has(entry.id)
        && message?.role === "assistant"
        && isContextOverflow(message)
      ) {
        continue;
      }
      serialized.push(addMutationStatus({
        type: messageRoleToHistoryType(message?.role),
        id: entry.id,
        parentId: entry.parentId,
        message: serializeMessageValue(message),
      }, entry));
      continue;
    }

    if (entry.type === "custom_message") {
      const message = customHistoryMessage(entry.customType || "custom", entry.content, entry.timestamp, entry.details, entry.display);
      message.id = entry.id;
      message.parentId = entry.parentId;
      serialized.push(addMutationStatus(message, entry));
      continue;
    }

    if (entry.type === "custom" && entry.customType === DELETED_EVENT_TOMBSTONE) {
      serialized.push({
        type: "custom",
        id: entry.id,
        parentId: entry.parentId,
        mutation_status: "deleted",
        message: {
          role: "custom",
          customType: DELETED_EVENT_TOMBSTONE,
          timestamp: entry.timestamp,
          display: true,
        },
      });
      continue;
    }

    // Derived invalidations deliberately remain invisible in ordinary chat.
    if (entry.type === "custom" && entry.customType === INVALIDATED_DERIVED_EVENT_TOMBSTONE) continue;

    if (entry.type === "custom" && entry.customType === "wayang-agent-change") {
      const data = entry.data ?? {};
      const message = customHistoryMessage(
        "wayang-agent-change",
        `Agent changed to ${data.to_agent_profile_id ?? "unknown"} (${data.provider ?? "unknown"}/${data.model ?? "unknown"})`,
        entry.timestamp,
        data,
        true,
      );
      message.id = entry.id;
      message.parentId = entry.parentId;
      serialized.push(addMutationStatus(message, entry));
      continue;
    }

    if (entry.type === "branch_summary" && entry.summary) {
      const message = customHistoryMessage("branch-summary", entry.summary, entry.timestamp, entry.details);
      message.id = entry.id;
      message.parentId = entry.parentId;
      serialized.push(addMutationStatus(message, entry));
      continue;
    }

    if (entry.type === "compaction" && entry.summary) {
      const message = customHistoryMessage("compaction-summary", entry.summary, entry.timestamp, entry.details);
      message.id = entry.id;
      message.parentId = entry.parentId;
      serialized.push(addMutationStatus(message, entry));
    }
  }

  return serialized;
}

function getSessionManagerTranscript(manager: SessionManager): SerializedMessage[] {
  const branch = manager.getBranch();
  return serializeHistoryEntries(branch.length > 0 ? branch : manager.getEntries());
}

export function getMessageHistory(id: string): SerializedMessage[] {
  const handle = sessions.get(id);
  if (!handle) return [];

  return getSessionManagerTranscript(handle.session.sessionManager);
}

export function appendStreamingMessageToHistory(
  history: SerializedMessage[],
  streamingMessage: any,
): SerializedMessage[] {
  const role = typeof streamingMessage?.role === "string" ? streamingMessage.role : undefined;
  if (!role || !["user", "assistant", "toolResult", "custom"].includes(role)) return history;
  return [
    ...history,
    {
      type: messageRoleToHistoryType(role),
      message: serializeMessageValue(streamingMessage),
    },
  ];
}

/** Freeze the ID-less in-progress overlay at an exact subscription boundary. */
export function serializeStreamingMessageForWindow(streamingMessage: any): SerializedMessage | null {
  const serialized = appendStreamingMessageToHistory([], streamingMessage)[0];
  if (!serialized) return null;
  try { return structuredClone(serialized); }
  catch { return null; }
}

/**
 * Capture live transcript state, including the in-progress message that Pi
 * intentionally has not persisted to SessionManager until message_end.
 */
export function getLiveMessageHistory(id: string): SerializedMessage[] {
  const handle = sessions.get(id);
  if (!handle) return [];
  const history = getSessionManagerTranscript(handle.session.sessionManager);
  return appendStreamingMessageToHistory(
    history,
    handle.liveStreamingMessage ?? handle.session.state.streamingMessage,
  );
}

export function getTodoState(id: string): SerializedTodoState {
  const handle = sessions.get(id);
  if (!handle) return { type: "todo_state", todos: [], source: "none" };
  const manager = handle.session.sessionManager;
  return extractTodoStateFromEntries(manager.getBranch().length > 0 ? manager.getBranch() : manager.getEntries());
}

export interface SessionFileSnapshot {
  fingerprint: FileFingerprint;
  autoTitle: AutoTitleActivationSnapshot;
  messages: SerializedMessage[];
  todoState: SerializedTodoState;
  approximateBytes: number;
  payloadBytes: number;
}

interface CachedSessionFileSnapshot {
  snapshot: SessionFileSnapshot;
  cacheBytes: number;
}

const snapshotCache = new Map<string, CachedSessionFileSnapshot>();
const SNAPSHOT_CACHE_MAX_FILES = Math.max(1, Number.parseInt(process.env.WAYANG_HISTORY_CACHE_FILES || "8", 10) || 8);
const SNAPSHOT_CACHE_MAX_BYTES = Math.max(1024 * 1024, Number.parseInt(process.env.WAYANG_HISTORY_CACHE_BYTES || String(64 * 1024 * 1024), 10) || 64 * 1024 * 1024);
let snapshotCacheBytes = 0;

function sessionFileFingerprint(sessionFile: string): FileFingerprint {
  const stat = fs.statSync(sessionFile);
  return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: Number(stat.ino) || 0 };
}

function touchSnapshotCache(sessionFile: string, cached: CachedSessionFileSnapshot): SessionFileSnapshot {
  snapshotCache.delete(sessionFile);
  snapshotCache.set(sessionFile, cached);
  return cached.snapshot;
}

function storeSnapshotCache(sessionFile: string, snapshot: SessionFileSnapshot): void {
  const previous = snapshotCache.get(sessionFile);
  if (previous) snapshotCacheBytes -= previous.cacheBytes;
  const cacheBytes = Math.max(snapshot.approximateBytes, snapshot.payloadBytes);
  snapshotCache.delete(sessionFile);
  if (cacheBytes > SNAPSHOT_CACHE_MAX_BYTES) return;
  snapshotCache.set(sessionFile, { snapshot, cacheBytes });
  snapshotCacheBytes += cacheBytes;
  while (snapshotCache.size > SNAPSHOT_CACHE_MAX_FILES || snapshotCacheBytes > SNAPSHOT_CACHE_MAX_BYTES) {
    const oldest = snapshotCache.entries().next().value as [string, CachedSessionFileSnapshot] | undefined;
    if (!oldest) break;
    snapshotCache.delete(oldest[0]);
    snapshotCacheBytes -= oldest[1].cacheBytes;
  }
}

export function invalidateSessionFileSnapshot(sessionFile?: string | null): void {
  if (!sessionFile) return;
  const cached = snapshotCache.get(sessionFile);
  if (!cached) return;
  snapshotCache.delete(sessionFile);
  snapshotCacheBytes -= cached.cacheBytes;
}

export function getSessionFileSnapshot(
  sessionFile: string | null | undefined,
  cwd?: string | null,
): SessionFileSnapshot | null {
  if (!sessionFile) return null;
  const startedAt = performance.now();
  try {
    const fingerprint = sessionFileFingerprint(sessionFile);
    const cached = snapshotCache.get(sessionFile);
    if (cached && fingerprintsEqual(cached.snapshot.fingerprint, fingerprint)) {
      recordLatencyMetric("history_snapshot_ms", performance.now() - startedAt);
      return touchSnapshotCache(sessionFile, cached);
    }
    if (cached) invalidateSessionFileSnapshot(sessionFile);

    // SessionManager.open performs the one canonical parse. Both messages and
    // todo state are derived from the same active branch before this snapshot
    // enters the strict count/byte-bounded LRU.
    const manager = SessionManager.open(sessionFile, undefined, cwd || undefined);
    const branch = manager.getBranch();
    const activeEntries = branch.length > 0 ? branch : manager.getEntries();
    const messages = serializeHistoryEntries(activeEntries);
    const todoState = extractTodoStateFromEntries(activeEntries);
    const firstUser = activeEntries.find((entry: any) => entry?.type === "message" && entry.message?.role === "user");
    const payloadBytes = Buffer.byteLength(JSON.stringify(messages));
    const snapshot: SessionFileSnapshot = {
      fingerprint,
      autoTitle: {
        sessionId: manager.getSessionId(),
        cwd: manager.getHeader()?.cwd ?? "",
        sessionFile,
        fingerprint,
        nameState: manager.getSessionNameState(),
        markedProjection: extractCompletedTitleExchanges(activeEntries),
        legacyProjection: extractCompletedTitleExchanges(activeEntries, { allowSafeLegacyUserText: true }),
        normalizedFirstUserFallback: normalizeProvisionalSessionTitle(titleTextBlocks((firstUser as any)?.message?.content)),
      },
      messages,
      todoState,
      approximateBytes: fingerprint.size,
      payloadBytes,
    };
    storeSnapshotCache(sessionFile, snapshot);
    recordLatencyMetric("history_snapshot_ms", performance.now() - startedAt);
    recordLatencyMetric("history_snapshot_bytes", fingerprint.size);
    return snapshot;
  } catch {
    return null;
  }
}

export function getSessionFileTodoState(
  sessionFile: string | null | undefined,
  cwd?: string | null,
): SerializedTodoState {
  return getSessionFileSnapshot(sessionFile, cwd)?.todoState ?? { type: "todo_state", todos: [], source: "none" };
}

export function getSessionFileMessageHistory(
  sessionFile: string | null | undefined,
  cwd?: string | null,
): SerializedMessage[] {
  return getSessionFileSnapshot(sessionFile, cwd)?.messages ?? [];
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function cleanup(): Promise<void> {
  for (const [id] of sessions) {
    await destroyPiSession(id, { kind: "revoke", reason: "service_shutdown" });
  }
  await Promise.allSettled([...interactiveBrowserLifecycleCleanupTasks]);
  await productionInteractiveBrowserSessionLifecycle?.close();
}