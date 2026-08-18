export type TranscriptMutationMarkerValue = "edited" | "deleted" | "partially modified" | null;

export interface TranscriptImmutableEnvelope {
  type: unknown;
  id: unknown;
  parentId?: unknown;
  timestamp?: unknown;
}

const TRANSCRIPT_ENVELOPE_FIELDS = new Set(["type", "id", "parentId", "timestamp"]);
const TRANSCRIPT_RESERVED_MUTATION_FIELDS = new Set(["wayangMutation", "wayang_mutation"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Deterministic test seam: reserved mutation metadata is never editable. */
export function editableTranscriptPayload(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (TRANSCRIPT_ENVELOPE_FIELDS.has(key) || TRANSCRIPT_RESERVED_MUTATION_FIELDS.has(key)) continue;
    payload[key] = value;
  }
  return payload;
}

/** Deterministic test seam used by edit requests; immutable envelope wins. */
export function reconstructTranscriptEntry(
  envelope: Readonly<TranscriptImmutableEnvelope>,
  editablePayload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const replacement = editableTranscriptPayload(editablePayload);
  return { ...replacement, ...envelope };
}

export function transcriptMutationMarker(message: unknown): TranscriptMutationMarkerValue {
  const event = record(message);
  const nested = record(event?.message);
  const status = event?.mutation_status ?? nested?.mutation_status;
  if (event?.deleted === true || nested?.deleted === true || status === "deleted") return "deleted";
  if (event?.edited === true || nested?.edited === true || status === "edited") return "edited";
  return null;
}
