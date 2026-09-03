import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ArtifactTextPreviewResponse,
  SessionArtifact,
  SessionArtifactsResponse,
} from "@wayang/protocol";
import { getSessionAttachmentRoot } from "../protected-artifacts.js";
import {
  artifactDisplayPath,
  authorizeArtifactPath,
  authorizeArtifactSession,
  ArtifactAuthorizationError,
} from "./authorization.js";
import { emitArtifactCatalogChanged } from "./events.js";
import {
  closeOpenArtifact,
  openArtifactFile,
  PREVIEW_LIMITS,
  readOpenArtifact,
  type OpenArtifactFile,
} from "./file.js";
import {
  getArtifactCatalogRevision,
  getArtifactRow,
  listArtifactRows,
  upsertArtifacts,
} from "./registry.js";
import type { ArtifactCatalogRow, ArtifactLocatorKind, ArtifactRegistration } from "./types.js";

const UNSAFE_DISPLAY = /[\0\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u;

export interface PresentArtifactInput {
  path: string;
  title?: string;
  description?: string;
}

export interface UploadedArtifactInput {
  filePath: string;
  displayName: string;
  attachmentId: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeMetadata(value: unknown, label: string, maxBytes: number, optional = true): string | null {
  if (value === undefined || value === null) return optional ? null : "";
  if (typeof value !== "string") throw new ArtifactAuthorizationError(`${label} must be text`, 400, "invalid_artifact");
  const normalized = value.normalize("NFC").trim();
  if (!normalized && optional) return null;
  if (UNSAFE_DISPLAY.test(normalized)) throw new ArtifactAuthorizationError(`${label} contains unsafe display characters`, 400, "invalid_artifact");
  if (byteLength(normalized) > maxBytes) throw new ArtifactAuthorizationError(`${label} is too long`, 400, "invalid_artifact");
  return normalized;
}

function safeDisplayName(value: string): string {
  const normalized = normalizeMetadata(path.basename(value), "Artifact name", 255, false);
  return normalized || "artifact";
}

function locatorKindFor(sessionId: string, canonicalPath: string): ArtifactLocatorKind {
  try {
    const root = fs.realpathSync.native(getSessionAttachmentRoot(sessionId));
    return path.dirname(canonicalPath) === root ? "session_attachment" : "home_file";
  } catch {
    return "home_file";
  }
}

function emitCommittedRevisions(
  revisions: Map<string, number>,
  primarySessionId: string,
  reason: "presented" | "uploaded",
  focusArtifactId: string | null,
): void {
  for (const [sessionId, revision] of revisions) {
    emitArtifactCatalogChanged({
      session_id: sessionId,
      revision,
      reason: sessionId === primarySessionId ? reason : "removed",
      focus_artifact_id: sessionId === primarySessionId ? focusArtifactId : null,
    });
  }
}

export function presentArtifacts(
  sessionId: string,
  inputs: readonly PresentArtifactInput[],
  sourceEventId?: string,
): { id: string; name: string; title: string | null; description: string | null }[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 20) {
    throw new ArtifactAuthorizationError("present_artifact requires 1–20 artifacts", 400, "invalid_artifact");
  }
  const authorization = authorizeArtifactSession(sessionId, "present");
  const registrations: ArtifactRegistration[] = [];
  for (const input of inputs) {
    if (!input || typeof input !== "object" || typeof input.path !== "string" || !input.path.trim()) {
      throw new ArtifactAuthorizationError("Each artifact requires a path", 400, "invalid_artifact");
    }
    if (byteLength(input.path) > 4096) throw new ArtifactAuthorizationError("Artifact path is too long", 400, "invalid_artifact");
    const authorized = authorizeArtifactPath(authorization, input.path);
    registrations.push({
      locatorKind: locatorKindFor(sessionId, authorized.canonicalPath),
      locatorPath: authorized.canonicalPath,
      displayName: safeDisplayName(path.basename(authorized.canonicalPath)),
      title: normalizeMetadata(input.title, "Artifact title", 120),
      description: normalizeMetadata(input.description, "Artifact description", 1000),
      source: "presented",
      sourceEventId: normalizeMetadata(sourceEventId, "Source event id", 512),
    });
  }
  const committed = upsertArtifacts(sessionId, registrations);
  const firstId = committed.rows[0]?.id ?? null;
  emitCommittedRevisions(committed.revisions, sessionId, "presented", firstId);
  return committed.rows.map((row) => ({ id: row.id, name: row.display_name, title: row.title, description: row.description }));
}

export function registerUploadedArtifacts(sessionId: string, uploads: readonly UploadedArtifactInput[]): Array<{ attachmentId: string; artifactId: string }> {
  if (uploads.length === 0) return [];
  const authorization = authorizeArtifactSession(sessionId, "http");
  const registrations: ArtifactRegistration[] = uploads.map((upload) => {
    const authorized = authorizeArtifactPath(authorization, upload.filePath, "session_attachment");
    return {
      locatorKind: "session_attachment",
      locatorPath: authorized.canonicalPath,
      displayName: safeDisplayName(upload.displayName),
      title: null,
      description: null,
      source: "upload",
      sourceEventId: normalizeMetadata(upload.attachmentId, "Attachment id", 512),
    };
  });
  const committed = upsertArtifacts(sessionId, registrations);
  emitCommittedRevisions(committed.revisions, sessionId, "uploaded", null);
  return committed.rows.flatMap((row) => row.source_event_id
    ? [{ attachmentId: row.source_event_id, artifactId: row.id }]
    : []);
}

function unavailableArtifact(row: ArtifactCatalogRow): SessionArtifact {
  return {
    id: row.id,
    name: row.display_name,
    display_path: row.locator_kind === "session_attachment" ? row.display_name : row.display_name,
    title: row.title,
    description: row.description,
    source: row.source,
    renderer: "unsupported",
    language: null,
    size: null,
    modified_at: null,
    last_seen_at: row.last_seen_at,
    available: false,
    unavailable_reason: "policy_changed",
    preview_available: false,
    preview_unavailable_reason: "artifact_unavailable",
    download_available: false,
    download_unavailable_reason: "artifact_unavailable",
  };
}

function projectArtifact(sessionId: string, row: ArtifactCatalogRow): SessionArtifact {
  let opened: OpenArtifactFile | null = null;
  try {
    opened = openArtifactFile(sessionId, row);
    const classification = opened.classification;
    return {
      id: row.id,
      name: row.display_name,
      display_path: artifactDisplayPath(opened.authorization, opened.canonicalPath, row.locator_kind, row.display_name),
      title: row.title,
      description: row.description,
      source: row.source,
      renderer: classification.renderer,
      language: classification.language,
      size: opened.stat.size,
      modified_at: opened.stat.mtimeMs,
      last_seen_at: row.last_seen_at,
      available: true,
      unavailable_reason: null,
      preview_available: classification.previewAvailable,
      preview_unavailable_reason: classification.previewUnavailableReason,
      download_available: opened.stat.size <= PREVIEW_LIMITS.download,
      download_unavailable_reason: opened.stat.size <= PREVIEW_LIMITS.download ? null : "file_too_large",
    };
  } catch {
    return unavailableArtifact(row);
  } finally {
    if (opened) closeOpenArtifact(opened);
  }
}

export function listSessionArtifacts(sessionId: string): SessionArtifactsResponse {
  authorizeArtifactSession(sessionId, "http");
  const artifacts = listArtifactRows(sessionId).slice(0, 100).map((row) => projectArtifact(sessionId, row));
  const response: SessionArtifactsResponse = {
    session_id: sessionId,
    revision: getArtifactCatalogRevision(sessionId),
    artifacts,
  };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > 1024 * 1024) {
    throw new Error("Artifact catalog exceeded its response bound");
  }
  return response;
}

export function openSessionArtifact(sessionId: string, artifactId: string): OpenArtifactFile {
  authorizeArtifactSession(sessionId, "http");
  const row = getArtifactRow(sessionId, artifactId);
  if (!row) throw new ArtifactAuthorizationError("Artifact was not found", 404, "artifact_not_found");
  try { return openArtifactFile(sessionId, row); }
  catch { throw new ArtifactAuthorizationError("Artifact was not found", 404, "artifact_not_found"); }
}

export function readArtifactTextPreview(opened: OpenArtifactFile): ArtifactTextPreviewResponse {
  if (!opened.classification.previewAvailable
    || !["markdown", "text", "html"].includes(opened.classification.renderer)) {
    throw new ArtifactAuthorizationError("Artifact preview is unavailable", 422, "preview_unavailable");
  }
  const { bytes, sha256 } = readOpenArtifact(opened, PREVIEW_LIMITS.text);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ArtifactAuthorizationError("Artifact preview is unavailable", 422, "preview_unavailable"); }
  return {
    artifact_id: opened.row.id,
    renderer: opened.classification.renderer as "markdown" | "text" | "html",
    language: opened.classification.language,
    text,
    sha256,
  };
}
