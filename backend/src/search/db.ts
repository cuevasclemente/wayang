/**
 * search/db.ts — Opens and migrates the SQLite database used for session
 * history search.
 *
 * Two indices share one file:
 *   - `chunks` + `chunks_fts` (BM25 keyword)
 *   - `chunk_vectors` (semantic; populated lazily in M3)
 *
 * Path: <dataDir>/search.db, alongside store.json.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "../config.js";

export const SCHEMA_VERSION = 3;

let _db: DatabaseType | null = null;

export function getSearchDbPath(): string {
  return path.join(getConfig().dataDir, "search.db");
}

export function getSearchDb(): DatabaseType {
  if (_db) return _db;
  const dataDir = getConfig().dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = getSearchDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    // Reclaim an oversized WAL on its next reset; publication additionally pauses
    // text admission at a watermark while a reader prevents checkpoint progress.
    db.pragma("journal_size_limit = 8388608");
    db.pragma("foreign_keys = ON");
    migrate(db);
    // No worker survives process restart. Its unpublished generations may be
    // reclaimed; previously published coverage is not invalidated here.
    db.exec("UPDATE search_generations SET active=0 WHERE active=1; UPDATE search_work_state SET outcome='stale',queued_at=0 WHERE outcome IN ('running','queued') OR queued_at>0;");
    _db = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeSearchDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore
    }
    _db = null;
  }
}

export function migrate(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const currentVersion = readSchemaVersion(db);
  if (currentVersion === SCHEMA_VERSION) return;

  if (currentVersion > SCHEMA_VERSION) {
    throw new Error("Search database schema is newer than this runtime; refusing destructive downgrade");
  }
  db.transaction(() => {
    applySchemaV1(db);
    applyGenerationSchema(db);
    writeSchemaVersion(db, SCHEMA_VERSION);
  })();
}

function readSchemaVersion(db: DatabaseType): number {
  try {
    const row = db
      .prepare("SELECT value FROM search_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!row) return 0;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeSchemaVersion(db: DatabaseType, v: number): void {
  db.prepare(
    "INSERT INTO search_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(v));
}

function applyGenerationSchema(db: DatabaseType): void {
  const columns = new Set((db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).map((r) => r.name));
  // Older supported stores gain columns without deleting their valid coverage.
  if (!columns.has("transcript_epoch")) db.exec("ALTER TABLE chunks ADD COLUMN transcript_epoch TEXT");
  if (!columns.has("active_branch")) db.exec("ALTER TABLE chunks ADD COLUMN active_branch INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("generation")) db.exec("ALTER TABLE chunks ADD COLUMN generation TEXT NOT NULL DEFAULT 'legacy'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS chunks_generation ON chunks(session_id, generation, id);
    CREATE TABLE IF NOT EXISTS search_publication (
      session_id TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      valid INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS search_session_metadata (
      session_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL, title TEXT NOT NULL, goal TEXT, model TEXT, provider TEXT,
      created_at INTEGER NOT NULL, last_active INTEGER NOT NULL,
      archived INTEGER NOT NULL, has_error INTEGER NOT NULL,
      revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_generations (
      generation TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      text_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS search_work_state (
      session_id TEXT PRIMARY KEY,
      requested_revision TEXT,
      attempted_revision TEXT,
      successful_revision TEXT,
      outcome TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      error_code TEXT,
      chunk_bytes INTEGER NOT NULL DEFAULT 0,
      dirty_since INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIEW IF NOT EXISTS search_chunks_current AS
      SELECT c.id AS rowid, c.id, c.session_id,
        COALESCE(m.cwd,c.cwd) AS cwd, COALESCE(m.title,c.title) AS title,
        CASE WHEN m.session_id IS NULL THEN c.goal ELSE m.goal END AS goal,
        CASE WHEN m.session_id IS NULL THEN c.model ELSE m.model END AS model,
        CASE WHEN m.session_id IS NULL THEN c.provider ELSE m.provider END AS provider,
        COALESCE(m.created_at,c.created_at) AS created_at,
        COALESCE(m.last_active,c.last_active) AS last_active,
        COALESCE(m.archived,c.archived) AS archived,
        COALESCE(m.has_error,c.has_error) AS has_error,
        c.chunk_index,c.role,c.text,c.message_id,c.source_offset,
        c.transcript_epoch,c.active_branch,c.generation
      FROM chunks c
      LEFT JOIN search_publication p ON p.session_id=c.session_id
      LEFT JOIN search_session_metadata m ON m.session_id=c.session_id
      WHERE (p.session_id IS NULL AND c.generation='legacy')
         OR (p.valid=1 AND (c.generation=p.generation OR c.generation='metadata'));
  `);
}

function applySchemaV1(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id            INTEGER PRIMARY KEY,
      session_id    TEXT NOT NULL,
      cwd           TEXT NOT NULL,
      title         TEXT NOT NULL,
      goal          TEXT,
      model         TEXT,
      provider      TEXT,
      created_at    INTEGER NOT NULL,
      last_active   INTEGER NOT NULL,
      archived      INTEGER NOT NULL DEFAULT 0,
      has_error     INTEGER NOT NULL DEFAULT 0,
      chunk_index   INTEGER NOT NULL,
      role          TEXT NOT NULL,
      text          TEXT NOT NULL,
      message_id    TEXT,
      source_offset INTEGER,
      transcript_epoch TEXT,
      active_branch INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id);
    CREATE INDEX IF NOT EXISTS chunks_cwd_active ON chunks(cwd, last_active);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, title, goal,
      content='chunks',
      content_rowid='id',
      tokenize = 'unicode61 remove_diacritics 2'
    );

    -- Keep FTS5 in sync with chunks.
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text, title, goal)
      VALUES (new.id, new.text, new.title, COALESCE(new.goal, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, title, goal)
      VALUES ('delete', old.id, old.text, old.title, COALESCE(old.goal, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, title, goal)
      VALUES ('delete', old.id, old.text, old.title, COALESCE(old.goal, ''));
      INSERT INTO chunks_fts(rowid, text, title, goal)
      VALUES (new.id, new.text, new.title, COALESCE(new.goal, ''));
    END;

    CREATE TABLE IF NOT EXISTS chunk_vectors (
      chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      dim      INTEGER NOT NULL,
      vec      BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_index_state (
      session_id      TEXT PRIMARY KEY,
      pi_session_file TEXT,
      file_mtime_ms   INTEGER,
      file_size       INTEGER,
      indexed_at_ms   INTEGER,
      chunk_count     INTEGER,
      vector_count    INTEGER,
      schema_version  INTEGER NOT NULL DEFAULT 1,
      error           TEXT
    );
  `);
}
