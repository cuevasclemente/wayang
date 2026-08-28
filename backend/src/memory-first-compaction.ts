import type {
  ExtensionFactory,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_MEMORY_REVIEW_TOKENS = 96_000;
export const DEFAULT_MEMORY_COMPACTION_TRIGGER_TOKENS = 128_000;
export const DEFAULT_MEMORY_KEEP_RECENT_TOKENS = 20_000;
export const MEMORY_FIRST_MODEL_HEADROOM_TOKENS = 16_384;
export const MAX_MEMORY_FIRST_LIFECYCLE_EVENTS_PER_RUNTIME = 64;
export const MEMORY_FIRST_LIFECYCLE_EVENT_NAME = "wayang:memory-first-lifecycle:v1";
export const MEMORY_REVIEW_COMPLETE_TOOL_NAME = "memory_review_complete";
export const MEMORY_REVIEW_COMPLETE_ENTRY = "wayang-memory-review-complete-v1";
export const MEMORY_REVIEW_THRESHOLD_DEFERRED_ENTRY = "wayang-memory-review-threshold-deferred-v1";
export const MEMORY_REVIEW_REMINDER_MESSAGE = "wayang-memory-review-reminder-v1";
export const MEMORY_REVIEW_REMINDER_QUEUED_ENTRY = "wayang-memory-review-reminder-queued-v1";

export type MemoryFirstPrivacyMode = "standard" | "protected";
export type MemoryFirstRoute = "memoriki" | "project-local";
export type MemoryFirstExecutionMode = "interactive" | "scheduled" | "subagent";

export interface MemoryFirstCompactionConfig {
  /** Effective gate: false unless the master and at least one behavior flag are explicit. */
  enabled: boolean;
  guidanceEnabled: boolean;
  reviewEnabled: boolean;
  compactionControlsEnabled: boolean;
  ledgerEnabled: boolean;
  standardInteractiveEnabled: boolean;
  standardScheduledEnabled: boolean;
  protectedInteractiveEnabled: boolean;
  protectedScheduledEnabled: boolean;
  subagentEnabled: boolean;
  reviewTokens: number;
  compactionTriggerTokens: number;
  keepRecentTokens: number;
  keepCompleteTurns: boolean;
  standardRoute: "memoriki";
  protectedRoute: "project-local";
  /** Relative, traversal-free path inside the owning Protected project. */
  protectedProjectMemoryPath: string;
}

export const DISABLED_MEMORY_FIRST_COMPACTION_CONFIG: Readonly<MemoryFirstCompactionConfig> = Object.freeze({
  enabled: false,
  guidanceEnabled: false,
  reviewEnabled: false,
  compactionControlsEnabled: false,
  ledgerEnabled: false,
  standardInteractiveEnabled: false,
  standardScheduledEnabled: false,
  protectedInteractiveEnabled: false,
  protectedScheduledEnabled: false,
  subagentEnabled: false,
  reviewTokens: DEFAULT_MEMORY_REVIEW_TOKENS,
  compactionTriggerTokens: DEFAULT_MEMORY_COMPACTION_TRIGGER_TOKENS,
  keepRecentTokens: DEFAULT_MEMORY_KEEP_RECENT_TOKENS,
  keepCompleteTurns: false,
  standardRoute: "memoriki",
  protectedRoute: "project-local",
  protectedProjectMemoryPath: ".wayang/memory.md",
});

export type MemoryFirstLifecycleEventType =
  | "session_started"
  | "review_reminder_queued"
  | "review_completed"
  | "compaction_deferred"
  | "compaction_started"
  | "compaction_completed";

/** Content-free aggregate event. It deliberately carries no stable or raw identity. */
export interface MemoryFirstLifecycleEvent {
  type: MemoryFirstLifecycleEventType;
  privacyMode: MemoryFirstPrivacyMode;
  route: MemoryFirstRoute;
  executionMode: MemoryFirstExecutionMode;
  timestamp: number;
  contextTokens?: number;
  reason?: "threshold" | "manual" | "overflow" | "unknown";
}

export type MemoryFirstLifecycleSink = (event: Readonly<MemoryFirstLifecycleEvent>) => void;

let installedLifecycleSink: MemoryFirstLifecycleSink | undefined;

/** Optional coordinator seam. Wayang never persists these aggregate events. */
export function installMemoryFirstLifecycleSink(sink: MemoryFirstLifecycleSink): () => void {
  if (typeof sink !== "function") throw new Error("Memory-first lifecycle sink must be a function");
  if (installedLifecycleSink && installedLifecycleSink !== sink) {
    throw new Error("Memory-first lifecycle sink is already installed");
  }
  installedLifecycleSink = sink;
  return () => {
    if (installedLifecycleSink === sink) installedLifecycleSink = undefined;
  };
}

export interface MemoryFirstExtensionMetadata {
  privacyMode: MemoryFirstPrivacyMode;
  executionMode: MemoryFirstExecutionMode;
  memoryAccess: "none" | "read" | "read_write";
}

export type MemoryFirstCohortMetadata = Pick<MemoryFirstExtensionMetadata, "privacyMode" | "executionMode">;

export function isMemoryFirstCohortEligible(
  config: MemoryFirstCompactionConfig,
  metadata: MemoryFirstCohortMetadata,
): boolean {
  if (!config.enabled) return false;
  if (metadata.executionMode === "subagent") return config.subagentEnabled;
  if (metadata.privacyMode === "protected") {
    return metadata.executionMode === "scheduled"
      ? config.protectedScheduledEnabled
      : config.protectedInteractiveEnabled;
  }
  return metadata.executionMode === "scheduled"
    ? config.standardScheduledEnabled
    : config.standardInteractiveEnabled;
}

export function scopeMemoryFirstCompactionConfig(
  config: MemoryFirstCompactionConfig,
  metadata: MemoryFirstCohortMetadata,
): MemoryFirstCompactionConfig {
  if (isMemoryFirstCohortEligible(config, metadata)) return config;
  return {
    ...config,
    enabled: false,
    guidanceEnabled: false,
    reviewEnabled: false,
    compactionControlsEnabled: false,
    ledgerEnabled: false,
    keepCompleteTurns: false,
  };
}

const REVIEW_OUTCOMES = ["saved", "nothing_future_valuable", "blocked"] as const;
const WIKI_RESULTS = ["updated", "unchanged", "blocked"] as const;
export type MemoryReviewOutcome = typeof REVIEW_OUTCOMES[number];
export type MemoryWikiResult = typeof WIKI_RESULTS[number];

export interface MemoryReviewCompleteEntryData {
  outcome: MemoryReviewOutcome;
  short_term: MemoryWikiResult;
  long_term: MemoryWikiResult;
}

export interface MemoryReviewCycleState {
  completed: boolean;
  thresholdDeferred: boolean;
  reminderQueued: boolean;
  reminderDelivered: boolean;
  completion?: Readonly<MemoryReviewCompleteEntryData>;
}

export interface MemoryReviewBinding {
  privacyMode: MemoryFirstPrivacyMode;
  route: MemoryFirstRoute;
  executionMode: MemoryFirstExecutionMode;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseCompletionData(value: unknown): Readonly<MemoryReviewCompleteEntryData> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (!exactObjectKeys(data, ["outcome", "short_term", "long_term"])) return undefined;
  if (!REVIEW_OUTCOMES.includes(data.outcome as MemoryReviewOutcome)
    || !WIKI_RESULTS.includes(data.short_term as MemoryWikiResult)
    || !WIKI_RESULTS.includes(data.long_term as MemoryWikiResult)) return undefined;
  const parsed = {
    outcome: data.outcome as MemoryReviewOutcome,
    short_term: data.short_term as MemoryWikiResult,
    long_term: data.long_term as MemoryWikiResult,
  };
  try { validateCompletionCombination(parsed); }
  catch { return undefined; }
  return Object.freeze(parsed);
}

function isSingleEnumState(value: unknown, key: string, expected: string): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && exactObjectKeys(value as Record<string, unknown>, [key])
    && (value as Record<string, unknown>)[key] === expected);
}

