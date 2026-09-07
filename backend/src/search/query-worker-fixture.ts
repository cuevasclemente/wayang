/** Synthetic-only fixtures shared by query worker tests. Never imported by runtime. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { parseSearchQuery } from "./query-parser.js";
import { queryDatabaseSnapshot } from "./query-snapshot.js";
import type { QueryWorkerRequest } from "./query-worker-protocol.js";

export function createQueryWorkerFixture(sessions = 3, chunksPerSession = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-readonly-query-"));
  const dbPath = path.join(root, "search.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode=WAL");
  db.exec(`
    CREATE TABLE search_publication(session_id TEXT PRIMARY KEY,generation TEXT,valid INTEGER,source_revision TEXT);
    CREATE TABLE search_session_metadata(session_id TEXT PRIMARY KEY,cwd TEXT,title TEXT,goal TEXT,model TEXT,
      provider TEXT,created_at INTEGER,last_active INTEGER,archived INTEGER,has_error INTEGER,revision TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,text TEXT,title TEXT DEFAULT '',goal TEXT,
      message_id TEXT,transcript_epoch TEXT,active_branch INTEGER,generation TEXT);
    CREATE INDEX chunks_session ON chunks(session_id);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text,title,goal,content='chunks',content_rowid='id',
      tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid,text,title,goal) VALUES(new.id,new.text,new.title,COALESCE(new.goal,''));
    END;
    CREATE VIEW search_chunks_current AS SELECT c.id,c.session_id,m.cwd,m.title,m.goal,m.model,m.provider,
      m.created_at,m.last_active,m.archived,m.has_error,c.role,c.text,c.message_id,c.transcript_epoch,c.active_branch,c.generation
      FROM chunks c JOIN search_publication p ON p.session_id=c.session_id
      LEFT JOIN search_session_metadata m ON m.session_id=c.session_id
      WHERE p.valid=1 AND (c.generation=p.generation OR c.generation='metadata');
  `);
  const terms = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi";
  const ids = Array.from({ length: sessions }, (_, index) => `session-${index}`);
  const meta = db.prepare("INSERT INTO search_session_metadata VALUES(?,'/synthetic','Fixture',NULL,'test-model',NULL,1,1,0,0,'metadata-1')");
  const publication = db.prepare("INSERT INTO search_publication VALUES(?,'generation-1',1,'synthetic-source')");
  const body = db.prepare("INSERT INTO chunks(session_id,role,text,message_id,transcript_epoch,active_branch,generation) VALUES(?,'user',?,?,'epoch-1',1,'generation-1')");
  db.transaction(() => {
    for (const id of ids) {
      meta.run(id); publication.run(id);
      for (let chunk = 0; chunk < chunksPerSession; chunk++) body.run(id, `${terms} ${"filler ".repeat(30)}`, `message-${chunk}`);
    }
  })();
  function request(query = "alpha beta"): QueryWorkerRequest {
    return { dbPath, parsed: parseSearchQuery(query), filters: { limit: 30 }, metadataSessionIds: [...ids],
      allowedCwds: ["/synthetic"], bodies: ids.map(sessionId => ({ sessionId, generation: "generation-1", transcriptEpoch: "epoch-1" })),
      databaseSnapshot: queryDatabaseSnapshot(db, ids) };
  }
  return { db, dbPath, root, ids, terms, request };
}
