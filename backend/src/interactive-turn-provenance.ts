import { createHash, randomUUID } from "node:crypto";

export const WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE = "wayang-interactive-turn-source.v1";
export const MAX_INTERACTIVE_TURN_RAW_TEXT_CODE_POINTS = 4_096;

export interface BrowserTurnProvenance {
  readonly token: string;
  readonly acceptedAt: number;
  readonly clientMessageId: string;
  readonly contentSha256: string;
  readonly rawUserText: string;
  readonly provisionalTitleText: string;
  readonly provisionalTitleAccepted: boolean;
  readonly settlementReady: boolean;
  readonly sourceMarkerEligible: boolean;
  readonly sourceKind: "browser_send_message";
  readonly piUserEntryId: string | null;
  readonly sourceSessionId: string;
  readonly runtimeGeneration: string;
  readonly agentProfileId: string;
  readonly projectId: string;
  readonly projectCwd: string;
  readonly provider: string;
  readonly model: string;
  /** Process-local resolution boundary; never persisted or accepted from callers. */
  readonly acceptedEntryCount: number;
}

export interface BrowserTurnBinding {
  readonly sourceSessionId: string;
  readonly runtimeGeneration: string;
  readonly agentProfileId: string;
  readonly projectId: string;
  readonly projectCwd: string;
  readonly provider: string;
  readonly model: string;
  readonly acceptedEntryCount: number;
}

export interface WayangInteractiveTurnSourceV1 {
  user_entry_id: string;
  raw_user_text: string;
  accepted_at: number;
  client_message_id: string;
}

export function browserTurnContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("invalid Unicode code-point bound");
  return Array.from(value).slice(0, maximum).join("");
}

function validClientMessageId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

export function issueBrowserTurnProvenance(
  binding: BrowserTurnBinding,
  content: string,
  acceptedAt = Date.now(),
  options: {
    rawUserText?: string;
    provisionalTitleText?: string;
    clientMessageId?: string;
    sourceMarkerEligible?: boolean;
  } = {},
): BrowserTurnProvenance {
  if (!Number.isSafeInteger(binding.acceptedEntryCount) || binding.acceptedEntryCount < 0) {
    throw new Error("invalid Pi transcript entry boundary");
  }
  if (!Number.isFinite(acceptedAt) || acceptedAt < 0) throw new Error("invalid browser acceptance timestamp");
  const token = randomUUID();
  const clientMessageId = options.clientMessageId ?? token;
  if (!validClientMessageId(clientMessageId)) throw new Error("invalid browser client message ID");
  return Object.freeze({
    token,
    acceptedAt,
    clientMessageId,
    contentSha256: browserTurnContentHash(content),
    rawUserText: truncateUnicodeCodePoints(options.rawUserText ?? content, MAX_INTERACTIVE_TURN_RAW_TEXT_CODE_POINTS),
    provisionalTitleText: options.provisionalTitleText ?? options.rawUserText ?? content,
    provisionalTitleAccepted: false,
    settlementReady: false,
    sourceMarkerEligible: options.sourceMarkerEligible ?? true,
    sourceKind: "browser_send_message" as const,
    piUserEntryId: null,
    ...binding,
  });
}

function piUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const pieces: string[] = [];
  for (const item of content) {
    if (typeof item === "string") pieces.push(item);
    else if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
      pieces.push((item as Record<string, unknown>).text as string);
    }
  }
  return pieces.join("");
}

function matchingUserEntry(
  provenance: BrowserTurnProvenance,
  candidate: any,
  currentBranchEntryIds?: ReadonlySet<string>,
): boolean {
  if (candidate?.type !== "message" || candidate?.message?.role !== "user" || typeof candidate.id !== "string") return false;
  if (currentBranchEntryIds && !currentBranchEntryIds.has(candidate.id)) return false;
  const text = piUserText(candidate.message.content);
  return text !== null && browserTurnContentHash(text) === provenance.contentSha256;
}

