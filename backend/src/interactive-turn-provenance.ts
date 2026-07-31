import { createHash, randomUUID } from "node:crypto";

export interface BrowserTurnProvenance {
  readonly token: string;
  readonly acceptedAt: number;
  readonly contentSha256: string;
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

export function browserTurnContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function issueBrowserTurnProvenance(
  binding: BrowserTurnBinding,
  content: string,
  acceptedAt = Date.now(),
): BrowserTurnProvenance {
  if (!Number.isSafeInteger(binding.acceptedEntryCount) || binding.acceptedEntryCount < 0) {
    throw new Error("invalid Pi transcript entry boundary");
  }
  return Object.freeze({
    token: randomUUID(),
    acceptedAt,
    contentSha256: browserTurnContentHash(content),
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

/** Resolve only a newly persisted user entry on the current Pi branch. */
export function resolveBrowserTurnPiUserEntry(
  provenance: BrowserTurnProvenance,
  entries: readonly unknown[],
  currentBranchEntryIds?: ReadonlySet<string>,
): BrowserTurnProvenance | null {
  if (provenance.piUserEntryId) {
    const entry = entries.find((candidate: any) => candidate?.id === provenance.piUserEntryId) as any;
    const text = entry?.type === "message" && entry?.message?.role === "user" ? piUserText(entry.message.content) : null;
    if (text === null || browserTurnContentHash(text) !== provenance.contentSha256) return null;
    if (currentBranchEntryIds && !currentBranchEntryIds.has(provenance.piUserEntryId)) return null;
    return provenance;
  }

  const candidates = entries.slice(provenance.acceptedEntryCount).filter((candidate: any) => {
    if (candidate?.type !== "message" || candidate?.message?.role !== "user" || typeof candidate.id !== "string") return false;
    if (currentBranchEntryIds && !currentBranchEntryIds.has(candidate.id)) return false;
    const text = piUserText(candidate.message.content);
    return text !== null && browserTurnContentHash(text) === provenance.contentSha256;
  }) as any[];
  if (candidates.length !== 1) return null;
  return Object.freeze({ ...provenance, piUserEntryId: candidates[0].id });
}
