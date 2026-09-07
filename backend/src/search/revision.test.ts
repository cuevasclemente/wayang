import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { SessionRow } from "../db.js";
import { migrate } from "./db.js";
import { beginGeneration, publishGeneration, recordSearchOutcome, invalidatePublication } from "./publication.js";
import { getPublishedSearchRevision, SEARCH_EXTRACTION_VERSION, searchSourceRevisionKey } from "./revision.js";
const row={id:"synthetic-publication"} as SessionRow;
const source={filePath:"/synthetic/transcript.jsonl",fingerprint:{ino:17,size:101,mtimeMs:12.5,ctimeMs:13.5},
  extractionVersion:SEARCH_EXTRACTION_VERSION,transcriptEpoch:"exact-epoch"};

test("published witness is bound to its generation, independent of mutable attempted/requested work",()=>{
  const db=new Database(":memory:");migrate(db);
  try {
    assert.deepEqual(getPublishedSearchRevision(db,row.id),{kind:"legacy",generation:null});
    const generation=beginGeneration(db,row.id);
    publishGeneration(db,row,generation,()=>recordSearchOutcome(db,row.id,"r1","current"),source);
    const expected={kind:"published",generation,...source};
    assert.deepEqual(getPublishedSearchRevision(db,row.id),expected);
    recordSearchOutcome(db,row.id,"different-attempt","failed","synthetic");
    assert.deepEqual(getPublishedSearchRevision(db,row.id),expected);
    invalidatePublication(db,row.id);
    assert.deepEqual(getPublishedSearchRevision(db,row.id),{kind:"unpublished"});
  } finally {db.close();}
});
test("legacy and malformed publication witnesses never masquerade as exact evidence",()=>{
  const db=new Database(":memory:");migrate(db);
  try {
    db.prepare("INSERT INTO search_publication(session_id,generation,valid) VALUES(?,'old-generation',1)").run(row.id);
    assert.deepEqual(getPublishedSearchRevision(db,row.id),{kind:"legacy",generation:"old-generation"});
    db.prepare("UPDATE search_publication SET source_revision=?").run('{"format":1,"filePath":"/synthetic","fingerprint":null}');
    assert.deepEqual(getPublishedSearchRevision(db,row.id),{kind:"unpublished"});
    db.prepare("UPDATE search_publication SET source_revision='invalid-json'").run();
    assert.deepEqual(getPublishedSearchRevision(db,row.id),{kind:"unpublished"});
  } finally {db.close();}
});
test("schema-3 publication rows migrate additively with explicitly legacy witnesses",()=>{
  const db=new Database(":memory:");migrate(db);
  try {
    db.exec("ALTER TABLE search_publication DROP COLUMN source_revision; UPDATE search_meta SET value='3' WHERE key='schema_version'");
    db.prepare("INSERT INTO search_publication VALUES(?,'old-generation',1)").run(row.id);
    migrate(db);
    assert.deepEqual(getPublishedSearchRevision(db,row.id),{kind:"legacy",generation:"old-generation"});
  } finally {db.close();}
});
test("source dirty key canonicalizes fingerprint property order",()=>{
  assert.equal(searchSourceRevisionKey(source.filePath,source.fingerprint),searchSourceRevisionKey(source.filePath,
    {ctimeMs:13.5,mtimeMs:12.5,size:101,ino:17}));
});
