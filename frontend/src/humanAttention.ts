export interface HumanAttention {
  sessionId: string;
  kind: "question";
  sourceId: string;
  createdAt: number;
  status: "pending";
  requiresWayang: true;
}

const MAX_SOURCE_ID_UTF8_BYTES = 512;
const unsafeSourceIdCharacters = /[\p{Cc}\p{Cf}]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isValidSourceId(value: unknown): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value !== value.normalize("NFC")
    || unsafeSourceIdCharacters.test(value)) {
    return false;
  }
  return new TextEncoder().encode(value).byteLength <= MAX_SOURCE_ID_UTF8_BYTES;
}

/**
 * Current backend authority projects only unresolved Wayang interview
 * questions. Keep this strict adapter localized so later gate kinds require an
 * explicit frontend/backend contract change rather than being inferred here.
 */
export function normalizeHumanAttention(value: unknown, parentSessionId: string): HumanAttention[] {
  if (!Array.isArray(value)) return [];

  const sourceIds = new Set<string>();
  const normalized: HumanAttention[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)
      || candidate.sessionId !== parentSessionId
      || candidate.kind !== "question"
      || !isValidSourceId(candidate.sourceId)
      || typeof candidate.createdAt !== "number"
      || !Number.isSafeInteger(candidate.createdAt)
      || candidate.createdAt < 0
      || candidate.status !== "pending"
      || candidate.requiresWayang !== true
      || sourceIds.has(candidate.sourceId)) {
      continue;
    }
    sourceIds.add(candidate.sourceId);
    normalized.push({
      sessionId: candidate.sessionId,
      kind: "question",
      sourceId: candidate.sourceId,
      createdAt: candidate.createdAt,
      status: "pending",
      requiresWayang: true,
    });
  }
  return normalized;
}

export function humanAttentionAriaLabel(attention: HumanAttention[]): string {
  return `Needs human input: ${attention.length} pending ${attention.length === 1 ? "question" : "questions"}`;
}
