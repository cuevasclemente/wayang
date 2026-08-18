export const DELETED_EVENT_TOMBSTONE = "wayang-deleted-event-v1";
export const INVALIDATED_DERIVED_EVENT_TOMBSTONE = "wayang-invalidated-derived-event-v1";

export interface TrustedEditedMutationMarker {
  version: 1;
  kind: "edited";
  at: string;
}

export function trustedEditedMutationMarker(value: unknown): TrustedEditedMutationMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).sort().join(",") !== "at,kind,version"
    || marker.version !== 1 || marker.kind !== "edited" || typeof marker.at !== "string") return null;
  const epoch = Date.parse(marker.at);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== marker.at) return null;
  return { version: 1, kind: "edited", at: marker.at };
}
