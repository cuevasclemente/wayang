import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BUNDLE_PATTERN = /^[a-f0-9]{64}$/u;
const GENERATION_PATTERN = /^[a-f0-9]{32}$/u;
const SYNTHETIC_USER_MESSAGE = "Warm this stable prefix without taking action or calling tools.";
const COORDINATION_BLOCK_START = "\n## Cross-session coordination\n";
const COORDINATION_BLOCK_END = "Guideline: coordination is advisory. Check peers before broad edits, claim intended work, share useful blockers, avoid secrets, and use separate Git worktrees/branches for concurrent implementation.";
const RETAINED_OPTION_FIELDS = [
  "chat_template_kwargs",
  "reasoning_effort",
  "parallel_tool_calls",
  "tool_stream",
] as const;

export interface CanonicalKvWarmupConfig {
  enabled: boolean;
  projectId: string;
  agentProfileId: string;
  provider: string;
  model: string;
  family: string;
  ruminantBaseUrl: string;
  apiKeyFile: string;
  pollMs: number;
  statusTimeoutMs: number;
  requestTimeoutMs: number;
  maxTemplateBytes: number;
}

export interface CanonicalWarmTemplate {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly bundleHash: string;
  readonly byteLength: number;
}

export interface CanonicalProviderPayloadRelocation {
  readonly payload: unknown;
  readonly relocated: boolean;
  readonly malformed: boolean;
}

export interface CanonicalKvWarmupIdentity {
  projectId: string;
  agentProfileId: string;
}

export interface CanonicalKvWarmupSnapshot {
  enabled: boolean;
  started: boolean;
  templateAvailable: boolean;
  templateBundleHash: string | null;
  templateBytes: number | null;
  inFlight: boolean;
  lastOutcome: "disabled" | "unseeded" | "idle" | "already_warm" | "warmed" | "preempted" | "error";
  capturesAccepted: number;
  capturesRejected: number;
  attempts: number;
  failures: number;
}

interface WarmStatus {
  generation: string;
  state: string;
  warmBundleHash: string | null;
  attemptActive: boolean;
}

interface CanonicalKvWarmupDependencies {
  fetch: typeof fetch;
  readSecretFile: (file: string) => string;
  now: () => number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  warn: (message: string) => void;
}

const DEFAULT_DEPENDENCIES: CanonicalKvWarmupDependencies = {
  fetch: globalThis.fetch,
  readSecretFile: readSecretFileStrict,
  now: Date.now,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  warn: (message) => console.warn(`[canonical-kv-warmup] ${message}`),
};

export class CanonicalKvWarmupSessionBinding {
  readonly extensionFactory: ExtensionFactory;
  private modelEligible = false;
  private closed = false;

  constructor(
    private readonly coordinator: CanonicalKvWarmupCoordinator,
  ) {
    this.extensionFactory = (pi) => {
      pi.on("before_provider_headers", (event) => {
        if (!this.isEligible()) return;
        const template = this.coordinator.currentTemplate();
        if (!template) return;
        event.headers["x-ruminant-prefix-family"] = this.coordinator.config.family;
        event.headers["x-ruminant-prefix-bundle"] = template.bundleHash;
      });
      pi.on("before_provider_request", (event) => {
        if (!this.isEligible()) return;
        const relocation = relocateDynamicCoordinationContext(event.payload);
        if (relocation.malformed) {
          this.coordinator.capture(undefined);
          return;
        }
        this.coordinator.capture(relocation.payload);
        return relocation.relocated ? relocation.payload : undefined;
      });
      pi.on("model_select", (event) => {
        this.bindModel(String(event.model.provider), event.model.id, event.model.baseUrl);
      });
      pi.on("session_shutdown", () => {
        this.closed = true;
        this.modelEligible = false;
      });
    };
  }

  bindModel(provider: string, model: string, baseUrl: string): void {
    if (this.closed) return;
    this.modelEligible = provider === this.coordinator.config.provider
      && model === this.coordinator.config.model
      && modelUsesConfiguredRuminant(baseUrl, this.coordinator.config.ruminantBaseUrl);
  }

  private isEligible(): boolean {
    return !this.closed && this.modelEligible && this.coordinator.config.enabled;
  }
}

export class CanonicalKvWarmupCoordinator {
  private readonly dependencies: CanonicalKvWarmupDependencies;
  private template: CanonicalWarmTemplate | null = null;
  private apiKey = "";
  private started = false;
  private stopped = false;
  private inFlight = false;
  private rerunRequested = false;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private nextAllowedAt = 0;
  private consecutiveFailures = 0;
  private lastOutcome: CanonicalKvWarmupSnapshot["lastOutcome"];
  private capturesAccepted = 0;
  private capturesRejected = 0;
  private attempts = 0;
  private failures = 0;

