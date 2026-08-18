import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  TranscriptEventEntry,
  TranscriptEventListResponse,
  TranscriptEventMutationKind,
  TranscriptEventMutationResponse,
} from "@wayang/protocol";
import type { SettingsPinAttemptPort } from "./workspace-capability-approval/types.js";
import { getStore, type SessionRow } from "./db.js";
import { listHumanAttentionForSession } from "./human-attention.js";
import { getActionApprovalBridge } from "./action-approval-bridge.js";
import { getCommandGuardIdentityBridge } from "./command-guard-bridge.js";
import { getSudoBridge } from "./sudo-bridge.js";
import {
  getPiSession,
  getPiSessionRuntimeState,
  getRuntimeMutationSessionState,
  invalidateSessionFileSnapshot,
  isPiSessionAgentSwitchInProgress,
  lockRuntimeMutationSession,
  protectedBrowserIdleRetentionIsRequired,
  stopPiSessionIfIdle,
  unlockRuntimeMutationSession,
} from "./pi-bridge.js";
import {
  getSessionById,
  markSessionTranscriptMutated,
  syncPiSessionFiles,
} from "./sessions.js";
import {
  beginTranscriptMutationSearchFence,
  endTranscriptMutationSearchFence,
  indexSession,
} from "./search/indexer.js";

export const DELETED_EVENT_TOMBSTONE = "wayang-deleted-event-v1";
export const INVALIDATED_DERIVED_EVENT_TOMBSTONE = "wayang-invalidated-derived-event-v1";
export const MAX_TRANSCRIPT_EVENT_BYTES = 1024 * 1024;
export const MAX_TRANSCRIPT_EVENTS_PER_PAGE = 500;
const MAX_EVENT_DEPTH = 64;
const MAX_EVENT_NODES = 100_000;
const MAX_EVENT_ID_BYTES = 512;
const KNOWN_ENTRY_TYPES = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const DERIVED_ENTRY_TYPES = new Set(["compaction", "branch_summary"]);

export interface TranscriptMutationPinValidationResult {
  ok: boolean;
  pinConfigured: boolean;
  error?: string;
  statusCode?: number;
  code?: string;
  retryAt?: number;
}

export class TranscriptMutationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "invalid_request",
    readonly pin?: Pick<TranscriptMutationPinValidationResult, "pinConfigured">,
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

export type CanonicalEntry = TranscriptEventEntry;

export interface CanonicalEntryReplacement {
  expectedEntry: CanonicalEntry;
  replacementEntry: CanonicalEntry;
}

export interface CanonicalTranscriptPort {
  getHeader(): unknown;
  getEntries(): CanonicalEntry[];
  getBranch(): CanonicalEntry[];
  replaceEntriesIfCurrent(replacements: readonly CanonicalEntryReplacement[]): void;
}

/**
 * The only compatibility boundary for the expected Pi multi-entry CAS API.
 * The manager must compare every complete expected entry under one lock and
 * atomically rewrite the file once. No sequential fallback is permitted.
 */
interface ExpectedEntryCasSessionManager {
  getHeader(): unknown;
  getEntries(): CanonicalEntry[];
  getBranch(): CanonicalEntry[];
  replaceEntriesIfCurrent(
    replacements: readonly Array<{ expectedEntry: CanonicalEntry; replacement: CanonicalEntry }>,
  ): void | boolean | { replaced: boolean };
}

