import type { ArtifactCatalogChangedMessage } from "@wayang/protocol";

export type ArtifactCatalogEvent = Omit<ArtifactCatalogChangedMessage, "type" | "selection_id">;

type Listener = (event: ArtifactCatalogEvent) => void;
const listeners = new Set<Listener>();

/** Post-commit notification failures are isolated from durable registry state. */
export function emitArtifactCatalogChanged(event: ArtifactCatalogEvent): void {
  const frozen = Object.freeze({ ...event });
  for (const listener of [...listeners]) {
    try { listener(frozen); }
    catch { console.warn("[artifacts] catalog listener failed after commit"); }
  }
}

export function onArtifactCatalogChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