function isReminderDetails(value: unknown, binding: Readonly<MemoryReviewBinding>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  if (!exactObjectKeys(details, ["schema", "privacy", "route", "execution", "trigger"])) return false;
  if (details.schema !== "v1" || details.trigger !== "review_threshold") return false;
  if (details.privacy !== "standard" && details.privacy !== "protected") return false;
  if (details.route !== "memoriki" && details.route !== "project-local") return false;
  if (details.execution !== "interactive" && details.execution !== "scheduled" && details.execution !== "subagent") return false;
  const internallyConsistent = details.privacy === "protected"
    ? details.route === "project-local"
    : details.route === "memoriki";
  return internallyConsistent
    && details.privacy === binding.privacyMode
    && details.route === binding.route
    && details.execution === binding.executionMode;
}

/** Reconstruct the current post-compaction review cycle for one exact policy binding. */
export function reconstructMemoryReviewCycle(
  branchEntries: readonly any[],
  binding: Readonly<MemoryReviewBinding>,
): MemoryReviewCycleState {
  let cycleStart = 0;
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    if (branchEntries[index]?.type === "compaction") {
      cycleStart = index + 1;
      break;
    }
  }
  let completion: Readonly<MemoryReviewCompleteEntryData> | undefined;
  let thresholdDeferred = false;
  let reminderQueued = false;
  let reminderDelivered = false;
  for (let index = cycleStart; index < branchEntries.length; index++) {
    const entry = branchEntries[index];
    if (entry?.type === "custom" && entry.customType === MEMORY_REVIEW_COMPLETE_ENTRY) {
      completion = parseCompletionData(entry.data) ?? completion;
    } else if (entry?.type === "custom" && entry.customType === MEMORY_REVIEW_THRESHOLD_DEFERRED_ENTRY) {
      thresholdDeferred ||= isSingleEnumState(entry.data, "action", "deferred");
    } else if (entry?.type === "custom" && entry.customType === MEMORY_REVIEW_REMINDER_QUEUED_ENTRY) {
      reminderQueued ||= isSingleEnumState(entry.data, "state", "queued");
    } else if (entry?.type === "custom_message" && entry.customType === MEMORY_REVIEW_REMINDER_MESSAGE) {
      reminderDelivered ||= isReminderDetails(entry.details, binding);
    }
  }
  return Object.freeze({
    completed: Boolean(completion),
    thresholdDeferred,
    reminderQueued: reminderQueued && !reminderDelivered,
    reminderDelivered,
    ...(completion ? { completion } : {}),
  });
}

