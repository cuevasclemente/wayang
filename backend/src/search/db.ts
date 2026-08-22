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

export const SCHEMA_VERSION = 2;

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
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  _db = db;
  return db;
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

function migrate(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const currentVersion = readSchemaVersion(db);
  if (currentVersion === SCHEMA_VERSION) return;

  if (currentVersion > SCHEMA_VERSION) {
    // Downgrade: drop and rebuild rather than carry forward an unknown schema.
    dropAll(db);
  } else if (currentVersion > 0 && currentVersion < SCHEMA_VERSION) {
    // No incremental migrations yet — clean rebuild on bump.
    dropAll(db);
  }

  applySchemaV1(db);
  writeSchemaVersion(db, SCHEMA_VERSION);
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

function dropAll(db: DatabaseType): void {
  db.exec(`
    DROP TABLE IF EXISTS chunk_vectors;
    DROP TABLE IF EXISTS chunks_fts;
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS session_index_state;
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
