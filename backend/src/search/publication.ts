import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import type { Database } from "better-sqlite3";
import type { SessionRow } from "../db.js";
import type { Chunk } from "./types.js";
import { SEARCH_MAX_DOCUMENT_BYTES, SEARCH_MAX_GENERATION_BYTES } from "./extraction.js";

export const SEARCH_STAGE_MAX_ROWS = 16;
export const SEARCH_STAGE_MAX_BYTES = 128 * 1024;
export const SEARCH_GLOBAL_STAGING_BYTES = 64 * 1024 * 1024;
export const SEARCH_WAL_PAUSE_BYTES = 64 * 1024 * 1024;
export type SearchOutcome = "queued" | "running" | "current" | "metadata_only" | "partial" | "unsupported" | "failed" | "stale";
const metrics = { stageTransactions: 0, maxStageMs: 0, slowStageTransactions: 0, cleanupRows: 0, cleanupCandidates: 0, maxCleanupMs: 0, maxPublishMs: 0, walBytes: 0, walPressurePauses: 0, stageBytes: 0 };
const cleanupCursors = new WeakMap<Database, Map<string, number>>();
const generationCleanupCursors = new WeakMap<Database, string>();
export function getSearchPublicationMetrics() { return { ...metrics }; }
export function yieldSearchTurn(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

function assertWalAdmission(db: Database): void {
  let bytes = 0;
  if (db.name !== ":memory:") {
    try { bytes = fs.statSync(`${db.name}-wal`).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("wal_observation_failed"); }
  }
  metrics.walBytes = bytes;
  // Admission watermark, not a hard filesystem quota: a single bounded FTS
  // transaction can overshoot, and denial/cleanup/state writes remain allowed.
  if (bytes >= SEARCH_WAL_PAUSE_BYTES) { metrics.walPressurePauses++; throw new Error("wal_pressure"); }
}

export function invalidatePublication(db: Database, sessionId: string): void {
  // Denial is O(1); physical FTS/vector cleanup happens in bounded slices.
  db.prepare(`INSERT INTO search_publication(session_id,generation,valid) VALUES(?,'denied',0)
    ON CONFLICT(session_id) DO UPDATE SET valid=0`).run(sessionId);
}
export function beginGeneration(db: Database, sessionId: string): string {
  assertWalAdmission(db);
  const bytes = db.prepare(`SELECT COALESCE(SUM(g.text_bytes),0) AS n FROM search_generations g
    LEFT JOIN search_publication p ON p.session_id=g.session_id AND p.generation=g.generation AND p.valid=1
    WHERE p.session_id IS NULL`).get() as { n: number };
  if (bytes.n + SEARCH_MAX_GENERATION_BYTES > SEARCH_GLOBAL_STAGING_BYTES) throw new Error("staging_capacity");
  const generation = randomUUID();
  db.prepare("INSERT INTO search_generations(generation,session_id,created_at,active) VALUES(?,?,?,1)").run(generation, sessionId, Date.now());
  return generation;
}
export function stageDocuments(db: Database, sessionId: string, generation: string, epoch: string, chunks: Chunk[]): void {
  const bytes = chunks.reduce((sum, c) => sum + Buffer.byteLength(c.text), 0);
  if (!chunks.length || chunks.length > SEARCH_STAGE_MAX_ROWS || bytes > SEARCH_STAGE_MAX_BYTES
    || chunks.some((c) => Buffer.byteLength(c.text) > SEARCH_MAX_DOCUMENT_BYTES)) throw new Error("stage_batch_limit");
  const started = performance.now();
  assertWalAdmission(db);
  db.transaction(() => {
    const generationRow = db.prepare("SELECT text_bytes FROM search_generations WHERE generation=? AND session_id=?")
      .get(generation, sessionId) as { text_bytes: number } | undefined;
    if (!generationRow || generationRow.text_bytes + bytes > SEARCH_MAX_GENERATION_BYTES) throw new Error("generation_capacity");
    const insert = db.prepare(`INSERT INTO chunks(session_id,cwd,title,created_at,last_active,chunk_index,role,text,
      message_id,source_offset,transcript_epoch,active_branch,generation) VALUES(?,'','',0,0,?,?,?,?,?,?,1,?)`);
    for (const c of chunks) insert.run(sessionId,c.chunkIndex,c.role,c.text,c.messageId ?? null,c.sourceOffset ?? null,epoch,generation);
    db.prepare("UPDATE search_generations SET text_bytes=text_bytes+? WHERE generation=?").run(bytes,generation);
  })();
  const elapsed = performance.now() - started;
  metrics.stageTransactions++;
  metrics.stageBytes += bytes;
  metrics.maxStageMs = Math.max(metrics.maxStageMs, elapsed);
  if (elapsed > 25) metrics.slowStageTransactions++;
}

export function metadataRevision(row: SessionRow): string {
  return JSON.stringify([row.title,row.goal,row.cwd,row.model,row.provider,row.created_at,row.last_active,row.archived,Boolean(row.error)]);
}
export function publishMetadata(db: Database, row: SessionRow): void {
  const revision = metadataRevision(row);
  const old = db.prepare("SELECT revision FROM search_session_metadata WHERE session_id=?").get(row.id) as { revision: string } | undefined;
  if (old?.revision === revision) return;
  assertWalAdmission(db);
  const text = [row.title,row.goal,`cwd: ${row.cwd}`,row.model ? `model: ${row.model}` : ""].filter(Boolean).join("\n\n");
  if (Buffer.byteLength(text) > SEARCH_MAX_DOCUMENT_BYTES) throw new Error("metadata_unsupported");
  db.prepare(`INSERT INTO search_session_metadata VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd,title=excluded.title,goal=excluded.goal,
    model=excluded.model,provider=excluded.provider,created_at=excluded.created_at,last_active=excluded.last_active,
    archived=excluded.archived,has_error=excluded.has_error,revision=excluded.revision`).run(
      row.id,row.cwd,row.title || "(untitled)",row.goal,row.model,row.provider,row.created_at,row.last_active,
      row.archived ? 1 : 0,row.error ? 1 : 0,revision);
  const existing = db.prepare("SELECT id,text FROM chunks WHERE session_id=? AND generation='metadata' LIMIT 1")
    .get(row.id) as { id: number; text: string } | undefined;
  // Archive/last-active/model projection updates never rewrite body rows. Recency
  // alone also leaves the metadata FTS document untouched.
  if (existing?.text === text) return;
  if (existing) db.prepare("UPDATE chunks SET text=? WHERE id=?").run(text,existing.id);
  else db.prepare(`INSERT INTO chunks(session_id,cwd,title,created_at,last_active,chunk_index,role,text,generation)
    VALUES(?,'','',0,0,-1,'meta',?,'metadata')`).run(row.id,text);
}

export function publishGeneration(db: Database, row: SessionRow, generation: string, commitState: () => void): void {
  const start = performance.now();
  db.transaction(() => {
    db.prepare(`INSERT INTO search_publication(session_id,generation,valid) VALUES(?,?,1)
      ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,valid=1`).run(row.id,generation);
    commitState();
  })();
  metrics.maxPublishMs = Math.max(metrics.maxPublishMs,performance.now()-start);
}

/** At most 16 rows and 128 KiB of known text per transaction; never in the flip.
 * A legacy over-limit row is deleted alone to guarantee eventual reclamation.
 */
export async function cleanupSearchChunks(db: Database, options: { sessionId?: string; maxBatches?: number } = {}): Promise<number> {
  let removed = 0;
  let cursors = cleanupCursors.get(db);
  if (!cursors) { cursors = new Map(); cleanupCursors.set(db,cursors); }
  const cursorKey = options.sessionId ?? "";
  let cursor = cursors.get(cursorKey) ?? 0;
  for (let batch = 0; batch < (options.maxBatches ?? 4); batch++) {
    // Bound the candidate scan BEFORE visibility filtering; LIMIT on matching
    // garbage alone can still walk every published row in a healthy corpus.
    const candidates = db.prepare(`WITH candidates AS MATERIALIZED (
      SELECT id,session_id,generation FROM chunks WHERE id>? ${options.sessionId ? "AND session_id=?" : ""}
      ORDER BY id LIMIT 64)
      SELECT c.id, CASE WHEN (p.valid=0 OR (p.valid=1 AND c.generation NOT IN (p.generation,'metadata'))
        OR (p.session_id IS NULL AND c.generation NOT IN ('legacy','metadata')))
        AND COALESCE(g.active,0)=0 THEN 1 ELSE 0 END AS garbage
      FROM candidates c LEFT JOIN search_publication p ON p.session_id=c.session_id
      LEFT JOIN search_generations g ON g.generation=c.generation ORDER BY c.id`)
      .all(cursor,...(options.sessionId ? [options.sessionId] : [])) as Array<{id:number;garbage:number}>;
    metrics.cleanupCandidates += candidates.length;
    if (!candidates.length) { cursor = 0; break; }
    const rows: Array<{id:number;bytes:number}> = [];
    for (const candidate of candidates) {
      cursor = candidate.id;
      if (candidate.garbage) {
        const cost = db.prepare("SELECT length(CAST(text AS BLOB)) AS bytes FROM chunks WHERE id=?").get(candidate.id) as {bytes:number};
        rows.push({id:candidate.id,bytes:cost.bytes});
        if (rows.length >= SEARCH_STAGE_MAX_ROWS) break;
      }
    }
    let bytes = 0;
    const ids: number[] = [];
    for (const row of rows) {
      if (ids.length && bytes + row.bytes > SEARCH_STAGE_MAX_BYTES) { cursor = ids.at(-1)!; break; }
      ids.push(row.id); bytes += row.bytes;
    }
    const start = performance.now();
    db.transaction(() => {
      const remove = db.prepare("DELETE FROM chunks WHERE id=?");
      for (const id of ids) remove.run(id);
    })();
    metrics.maxCleanupMs = Math.max(metrics.maxCleanupMs, performance.now()-start);
    metrics.cleanupRows += ids.length;
    removed += ids.length;
    await yieldSearchTurn();
  }
  if (cursor) cursors.set(cursorKey,cursor); else cursors.delete(cursorKey);
  // Candidate-bounded bookkeeping too. An active empty generation belongs to
  // a worker awaiting its first source/batch and must never be reclaimed.
  const generationRows = db.prepare("SELECT generation,session_id,active FROM search_generations WHERE generation>? ORDER BY generation LIMIT 64")
    .all(generationCleanupCursors.get(db) ?? "") as Array<{generation:string;session_id:string;active:number}>;
  for (const row of generationRows) {
    if (!row.active) db.prepare(`DELETE FROM search_generations WHERE generation=? AND NOT EXISTS
      (SELECT 1 FROM chunks WHERE session_id=? AND generation=?)`).run(row.generation,row.session_id,row.generation);
  }
  generationCleanupCursors.set(db,generationRows.at(-1)?.generation ?? "");
  return removed;
}

export function recordSearchQueued(db: Database, sessionId: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO search_work_state(session_id,requested_revision,outcome,updated_at,dirty_since,queued_at)
    VALUES(?,'queued','queued',?,?,?) ON CONFLICT(session_id) DO UPDATE SET
    requested_revision='queued',queued_at=CASE WHEN queued_at>0 THEN queued_at ELSE excluded.queued_at END,
    dirty_since=CASE WHEN dirty_since>0 THEN dirty_since ELSE excluded.dirty_since END`).run(sessionId,now,now,now);
}

export function recordSearchOutcome(db: Database, sessionId: string, revision: string | null, outcome: SearchOutcome,
  errorCode: string | null = null, bytes = 0): void {
  const successful = outcome === "current" || outcome === "metadata_only";
  const attempted = outcome !== "queued";
  const prior = db.prepare("SELECT attempts,attempted_revision FROM search_work_state WHERE session_id=?").get(sessionId) as
    {attempts:number;attempted_revision:string|null} | undefined;
  const priorAttempts = prior?.attempted_revision === revision ? prior.attempts : 0;
  const attempts = outcome === "failed" ? priorAttempts + 1 : successful ? 0 : priorAttempts;
  const retryAt = outcome === "failed" ? Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 6)) : 0;
  db.prepare(`INSERT INTO search_work_state(session_id,requested_revision,attempted_revision,successful_revision,
    outcome,attempts,retry_at,updated_at,error_code,chunk_bytes,dirty_since,queued_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(session_id) DO UPDATE SET
    requested_revision=COALESCE(excluded.requested_revision,requested_revision),
    attempted_revision=CASE WHEN ? THEN excluded.attempted_revision ELSE attempted_revision END,
    successful_revision=CASE WHEN ? THEN excluded.successful_revision ELSE successful_revision END,
    outcome=excluded.outcome,attempts=excluded.attempts,retry_at=excluded.retry_at,
    updated_at=excluded.updated_at,error_code=excluded.error_code,chunk_bytes=excluded.chunk_bytes,queued_at=0,
    dirty_since=CASE WHEN ? THEN 0 WHEN dirty_since>0 THEN dirty_since ELSE excluded.dirty_since END`).run(
    sessionId,revision,attempted ? revision : null,successful ? revision : null,outcome,attempts,retryAt,Date.now(),errorCode,bytes,
    successful ? 0 : Date.now(),attempted ? 1 : 0,successful ? 1 : 0,successful ? 1 : 0);
}

/** Caller supplies its existing authorization set; this API never walks catalog policy or files. */
export function getIndexCoverageSnapshot(db: Database, allowedIds: ReadonlySet<string>) {
  const counts: Record<SearchOutcome | "legacy" | "missing", number> = { queued:0,running:0,current:0,metadata_only:0,partial:0,
    unsupported:0,failed:0,stale:0,legacy:0,missing:0 };
  const state = db.prepare(`SELECT w.outcome,w.requested_revision,w.successful_revision,w.dirty_since,w.queued_at,w.retry_at,
    p.valid,s.session_id AS legacy FROM (SELECT ? AS session_id) a
    LEFT JOIN search_work_state w ON w.session_id=a.session_id LEFT JOIN search_publication p ON p.session_id=a.session_id
    LEFT JOIN session_index_state s ON s.session_id=a.session_id`);
  let oldestPendingAgeMs = 0;
  let retrying = 0;
  for (const id of allowedIds) {
    const row = state.get(id) as { outcome: SearchOutcome | null; requested_revision:string|null; successful_revision:string|null;
      dirty_since:number|null;queued_at:number|null;retry_at:number|null; valid:number|null;legacy:string|null };
    let outcome: keyof typeof counts = row.queued_at && row.outcome !== "running" ? "queued"
      : row.outcome ?? (row.legacy ? "legacy" : "missing");
    if (!Object.hasOwn(counts,outcome)) outcome = "unsupported";
    if ((outcome === "current" || outcome === "metadata_only") && (row.valid !== 1 || row.requested_revision !== row.successful_revision)) outcome = "stale";
    counts[outcome]++;
    if (row.retry_at) retrying++;
    if (!["current","metadata_only"].includes(outcome) && row.dirty_since) oldestPendingAgeMs = Math.max(oldestPendingAgeMs,Date.now()-row.dirty_since);
  }
  return { total: allowedIds.size, counts, retrying, oldestPendingAgeMs };
}
