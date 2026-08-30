import type { ArtifactRenderer, ArtifactSource, SessionArtifact } from "@wayang/protocol";

export type ArtifactLocatorKind = "home_file" | "session_attachment";

export interface ArtifactCatalogRow {
  id: string;
  session_id: string;
  locator_kind: ArtifactLocatorKind;
  locator_path: string;
  display_name: string;
  title: string | null;
  description: string | null;
  source: ArtifactSource;
  source_event_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
  presented_at: number | null;
  row_revision: number;
}

export interface ArtifactRegistration {
  locatorKind: ArtifactLocatorKind;
  locatorPath: string;
  displayName: string;
  title?: string | null;
  description?: string | null;
  source: ArtifactSource;
  sourceEventId?: string | null;
}

export interface ArtifactFileClassification {
  renderer: ArtifactRenderer;
  language: string | null;
  previewAvailable: boolean;
  previewUnavailableReason: string | null;
  contentType: string | null;
}

export interface ArtifactProjectionResult {
  artifact: SessionArtifact;
  row: ArtifactCatalogRow;
}
