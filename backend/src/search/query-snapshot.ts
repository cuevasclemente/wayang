/** Shared prepare/worker database attestation. No config, store, or filesystem imports. */
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { SearchQueryError } from "./query-parser.js";
import { QUERY_WORKER_BUDGETS } from "./query-worker-protocol.js";

/** Opaque digest only; never log digest inputs or return them to callers. */
export function boundedSnapshotDigest(values: Iterable<unknown>): string {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const value of values) {
    const json = JSON.stringify(value) ?? "null";
    bytes += Buffer.byteLength(json, "utf8") + 1;
    if (bytes > QUERY_WORKER_BUDGETS.snapshotBytes) throw new SearchQueryError("search_request_too_large");
    hash.update(json).update("\n");
  }
  return hash.digest("hex");
}

/**
 * Caller-owned connection; the worker invokes this INSIDE the same read
 * transaction as MATCH. Includes missing metadata/publication rows and legacy
 * metadata content, not only rows producing hits. Published body content is
 * immutable under its generation/source witness and is not copied here.
 * Unpublished FTS statistics are deliberately not an authorization witness.
 */
export function queryDatabaseSnapshot(db: Database, allowedIds: readonly string[]): string {
  if (allowedIds.length > QUERY_WORKER_BUDGETS.authorizedSessions) throw new SearchQueryError("search_request_too_large");
  const ids = JSON.stringify([...allowedIds].sort());
  const publication = db.prepare(`SELECT a.value AS session_id,
    p.generation, p.valid, p.source_revision,
    m.session_id AS metadata_present, m.cwd, m.title, m.goal, m.model, m.provider,
    m.created_at, m.last_active, m.archived, m.has_error, m.revision
    FROM json_each(?) a LEFT JOIN search_publication p ON p.session_id=a.value
    LEFT JOIN search_session_metadata m ON m.session_id=a.value
    ORDER BY a.value COLLATE BINARY`).iterate(ids);
  const metadata = db.prepare(`SELECT id, session_id, cwd, title, goal, model,
    last_active, archived, has_error, text, generation
    FROM search_chunks_current WHERE role='meta'
      AND session_id IN (SELECT value FROM json_each(?))
    ORDER BY session_id COLLATE BINARY, id`).iterate(ids);
  return boundedSnapshotDigest((function* () {
    yield ["query-database-snapshot-v1", [...allowedIds].sort()];
    yield* publication;
    yield "metadata-documents";
    yield* metadata;
  })());
}
