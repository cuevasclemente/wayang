import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { getConfig } from "../config.js";
import type { ArtifactCatalogRow, ArtifactRegistration } from "./types.js";

const SCHEMA_VERSION = 1;
const MAX_SESSION_ARTIFACTS = 100;
const MAX_GLOBAL_ARTIFACTS = 8_192;

let db: DatabaseType | null = null;
let dbPath: string | null = null;

export class ArtifactRegistryError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 500, code = "artifact_registry_error") {
    super(message);
    this.name = "ArtifactRegistryError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function getArtifactDbPath(dataDir = getConfig().dataDir): string {
  return path.join(dataDir, "artifact-index.db");
}

function assertPrivateDirectory(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dataDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ArtifactRegistryError("Artifact registry parent must be a real directory");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new ArtifactRegistryError("Artifact registry parent must be owned by the Wayang user");
  }
  fs.chmodSync(dataDir, 0o700);
  if (fs.realpathSync.native(dataDir) !== path.resolve(dataDir)) {
    throw new ArtifactRegistryError("Artifact registry parent cannot traverse symlinks");
  }
}

function assertPrivateDatabase(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ArtifactRegistryError("Artifact registry must be a single-link regular file");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new ArtifactRegistryError("Artifact registry must be owned by the Wayang user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ArtifactRegistryError("Artifact registry permissions must be 0600");
  }
}

function createSchema(database: DatabaseType): void {
  database.exec(`
    CREATE TABLE artifact_meta (
      schema_version INTEGER NOT NULL
    );
    INSERT INTO artifact_meta(schema_version) VALUES (${SCHEMA_VERSION});

    CREATE TABLE artifact_catalog (
      session_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE session_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      locator_kind TEXT NOT NULL CHECK(locator_kind IN ('home_file', 'session_attachment')),
      locator_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      title TEXT,
      description TEXT,
      source TEXT NOT NULL CHECK(source IN ('presented', 'upload')),
      source_event_id TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      presented_at INTEGER,
      row_revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(session_id, locator_kind, locator_path)
    );
    CREATE INDEX session_artifacts_session_order
      ON session_artifacts(session_id, last_seen_at DESC, id);
    CREATE INDEX session_artifacts_global_order
      ON session_artifacts(last_seen_at, id);
  `);
}

function validateSchema(database: DatabaseType): void {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_meta'").get();
  if (!table) {
    createSchema(database);
    return;
  }
  const row = database.prepare("SELECT schema_version FROM artifact_meta LIMIT 1").get() as { schema_version?: unknown } | undefined;
  if (!row || !Number.isInteger(row.schema_version)) {
    throw new ArtifactRegistryError("Artifact registry schema metadata is malformed");
  }
  const schemaVersion = row.schema_version as number;
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new ArtifactRegistryError(
      schemaVersion > SCHEMA_VERSION
        ? "Artifact registry schema is newer than this Wayang build"
        : "Artifact registry schema requires an explicit migration",
    );
  }
  for (const required of ["artifact_catalog", "session_artifacts"]) {
    const found = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(required);
    if (!found) throw new ArtifactRegistryError(`Artifact registry is missing ${required}`);
  }
}

export function initArtifactRegistry(dataDir = getConfig().dataDir): DatabaseType {
  const nextPath = getArtifactDbPath(dataDir);
  if (db) {
    if (dbPath !== nextPath) throw new ArtifactRegistryError("Artifact registry is already initialized for another data directory");
    return db;
  }
  assertPrivateDirectory(dataDir);
  assertPrivateDatabase(nextPath);
  const previousUmask = process.umask(0o077);
  try {
    const opened = new Database(nextPath);
    try {
      opened.pragma("journal_mode = WAL");
      opened.pragma("synchronous = NORMAL");
      opened.pragma("foreign_keys = ON");
      opened.pragma("busy_timeout = 2000");
      validateSchema(opened);
      fs.chmodSync(nextPath, 0o600);
      db = opened;
      dbPath = nextPath;
      return opened;
    } catch (error) {
      try { opened.close(); } catch { /* ignore */ }
      throw error;
    }
  } finally {
    process.umask(previousUmask);
  }
}

export function artifactRegistryIsInitialized(): boolean {
  return db !== null;
}

export function getArtifactRegistry(): DatabaseType {
  return db ?? initArtifactRegistry();
}

export function closeArtifactRegistry(): void {
  if (!db) return;
  try { db.close(); } finally {
    db = null;
    dbPath = null;
  }
}

function bumpRevision(database: DatabaseType, sessionId: string): number {
  database.prepare(`
    INSERT INTO artifact_catalog(session_id, revision) VALUES(?, 1)
    ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1
  `).run(sessionId);
  return (database.prepare("SELECT revision FROM artifact_catalog WHERE session_id=?").get(sessionId) as { revision: number }).revision;
}

function pruneIds(database: DatabaseType, sessionId: string | null, excess: number): string[] {
  if (excess <= 0) return [];
  const rows = (sessionId
    ? database.prepare(`
        SELECT id FROM session_artifacts WHERE session_id=?
        ORDER BY CASE source WHEN 'upload' THEN 0 ELSE 1 END, last_seen_at ASC, id ASC LIMIT ?
      `).all(sessionId, excess)
    : database.prepare(`
        SELECT id FROM session_artifacts
        ORDER BY CASE source WHEN 'upload' THEN 0 ELSE 1 END, last_seen_at ASC, id ASC LIMIT ?
      `).all(excess)) as Array<{ id: string }>;
  const remove = database.prepare("DELETE FROM session_artifacts WHERE id=? RETURNING session_id");
  const affected = new Set<string>();
  for (const row of rows) {
    const deleted = remove.get(row.id) as { session_id: string } | undefined;
    if (deleted) affected.add(deleted.session_id);
  }
  return [...affected];
}