function adaptSessionManager(manager: SessionManager): CanonicalTranscriptPort {
  const cas = manager as unknown as ExpectedEntryCasSessionManager;
  return {
    getHeader: () => cas.getHeader(),
    getEntries: () => cas.getEntries(),
    getBranch: () => cas.getBranch(),
    replaceEntriesIfCurrent(replacements) {
      if (typeof cas.replaceEntriesIfCurrent !== "function") {
        throw new TranscriptMutationError(
          "Canonical transcript mutation is unavailable in the installed Pi SDK",
          503,
          "cas_unavailable",
        );
      }
      let result: void | boolean | { replaced: boolean };
      try {
        result = cas.replaceEntriesIfCurrent(replacements.map(({ expectedEntry, replacementEntry }) => ({
          expectedEntry,
          replacement: replacementEntry,
        })));
      } catch (error) {
        const candidate = error as { statusCode?: unknown; code?: unknown };
        if (candidate?.statusCode === 409 || candidate?.code === "CAS_CONFLICT" || candidate?.code === "ERR_SESSION_ENTRY_CONFLICT") {
          throw new TranscriptMutationError("Transcript events changed before mutation", 409, "cas_conflict");
        }
        throw error;
      }
      if (result === false || (result && typeof result === "object" && result.replaced === false)) {
        throw new TranscriptMutationError("Transcript events changed before mutation", 409, "cas_conflict");
      }
      const currentById = new Map(cas.getEntries().map((entry) => [entry.id, entry]));
      if (replacements.some(({ replacementEntry }) => !isDeepStrictEqual(currentById.get(replacementEntry.id), replacementEntry))) {
        const conflict = new TranscriptMutationError(
          "Canonical transcript CAS did not commit the exact replacement set",
          409,
          "cas_conflict",
        ) as TranscriptMutationError & { canonicalMayHaveChanged: true };
        conflict.canonicalMayHaveChanged = true;
        throw conflict;
      }
    },
  };
}

export interface TranscriptMutationDependencies {
  getSession(id: string): SessionRow | undefined;
  validatePin(pin: unknown, operation: unknown): Promise<TranscriptMutationPinValidationResult>;
  acquireRuntimeLock(id: string): boolean;
  releaseRuntimeLock(id: string): void;
  inspectRuntime(id: string): {
    runtime_status: "active" | "starting" | "stopped";
    streaming: boolean;
    compacting: boolean;
    queued: boolean;
    humanGate: boolean;
  };
  isMessagingBound(id: string): boolean;
  hasPendingSessionMutation(id: string): boolean;
  hasDurableHumanGate(id: string): boolean;
  disposeIdleRuntime(id: string): Promise<boolean>;
  openTranscript(session: SessionRow): CanonicalTranscriptPort;
  purgeSearch(id: string): Promise<void>;
  releaseSearchFence(id: string): void;
  invalidateSnapshots(sessionFile: string | null): void;
  reconcileMetadata(id: string): Promise<void>;
  forceReindex(id: string): Promise<void>;
}

let transcriptMutationPinAttempts: SettingsPinAttemptPort | undefined;
const TRANSCRIPT_MUTATION_PIN_REALM = "wayang.transcript-mutation.v1";
const TRANSCRIPT_MUTATION_PIN_TTL_MS = 60_000;

/** Install the one process-wide hardened persistent cooldown authority. */
export function installTranscriptMutationPinAttempts(pinAttempts: SettingsPinAttemptPort): void {
  if (transcriptMutationPinAttempts && transcriptMutationPinAttempts !== pinAttempts) {
    throw new Error("Transcript mutation PIN attempt authority is already installed");
  }
  transcriptMutationPinAttempts = pinAttempts;
}