  constructor(
    readonly config: CanonicalKvWarmupConfig,
    dependencies: Partial<CanonicalKvWarmupDependencies> = {},
  ) {
    validateCanonicalKvWarmupConfig(config);
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.lastOutcome = config.enabled ? "unseeded" : "disabled";
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.config.enabled) return;
    this.apiKey = this.dependencies.readSecretFile(this.config.apiKeyFile);
    if (this.template) this.schedule(0);
  }

  createSessionBinding(identity: CanonicalKvWarmupIdentity): CanonicalKvWarmupSessionBinding | undefined {
    if (!this.config.enabled) return undefined;
    if (identity.projectId !== this.config.projectId
      || identity.agentProfileId !== this.config.agentProfileId) return undefined;
    return new CanonicalKvWarmupSessionBinding(this);
  }

  capture(payload: unknown): void {
    if (!this.config.enabled || this.stopped) return;
    const template = sanitizeCanonicalWarmPayload(
      payload,
      this.config.model,
      this.config.maxTemplateBytes,
    );
    if (!template) {
      this.capturesRejected += 1;
      return;
    }
    this.template = template;
    this.capturesAccepted += 1;
    this.lastOutcome = "idle";
    this.rerunRequested = true;
    this.schedule(0);
  }

  currentTemplate(): CanonicalWarmTemplate | null {
    return this.template;
  }

  snapshot(): CanonicalKvWarmupSnapshot {
    return {
      enabled: this.config.enabled,
      started: this.started,
      templateAvailable: this.template !== null,
      templateBundleHash: this.template?.bundleHash ?? null,
      templateBytes: this.template?.byteLength ?? null,
      inFlight: this.inFlight,
      lastOutcome: this.lastOutcome,
      capturesAccepted: this.capturesAccepted,
      capturesRejected: this.capturesRejected,
      attempts: this.attempts,
      failures: this.failures,
    };
  }

  async runOnce(): Promise<void> {
    if (!this.config.enabled || !this.started || this.stopped || !this.template) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    const now = this.dependencies.now();
    if (now < this.nextAllowedAt) {
      this.schedule(this.nextAllowedAt - now);
      return;
    }

    this.inFlight = true;
    this.rerunRequested = false;
    const template = this.template;
    try {
      const status = await this.fetchStatus();
      if (status.warmBundleHash === template.bundleHash && status.state === "warm") {
        this.lastOutcome = "already_warm";
        this.resetBackoff();
        return;
      }
      if (status.attemptActive || status.state === "warming") {
        this.lastOutcome = "idle";
        return;
      }
      this.attempts += 1;
      const response = await this.fetchWarmResponse(
        `${this.config.ruminantBaseUrl}/ruminant/warmup/${status.generation}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            "x-ruminant-prefix-family": this.config.family,
            "x-ruminant-prefix-bundle": template.bundleHash,
          },
          body: JSON.stringify(template.payload),
        },
      );
      if (response.ok) {
        this.lastOutcome = "warmed";
        this.resetBackoff();
        return;
      }
      if (response.status === 409) {
        this.lastOutcome = "preempted";
        this.nextAllowedAt = this.dependencies.now() + this.config.pollMs;
        return;
      }
      this.recordFailure(`warm request returned HTTP ${response.status}`);
    } catch (error) {
      if (this.stopped && isAbortError(error)) return;
      this.recordFailure("warm status or request failed");
    } finally {
      this.inFlight = false;
      this.abortController = null;
      if (!this.stopped && this.rerunRequested) this.schedule(0);
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      this.dependencies.clearTimeout(this.timer);
      this.timer = null;
    }
    this.abortController?.abort();
    while (this.inFlight) await new Promise((resolve) => this.dependencies.setTimeout(resolve, 5));
    this.apiKey = "";
    if (productionCoordinator === this) productionCoordinator = undefined;
  }

  private async fetchStatus(): Promise<WarmStatus> {
    const controller = new AbortController();
    this.abortController = controller;
    const timeout = this.dependencies.setTimeout(
      () => controller.abort(),
      this.config.statusTimeoutMs,
    );
    let response: Response;
    let text: string;
    try {
      response = await this.dependencies.fetch(
        `${this.config.ruminantBaseUrl}/ruminant/status`,
        {
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: controller.signal,
        },
      );
      text = await response.text();
    } finally {
      this.dependencies.clearTimeout(timeout);
      if (this.abortController === controller) this.abortController = null;
    }
    if (!response.ok) throw new Error(`warm status returned HTTP ${response.status}`);
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw new Error("Ruminant warm status exceeded the bounded response size");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Ruminant warm status is not valid JSON");
    }
    if (!isRecord(payload) || !isRecord(payload.warmup) || payload.warmup.enabled !== true) {
      throw new Error("Ruminant warm status is unavailable");
    }
    const generation = payload.warmup.generation;
    const state = payload.warmup.state;
    const warmBundleHash = payload.warmup.warm_bundle_hash;
    const attemptActive = payload.warmup.attempt_active;
    if (typeof generation !== "string" || !GENERATION_PATTERN.test(generation)
      || typeof state !== "string"
      || (warmBundleHash !== null && (typeof warmBundleHash !== "string" || !BUNDLE_PATTERN.test(warmBundleHash)))
      || typeof attemptActive !== "boolean") {
      throw new Error("Ruminant warm status is malformed");
    }
    return { generation, state, warmBundleHash, attemptActive };
  }

  private async fetchWarmResponse(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number }> {
    const controller = new AbortController();
    this.abortController = controller;
    const timeout = this.dependencies.setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );
    try {
      const response = await this.dependencies.fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
        throw new Error("Ruminant warm response exceeded the bounded response size");
      }
      return { ok: response.ok, status: response.status };
    } finally {
      this.dependencies.clearTimeout(timeout);
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.config.enabled || !this.started || this.stopped) return;
    if (this.timer !== null) return;
    this.timer = this.dependencies.setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => {
        if (!this.stopped) this.schedule(this.config.pollMs);
      });
    }, Math.max(0, delayMs));
  }

  private recordFailure(message: string): void {
    this.failures += 1;
    this.consecutiveFailures += 1;
    this.lastOutcome = "error";
    const multiplier = Math.min(16, 2 ** Math.min(4, this.consecutiveFailures - 1));
    this.nextAllowedAt = this.dependencies.now() + this.config.pollMs * multiplier;
    this.dependencies.warn(message);
  }

  private resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.nextAllowedAt = 0;
  }
}

export function relocateDynamicCoordinationContext(
  payload: unknown,
): CanonicalProviderPayloadRelocation {
  const unchanged = (malformed = false): CanonicalProviderPayloadRelocation => ({
    payload,
    relocated: false,
    malformed,
  });
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return unchanged();

  let sourceIndex = -1;
  let sourceContent = "";
  let blockStart = -1;
  let blockEnd = -1;
  for (let index = 0; index < payload.messages.length; index += 1) {
    const candidate = payload.messages[index];
    if (!isRecord(candidate)) return unchanged(true);
    if (candidate.role !== "system" && candidate.role !== "developer") break;
    if (typeof candidate.content !== "string") continue;
    const start = candidate.content.indexOf(COORDINATION_BLOCK_START);
    if (start < 0) continue;
    if (sourceIndex >= 0 || candidate.content.indexOf(COORDINATION_BLOCK_START, start + 1) >= 0) {
      return unchanged(true);
    }
    const endStart = candidate.content.indexOf(COORDINATION_BLOCK_END, start + COORDINATION_BLOCK_START.length);
    if (endStart < 0 || candidate.content.indexOf(COORDINATION_BLOCK_END, endStart + 1) >= 0) {
      return unchanged(true);
    }
    sourceIndex = index;
    sourceContent = candidate.content;
    blockStart = start;
    blockEnd = endStart + COORDINATION_BLOCK_END.length;
  }
  if (sourceIndex < 0) return unchanged();

  const messages = payload.messages.map((message) => isRecord(message) ? { ...message } : message);
  const source = messages[sourceIndex] as Record<string, unknown>;
  source.content = `${sourceContent.slice(0, blockStart)}${sourceContent.slice(blockEnd)}`;
  let firstConversationIndex = 0;
  while (firstConversationIndex < messages.length) {
    const message = messages[firstConversationIndex];
    if (!isRecord(message) || (message.role !== "system" && message.role !== "developer")) break;
    firstConversationIndex += 1;
  }
  messages.splice(firstConversationIndex, 0, {
    role: "user",
    content: sourceContent.slice(blockStart + 1, blockEnd),
  });
  return {
    payload: { ...payload, messages },
    relocated: true,
    malformed: false,
  };
}

export function sanitizeCanonicalWarmPayload(
  payload: unknown,
  expectedModel: string,
  maxBytes: number,
): CanonicalWarmTemplate | null {
  if (!isRecord(payload)) return null;
  let cloned: Record<string, unknown>;
  try {
    cloned = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (cloned.model !== expectedModel || !Array.isArray(cloned.messages)) return null;
  const leadingMessages: Record<string, unknown>[] = [];
  for (const candidate of cloned.messages) {
    if (!isRecord(candidate)) return null;
    if (candidate.role !== "system" && candidate.role !== "developer") break;
    leadingMessages.push(candidate);
  }
  if (leadingMessages.length === 0) return null;
  if (cloned.tools !== undefined && !Array.isArray(cloned.tools)) return null;

  const warmPayload: Record<string, unknown> = {
    model: expectedModel,
    messages: [
      ...leadingMessages,
      { role: "user", content: SYNTHETIC_USER_MESSAGE },
    ],
  };
  if (Array.isArray(cloned.tools)) warmPayload.tools = cloned.tools;
  for (const field of RETAINED_OPTION_FIELDS) {
    if (cloned[field] !== undefined) warmPayload[field] = cloned[field];
  }
  warmPayload.stream = false;
  warmPayload.max_tokens = 1;
  warmPayload.tool_choice = "none";
  warmPayload.n = 1;

  const serialized = JSON.stringify(warmPayload);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > maxBytes) return null;
  return Object.freeze({
    payload: Object.freeze(warmPayload),
    bundleHash: createHash("sha256").update(serialized).digest("hex"),
    byteLength,
  });
}

export function validateCanonicalKvWarmupConfig(config: CanonicalKvWarmupConfig): void {
  if (!Number.isInteger(config.pollMs) || config.pollMs < 250 || config.pollMs > 300_000) {
    throw new Error("canonical KV warmup pollMs must be an integer from 250 to 300000");
  }
  if (!Number.isInteger(config.statusTimeoutMs) || config.statusTimeoutMs < 250 || config.statusTimeoutMs > 30_000) {
    throw new Error("canonical KV warmup statusTimeoutMs must be an integer from 250 to 30000");
  }
  if (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1_000 || config.requestTimeoutMs > 600_000) {
    throw new Error("canonical KV warmup requestTimeoutMs must be an integer from 1000 to 600000");
  }
  if (!Number.isInteger(config.maxTemplateBytes) || config.maxTemplateBytes < 1024 || config.maxTemplateBytes > 32 * 1024 * 1024) {
    throw new Error("canonical KV warmup maxTemplateBytes must be an integer from 1024 to 33554432");
  }
  if (!config.enabled) return;
  for (const [label, value] of [
    ["projectId", config.projectId],
    ["agentProfileId", config.agentProfileId],
    ["provider", config.provider],
    ["model", config.model],
    ["family", config.family],
  ] as const) {
    if (!value || value !== value.trim() || value.length > 256) {
      throw new Error(`canonical KV warmup ${label} must be a bounded non-empty value`);
    }
  }
  if (!FAMILY_PATTERN.test(config.family)) throw new Error("canonical KV warmup family is invalid");
  if (!path.isAbsolute(config.apiKeyFile)) throw new Error("canonical KV warmup apiKeyFile must be absolute");
  let parsed: URL;
  try {
    parsed = new URL(config.ruminantBaseUrl);
  } catch {
    throw new Error("canonical KV warmup Ruminant base URL must be absolute");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
    || config.ruminantBaseUrl.endsWith("/")) {
    throw new Error("canonical KV warmup Ruminant base URL must be an HTTP(S) origin without credentials, path, query, fragment, or trailing slash");
  }
}

export function installProductionCanonicalKvWarmup(
  coordinator: CanonicalKvWarmupCoordinator,
): void {
  if (productionCoordinator && productionCoordinator !== coordinator) {
    throw new Error("production canonical KV warmup coordinator is already installed");
  }
  productionCoordinator = coordinator;
}

export function createProductionCanonicalKvWarmupBinding(
  identity: CanonicalKvWarmupIdentity,
): CanonicalKvWarmupSessionBinding | undefined {
  return productionCoordinator?.createSessionBinding(identity);
}

function readSecretFileStrict(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("canonical KV warmup API key path must be a regular non-symlink file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("canonical KV warmup API key file must not be accessible by group or others");
  }
  const value = fs.readFileSync(file, "utf8").trim();
  if (!value) throw new Error("canonical KV warmup API key file is empty");
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function modelUsesConfiguredRuminant(modelBaseUrl: string, ruminantBaseUrl: string): boolean {
  try {
    const modelUrl = new URL(modelBaseUrl);
    const ruminantUrl = new URL(ruminantBaseUrl);
    return modelUrl.origin === ruminantUrl.origin
      && (modelUrl.pathname === "/v1" || modelUrl.pathname === "/v1/");
  } catch {
    return false;
  }
}

let productionCoordinator: CanonicalKvWarmupCoordinator | undefined;