/** Resolve only a newly persisted user entry on the current Pi branch. */
export function resolveBrowserTurnPiUserEntry(
  provenance: BrowserTurnProvenance,
  entries: readonly unknown[],
  currentBranchEntryIds?: ReadonlySet<string>,
): BrowserTurnProvenance | null {
  if (provenance.piUserEntryId) {
    const entry = entries.find((candidate: any) => candidate?.id === provenance.piUserEntryId);
    return matchingUserEntry(provenance, entry, currentBranchEntryIds) ? provenance : null;
  }

  const candidates = entries.slice(provenance.acceptedEntryCount).filter((candidate) => (
    matchingUserEntry(provenance, candidate, currentBranchEntryIds)
  )) as any[];
  if (candidates.length !== 1) return null;
  return Object.freeze({ ...provenance, piUserEntryId: candidates[0].id });
}

/**
 * Resolve an insertion-ordered browser ledger against Pi's insertion-ordered
 * user entries. Already-bound IDs are reserved first. This preserves distinct
 * queued turns, including repeated text accepted at the same transcript edge.
 */
export function resolveBrowserTurnLedger(
  ledger: ReadonlyMap<string, BrowserTurnProvenance>,
  entries: readonly unknown[],
  currentBranchEntryIds?: ReadonlySet<string>,
): Map<string, BrowserTurnProvenance> {
  const resolved = new Map<string, BrowserTurnProvenance>();
  const assigned = new Set<string>();
  for (const [token, provenance] of ledger) {
    if (!provenance.piUserEntryId) continue;
    const checked = resolveBrowserTurnPiUserEntry(provenance, entries, currentBranchEntryIds);
    if (checked) {
      resolved.set(token, checked);
      assigned.add(checked.piUserEntryId!);
    }
  }
  for (const [token, provenance] of ledger) {
    if (provenance.piUserEntryId) continue;
    const candidate = entries.slice(provenance.acceptedEntryCount).find((entry: any) => (
      !assigned.has(entry?.id) && matchingUserEntry(provenance, entry, currentBranchEntryIds)
    )) as any;
    if (!candidate) continue;
    const bound = Object.freeze({ ...provenance, piUserEntryId: candidate.id });
    resolved.set(token, bound);
    assigned.add(candidate.id);
  }
  return resolved;
}

export function isWayangInteractiveTurnSourceV1(value: unknown): value is WayangInteractiveTurnSourceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Partial<WayangInteractiveTurnSourceV1>;
  return Object.keys(details).sort().join(",") === "accepted_at,client_message_id,raw_user_text,user_entry_id"
    && typeof details.user_entry_id === "string" && details.user_entry_id.length > 0
    && typeof details.raw_user_text === "string" && details.raw_user_text.trim().length > 0
    && Array.from(details.raw_user_text).length <= MAX_INTERACTIVE_TURN_RAW_TEXT_CODE_POINTS
    && typeof details.accepted_at === "number" && Number.isFinite(details.accepted_at) && details.accepted_at >= 0
    && typeof details.client_message_id === "string" && validClientMessageId(details.client_message_id);
}

export function wayangInteractiveTurnSourceFromEntry(entry: unknown): WayangInteractiveTurnSourceV1 | null {
  if (!entry || typeof entry !== "object") return null;
  const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
  return candidate.type === "custom"
    && candidate.customType === WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE
    && isWayangInteractiveTurnSourceV1(candidate.data)
    ? candidate.data
    : null;
}

/** Blank or attachment-only browser turns deliberately produce no eligible marker. */
export function interactiveTurnSourceDetails(
  provenance: BrowserTurnProvenance,
): WayangInteractiveTurnSourceV1 | null {
  if (!provenance.sourceMarkerEligible || !provenance.piUserEntryId || !provenance.rawUserText.trim()) return null;
  return Object.freeze({
    user_entry_id: provenance.piUserEntryId,
    raw_user_text: provenance.rawUserText,
    accepted_at: provenance.acceptedAt,
    client_message_id: provenance.clientMessageId,
  });
}