export async function validateTranscriptMutationPinAttempt(
  attempts: SettingsPinAttemptPort | undefined,
  pin: unknown,
  operation: unknown,
): Promise<TranscriptMutationPinValidationResult> {
  if (!attempts) return {
    ok: false,
    pinConfigured: false,
    error: "Transcript mutation PIN authority is unavailable.",
    statusCode: 503,
    code: "pin_unavailable",
  };
  const requestId = randomUUID();
  const reservationId = randomUUID();
  const expiresAt = Date.now() + TRANSCRIPT_MUTATION_PIN_TTL_MS;
  const encodedOperation = JSON.stringify(operation);
  if (encodedOperation === undefined) return {
    ok: false,
    pinConfigured: false,
    error: "Transcript mutation PIN authority is unavailable.",
    statusCode: 503,
    code: "pin_unavailable",
  };
  const operationDigest = createHash("sha256").update(encodedOperation, "utf8").digest("hex");
  const reserved = await attempts.reserve({
    realm: TRANSCRIPT_MUTATION_PIN_REALM,
    reservationId,
    requestId,
    operationDigest,
    expiresAt,
  });
  if (reserved.status === "cooldown") return {
    ok: false,
    pinConfigured: true,
    error: "Command guard identity PIN cooldown is active.",
    statusCode: 429,
    code: "pin_cooldown",
    retryAt: reserved.retryAt,
  };
  if (reserved.status === "busy") return {
    ok: false,
    pinConfigured: true,
    error: "Another PIN-confirmed operation is in progress.",
    statusCode: 409,
    code: "pin_busy",
  };
  if (reserved.status !== "reserved") return {
    ok: false,
    pinConfigured: false,
    error: "Transcript mutation PIN authority is unavailable.",
    statusCode: 503,
    code: "pin_unavailable",
  };
  let verified: Awaited<ReturnType<SettingsPinAttemptPort["verifyAndConsume"]>>;
  try {
    verified = await attempts.verifyAndConsume({
      realm: TRANSCRIPT_MUTATION_PIN_REALM,
      reservationId,
      requestId,
      pin: typeof pin === "string" ? pin : "",
      now: Date.now(),
    });
  } catch {
    await attempts.cancelAndConsume({
      realm: TRANSCRIPT_MUTATION_PIN_REALM,
      reservationId,
      requestId,
      reason: "backend_failure",
      now: Date.now(),
    }).catch(() => undefined);
    return {
      ok: false,
      pinConfigured: false,
      error: "Transcript mutation PIN authority is unavailable.",
      statusCode: 503,
      code: "pin_unavailable",
    };
  }
  if (verified.status === "verified") return { ok: true, pinConfigured: true };
  if (verified.status === "wrong_pin") return {
    ok: false,
    pinConfigured: true,
    error: "Incorrect command guard identity PIN.",
    statusCode: 403,
    code: "pin_rejected",
  };
  return {
    ok: false,
    pinConfigured: verified.status !== "unavailable",
    error: verified.status === "expired"
      ? "Command guard identity PIN attempt expired."
      : "Transcript mutation PIN authority is unavailable.",
    statusCode: verified.status === "expired" ? 403 : 503,
    code: verified.status === "expired" ? "pin_expired" : "pin_unavailable",
  };
}

function productionDependencies(): TranscriptMutationDependencies {
  return {
    getSession: getSessionById,
    validatePin: (pin, operation) => validateTranscriptMutationPinAttempt(
      transcriptMutationPinAttempts,
      pin,
      operation,
    ),
    acquireRuntimeLock: lockRuntimeMutationSession,
    releaseRuntimeLock: unlockRuntimeMutationSession,
    inspectRuntime(id) {
      const mutation = getRuntimeMutationSessionState(id);
      const runtime = getPiSessionRuntimeState(id);
      const handle = getPiSession(id);
      return {
        runtime_status: mutation.runtime_status,
        streaming: mutation.streaming,
        compacting: runtime.runtime_is_compacting,
        queued: mutation.queued,
        humanGate: Boolean(
          (handle && protectedBrowserIdleRetentionIsRequired(handle.protectedBrowserRuntime))
          || getActionApprovalBridge().getPendingRequests(id).length
          || getSudoBridge().getPendingRequests(id).length
          || getCommandGuardIdentityBridge().getPendingRequests(id).length
        ),
      };
    },
    isMessagingBound: (id) => getStore().messagingEndpoints.some((endpoint) => endpoint.active_session_id === id),
    hasPendingSessionMutation: (id) => isPiSessionAgentSwitchInProgress(id)
      || (getSessionById(id)?.pending_agent_switch ?? null) !== null,
    hasDurableHumanGate: (id) => listHumanAttentionForSession(id).length > 0,
    disposeIdleRuntime: stopPiSessionIfIdle,
    openTranscript(session) {
      const live = getPiSession(session.id);
      const manager = live?.session.sessionManager
        ?? (session.pi_session_file ? SessionManager.open(session.pi_session_file, undefined, session.cwd) : null);
      if (!manager) throw new TranscriptMutationError("Session has no canonical transcript", 409, "transcript_unavailable");
      return adaptSessionManager(manager);
    },
    async purgeSearch(id) { beginTranscriptMutationSearchFence(id); },
    releaseSearchFence: endTranscriptMutationSearchFence,
    invalidateSnapshots: invalidateSessionFileSnapshot,
    async reconcileMetadata(id) {
      markSessionTranscriptMutated(id);
      await syncPiSessionFiles();
    },
    async forceReindex(id) {
      try {
        const result = await indexSession(id, { force: true });
        if (!result.error) return;
      } catch { /* fixed public error below */ }
      throw new TranscriptMutationError(
        "Search reindex failed after transcript mutation.",
        500,
        "reindex_failed",
      );
    },
  };
}