function routeFor(metadata: MemoryFirstExtensionMetadata, config: MemoryFirstCompactionConfig): MemoryFirstRoute {
  return metadata.privacyMode === "protected" ? config.protectedRoute : config.standardRoute;
}

function executionGuidance(mode: MemoryFirstExecutionMode, privacyMode: MemoryFirstPrivacyMode): string {
  if (mode === "scheduled") {
    return "For scheduled work, finish the future-value wiki review before the run ends when authority permits; do not wait for human input, and record a blocked outcome when persistence is unavailable.";
  }
  if (mode === "subagent") {
    return privacyMode === "protected"
      ? "Keep the durable handoff inside the owning Protected project; do not route it through another project or agent memory."
      : "Return a concise future-value wiki handoff to the owning session and do not create a second compaction or content ledger.";
  }
  return privacyMode === "protected"
    ? "Keep this review inside the owning Protected project."
    : "When delegating, require a concise future-value wiki handoff to this owning session.";
}

export function buildMemoryFirstGuidance(
  metadata: MemoryFirstExtensionMetadata,
  config: MemoryFirstCompactionConfig,
  reviewReminder = false,
): string {
  const routeGuidance = metadata.privacyMode === "protected"
    ? [
        `Use only the project-local wiki at ${config.protectedProjectMemoryPath} inside the owning Protected project.`,
        "Do not claim or imply access to a global, personal, cross-project, or external wiki or memory store.",
      ].join(" ")
    : metadata.memoryAccess === "read_write"
      ? "Use the authorized Standard Memoriki wiki route for future-value knowledge."
      : metadata.memoryAccess === "read"
        ? "The Standard Memoriki wiki route is read-only for this profile; review it when useful and record a blocked outcome instead of claiming a write."
        : "The Standard Memoriki wiki route is unavailable to this profile; record a blocked outcome instead of claiming persistence.";
  const ledgerGuidance = config.ledgerEnabled
    ? "A reviewed memory extension may own a richer content ledger. Wayang records only enum review outcomes and content-free aggregate lifecycle events."
    : "Wayang records only the enum review outcome required to coordinate compaction; do not create a separate telemetry or content ledger.";
  const reminder = reviewReminder
    ? [
        `Context reached the configured ${config.reviewTokens}-token review threshold. Review the current work for information with future value before threshold compaction continues.`,
        "Update the short-term wiki with active commitments, current project state, and near-term decisions that future turns will need.",
        "Update the long-term wiki only with stable facts, preferences, constraints, and reusable decisions likely to remain valuable well beyond this task.",
        "Do not dump transcript text, tool logs, or transient status into either wiki.",
        `When the review is finished, call ${MEMORY_REVIEW_COMPLETE_TOOL_NAME} exactly once with enum outcomes; never put memory text, paths, or identifiers in that tool call.`,
      ].join(" ")
    : [
        "This runtime keeps one persistent Pi AgentSession and uses repeated traditional compaction, without capsules, logical episodes, or replacement sessions.",
        `At ${config.reviewTokens} tokens, review future-value short- and long-term wiki knowledge before the ${config.compactionTriggerTokens}-token threshold compaction.`,
        `Traditional compaction retains roughly ${config.keepRecentTokens} recent tokens${config.keepCompleteTurns ? " in complete turns" : ""}.`,
      ].join(" ");
  return [
    "## Memory-first traditional compaction",
    reminder,
    routeGuidance,
    ledgerGuidance,
    "Compaction summaries preserve operational continuity; they do not replace future-value wiki maintenance.",
    executionGuidance(metadata.executionMode, metadata.privacyMode),
  ].join("\n\n");
}

