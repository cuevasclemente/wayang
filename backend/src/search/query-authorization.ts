/** Dependency-light query BODY gate. Metadata authorization remains independent. */
import type { Database } from "better-sqlite3";
import type { FileFingerprint } from "../session-metadata.js";
import type { SessionIndexAuthorization } from "./policy-filter.js";
import type { PublishedSearchRevision } from "./revision.js";

export interface SearchBodyAuthorization {
  sessionId: string;
  generation: string;
  transcriptEpoch: string;
}

export interface SearchQueryAuthorization {
  metadataSessionIds: string[];
  bodies: SearchBodyAuthorization[];
  /** Internal authorized IDs only. Status may reclassify these; never emit IDs publicly. */
  rejectedBodySessionIds: string[];
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * The caller obtains all observations synchronously from exact authorization.
 * No yield is allowed between this comparison and queryKeywordSessions. SQL
 * additionally binds each body hit to this exact generation AND transcript epoch.
 * A valid owner/header TODAY is not authorization to reveal YESTERDAY's body.
 */
export function authorizeSearchQueryBodies(
  authorizations: readonly SessionIndexAuthorization[],
  readPublishedRevision: (sessionId: string) => PublishedSearchRevision,
  supportedExtractionVersion: string,
  visibleBodySessionIds: ReadonlySet<string>,
): SearchQueryAuthorization {
  const result: SearchQueryAuthorization = { metadataSessionIds: [], bodies: [], rejectedBodySessionIds: [] };
  for (const { session, transcript } of authorizations) {
    result.metadataSessionIds.push(session.id);
    const revision = readPublishedRevision(session.id);
    if (transcript && session.pi_session_file === transcript.path && revision.kind === "published"
      && revision.filePath === transcript.path && revision.fingerprint
      && revision.extractionVersion === supportedExtractionVersion
      && revision.transcriptEpoch && sameFingerprint(revision.fingerprint, transcript.fingerprint)) {
      result.bodies.push({ sessionId: session.id, generation: revision.generation, transcriptEpoch: revision.transcriptEpoch });
    } else if (visibleBodySessionIds.has(session.id)) {
      // Includes stale/legacy body left behind after detaching the transcript.
      // A genuinely metadata-only session with no old body is not a rejection.
      result.rejectedBodySessionIds.push(session.id);
    }
  }
  return result;
}

/** Content-free inventory solely to report actual hidden body coverage. */
export function getVisibleBodySessionIds(db: Database, allowedIds: readonly string[]): Set<string> {
  if (!allowedIds.length) return new Set();
  const rows = db.prepare(`SELECT DISTINCT session_id FROM search_chunks_current
    WHERE role IN ('user', 'assistant') AND active_branch = 1
      AND session_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(allowedIds)) as Array<{ session_id: string }>;
  return new Set(rows.map(row => row.session_id));
}