export interface ListedTranscriptEntry {
  entry: CanonicalEntry;
  active_branch: boolean;
  semantic_warnings: string[];
}

export interface TranscriptEventListing extends TranscriptEventListResponse {
  events: ListedTranscriptEntry[];
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TranscriptMutationError(`${label} is outside the permitted bounds`, 400, "invalid_bounds");
  }
  return value;
}

function assertJsonBounds(value: unknown, label: string): void {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new TranscriptMutationError(`${label} must be JSON`, 400, "invalid_schema"); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_TRANSCRIPT_EVENT_BYTES) {
    throw new TranscriptMutationError(`${label} exceeds the permitted byte bound`, 413, "event_too_large");
  }
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes++;
    if (nodes > MAX_EVENT_NODES || depth > MAX_EVENT_DEPTH) {
      throw new TranscriptMutationError(`${label} exceeds the permitted structural bounds`, 413, "event_too_large");
    }
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new TranscriptMutationError(`${label} contains a non-finite number`, 400, "invalid_schema");
      return;
    }
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child, depth + 1);
      return;
    }
    if (typeof candidate !== "object") throw new TranscriptMutationError(`${label} contains a non-JSON value`, 400, "invalid_schema");
    for (const [key, child] of Object.entries(candidate)) {
      if (key === "__proto__") throw new TranscriptMutationError(`${label} contains an unsafe property`, 400, "invalid_schema");
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_EVENT_ID_BYTES
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}

function asEntry(value: unknown, label: string, options: { knownType: boolean }): CanonicalEntry {
  assertJsonBounds(value, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TranscriptMutationError(`${label} must be one transcript entry object`, 400, "invalid_schema");
  }
  const entry = value as CanonicalEntry;
  if (!validId(entry.id) || typeof entry.type !== "string" || !entry.type
    || Buffer.byteLength(entry.type, "utf8") > 64
    || !(entry.parentId === null || validId(entry.parentId))) {
    throw new TranscriptMutationError(`${label} has invalid type/id/parent topology`, 400, "invalid_schema");
  }
  if (options.knownType && !KNOWN_ENTRY_TYPES.has(entry.type)) {
    throw new TranscriptMutationError(`${label} uses an unsupported event type`, 400, "unsupported_event_type");
  }
  return structuredClone(entry);
}

function assertNoReservedMutationMetadata(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (Object.hasOwn(record, "wayangMutation") || Object.hasOwn(record, "wayang_mutation")) {
      throw new TranscriptMutationError("Caller-supplied Wayang mutation metadata is reserved", 400, "reserved_mutation_metadata");
    }
    pending.push(...Object.values(record));
  }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 64) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function validContentBlock(block: unknown, role?: string): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  const value = block as Record<string, unknown>;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image") {
    return role !== "assistant" && typeof value.data === "string" && typeof value.mimeType === "string";
  }
  if (value.type === "thinking") {
    return role === "assistant" && typeof value.thinking === "string";
  }
  if (value.type === "toolCall") {
    return role === "assistant" && typeof value.id === "string" && Boolean(value.id)
      && typeof value.name === "string" && Boolean(value.name)
      && value.arguments !== null && typeof value.arguments === "object" && !Array.isArray(value.arguments);
  }
  return false;
}