function boundedReason(value: unknown): MemoryFirstLifecycleEvent["reason"] {
  return value === "threshold" || value === "manual" || value === "overflow" ? value : "unknown";
}

function contextTokenCount(ctx: { getContextUsage(): { tokens: number | null } | null | undefined }): number | undefined {
  const tokens = ctx.getContextUsage()?.tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : undefined;
}

function validateCompletionCombination(data: MemoryReviewCompleteEntryData): void {
  const results = [data.short_term, data.long_term];
  if (data.outcome === "saved" && !results.includes("updated")) {
    throw new Error("saved requires at least one updated wiki horizon");
  }
  if (data.outcome === "nothing_future_valuable" && results.some((value) => value !== "unchanged")) {
    throw new Error("nothing_future_valuable requires unchanged short- and long-term wikis");
  }
  if (data.outcome === "blocked" && !results.includes("blocked")) {
    throw new Error("blocked requires at least one blocked wiki horizon");
  }
}

/** Reviewed repo-owned factory. It coordinates review but never replaces Pi's compactor. */
export function createMemoryFirstCompactionExtension(
  metadata: MemoryFirstExtensionMetadata,
  config: MemoryFirstCompactionConfig,
  sink?: MemoryFirstLifecycleSink,
): ExtensionFactory {
  if (!config.enabled) throw new Error("Cannot create a disabled memory-first extension");
  const route = routeFor(metadata, config);
  const reviewBinding: Readonly<MemoryReviewBinding> = Object.freeze({
    privacyMode: metadata.privacyMode,
    route,
    executionMode: metadata.executionMode,
  });
  return (pi) => {
    // A new extension runtime cannot inherit Pi's old in-memory queue. This
    // recovery permission is runtime-local; queued/completed review state is durable.
    let recoverQueuedReminder = false;
    let emittedEvents = 0;
    const emit = (event: Omit<MemoryFirstLifecycleEvent, "privacyMode" | "route" | "executionMode" | "timestamp">): void => {
      if (!config.ledgerEnabled || emittedEvents >= MAX_MEMORY_FIRST_LIFECYCLE_EVENTS_PER_RUNTIME) return;
      emittedEvents++;
      const lifecycleEvent = Object.freeze({
        ...event,
        privacyMode: metadata.privacyMode,
        route,
        executionMode: metadata.executionMode,
        timestamp: Date.now(),
      }) as Readonly<MemoryFirstLifecycleEvent>;
      try { (pi.events as { emit?: (name: string, value: unknown) => void } | undefined)?.emit?.(MEMORY_FIRST_LIFECYCLE_EVENT_NAME, lifecycleEvent); }
      catch { /* a telemetry consumer must never change agent lifecycle */ }
      try { (sink ?? installedLifecycleSink)?.(lifecycleEvent); }
      catch { /* a telemetry consumer must never change agent lifecycle */ }
    };
    const currentCycle = (ctx: { sessionManager: { getBranch(): readonly any[] } }) => (
      reconstructMemoryReviewCycle(ctx.sessionManager.getBranch(), reviewBinding)
    );
    const createReviewMessage = (content: string) => ({
      customType: MEMORY_REVIEW_REMINDER_MESSAGE,
      content,
      display: true,
      details: Object.freeze({
        schema: "v1",
        privacy: metadata.privacyMode,
        route,
        execution: metadata.executionMode,
        trigger: "review_threshold",
      }),
    });
    const sendReviewFollowUp = (content: string): boolean => {
      try {
        pi.sendMessage(createReviewMessage(content), { deliverAs: "followUp", triggerTurn: true });
        return true;
      } catch {
        return false;
      }
    };
    const queueReminder = (ctx: {
      sessionManager: { getBranch(): readonly any[] };
      getContextUsage(): { tokens: number | null } | null | undefined;
    }, requireThreshold = true): boolean => {
      if (!config.reviewEnabled) return false;
      const state = currentCycle(ctx);
      if (state.completed || state.reminderDelivered || (state.reminderQueued && !recoverQueuedReminder)) return false;
      const tokens = contextTokenCount(ctx);
      if (requireThreshold && (tokens === undefined || tokens < config.reviewTokens)) return false;
      if (!sendReviewFollowUp(buildMemoryFirstGuidance(metadata, config, true))) return false;
      if (!state.reminderQueued) {
        pi.appendEntry(MEMORY_REVIEW_REMINDER_QUEUED_ENTRY, Object.freeze({ state: "queued" as const }));
      }
      recoverQueuedReminder = false;
      emit({ type: "review_reminder_queued", contextTokens: tokens });
      return true;
    };
    const queueThresholdRetry = (ctx: {
      getContextUsage(): { tokens: number | null } | null | undefined;
    }): boolean => {
      const queued = sendReviewFollowUp([
        "This is the single memory-review retry before threshold compaction proceeds.",
        buildMemoryFirstGuidance(metadata, config, true),
      ].join("\n\n"));
      if (queued) emit({ type: "review_reminder_queued", contextTokens: contextTokenCount(ctx) });
      return queued;
    };

    if (config.reviewEnabled) {
      pi.registerTool({
        name: MEMORY_REVIEW_COMPLETE_TOOL_NAME,
        label: "Complete memory review",
        description: "Record a bounded enum-only short/long-term wiki review outcome. Never pass memory content, paths, or identifiers.",
        parameters: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: [...REVIEW_OUTCOMES] },
            short_term: { type: "string", enum: [...WIKI_RESULTS] },
            long_term: { type: "string", enum: [...WIKI_RESULTS] },
          },
          required: ["outcome", "short_term", "long_term"],
          additionalProperties: false,
        } as any,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const reviewParams = params as Record<string, unknown>;
          const data: MemoryReviewCompleteEntryData = {
            outcome: reviewParams.outcome as MemoryReviewOutcome,
            short_term: reviewParams.short_term as MemoryWikiResult,
            long_term: reviewParams.long_term as MemoryWikiResult,
          };
          validateCompletionCombination(data);
          const existing = currentCycle(ctx);
          if (existing.completed && existing.completion) {
            const exactRetry = existing.completion.outcome === data.outcome
              && existing.completion.short_term === data.short_term
              && existing.completion.long_term === data.long_term;
            if (!exactRetry) throw new Error("Memory review outcome conflicts with the canonical completion for this compaction cycle");
            return {
              content: [{ type: "text" as const, text: "Canonical memory review outcome was already recorded for this compaction cycle." }],
              details: existing.completion,
            };
          }
          if (!existing.reminderDelivered && !existing.thresholdDeferred) {
            throw new Error("No memory review is due in the current compaction cycle");
          }
          pi.appendEntry(MEMORY_REVIEW_COMPLETE_ENTRY, Object.freeze({ ...data }));
          recoverQueuedReminder = false;
          emit({ type: "review_completed" });
          return {
            content: [{ type: "text" as const, text: "Memory review outcome recorded; threshold compaction may continue." }],
            details: Object.freeze({ ...data }),
          };
        },
      });
    }

    pi.on("session_start", (_event, ctx) => {
      recoverQueuedReminder = true;
      currentCycle(ctx); // Validate/reconstruct branch state at every startup or reload.
      emit({ type: "session_started" });
    });

    pi.on("before_agent_start", (event, ctx) => {
      // This event fires before Pi marks the run active. Starting a triggered
      // follow-up here can create a concurrent nested run, so recovery injects
      // the reminder directly into the pending run instead of calling sendMessage.
      const state = currentCycle(ctx);
      const tokens = contextTokenCount(ctx);
      const reminderDue = config.reviewEnabled
        && !state.completed
        && !state.reminderDelivered
        && (!state.reminderQueued || recoverQueuedReminder)
        && tokens !== undefined
        && tokens >= config.reviewTokens;
      const systemPrompt = config.guidanceEnabled
        ? `${event.systemPrompt}\n\n${buildMemoryFirstGuidance(metadata, config)}`
        : undefined;
      if (!reminderDue) return systemPrompt ? { systemPrompt } : undefined;
      if (!state.reminderQueued) {
        pi.appendEntry(MEMORY_REVIEW_REMINDER_QUEUED_ENTRY, Object.freeze({ state: "queued" as const }));
      }
      recoverQueuedReminder = false;
      emit({ type: "review_reminder_queued", contextTokens: tokens });
      return {
        ...(systemPrompt ? { systemPrompt } : {}),
        message: createReviewMessage(buildMemoryFirstGuidance(metadata, config, true)),
      };
    });

    pi.on("agent_end", (_event, ctx) => {
      queueReminder(ctx);
    });

    pi.on("session_before_compact", (event, ctx) => {
      const reason = boundedReason((event as { reason?: unknown }).reason);
      if (!config.reviewEnabled || reason !== "threshold") {
        emit({ type: "compaction_started", reason });
        return undefined;
      }
      const state = currentCycle(ctx);
      if (state.completed) {
        emit({ type: "compaction_started", reason });
        return undefined;
      }
      if (state.thresholdDeferred) {
        if (state.reminderQueued && !state.reminderDelivered && recoverQueuedReminder) {
          if (queueReminder(ctx, false)) return { cancel: true };
        }
        emit({ type: "compaction_started", reason });
        return undefined;
      }
      // One durable deferral per active compaction cycle. An ordinary reminder
      // still queued is already the continuation; only a delivered-but-ignored
      // reminder needs one retry turn. The next threshold attempt passes.
      pi.appendEntry(MEMORY_REVIEW_THRESHOLD_DEFERRED_ENTRY, Object.freeze({ action: "deferred" as const }));
      const continuationQueued = state.reminderQueued
        ? true
        : state.reminderDelivered
          ? queueThresholdRetry(ctx)
          : queueReminder(ctx, false);
      if (!continuationQueued) {
        // Never leave an over-threshold session idle when the continuation
        // cannot be queued. Fail open to ordinary compaction.
        emit({ type: "compaction_started", reason });
        return undefined;
      }
      emit({ type: "compaction_deferred", reason });
      return { cancel: true };
    });

    pi.on("session_compact", (event) => {
      recoverQueuedReminder = false;
      emit({
        type: "compaction_completed",
        contextTokens: Number.isFinite(event.compactionEntry?.tokensBefore)
          ? Math.max(0, Math.floor(event.compactionEntry.tokensBefore))
          : undefined,
      });
    });
  };
}

