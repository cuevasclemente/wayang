/**
 * search/indexer.ts — Index pi JSONL sessions into search.db.
 *
 * Operations:
 *   - indexSession(sessionId, { force? }): stat the jsonl, diff against
 *     session_index_state, reindex if changed. Wrapped in a single transaction.
 *   - reindexAll(): iterate all sessions (including archived) and index any
 *     that changed.
 *   - removeSession(sessionId): delete chunks + state for a session. Used only
 *     on physical delete; archived sessions are retained.
 *
 * Failure handling: per-session errors are recorded in
 * session_index_state.error and surfaced by /api/sessions/search/health. They
 * do not abort the batch.
 */

import * as fs from "node:fs";
import { getStore, type SessionRow } from "../db.js";
import { listSessions } from "../sessions.js";
import { getSearchDb, SCHEMA_VERSION } from "./db.js";
import { isSessionIndexable } from "./policy-filter.js";
import { chunkJsonlFile, type MetaForChunker } from "./chunker.js";
import { writeDreamPolicyProjection } from "./policy-projection.js";

export interface IndexResult {
  sessionId: string;
  chunkCount: number;
  skipped: boolean;
  policySkipped?: boolean;
  mutationFenced?: boolean;
  retryable?: boolean;
  error?: string;
}

export interface IndexBatchSummary {
  total: number;
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface IndexerOptions {
  includeThinking?: boolean;
  force?: boolean;
  /** @internal Pauses after transcript chunking for deterministic CAS tests. */
  afterChunkingForTests?: () => void | Promise<void>;
}

let _includeThinking = false;
const transcriptMutationFences = new Set<string>();

export function setIncludeThinking(v: boolean): void {
  _includeThinking = v;
}

export function getIncludeThinking(): boolean {
  return _includeThinking;
}

async function loadSessionRow(sessionId: string): Promise<SessionRow | null> {
  const store = getStore();
  const row = store.sessions.find((r) => r.id === sessionId);
  return row ? { ...row } : null;
}

interface IndexMetadataProjection {
  catalogMutationVersion: number;
  piSessionFile: string | null;
  title: string;
  goal: string | null;
  cwd: string;
  model: string | null;
  provider: string | null;
  createdAt: number;
  lastActive: number;
  archived: number;
  error: string | null;
}

function indexMetadataProjection(row: SessionRow): IndexMetadataProjection {
  return {
    catalogMutationVersion: row.catalog_mutation_version ?? 0,
    piSessionFile: row.pi_session_file,
    title: row.title,
    goal: row.goal,
    cwd: row.cwd,
    model: row.model,
    provider: row.provider,
    createdAt: row.created_at,
    lastActive: row.last_active,
    archived: row.archived,
    error: row.error,
  };
}

function sameIndexMetadata(left: IndexMetadataProjection, right: IndexMetadataProjection): boolean {
  return left.catalogMutationVersion === right.catalogMutationVersion
    && left.piSessionFile === right.piSessionFile
    && left.title === right.title
    && left.goal === right.goal
    && left.cwd === right.cwd
    && left.model === right.model
    && left.provider === right.provider
    && left.createdAt === right.createdAt
    && left.lastActive === right.lastActive
    && left.archived === right.archived
    && left.error === right.error;
}

function makeMeta(row: SessionRow): MetaForChunker {
  return {
    title: row.title || "(untitled)",
    goal: row.goal,
    cwd: row.cwd,
    model: row.model,
  };
}

const RETRY_FRESH_ROW = Symbol("retry-fresh-index-row");
const MAX_INDEX_METADATA_CAS_ATTEMPTS = 3;

export async function indexSession(
  sessionId: string,
  options: IndexerOptions = {},
): Promise<IndexResult> {
  for (let attempt = 0; attempt < MAX_INDEX_METADATA_CAS_ATTEMPTS; attempt++) {
    const result = await indexSessionAttempt(sessionId, options);
    if (result !== RETRY_FRESH_ROW) return result;
  }
  purgeSessionIndex(sessionId);
  return {
    sessionId,
    chunkCount: 0,
    skipped: true,
    retryable: true,
    error: "Session metadata changed repeatedly during indexing; retry later.",
  };
}

async function indexSessionAttempt(
  sessionId: string,
  options: IndexerOptions,
): Promise<IndexResult | typeof RETRY_FRESH_ROW> {
  if (transcriptMutationFences.has(sessionId)) {
    purgeSessionIndex(sessionId);
    return { sessionId, chunkCount: 0, skipped: true, mutationFenced: true };
  }
  const row = await loadSessionRow(sessionId);
  if (!row) {
    return { sessionId, chunkCount: 0, skipped: true, error: "session not found" };
  }
  const expectedMetadata = indexMetadataProjection(row);

  // Publish the current complete path decision before this background path can
  // touch transcript metadata. Unknown paths remain denied by the Dream runner.
  writeDreamPolicyProjection();

  // Authorization precedes search DB lookup, transcript stat/read, and the
  // unchanged shortcut. Denial removes stale indexed content.
  const initialDenial = policyDenial(row);
  if (initialDenial) return purgePolicyDeniedSession(sessionId, initialDenial);
  const db = getSearchDb();
  const filePath = row.pi_session_file;
  let fileMtime: number | null = null;
  let fileSize: number | null = null;
  if (filePath) {
    try {
      const stat = fs.statSync(filePath);
      fileMtime = stat.mtimeMs;
      fileSize = stat.size;
    } catch {
      // File missing — fall through; we still index the meta chunk so the
      // session is searchable by title/goal.
    }
  }

  // Recheck after stat and before the unchanged shortcut so a policy change
  // cannot preserve stale searchable content merely because bytes are stable.
  if (transcriptMutationFences.has(sessionId)) {
    purgeSessionIndex(sessionId);
    return { sessionId, chunkCount: 0, skipped: true, mutationFenced: true };
  }
  const postStatDenial = policyDenial(row);
  if (postStatDenial) return purgePolicyDeniedSession(sessionId, postStatDenial);

  // Skip if unchanged.
  const existing = db
    .prepare(
      "SELECT pi_session_file, file_mtime_ms, file_size, schema_version, indexed_at_ms FROM session_index_state WHERE session_id = ?",
    )
    .get(sessionId) as
    | {
        pi_session_file: string | null;
        file_mtime_ms: number | null;
        file_size: number | null;
        schema_version: number;
        indexed_at_ms: number;
      }
    | undefined;

  const indexedMetadata = db.prepare(
    `SELECT cwd, title, goal, model, provider, created_at, last_active, archived, has_error
       FROM chunks WHERE session_id = ? ORDER BY chunk_index LIMIT 1`,
  ).get(sessionId) as {
    cwd: string; title: string; goal: string | null; model: string | null; provider: string | null;
    created_at: number; last_active: number; archived: number; has_error: number;
  } | undefined;
  const indexedMetadataMatches = Boolean(indexedMetadata
    && indexedMetadata.cwd === row.cwd
    && indexedMetadata.title === row.title
    && indexedMetadata.goal === row.goal
    && indexedMetadata.model === row.model
    && indexedMetadata.provider === row.provider
    && indexedMetadata.created_at === row.created_at
    && indexedMetadata.last_active === row.last_active
    && indexedMetadata.archived === (row.archived ? 1 : 0)
    && indexedMetadata.has_error === (row.error ? 1 : 0));

  if (
    !options.force &&
    existing &&
    indexedMetadataMatches &&
    existing.schema_version === SCHEMA_VERSION &&
    existing.pi_session_file === (filePath ?? null) &&
    existing.file_mtime_ms === (fileMtime ?? null) &&
    existing.file_size === (fileSize ?? null)
  ) {
    return { sessionId, chunkCount: 0, skipped: true };
  }

  let chunks: Awaited<ReturnType<typeof chunkJsonlFile>>["chunks"] = [];
  let chunkerError: string | undefined;

  const meta = makeMeta(row);
  if (filePath && fileMtime != null) {
    const preReadDenial = policyDenial(row);
    if (preReadDenial) return purgePolicyDeniedSession(sessionId, preReadDenial);
    try {
      const result = await chunkJsonlFile(filePath, meta, {
        includeThinking: _includeThinking || options.includeThinking,
      });
      chunks = result.chunks;
    } catch (err: any) {
      chunkerError = err?.message || String(err);
      // Even on chunker failure, fall back to a meta-only chunk so the
      // session is still searchable by title/goal/cwd.
      chunks = [
        {
          chunkIndex: 0,
          role: "meta",
          text: [meta.title, meta.goal || "", `cwd: ${meta.cwd}`, meta.model ? `model: ${meta.model}` : ""]
            .filter(Boolean)
            .join("\n\n"),
          messageId: null,
          sourceOffset: null,
        },
      ];
    }
  } else {
    // No pi file yet — emit just the meta chunk.
    chunks = [
      {
        chunkIndex: 0,
        role: "meta",
        text: [meta.title, meta.goal || "", `cwd: ${meta.cwd}`, meta.model ? `model: ${meta.model}` : ""]
          .filter(Boolean)
          .join("\n\n"),
        messageId: null,
        sourceOffset: null,
      },
    ];
  }

  await options.afterChunkingForTests?.();

  // chunkJsonlFile and test seams yield while streaming. Reauthorize and
  // compare the complete index projection before preparing a commit.
  if (transcriptMutationFences.has(sessionId)) {
    purgeSessionIndex(sessionId);
    return { sessionId, chunkCount: 0, skipped: true, mutationFenced: true };
  }
  const preCommitDenial = policyDenial(row);
  if (preCommitDenial) return purgePolicyDeniedSession(sessionId, preCommitDenial);
  const afterChunkingRow = await loadSessionRow(sessionId);
  if (!afterChunkingRow || !sameIndexMetadata(expectedMetadata, indexMetadataProjection(afterChunkingRow))) {
    return RETRY_FRESH_ROW;
  }

  const insertStmt = db.prepare(
    `INSERT INTO chunks (
      session_id, cwd, title, goal, model, provider,
      created_at, last_active, archived, has_error,
      chunk_index, role, text, message_id, source_offset
    ) VALUES (
      @session_id, @cwd, @title, @goal, @model, @provider,
      @created_at, @last_active, @archived, @has_error,
      @chunk_index, @role, @text, @message_id, @source_offset
    )`,
  );

  const deleteStmt = db.prepare("DELETE FROM chunks WHERE session_id = ?");
  const stateStmt = db.prepare(
    `INSERT INTO session_index_state (
       session_id, pi_session_file, file_mtime_ms, file_size,
       indexed_at_ms, chunk_count, vector_count, schema_version, error
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       pi_session_file = excluded.pi_session_file,
       file_mtime_ms   = excluded.file_mtime_ms,
       file_size       = excluded.file_size,
       indexed_at_ms   = excluded.indexed_at_ms,
       chunk_count     = excluded.chunk_count,
       schema_version  = excluded.schema_version,
       error           = excluded.error`,
  );

  // Last synchronous CAS immediately before the SQLite transaction. No await
  // is permitted between this durable-row read and trx().
  const preTransactionRow = getStore().sessions.find((candidate) => candidate.id === sessionId);
  if (!preTransactionRow || !sameIndexMetadata(expectedMetadata, indexMetadataProjection(preTransactionRow))) {
    return RETRY_FRESH_ROW;
  }

  const trx = db.transaction(() => {
    deleteStmt.run(sessionId);
    for (const c of chunks) {
      insertStmt.run({
        session_id: sessionId,
        cwd: row.cwd,
        title: row.title || "(untitled)",
        goal: row.goal,
        model: row.model,
        provider: row.provider,
        created_at: row.created_at,
        last_active: row.last_active,
        archived: row.archived ? 1 : 0,
        has_error: row.error ? 1 : 0,
        chunk_index: c.chunkIndex,
        role: c.role,
        text: c.text,
        message_id: c.messageId ?? null,
        source_offset: c.sourceOffset ?? null,
      });
    }
    stateStmt.run(
      sessionId,
      filePath ?? null,
      fileMtime ?? null,
      fileSize ?? null,
      Date.now(),
      chunks.length,
      SCHEMA_VERSION,
      chunkerError ?? null,
    );
  });
  trx();

  return { sessionId, chunkCount: chunks.length, skipped: false, error: chunkerError };
}

export async function removeSession(sessionId: string): Promise<void> {
  purgeSessionIndex(sessionId);
}

/** Prevent watcher/manual indexing from republishing stale text during rewrite. */
export function beginTranscriptMutationSearchFence(sessionId: string): void {
  if (transcriptMutationFences.has(sessionId)) {
    throw new Error("A transcript mutation search fence is already active");
  }
  transcriptMutationFences.add(sessionId);
  try {
    purgeSessionIndex(sessionId);
  } catch (error) {
    transcriptMutationFences.delete(sessionId);
    throw error;
  }
}

export function endTranscriptMutationSearchFence(sessionId: string): void {
  transcriptMutationFences.delete(sessionId);
}

export function purgePolicyDeniedSessions(): { purged: number; errors: number } {
  let purged = 0;
  let errors = 0;
  for (const row of listSessions(true)) {
    if (!policyDenial(row)) continue;
    try {
      purgeSessionIndex(row.id);
      purged++;
    } catch (error) {
      errors++;
      console.error(`[search] policy purge failed for ${row.id}:`, error);
    }
  }
  return { purged, errors };
}

export async function reindexAll(options: IndexerOptions = {}): Promise<IndexBatchSummary> {
  const start = Date.now();
  const sessions = listSessions(true); // include archived
  let indexed = 0;
  let skipped = 0;
  let errors = 0;
  for (const s of sessions) {
    try {
      const r = await indexSession(s.id, options);
      if (r.skipped) skipped++;
      else indexed++;
      if (r.error) errors++;
    } catch (err) {
      errors++;
      console.error(`[search] indexSession(${s.id}) failed:`, err);
    }
  }
  return {
    total: sessions.length,
    indexed,
    skipped,
    errors,
    durationMs: Date.now() - start,
  };
}

function policyDenial(row: SessionRow): string | null {
  // Re-resolve the durable row on every phase check so a quarantine committed
  // while the streaming chunker yields cannot publish derived private text.
  const current = getStore().sessions.find((candidate) => candidate.id === row.id);
  return current && isSessionIndexable(current)
    ? null
    : "Session indexing denied by project or legacy private-data policy";
}

function purgeSessionIndex(sessionId: string): void {
  const db = getSearchDb();
  db.transaction(() => {
    db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM session_index_state WHERE session_id = ?").run(sessionId);
  })();
}

function purgePolicyDeniedSession(sessionId: string, reason: string): IndexResult {
  try {
    purgeSessionIndex(sessionId);
    return { sessionId, chunkCount: 0, skipped: true, policySkipped: true };
  } catch (error) {
    return {
      sessionId,
      chunkCount: 0,
      skipped: true,
      policySkipped: true,
      error: `Policy denied indexing and stale-index purge failed: ${error instanceof Error ? error.message : String(error)} (${reason})`,
    };
  }
}