function validMessageContent(value: unknown, role?: string): boolean {
  return typeof value === "string" || (Array.isArray(value)
    && value.every((block) => validContentBlock(block, role)));
}

function validateReplacement(expected: CanonicalEntry, replacementValue: unknown): CanonicalEntry {
  const replacement = asEntry(replacementValue, "replacement_entry", { knownType: true });
  assertNoReservedMutationMetadata(replacement);
  if (replacement.customType === DELETED_EVENT_TOMBSTONE
    || replacement.customType === INVALIDATED_DERIVED_EVENT_TOMBSTONE) {
    throw new TranscriptMutationError("Caller-supplied mutation tombstones are reserved", 400, "reserved_mutation_metadata");
  }
  if (!validTimestamp(replacement.timestamp)) {
    throw new TranscriptMutationError("Replacement events require a valid timestamp", 400, "invalid_schema");
  }
  if (replacement.id !== expected.id || replacement.parentId !== expected.parentId || replacement.type !== expected.type) {
    throw new TranscriptMutationError("Event type, id, and parentId are immutable", 400, "immutable_topology");
  }
  if (replacement.type === "message") {
    const before = expected.message as Record<string, unknown> | undefined;
    const after = replacement.message as Record<string, unknown> | undefined;
    if (!before || !after || typeof before !== "object" || typeof after !== "object"
      || typeof before.role !== "string" || !["user", "assistant", "toolResult"].includes(before.role)
      || after.role !== before.role || !validMessageContent(after.content, before.role)) {
      throw new TranscriptMutationError("Message edits must preserve a supported role and provide structured content", 400, "invalid_schema");
    }
    if (before.role === "toolResult"
      && (typeof before.toolCallId !== "string" || typeof before.toolName !== "string"
        || after.toolCallId !== before.toolCallId || after.toolName !== before.toolName)) {
      throw new TranscriptMutationError("Tool-result call identity is immutable", 400, "immutable_tool_identity");
    }
  }
  if ((replacement.type === "compaction" || replacement.type === "branch_summary")
    && typeof replacement.summary !== "string") {
    throw new TranscriptMutationError("Summary events require a string summary", 400, "invalid_schema");
  }
  if (replacement.type === "model_change"
    && (typeof replacement.provider !== "string" || !replacement.provider
      || typeof replacement.modelId !== "string" || !replacement.modelId)) {
    throw new TranscriptMutationError("Model-change events require provider and modelId", 400, "invalid_schema");
  }
  if (replacement.type === "thinking_level_change"
    && (typeof replacement.thinkingLevel !== "string" || !replacement.thinkingLevel)) {
    throw new TranscriptMutationError("Thinking-level events require thinkingLevel", 400, "invalid_schema");
  }
  if (replacement.type === "label" && typeof replacement.label !== "string") {
    throw new TranscriptMutationError("Label events require a string label", 400, "invalid_schema");
  }
  if (replacement.type === "session_info" && typeof replacement.name !== "string") {
    throw new TranscriptMutationError("Session-info events require a string name", 400, "invalid_schema");
  }
  if (replacement.type === "custom" && typeof replacement.customType !== "string") {
    throw new TranscriptMutationError("Custom events require customType", 400, "invalid_schema");
  }
  if (replacement.type === "custom_message"
    && (typeof replacement.customType !== "string" || !validMessageContent(replacement.content))) {
    throw new TranscriptMutationError("Custom message events require customType and content", 400, "invalid_schema");
  }
  return replacement;
}