export interface MemoryFirstModelDescriptor {
  provider: string;
  id: string;
  contextWindow: number;
}

export function validateMemoryFirstModel(
  config: MemoryFirstCompactionConfig,
  model: MemoryFirstModelDescriptor,
): void {
  if (!config.enabled) return;
  if (!model.provider.trim() || !model.id.trim() || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error("Memory-first compaction requires a model with a valid provider, id, and context window");
  }
  if (config.reviewEnabled && model.contextWindow <= config.reviewTokens) {
    throw new Error(`Model ${model.provider}/${model.id} context window must exceed the memory review threshold`);
  }
  if (config.compactionControlsEnabled
    && model.contextWindow < config.compactionTriggerTokens + MEMORY_FIRST_MODEL_HEADROOM_TOKENS) {
    throw new Error(
      `Model ${model.provider}/${model.id} context window must provide at least ${MEMORY_FIRST_MODEL_HEADROOM_TOKENS} tokens beyond the compaction trigger`,
    );
  }
}

/**
 * Pi 0.84.1 types do not yet declare triggerTokens/keepCompleteTurns. Keep the
 * compatibility cast isolated here and retain reserveTokens as the current-SDK
 * absolute-trigger fallback. Remove only this helper when dependency types land.
 */
export function applyMemoryFirstCompactionOverrides(
  settingsManager: SettingsManager,
  config: MemoryFirstCompactionConfig,
  modelContextWindow: number,
): void {
  if (!config.enabled || !config.compactionControlsEnabled) return;
  const reserveTokens = modelContextWindow - config.compactionTriggerTokens;
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens < MEMORY_FIRST_MODEL_HEADROOM_TOKENS) {
    throw new Error("Memory-first compaction model headroom is invalid");
  }
  type CompatCompactionOverrides = {
    enabled: true;
    reserveTokens: number;
    keepRecentTokens: number;
    triggerTokens?: number;
    keepCompleteTurns?: true;
  };
  const compaction: CompatCompactionOverrides = {
    enabled: true,
    reserveTokens,
    keepRecentTokens: config.keepRecentTokens,
    triggerTokens: config.compactionTriggerTokens,
    ...(config.keepCompleteTurns ? { keepCompleteTurns: true as const } : {}),
  };
  settingsManager.applyOverrides({ compaction } as Parameters<SettingsManager["applyOverrides"]>[0]);
}
