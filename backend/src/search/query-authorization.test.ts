/** Synthetic exact-authorization -> publication-witness -> SQL regressions. */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { SessionRow } from "../db.js";
import { authorizeSearchQueryBodies, getVisibleBodySessionIds } from "./query-authorization.js";
import { parseSearchQuery } from "./query-parser.js";
import { queryKeywordSessions } from "./query-sql.js";
import {
  encodePublishedSearchSource, getPublishedSearchRevision, SEARCH_EXTRACTION_VERSION,
} from "./revision.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-query-revision-"));
const cwd = path.join(root, "project");
const piRoot = path.join(root, "pi", "sessions");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(piRoot, { recursive: true });
process.env.HOME = root;
process.env.WAYANG_DATA_DIR = path.join(root, "data");
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
process.env.PI_CODING_AGENT_SESSION_DIR = piRoot;
const storeMod = await import("../db.js");
const projectsMod = await import("../projects.js");
const policyFilter = await import("./policy-filter.js");
storeMod.init();

let counter = 0;
function fixture() {
  const id = `query-revision-${++counter}`;
  const { project } = projectsMod.ensureProjectForCwd(cwd);
  const file = path.join(piRoot, `${id}.jsonl`);
  const header = JSON.stringify({ type: "session", version: 3, id, cwd: project.cwd });
  const message = JSON.stringify({ type: "message", id: "original", parentId: null,
    message: { role: "user", content: [{ type: "text", text: "oldbodycanary" }] } });
  fs.writeFileSync(file, `${header}\n${message}\n`);
  // Distinguishable old timestamps; all file content and metadata are synthetic.
  fs.utimesSync(file, 1000, 1000);
  const row: SessionRow = {
    id, pi_session_file: file, title: "syntheticmeta", title_source: "explicit",
    cwd: project.cwd, project_id: project.id, provider: "synthetic", model: "test-model",
    agent_profile_id: project.default_agent_profile_id, pending_agent_switch: null,
    legacy_private_session_quarantine: false, legacy_capability_ineligible: false,
    created_at: 1, last_active: 1, archived: 0, archived_at: null,
    goal: null, goal_status: null, scheduled_job_id: null, scheduled_run_id: null, error: null,
  };
  storeMod.getStore().sessions.push(row);
  storeMod.flush();
  const observed = policyFilter.getSessionIndexAuthorization(row);
  assert.ok(observed?.transcript, "the initial synthetic transcript must pass exact authorization");
  const source = { filePath: file, fingerprint: observed.transcript.fingerprint,
    extractionVersion: SEARCH_EXTRACTION_VERSION, transcriptEpoch: "published-epoch" };
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE search_publication(session_id TEXT PRIMARY KEY, generation TEXT, valid INTEGER, source_revision TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, session_id TEXT, cwd TEXT, title TEXT,
      goal TEXT, model TEXT, last_active INTEGER, archived INTEGER DEFAULT 0, has_error INTEGER DEFAULT 0,
      role TEXT, text TEXT, message_id TEXT, transcript_epoch TEXT, active_branch INTEGER, generation TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, title, goal, content='chunks', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid,text,title,goal) VALUES(new.id,new.text,new.title,COALESCE(new.goal,''));
    END;
    CREATE VIEW search_chunks_current AS SELECT c.* FROM chunks c
      LEFT JOIN search_publication p ON p.session_id=c.session_id
      WHERE (p.session_id IS NULL AND c.generation='legacy')
        OR (p.valid=1 AND (c.generation=p.generation OR c.generation='metadata'));
  `);
  db.prepare("INSERT INTO search_publication VALUES(?, 'generation-1', 1, ?)").run(id, encodePublishedSearchSource(source));
  const insert = db.prepare(`INSERT INTO chunks(session_id,cwd,title,model,last_active,role,text,message_id,transcript_epoch,active_branch,generation)
    VALUES(?,?, 'syntheticmeta','test-model',1,?,?,?,?,?,?)`);
  insert.run(id, cwd, "user", "oldbodycanary", "original", "published-epoch", 1, "generation-1");
  insert.run(id, cwd, "meta", "syntheticmeta", null, null, 0, "metadata");
  function search(query: string) {
    const current = policyFilter.getSessionIndexAuthorization(row);
    assert.ok(current, "current owning metadata/header remains authorized in this regression");
    const gate = authorizeSearchQueryBodies([current], sessionId => getPublishedSearchRevision(db, sessionId),
      SEARCH_EXTRACTION_VERSION, getVisibleBodySessionIds(db, [id]));
    return { gate, ...queryKeywordSessions(db, parseSearchQuery(query), gate.metadataSessionIds, [cwd], {}, gate.bodies) };
  }
  function assertBodyHidden() {
    const result = search("oldbodycanary");
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.facets, { cwds: [], models: [] });
    assert.deepEqual(result.gate.rejectedBodySessionIds, [id]);
    const metadata = search("syntheticmeta");
    assert.equal(metadata.rows[0].session_id, id);
    assert.equal(metadata.rows[0].message_id, null);
  }
  return { db, id, file, header, message, row, source, search, assertBodyHidden };
}

test("unchanged exact published revision permits its body and exact anchor", () => {
  const f = fixture();
  try {
    const out = f.search("oldbodycanary");
    assert.equal(out.rows[0].session_id, f.id);
    assert.equal(out.rows[0].message_id, "original");
    assert.equal(out.rows[0].transcript_epoch, "published-epoch");
    assert.deepEqual(out.gate.rejectedBodySessionIds, []);
  } finally { f.db.close(); }
});

test("valid-owner same-size rewrite with restored mtime cannot expose yesterday's published body", async () => {
  const f = fixture();
  try {
    await new Promise(resolve => setTimeout(resolve, 5));
    const rewritten = f.message.replace("oldbodycanary", "newbodycanary");
    fs.writeFileSync(f.file, `${f.header}\n${rewritten}\n`);
    fs.utimesSync(f.file, 1000, 1000);
    assert.equal(fs.statSync(f.file).size, f.source.fingerprint.size);
    assert.equal(fs.statSync(f.file).mtimeMs, f.source.fingerprint.mtimeMs);
    f.assertBodyHidden();
  } finally { f.db.close(); }
});

test("external sibling append before a paused watcher denies the old branch publication", () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.file, JSON.stringify({ type: "message", id: "sibling", parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: "replacement branch" }] } }) + "\n");
    f.assertBodyHidden();
  } finally { f.db.close(); }
});

test("changing to a different canonical file with the same valid owner/header rejects old body", () => {
  const f = fixture();
  try {
    const replacement = `${f.file}.replacement`;
    fs.writeFileSync(replacement, `${f.header}\n${f.message}\n`);
    f.row.pi_session_file = replacement;
    storeMod.flush();
    f.assertBodyHidden();
  } finally { f.db.close(); }
});

test("detaching a transcript is metadata-only authority, not access to retained body rows", () => {
  const f = fixture();
  try {
    f.row.pi_session_file = null;
    storeMod.flush();
    assert.equal(policyFilter.isSessionIndexable(f.row), true, "existing metadata-only authorization contract is preserved");
    f.assertBodyHidden();
  } finally { f.db.close(); }
});

test("legacy publication without an immutable fingerprint exposes authorized metadata only", () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE search_publication SET source_revision=NULL WHERE session_id=?").run(f.id);
    f.assertBodyHidden();
    // Also cover pre-migration legacy with no publication row at all.
    f.db.prepare("DELETE FROM search_publication WHERE session_id=?").run(f.id);
    f.db.prepare("UPDATE chunks SET generation='legacy' WHERE session_id=?").run(f.id);
    f.assertBodyHidden();
  } finally { f.db.close(); }
});

test("published path, extraction version and fingerprint fields must all agree", () => {
  const f = fixture();
  try {
    const variations = [
      { ...f.source, filePath: `${f.file}.other` },
      { ...f.source, extractionVersion: "unsupported-extraction" },
      ...(["ino", "size", "mtimeMs", "ctimeMs"] as const).map(key => ({ ...f.source,
        fingerprint: { ...f.source.fingerprint, [key]: f.source.fingerprint[key] + 1 } })),
    ];
    for (const source of variations) {
      f.db.prepare("UPDATE search_publication SET source_revision=? WHERE session_id=?")
        .run(encodePublishedSearchSource(source), f.id);
      f.assertBodyHidden();
    }
  } finally { f.db.close(); }
});

test("a genuine metadata-only session with no retained body is not counted as a rejection", () => {
  const f = fixture();
  try {
    f.row.pi_session_file = null;
    storeMod.flush();
    f.db.prepare("UPDATE search_publication SET source_revision=? WHERE session_id=?")
      .run(encodePublishedSearchSource({ filePath: null, fingerprint: null,
        extractionVersion: SEARCH_EXTRACTION_VERSION, transcriptEpoch: null }), f.id);
    f.db.exec("DROP VIEW search_chunks_current; CREATE VIEW search_chunks_current AS SELECT * FROM chunks WHERE role='meta'");
    const out = f.search("syntheticmeta");
    assert.equal(out.rows.length, 1);
    assert.deepEqual(out.gate.rejectedBodySessionIds, []);
  } finally { f.db.close(); }
});

test("invalid publication and mismatched chunk epoch cannot contribute body text", () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE chunks SET transcript_epoch='different-epoch' WHERE role='user'").run();
    assert.deepEqual(f.search("oldbodycanary").rows, []);
    f.db.prepare("UPDATE search_publication SET valid=0 WHERE session_id=?").run(f.id);
    assert.deepEqual(f.search("oldbodycanary").rows, []);
  } finally { f.db.close(); }
});