function semanticWarnings(entry: CanonicalEntry): string[] {
  const warnings: string[] = [];
  if (!KNOWN_ENTRY_TYPES.has(entry.type)) warnings.push("Unknown structured event type; mutation is unavailable.");
  if (entry.type === "message") {
    const message = entry.message as Record<string, unknown> | undefined;
    if (message?.role === "toolResult") {
      warnings.push("Tool results are independent events; editing or deleting one does not mutate its tool call.");
    }
    if (message?.role === "assistant" && Array.isArray(message.content)
      && message.content.some((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall")) {
      warnings.push("Tool calls are not bundled with their result events; semantic consistency is the caller's responsibility.");
    }
  }
  return warnings;
}

function leafEntries(entries: CanonicalEntry[]): CanonicalEntry[] {
  const parentIds = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => typeof id === "string"));
  return entries.filter((entry) => !parentIds.has(entry.id));
}

function listing(
  sessionId: string,
  transcript: CanonicalTranscriptPort,
  offset: number,
  limit: number,
  branchOffset: number,
  branchLimit: number,
): TranscriptEventListing {
  const entries = transcript.getEntries().map((entry) => asEntry(entry, "canonical_entry", { knownType: false }));
  const branch = transcript.getBranch();
  const activeIds = new Set(branch.map((entry) => entry.id));
  const leaves = leafEntries(entries);
  const activeTip = branch.at(-1)?.id;
  const branchTips = [...leaves];
  if (activeTip && !branchTips.some((entry) => entry.id === activeTip)) {
    const activeTipEntry = entries.find((entry) => entry.id === activeTip);
    if (activeTipEntry) branchTips.push(activeTipEntry);
  }
  const page = entries.slice(offset, offset + limit);
  const branchPage = branchTips.slice(branchOffset, branchOffset + branchLimit);
  return {
    session_id: sessionId,
    header: structuredClone(transcript.getHeader()),
    header_immutable: true,
    total_events: entries.length,
    offset,
    limit,
    next_offset: offset + page.length < entries.length ? offset + page.length : null,
    total_branches: branchTips.length,
    branch_offset: branchOffset,
    branch_limit: branchLimit,
    next_branch_offset: branchOffset + branchPage.length < branchTips.length ? branchOffset + branchPage.length : null,
    branches: branchPage.map((entry) => ({ tip_entry_id: entry.id, active: entry.id === activeTip })),
    events: page.map((entry) => ({
      entry,
      active_branch: activeIds.has(entry.id),
      semantic_warnings: semanticWarnings(entry),
    })),
  };
}

function tombstone(expected: CanonicalEntry, customType: string): CanonicalEntry {
  return {
    type: "custom",
    id: expected.id,
    parentId: expected.parentId,
    timestamp: validTimestamp(expected.timestamp) ? expected.timestamp : new Date().toISOString(),
    customType,
    data: { version: 1 },
  };
}

function contentBearingDerivedEntries(entries: CanonicalEntry[], targetId: string): CanonicalEntry[] {
  // A branch summary can summarize content from a sibling path rather than an
  // ancestor path represented by parentId. Until Pi exposes exact summary
  // dependencies, invalidate every content-bearing summary in the same atomic
  // rewrite. The target itself receives its requested replacement instead.
  return entries.filter((entry) => entry.id !== targetId && DERIVED_ENTRY_TYPES.has(entry.type));
}

export type TranscriptMutationKind = TranscriptEventMutationKind;

export interface TranscriptMutationInput {
  pin: unknown;
  expectedEntry: unknown;
  replacementEntry?: unknown;
}

export interface TranscriptMutationResult extends TranscriptEventMutationResponse {
  mutation: TranscriptMutationKind;
  replacement: CanonicalEntry;
}

export class TranscriptMutationService {
  constructor(private readonly dependencies: TranscriptMutationDependencies = productionDependencies()) {}

