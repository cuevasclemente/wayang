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
import { chunkJsonlFile, type MetaForChunker } from "./chunker.js";

export interface IndexResult {
  sessionId: string;
  chunkCount: number;
  skipped: boolean;
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
}

let _includeThinking = false;

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

function makeMeta(row: SessionRow): MetaForChunker {
  return {
    title: row.title || "(untitled)",
    goal: row.goal,
    cwd: row.cwd,
    model: row.model,
  };
}

export async function indexSession(
  sessionId: string,
  options: IndexerOptions = {},
): Promise<IndexResult> {
  const db = getSearchDb();
  const row = await loadSessionRow(sessionId);
  if (!row) {
    return { sessionId, chunkCount: 0, skipped: true, error: "session not found" };
  }

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

  if (
    !options.force &&
    existing &&
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
  const db = getSearchDb();
  db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM session_index_state WHERE session_id = ?").run(sessionId);
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