export function upsertArtifacts(sessionId: string, registrations: readonly ArtifactRegistration[]): {
  rows: ArtifactCatalogRow[];
  revisions: Map<string, number>;
} {
  if (!sessionId || registrations.length === 0) return { rows: [], revisions: new Map() };
  const database = getArtifactRegistry();
  const run = database.transaction(() => {
    const now = Date.now();
    const select = database.prepare(`
      SELECT * FROM session_artifacts
      WHERE session_id=? AND locator_kind=? AND locator_path=?
    `);
    const insert = database.prepare(`
      INSERT INTO session_artifacts(
        id, session_id, locator_kind, locator_path, display_name, title, description,
        source, source_event_id, first_seen_at, last_seen_at, presented_at, row_revision
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const updatePresented = database.prepare(`
      UPDATE session_artifacts SET
        display_name=?, title=?, description=?, source='presented', source_event_id=?,
        last_seen_at=?, presented_at=?, row_revision=row_revision+1
      WHERE id=?
    `);
    const updateUpload = database.prepare(`
      UPDATE session_artifacts SET
        display_name=?, last_seen_at=?, row_revision=row_revision+1
      WHERE id=?
    `);
    const ids: string[] = [];
    for (const registration of registrations) {
      const existing = select.get(sessionId, registration.locatorKind, registration.locatorPath) as ArtifactCatalogRow | undefined;
      if (!existing) {
        const id = randomUUID();
        insert.run(
          id,
          sessionId,
          registration.locatorKind,
          registration.locatorPath,
          registration.displayName,
          registration.title ?? null,
          registration.description ?? null,
          registration.source,
          registration.sourceEventId ?? null,
          now,
          now,
          registration.source === "presented" ? now : null,
        );
        ids.push(id);
      } else {
        if (registration.source === "presented") {
          updatePresented.run(
            registration.displayName,
            registration.title ?? existing.title,
            registration.description ?? existing.description,
            registration.sourceEventId ?? existing.source_event_id,
            now,
            now,
            existing.id,
          );
        } else {
          updateUpload.run(registration.displayName, now, existing.id);
        }
        ids.push(existing.id);
      }
    }

    const changed = new Set<string>([sessionId]);
    const sessionCount = (database.prepare("SELECT COUNT(*) AS count FROM session_artifacts WHERE session_id=?").get(sessionId) as { count: number }).count;
    for (const affected of pruneIds(database, sessionId, sessionCount - MAX_SESSION_ARTIFACTS)) changed.add(affected);
    const globalCount = (database.prepare("SELECT COUNT(*) AS count FROM session_artifacts").get() as { count: number }).count;
    for (const affected of pruneIds(database, null, globalCount - MAX_GLOBAL_ARTIFACTS)) changed.add(affected);

    const revisions = new Map<string, number>();
    for (const changedSession of changed) revisions.set(changedSession, bumpRevision(database, changedSession));
    const rows = ids.map((id) => database.prepare("SELECT * FROM session_artifacts WHERE id=?").get(id) as ArtifactCatalogRow | undefined)
      .filter((row): row is ArtifactCatalogRow => Boolean(row));
    return { rows, revisions };
  });
  return run();
}

export function listArtifactRows(sessionId: string): ArtifactCatalogRow[] {
  return getArtifactRegistry().prepare(`
    SELECT * FROM session_artifacts WHERE session_id=?
    ORDER BY COALESCE(presented_at, last_seen_at) DESC, last_seen_at DESC, id ASC
  `).all(sessionId) as ArtifactCatalogRow[];
}

export function getArtifactRow(sessionId: string, artifactId: string): ArtifactCatalogRow | undefined {
  return getArtifactRegistry().prepare("SELECT * FROM session_artifacts WHERE session_id=? AND id=?")
    .get(sessionId, artifactId) as ArtifactCatalogRow | undefined;
}

export function getArtifactCatalogRevision(sessionId: string): number {
  const row = getArtifactRegistry().prepare("SELECT revision FROM artifact_catalog WHERE session_id=?")
    .get(sessionId) as { revision: number } | undefined;
  return row?.revision ?? 0;
}

export function removeSessionArtifacts(sessionId: string): void {
  if (!db) return;
  const database = db;
  database.transaction(() => {
    database.prepare("DELETE FROM session_artifacts WHERE session_id=?").run(sessionId);
    database.prepare("DELETE FROM artifact_catalog WHERE session_id=?").run(sessionId);
  })();
}

export function pruneOrphanArtifactSessions(sessionExists: (sessionId: string) => boolean): string[] {
  const database = getArtifactRegistry();
  const sessionIds = database.prepare("SELECT session_id FROM artifact_catalog").all() as Array<{ session_id: string }>;
  const orphaned = sessionIds.filter((row) => !sessionExists(row.session_id)).map((row) => row.session_id);
  if (orphaned.length === 0) return [];
  database.transaction(() => {
    for (const sessionId of orphaned) {
      database.prepare("DELETE FROM session_artifacts WHERE session_id=?").run(sessionId);
      database.prepare("DELETE FROM artifact_catalog WHERE session_id=?").run(sessionId);
    }
  })();
  return orphaned;
}