  listEvents(
    sessionId: string,
    options: { offset?: number; limit?: number; branchOffset?: number; branchLimit?: number } = {},
  ): TranscriptEventListing {
    if (!validId(sessionId)) throw new TranscriptMutationError("Invalid session id", 400, "invalid_session_id");
    const offset = boundedInteger(options.offset ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(options.limit ?? 100, "limit", 1, MAX_TRANSCRIPT_EVENTS_PER_PAGE);
    const branchOffset = boundedInteger(options.branchOffset ?? 0, "branch_offset", 0, Number.MAX_SAFE_INTEGER);
    const branchLimit = boundedInteger(options.branchLimit ?? 100, "branch_limit", 1, MAX_TRANSCRIPT_EVENTS_PER_PAGE);
    const session = this.dependencies.getSession(sessionId);
    if (!session) throw new TranscriptMutationError("Session not found", 404, "session_not_found");
    return listing(sessionId, this.dependencies.openTranscript(session), offset, limit, branchOffset, branchLimit);
  }

  async mutateEvent(
    sessionId: string,
    eventId: string,
    kind: TranscriptMutationKind,
    input: TranscriptMutationInput,
  ): Promise<TranscriptMutationResult> {
    if (!validId(sessionId) || !validId(eventId)) {
      throw new TranscriptMutationError("Invalid session or event id", 400, "invalid_event_id");
    }
    const expected = asEntry(input.expectedEntry, "expected_entry", { knownType: false });
    if (expected.id !== eventId) throw new TranscriptMutationError("expected_entry id does not match the route", 400, "event_id_mismatch");
    const replacement = kind === "edit"
      ? validateReplacement(expected, input.replacementEntry)
      : tombstone(expected, DELETED_EVENT_TOMBSTONE);
    const session = this.dependencies.getSession(sessionId);
    if (!session) throw new TranscriptMutationError("Session not found", 404, "session_not_found");
    if (!this.dependencies.acquireRuntimeLock(sessionId)) {
      throw new TranscriptMutationError("Session mutation is already in progress", 409, "mutation_busy");
    }

    let searchFenced = false;
    let canonicalChanged = false;
    let mutatedSessionFile: string | null = null;
    try {
      const pin = await this.dependencies.validatePin(input.pin, {
        realm: TRANSCRIPT_MUTATION_PIN_REALM,
        sessionId,
        eventId,
        kind,
        expectedEntry: expected,
        replacementEntry: replacement,
      });
      if (!pin.ok) {
        throw new TranscriptMutationError(
          pin.error || "Command guard identity PIN is required.",
          pin.statusCode ?? 403,
          pin.code ?? "pin_rejected",
          { pinConfigured: pin.pinConfigured },
          pin.retryAt,
        );
      }
      this.assertMutationGates(sessionId);
      if (!await this.dependencies.disposeIdleRuntime(sessionId)) {
        throw new TranscriptMutationError("Session runtime is not idle", 409, "runtime_busy");
      }
      this.assertMutationGates(sessionId, true);

      const currentSession = this.dependencies.getSession(sessionId);
      if (!currentSession || currentSession.pi_session_file !== session.pi_session_file) {
        throw new TranscriptMutationError("Session transcript changed before mutation", 409, "session_conflict");
      }
      const transcript = this.dependencies.openTranscript(currentSession);
      mutatedSessionFile = currentSession.pi_session_file;
      const entries = transcript.getEntries().map((entry) => asEntry(entry, "canonical_entry", { knownType: false }));
      const current = entries.find((entry) => entry.id === eventId);
      if (!current || !isDeepStrictEqual(current, expected)) {
        throw new TranscriptMutationError("Transcript event changed before mutation", 409, "cas_conflict");
      }
      const entryIds = new Set(entries.map((entry) => entry.id));
      if (entryIds.size !== entries.length) throw new TranscriptMutationError("Transcript contains duplicate event ids", 409, "invalid_topology");
      const derived = contentBearingDerivedEntries(entries, eventId);

      // Search is purged before the first canonical rewrite. If any later step
      // fails, stale removed text remains unavailable rather than being served.
      await this.dependencies.purgeSearch(sessionId);
      searchFenced = true;
      // purgeSearch may yield to the event loop. Recheck every in-process gate
      // once more, then perform the synchronous Pi CAS without another await.
      this.assertMutationGates(sessionId, true);

      const replacements: CanonicalEntryReplacement[] = [
        { expectedEntry: expected, replacementEntry: replacement },
        ...derived.map((entry) => ({
          expectedEntry: entry,
          replacementEntry: tombstone(entry, INVALIDATED_DERIVED_EVENT_TOMBSTONE),
        })),
      ];
      transcript.replaceEntriesIfCurrent(replacements);
      canonicalChanged = true;

      this.dependencies.invalidateSnapshots(currentSession.pi_session_file);
      await this.dependencies.reconcileMetadata(sessionId);
      this.dependencies.releaseSearchFence(sessionId);
      searchFenced = false;
      await this.dependencies.forceReindex(sessionId);
      canonicalChanged = false;

      return {
        mutation_id: randomUUID(),
        session_id: sessionId,
        event_id: eventId,
        mutation: kind,
        replacement: structuredClone(replacement),
        invalidated_entry_ids: derived.map((entry) => entry.id),
        semantic_warnings: [
          ...semanticWarnings(expected),
          ...(derived.length > 0 ? [
            "All compaction and branch-summary events were invalidated because their exact source dependencies are not represented in Pi topology.",
          ] : []),
        ],
        revision_retained: false,
      };
    } catch (error) {
      // The Pi operation is one atomic replacement-set CAS. A post-commit
      // adapter verification failure may still mean the canonical rewrite won;
      // reconcile that winner without retaining or rolling back old content.
      if ((error as { canonicalMayHaveChanged?: unknown })?.canonicalMayHaveChanged === true) {
        canonicalChanged = true;
      }
      const shouldReindexWinner = searchFenced;
      if (canonicalChanged) {
        try { this.dependencies.invalidateSnapshots(mutatedSessionFile); } catch { /* best-effort safety cleanup */ }
        try { await this.dependencies.reconcileMetadata(sessionId); } catch { /* original mutation error remains authoritative */ }
      }
      if (searchFenced) {
        try { this.dependencies.releaseSearchFence(sessionId); } catch { /* released again in finally */ }
        searchFenced = false;
      }
      if (shouldReindexWinner) {
        try { await this.dependencies.forceReindex(sessionId); } catch { /* stale index was already purged */ }
      }
      throw error;
    } finally {
      if (searchFenced) this.dependencies.releaseSearchFence(sessionId);
      this.dependencies.releaseRuntimeLock(sessionId);
    }
  }

  private assertMutationGates(sessionId: string, requireStopped = false): void {
    if (this.dependencies.isMessagingBound(sessionId)) {
      throw new TranscriptMutationError("Actively messaging-bound sessions cannot be mutated", 409, "messaging_bound");
    }
    if (this.dependencies.hasPendingSessionMutation(sessionId)) {
      throw new TranscriptMutationError("Session assignment mutation is in progress", 409, "session_conflict");
    }
    if (this.dependencies.hasDurableHumanGate(sessionId)) {
      throw new TranscriptMutationError("Resolve or cancel pending human input before mutating this session", 409, "human_gate_open");
    }
    const runtime = this.dependencies.inspectRuntime(sessionId);
    if (runtime.streaming || runtime.compacting || runtime.queued) {
      throw new TranscriptMutationError("Streaming, compacting, or queued sessions cannot be mutated", 409, "runtime_busy");
    }
    if (runtime.humanGate) {
      throw new TranscriptMutationError("Close the active human approval or browser handoff before mutation", 409, "human_gate_open");
    }
    if (runtime.runtime_status === "starting" || (requireStopped && runtime.runtime_status !== "stopped")) {
      throw new TranscriptMutationError("Session runtime must be fully stopped before mutation", 409, "runtime_busy");
    }
  }
}
