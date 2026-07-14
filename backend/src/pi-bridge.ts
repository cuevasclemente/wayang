/**
 * pi-bridge.ts — Manages pi AgentSession instances.
 *
 * Each web session gets a pi AgentSession that handles the LLM interaction.
 * We use the pi SDK's structured events to relay messages to the frontend
 * via WebSocket, rather than raw PTY bytes.
 */

import type { AgentSession, AgentSessionEvent, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  discoverAndLoadExtensions,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { fingerprintsEqual, type FileFingerprint } from "./session-metadata.js";
import { recordLatencyMetric } from "./latency-metrics.js";
import { getInterviewBridge } from "./interview-bridge.js";
import type { InterviewRecord } from "./interviews.js";
import { getSessionById, updatePiSessionFile } from "./sessions.js";
import { getSudoBridge } from "./sudo-bridge.js";
import { getCommandGuardIdentityBridge } from "./command-guard-bridge.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

export interface SerializedMessage {
  type: string;
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
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_IDLE_CHECK_INTERVAL_MS = 30 * 1000;
const sessions = new Map<string, PiSessionHandle>();
const sessionCreations = new Map<string, Promise<PiSessionHandle>>();
let idleCleanupTimer: NodeJS.Timeout | null = null;

/** Maps pi cwd → web sessionId for legacy web-mode extensions. */
const cwdToSessionId = new Map<string, string>();
/** Maps canonical pi SessionManager IDs/files → web sessionId for thread-scoped bridges. */
const piSessionToWebSessionId = new Map<string, string>();
const piSessionFileToWebSessionId = new Map<string, string>();
(globalThis as any).__pi_interview_cwd_sessions = cwdToSessionId;
(globalThis as any).__pi_interview_pi_sessions = piSessionToWebSessionId;
(globalThis as any).__pi_interview_session_files = piSessionFileToWebSessionId;
(globalThis as any).__pi_sudo_cwd_sessions = cwdToSessionId;
(globalThis as any).__pi_sudo_pi_sessions = piSessionToWebSessionId;
(globalThis as any).__pi_sudo_session_files = piSessionFileToWebSessionId;
(globalThis as any).__pi_command_guard_cwd_sessions = cwdToSessionId;
(globalThis as any).__pi_command_guard_pi_sessions = piSessionToWebSessionId;
(globalThis as any).__pi_command_guard_session_files = piSessionFileToWebSessionId;

// Lazy-initialized singletons
let _authStorage: AuthStorage | null = null;
let _modelRegistry: ModelRegistry | null = null;
let _agentDir: string | null = null;
let _extensionProviderLoadPromise: Promise<void> | null = null;
let _extensionProviderLoadError: string | undefined;
let _extensionProvidersLoaded = false;

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

function installWayangRawSudoFailClosedGuard(session: AgentSession, sessionId: string): void {
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

function getAuthStorage(): AuthStorage {
  if (!_authStorage) _authStorage = AuthStorage.create();
  return _authStorage;
}

/**
 * Reload AuthStorage from disk. Call after externally updating auth.json
 * (e.g. via the key-mode route) so new sessions pick up the new credentials
 * without needing a server restart.
 */
export function reloadAuthStorage(): void {
  if (_authStorage) _authStorage.reload();
}

function getModelRegistry(): ModelRegistry {
  if (!_modelRegistry) _modelRegistry = ModelRegistry.create(getAuthStorage());
  return _modelRegistry;
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

export interface PiSessionRuntimeState {
  runtime_status: "active" | "starting" | "stopped";
  runtime_is_streaming: boolean;
  runtime_subscriber_count: number;
  runtime_last_activity_at: number | null;
}

export function getPiSessionRuntimeState(id: string): PiSessionRuntimeState {
  const handle = sessions.get(id);
  if (handle) {
    return {
      runtime_status: "active",
      runtime_is_streaming: Boolean(handle.session.isStreaming),
      runtime_subscriber_count: handle.subscriberCount,
      runtime_last_activity_at: handle.lastActivityAt,
    };
  }
  if (sessionCreations.has(id)) {
    return {
      runtime_status: "starting",
      runtime_is_streaming: false,
      runtime_subscriber_count: 0,
      runtime_last_activity_at: null,
    };
  }
  return {
    runtime_status: "stopped",
    runtime_is_streaming: false,
    runtime_subscriber_count: 0,
    runtime_last_activity_at: null,
  };
}

export async function stopIdlePiSessions(now = Date.now()): Promise<string[]> {
  const stopped: string[] = [];
  for (const [id, handle] of [...sessions]) {
    if (handle.session.isStreaming) continue;
    if (now - handle.lastActivityAt < SESSION_IDLE_TIMEOUT_MS) continue;
    await destroyPiSession(id);
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
  openrouter: "deepseek/deepseek-v4-pro",
  deepseek: "deepseek-v4-pro",
  "github-copilot": "claude-sonnet-4-5",
};

/** Provider → env var name(s) mapping for auto-detection */
const PROVIDER_ENV_MAP: Record<string, string[]> = {
  openrouter: ["OPENROUTER_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
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
  "openrouter",
  "github-copilot",
  "deepseek",
  "google",
  "groq",
  "cerebras",
  "xai",
  "mistral",
  "fireworks",
];

function providerHasConfiguredModel(provider: string): boolean {
  const registry = getModelRegistry();
  return registry.getAll().some((model) => String(model.provider) === provider && registry.hasConfiguredAuth(model));
}

function resolveUsableModel(provider: string | null | undefined, modelId: string | null | undefined): Model<Api> | undefined {
  if (!provider || !modelId) return undefined;
  const model = resolveRegisteredModel(provider, modelId);
  if (!model || !getModelRegistry().hasConfiguredAuth(model)) return undefined;
  return model;
}

function resolveSettingsDefaultModel(settingsManager: SettingsManager): Model<Api> | undefined {
  return resolveUsableModel(settingsManager.getDefaultProvider(), settingsManager.getDefaultModel());
}

function resolveDetectedDefaultModel(): Model<Api> | undefined {
  const provider = detectDefaultProvider();
  return resolveUsableModel(provider, provider ? DEFAULT_MODELS[provider] : undefined);
}

function resolveWebDefaultModel(settingsManager?: SettingsManager): Model<Api> | undefined {
  return (settingsManager ? resolveSettingsDefaultModel(settingsManager) : undefined) || resolveDetectedDefaultModel();
}

function firstConfiguredProvider(providers: Iterable<string>): string | null {
  for (const provider of providers) {
    if (providerHasConfiguredModel(provider)) return provider;
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
function detectDefaultProvider(): string | null {
  const authStorage = getAuthStorage();
  const configured = new Set(authStorage.list());
  const oauthProviders = new Set(
    authStorage
      .getOAuthProviders()
      .map((provider) => provider.id)
      .filter((provider) => authStorage.get(provider)?.type === "oauth"),
  );

  // Prefer subscription/OAuth providers for unattended web sessions. This keeps
  // scheduled jobs from accidentally using an unrelated API-key env var inherited
  // by the wayang process.
  const storedOAuthProvider = firstConfiguredProvider(
    STORED_AUTH_PROVIDER_PREFERENCE.filter((provider) => configured.has(provider) && oauthProviders.has(provider)),
  );
  if (storedOAuthProvider) return storedOAuthProvider;

  for (const [provider, envVars] of Object.entries(PROVIDER_ENV_MAP)) {
    if (envVars.some((v) => process.env[v]) && providerHasConfiguredModel(provider)) return provider;
  }

  return (
    firstConfiguredProvider(STORED_AUTH_PROVIDER_PREFERENCE.filter((provider) => configured.has(provider))) ||
    firstConfiguredProvider(configured)
  );
}

function formatLoadErrors(errors: string[]): string | undefined {
  return errors.length > 0 ? errors.join("\n") : undefined;
}

async function ensureExtensionProvidersLoaded(cwd = process.cwd()): Promise<void> {
  if (_extensionProvidersLoaded) return;
  if (!_extensionProviderLoadPromise) {
    _extensionProviderLoadPromise = (async () => {
      const registry = getModelRegistry();
      const errors: string[] = [];
      try {
        const result = await discoverAndLoadExtensions([], cwd, getAgentDirPath());
        for (const error of result.errors) {
          errors.push(`Extension "${error.path}" failed to load: ${error.error}`);
        }
        for (const { name, config, extensionPath } of result.runtime.pendingProviderRegistrations) {
          try {
            registry.registerProvider(name, config);
          } catch (error) {
            errors.push(
              `Extension "${extensionPath}" failed to register provider "${name}": ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        result.runtime.pendingProviderRegistrations = [];
      } catch (error) {
        errors.push(`Failed to load extension providers: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        _extensionProviderLoadError = formatLoadErrors(errors);
        _extensionProvidersLoaded = true;
      }
    })().finally(() => {
      _extensionProviderLoadPromise = null;
    });
  }
  await _extensionProviderLoadPromise;
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
  const authStorage = getAuthStorage();
  const credential = authStorage.get("anthropic");
  // Claude subscription/OAuth credentials can be valid for messages while the
  // public model-list endpoint rejects them. OpenRouter's public catalog still
  // lets us derive current canonical Anthropic model IDs for the picker.
  if (credential?.type === "oauth") return [];

  const template = findProviderTemplate(registry, "anthropic", "claude-opus-4-7");
  if (!template || !registry.hasConfiguredAuth(template)) return [];

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
      (model) => !builtInKeys.has(dynamicModelKey(String(model.provider), model.id)),
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

function resolveRegisteredModel(provider: string, modelId: string): Model<Api> | undefined {
  return (
    getModelRegistry().find(provider, modelId) ||
    getCachedDynamicModel(provider, modelId) ||
    (getModel(provider as any, modelId as any) as Model<Api> | undefined)
  );
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

export async function listModels(options: { refresh?: boolean } = {}): Promise<{ models: WebModelInfo[]; defaultModel: WebDefaultModelInfo | null; error?: string }> {
  await ensureExtensionProvidersLoaded();
  const registry = getModelRegistry();
  registry.refresh();
  const dynamicModels = await refreshDynamicModels(registry, options.refresh ?? false);
  const models = uniqueModels([...registry.getAll(), ...dynamicModels.models]).map((model) => modelToWebInfo(registry, model));
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

  const settingsManager = SettingsManager.create(process.cwd(), getAgentDirPath());
  const defaultModel = resolveWebDefaultModel(settingsManager);

  return {
    models,
    defaultModel: defaultModel
      ? { provider: String(defaultModel.provider), id: defaultModel.id, name: defaultModel.name }
      : null,
    error: combineModelErrors(registry.getError(), _extensionProviderLoadError, dynamicModels.error),
  };
}

export async function setSessionModel(
  id: string,
  provider: string,
  modelId: string,
): Promise<{ provider: string; model: string; name: string }> {
  await ensureExtensionProvidersLoaded();
  await refreshDynamicModels(getModelRegistry());
  const model = resolveRegisteredModel(provider, modelId);
  if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);

  const handle = sessions.get(id);
  if (handle?.session.isStreaming) {
    throw new Error("Cannot change model while the agent is streaming");
  }

  if (handle) {
    markSessionActivity(id);
    await handle.session.setModel(model);
    handle.model = model.id;
  } else if (!getModelRegistry().hasConfiguredAuth(model)) {
    throw new Error(`No API key for ${model.provider}/${model.id}`);
  }

  return { provider: String(model.provider), model: model.id, name: model.name };
}

export async function setSessionDefaultModel(
  id: string,
): Promise<{ provider: string; model: string; name: string }> {
  await ensureExtensionProvidersLoaded();
  await refreshDynamicModels(getModelRegistry());
  const settingsManager = SettingsManager.create(process.cwd(), getAgentDirPath());
  const defaultModel = resolveWebDefaultModel(settingsManager);
  if (!defaultModel) throw new Error("No default model is available");
  return setSessionModel(id, String(defaultModel.provider), defaultModel.id);
}

export async function createPiSession(
  id: string,
  cwd: string,
  provider: string | null = null,
  modelId: string | null = null,
  sessionFile?: string | null,
): Promise<PiSessionHandle> {
  const existing = sessions.get(id);
  if (existing) {
    markSessionActivity(id);
    return existing;
  }

  const pending = sessionCreations.get(id);
  if (pending) return pending;

  const creationStartedAt = performance.now();
  const creation = (async () => {
    await stopIdlePiSessions();
    if (sessions.size + sessionCreations.size > MAX_SESSIONS) {
      throw new Error(`Max sessions (${MAX_SESSIONS}) reached`);
    }

    const extensionsStartedAt = performance.now();
    await ensureExtensionProvidersLoaded(cwd);
    recordLatencyMetric("lazy_extensions_ms", performance.now() - extensionsStartedAt);

    const settingsModelStartedAt = performance.now();
    // Match interactive pi as closely as possible: load merged global + project
    // settings instead of using web-only in-memory defaults.
    const settingsManager = SettingsManager.create(cwd, getAgentDirPath());

    // Prefer explicit web session settings, then a fully usable pi settings
    // provider/model pair, then credential-based provider detection. A provider
    // with auth is not enough: if settings contain a stale or mismatched model
    // id, passing no resolved model lets the SDK restore the old session model
    // from JSONL (for example OpenRouter DeepSeek) instead of the current web
    // default.
    let model: Model<Api> | undefined;
    if (provider && modelId) {
      model = resolveRegisteredModel(provider, modelId);
      if (!model) {
        await refreshDynamicModels(getModelRegistry());
        model = resolveRegisteredModel(provider, modelId);
      }
      if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
      if (!getModelRegistry().hasConfiguredAuth(model)) throw new Error(`No API key for ${model.provider}/${model.id}`);
    } else if (provider) {
      model = resolveUsableModel(provider, DEFAULT_MODELS[provider]);
      if (!model) throw new Error(`No usable default model is available for provider ${provider}`);
    } else {
      model = resolveWebDefaultModel(settingsManager);
      if (!model) {
        throw new Error(
          "No usable default model found. Set an API key environment variable (e.g., OPENROUTER_API_KEY, ANTHROPIC_API_KEY), configure a valid default provider/model in pi settings, or use /login to log into a provider.",
        );
      }
    }

    const modelRegistry = getModelRegistry();
    recordLatencyMetric("lazy_settings_model_ms", performance.now() - settingsModelStartedAt);

    const transcriptStartedAt = performance.now();
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined, cwd)
      : SessionManager.create(cwd);
    recordLatencyMetric("lazy_transcript_open_ms", performance.now() - transcriptStartedAt);

    const agentCreateStartedAt = performance.now();
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir: getAgentDirPath(),
      model: model,
      authStorage: getAuthStorage(),
      modelRegistry,
      sessionManager,
      settingsManager,
    });
    recordLatencyMetric("lazy_agent_create_ms", performance.now() - agentCreateStartedAt);

    // The SDK constructor loads extension handlers, but lifecycle hooks (including
    // session_start) only run after bindExtensions(). wayang has no TUI context,
    // but still needs those hooks so web-aware extensions can register bridge
    // controllers such as the command guard status/toggle bridge.
    const extensionBindStartedAt = performance.now();
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
    recordLatencyMetric("lazy_extension_bind_ms", performance.now() - extensionBindStartedAt);

    // Defense in depth: Wayang never authorizes sudo through bash. Privileged
    // execution uses the structured sudo_exec tool; any raw sudo reaching the
    // shell path indicates extension drift and is blocked unconditionally.
    installWayangRawSudoFailClosedGuard(session, id);

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
    };

    sessions.set(id, handle);
    cwdToSessionId.set(cwd, id);
    piSessionToWebSessionId.set(sessionManager.getSessionId(), id);
    const canonicalSessionFile = sessionManager.getSessionFile();
    if (canonicalSessionFile) piSessionFileToWebSessionId.set(canonicalSessionFile, id);
    ensureIdleCleanupTimer();
    return handle;
  })().finally(() => {
    recordLatencyMetric("lazy_session_create_ms", performance.now() - creationStartedAt);
    sessionCreations.delete(id);
  });

  sessionCreations.set(id, creation);
  return creation;
}

export function getPiSession(id: string): PiSessionHandle | undefined {
  return sessions.get(id);
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

  for (const command of WEB_SUPPORTED_BUILTIN_SLASH_COMMANDS) {
    commands.set(command.name, { ...command });
  }

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

export async function destroyPiSession(id: string): Promise<void> {
  const handle = sessions.get(id);
  if (!handle) return;
  try {
    if (handle.session.isStreaming) {
      await handle.session.abort();
    }
  } catch {
    // ignore
  }
  try {
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
  maybeStopIdleCleanupTimer();
  // Clean up web-session lookup mappings.
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

export async function stopPiSession(id: string): Promise<void> {
  const pending = sessionCreations.get(id);
  if (pending) {
    try {
      await pending;
    } catch {
      // A failed creation leaves no live session to stop.
    }
  }
  await destroyPiSession(id);
}

export interface InterviewSubmissionDelivery {
  entryId: string;
  alreadyPresent: boolean;
}

function interviewSubmissionContent(record: InterviewRecord): string {
  const submittedAt = record.submitted_at ? new Date(record.submitted_at).toISOString() : "unknown time";
  const answers = (record.answers ?? [])
    .map((answer) => `- ${answer.id}: ${answer.label}${answer.wasCustom ? " (custom)" : ""}`)
    .join("\n");
  return [
    "A previously requested interview/questionnaire has now been submitted.",
    "It may be stale; decide whether it remains relevant before acting.",
    `Request: ${record.request_id}; originating tool: ${record.origin_tool_name}; submitted: ${submittedAt}`,
    "Answers:",
    answers || "- (no answers)",
  ].join("\n");
}

function findInterviewSubmissionEntry(handle: PiSessionHandle, record: InterviewRecord): string | undefined {
  return handle.session.sessionManager.getEntries().find((entry: any) => (
    entry.type === "custom_message" &&
    entry.customType === "wayang-interview-submission" &&
    entry.details?.request_id === record.request_id &&
    entry.details?.submission_id === record.submission_id
  ))?.id;
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const entryId = findInterviewSubmissionEntry(handle, record);
    if (entryId) return { entryId, alreadyPresent: false };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Interview submission was queued but not persisted before delivery timeout");
}

export async function sendMessage(
  id: string,
  content: string,
  images?: ImageContent[],
): Promise<void> {
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  markSessionActivity(id);

  const isStreaming = handle.session.isStreaming;
  if (isStreaming) {
    await handle.session.steer(content, images);
  } else {
    await handle.session.prompt(content, {
      expandPromptTemplates: true,
      images,
    });
  }
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

export async function resendMessage(id: string, messageId: string): Promise<ResendMessageResult> {
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
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

  const turn = handle.session.prompt(text, {
    expandPromptTemplates: true,
    images: images.length > 0 ? images : undefined,
  }).then(() => {
    markSessionActivity(id);
  });

  return {
    messages: getMessageHistory(id),
    turn,
  };
}

export interface RunPromptResult {
  resultSummary: string | null;
  messages: SerializedMessage[];
}

export interface ResendMessageResult {
  messages: SerializedMessage[];
  turn: Promise<void>;
}

export async function runPromptAndWait(
  id: string,
  content: string,
  options: { timeoutMs?: number } = {},
): Promise<RunPromptResult> {
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  markSessionActivity(id);

  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timeout: NodeJS.Timeout | null = null;

  const completion = new Promise<void>((resolve) => {
    unsubscribe = handle.session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "agent_end" || event.type === "turn_end") {
        resolve();
      }
    });
  });

  const promptPromise = handle.session.isStreaming
    ? handle.session.steer(content)
    : handle.session.prompt(content, { expandPromptTemplates: true });

  const timeoutPromise = new Promise<never>((_, reject) => {
    if (!options.timeoutMs || options.timeoutMs <= 0) return;
    timeout = setTimeout(() => reject(new Error(`Prompt timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  });

  try {
    await Promise.race([
      Promise.race([completion, promptPromise.then(() => undefined)]).then(() => {
        settled = true;
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    if (!settled) {
      try {
        await handle.session.abort();
      } catch {
        // ignore abort failures; report original error
      }
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    const stopSubscription = unsubscribe as (() => void) | null;
    if (stopSubscription) stopSubscription();
  }

  const assistantError = getLastAssistantError(handle.session.messages);
  if (assistantError) throw new Error(assistantError);

  return {
    resultSummary: summarizeLastAssistantMessage(handle.session.messages),
    messages: getMessageHistory(id),
  };
}

export async function abortSession(
  id: string,
  options: { clearQueue?: boolean } = {},
): Promise<{ steering: string[]; followUp: string[] }> {
  const handle = sessions.get(id);
  if (!handle) throw new Error(`Session ${id} not found`);
  markSessionActivity(id);
  const clearedQueue = options.clearQueue
    ? handle.session.clearQueue()
    : { steering: [], followUp: [] };
  await handle.session.abort();
  return clearedQueue;
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
    const serialized = serializeEvent(event);
    if (serialized) {
      markSessionActivity(id);
      onMessage(serialized);
    }
  });

  return () => {
    handle.subscriberCount = Math.max(0, handle.subscriberCount - 1);
    unsub();
  };
}

// ---------------------------------------------------------------------------
// Event serialization
// ---------------------------------------------------------------------------

function serializeEvent(event: AgentSessionEvent): SerializedMessage | null {
  switch (event.type) {
    case "message_start": {
      return serializeMessage("message_start", (event as any).message);
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
      };
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
    case "compaction_start":
    case "compaction_end":
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

function serializeMessageValue(msg: any): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
  };

  if (msg.model) base.model = msg.model;
  if (msg.stopReason) base.stopReason = msg.stopReason;
  if (msg.usage) base.usage = msg.usage;
  if (msg.errorMessage) base.errorMessage = msg.errorMessage;
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

function getLastAssistantError(messages: any[]): string | null {
  const assistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!assistant) return null;
  if (assistant.errorMessage) return String(assistant.errorMessage);
  if (assistant.stopReason === "error") return "Assistant turn ended with an error";
  return null;
}

function summarizeLastAssistantMessage(messages: any[]): string | null {
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
  const normalized = text.replace(/\s+/g, " ").trim();
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

function serializeHistoryEntries(entries: any[]): SerializedMessage[] {
  const serialized: SerializedMessage[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      serialized.push({
        type: messageRoleToHistoryType(message?.role),
        id: entry.id,
        parentId: entry.parentId,
        message: serializeMessageValue(message),
      });
      continue;
    }

    if (entry.type === "custom_message") {
      const message = customHistoryMessage(entry.customType || "custom", entry.content, entry.timestamp, entry.details, entry.display);
      message.id = entry.id;
      message.parentId = entry.parentId;
      serialized.push(message);
      continue;
    }

    if (entry.type === "branch_summary" && entry.summary) {
      const message = customHistoryMessage("branch-summary", entry.summary, entry.timestamp, entry.details);
      message.id = entry.id;
      message.parentId = entry.parentId;
      serialized.push(message);
      continue;
    }

    if (entry.type === "compaction" && entry.summary) {
      const message = customHistoryMessage("compaction-summary", entry.summary, entry.timestamp, entry.details);
      message.id = entry.id;
      message.parentId = entry.parentId;
      serialized.push(message);
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

export function getTodoState(id: string): SerializedTodoState {
  const handle = sessions.get(id);
  if (!handle) return { type: "todo_state", todos: [], source: "none" };
  const manager = handle.session.sessionManager;
  return extractTodoStateFromEntries(manager.getBranch().length > 0 ? manager.getBranch() : manager.getEntries());
}

export interface SessionFileSnapshot {
  fingerprint: FileFingerprint;
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
    const payloadBytes = Buffer.byteLength(JSON.stringify(messages));
    const snapshot: SessionFileSnapshot = {
      fingerprint,
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
    await destroyPiSession(id);
  }
}