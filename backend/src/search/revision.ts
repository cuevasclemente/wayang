/** Dependency-light publication witness contract. No store/policy/filesystem access. */
import type { Database } from "better-sqlite3";
import type { FileFingerprint } from "../session-metadata.js";

export const SEARCH_EXTRACTION_VERSION = "message-document-v1:text-only:128KiB";
export interface PublishedSearchSource {
  filePath: string | null;
  fingerprint: FileFingerprint | null;
  extractionVersion: string;
  transcriptEpoch: string | null;
}
export type PublishedSearchRevision =
  | { kind: "legacy"; generation: string | null }
  | { kind: "unpublished" }
  | ({ kind: "published"; generation: string } & PublishedSearchSource);

/** Stable body dirty key, independent of mutable title/goal/archive metadata. */
export function searchSourceRevisionKey(filePath: string | null, fingerprint: FileFingerprint | null): string {
  return JSON.stringify([filePath,fingerprint ? {ino:fingerprint.ino,size:fingerprint.size,
    mtimeMs:fingerprint.mtimeMs,ctimeMs:fingerprint.ctimeMs} : null,SEARCH_EXTRACTION_VERSION]);
}
export function encodePublishedSearchSource(source: PublishedSearchSource): string {
  return JSON.stringify({format:1,...source});
}

/**
 * Reads the witness bound to the publication pointer, NOT attempted/requested
 * work state. Caller must supply an already-open DB and freshly authorize the
 * exact target file independently. Legacy is explicitly unproven; deciding
 * whether to deny or retain legacy query visibility belongs to the query owner.
 * Compare again after any query yield; this helper does not pin a SQL snapshot.
 */
export function getPublishedSearchRevision(db: Database, sessionId: string): PublishedSearchRevision {
  const row = db.prepare("SELECT generation,valid,source_revision FROM search_publication WHERE session_id=?")
    .get(sessionId) as {generation:string;valid:number;source_revision:string|null} | undefined;
  if (!row) return {kind:"legacy",generation:null};
  if (row.valid !== 1) return {kind:"unpublished"};
  if (row.source_revision === null) return {kind:"legacy",generation:row.generation};
  try {
    const value = JSON.parse(row.source_revision);
    if (!value || value.format !== 1 || typeof value.extractionVersion !== "string" || !value.extractionVersion) return {kind:"unpublished"};
    if (value.filePath === null) {
      if (value.fingerprint !== null || value.transcriptEpoch !== null) return {kind:"unpublished"};
    } else {
      const f = value.fingerprint;
      if (typeof value.filePath !== "string" || !value.filePath || typeof value.transcriptEpoch !== "string" || !value.transcriptEpoch
        || !f || !Number.isSafeInteger(f.ino) || f.ino<0 || !Number.isSafeInteger(f.size) || f.size<0
        || !Number.isFinite(f.mtimeMs) || !Number.isFinite(f.ctimeMs)) return {kind:"unpublished"};
    }
    return {kind:"published",generation:row.generation,filePath:value.filePath,
      fingerprint:value.fingerprint === null ? null : {ino:value.fingerprint.ino,size:value.fingerprint.size,
        mtimeMs:value.fingerprint.mtimeMs,ctimeMs:value.fingerprint.ctimeMs},
      extractionVersion:value.extractionVersion,transcriptEpoch:value.transcriptEpoch};
  } catch { return {kind:"unpublished"}; }
}
