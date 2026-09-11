import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import type { SessionRow } from "../db.js";
import { migrate, SCHEMA_VERSION } from "./db.js";
import { beginGeneration, stageDocuments, publishMetadata, publishGeneration, invalidatePublication,
  cleanupSearchChunks, recordSearchOutcome, recordSearchQueued, getIndexCoverageSnapshot, getSearchPublicationMetrics,
  SEARCH_WAL_PAUSE_BYTES } from "./publication.js";
const row = {id:"synthetic",cwd:"/synthetic",title:"title",goal:"goal",model:"model",provider:null,created_at:1,last_active:2,archived:0,error:null} as SessionRow;
function database() {const db=new Database(":memory:");db.pragma("foreign_keys=ON");migrate(db);return db;}
function visible(db: DatabaseType) { return db.prepare("SELECT text FROM search_chunks_current ORDER BY id").all() as Array<{text:string}>; }
test("unpublished generations are invisible, metadata overlays independently, cleanup preserves active staging", async()=>{
  const db=database();
  try {
    const generation=beginGeneration(db,row.id);
    await cleanupSearchChunks(db);
    assert.ok(db.prepare("SELECT generation FROM search_generations WHERE generation=?").get(generation),"active empty staging survives cleanup before first batch");
    stageDocuments(db,row.id,generation,"epoch",[{chunkIndex:0,role:"user",text:"body",messageId:"m",sourceOffset:42}]);
    assert.deepEqual(visible(db),[]);
    await cleanupSearchChunks(db);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {n:number}).n,1);
    db.transaction(()=>publishMetadata(db,row))();
    publishGeneration(db,row,generation,()=>recordSearchOutcome(db,row.id,"r1","current"));
    assert.deepEqual(visible(db).map(r=>r.text).sort(),["body","title\n\ngoal\n\ncwd: /synthetic\n\nmodel: model"].sort());
    const before=db.prepare("SELECT id,text FROM chunks WHERE role='user'").get();
    db.transaction(()=>publishMetadata(db,{...row,title:"renamed",goal:null,last_active:100}))();
    assert.deepEqual(db.prepare("SELECT id,text FROM chunks WHERE role='user'").get(),before);
    assert.deepEqual(db.prepare("SELECT DISTINCT title,goal,last_active FROM search_chunks_current").all(),[{title:"renamed",goal:null,last_active:100}]);
    invalidatePublication(db,row.id);
    assert.deepEqual(visible(db),[]);
    db.prepare("UPDATE search_generations SET active=0").run();
    await cleanupSearchChunks(db);
    assert.deepEqual(db.prepare("SELECT id FROM chunks").all(),[]);
  } finally {db.close();}
});
test("byte/row stage limits fail before insertion and outcomes back off durably",()=>{
  const db=database();
  try {
    const generation=beginGeneration(db,row.id);
    assert.throws(()=>stageDocuments(db,row.id,generation,"epoch",[{chunkIndex:0,role:"user",text:"x".repeat(128*1024+1)}]),/limit/);
    recordSearchOutcome(db,row.id,"r1","failed","io");
    const first=db.prepare("SELECT attempts,retry_at FROM search_work_state").get() as {attempts:number;retry_at:number};
    recordSearchOutcome(db,row.id,"r1","running");
    recordSearchOutcome(db,row.id,"r1","failed","io");
    const second=db.prepare("SELECT attempts,retry_at FROM search_work_state").get() as {attempts:number;retry_at:number};
    assert.equal(first.attempts,1);assert.equal(second.attempts,2);assert.ok(second.retry_at>first.retry_at);
    const snapshot=getIndexCoverageSnapshot(db,new Set([row.id,"missing"]));
    assert.equal(snapshot.counts.failed,1);assert.equal(snapshot.counts.missing,1);
    assert.equal(getIndexCoverageSnapshot(db,new Set()).total,0,"caller authorization set is authoritative");
  } finally {db.close();}
});
test("pinned SQLite reader holds WAL admission closed until checkpoint/truncate, without blocking denial or cleanup",async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"search-wal-pressure-synthetic-"));
  const file=path.join(root,"search.db");
  const db=new Database(file);
  let reader:DatabaseType|undefined;
  const walBytes=()=>fs.statSync(`${file}-wal`).size;
  type Checkpoint={busy:number;log:number;checkpointed:number};
  try {
    db.pragma("journal_mode=WAL");db.pragma("synchronous=NORMAL");
    db.pragma("foreign_keys=ON");db.pragma("busy_timeout=0");
    db.pragma("wal_autocheckpoint=1000");db.pragma("journal_size_limit=8388608");
    migrate(db);
    const generation=beginGeneration(db,row.id);
    stageDocuments(db,row.id,generation,"epoch",[{chunkIndex:0,role:"user",text:"abandoned synthetic body"}]);
    // A small reusable BLOB makes real WAL frames without a 64 MiB JS buffer,
    // huge FTS tokens, a fake/sparse WAL, or ever touching a canonical database.
    const payloadBytes=256*1024;
    const payloads=[Buffer.alloc(payloadBytes,0x61),Buffer.alloc(payloadBytes,0x62)];
    db.exec("CREATE TABLE synthetic_wal_pressure(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,payload BLOB NOT NULL)");
    db.prepare("INSERT INTO synthetic_wal_pressure VALUES(1,0,?)").run(payloads[0]);
    assert.equal((db.pragma("wal_checkpoint(TRUNCATE)") as Checkpoint[])[0].busy,0);
    reader=new Database(file,{readonly:true,fileMustExist:true});
    reader.pragma("busy_timeout=0");reader.exec("BEGIN");
    assert.equal((reader.prepare("SELECT revision FROM synthetic_wal_pressure WHERE id=1").get() as {revision:number}).revision,0);
    const update=db.prepare("UPDATE synthetic_wal_pressure SET revision=revision+1,payload=? WHERE id=1");
    const maxWrites=Math.ceil(SEARCH_WAL_PAUSE_BYTES/payloadBytes)+8;
    let writes=0;
    while(walBytes()<SEARCH_WAL_PAUSE_BYTES && writes<maxWrites) {
      update.run(payloads[(writes+1)%2]);writes++;
      if(writes%8===0)await new Promise<void>((resolve)=>setImmediate(resolve));
    }
    const walAtPause=walBytes();
    assert.ok(walAtPause>=SEARCH_WAL_PAUSE_BYTES,"the pinned reader must prevent automatic checkpoint/reset");
    assert.ok(walAtPause<SEARCH_WAL_PAUSE_BYTES+1024*1024,"fixture stops after the first bounded crossing, not indefinite WAL growth");
    assert.equal((reader.prepare("SELECT revision FROM synthetic_wal_pressure WHERE id=1").get() as {revision:number}).revision,0,
      "reader still owns its original snapshot while the writer has advanced");
    assert.equal((db.prepare("SELECT revision FROM synthetic_wal_pressure WHERE id=1").get() as {revision:number}).revision,writes);
    const blockedCheckpoint=(db.pragma("wal_checkpoint(TRUNCATE)") as Checkpoint[])[0];
    assert.equal(blockedCheckpoint.busy,1);
    assert.ok(blockedCheckpoint.log>blockedCheckpoint.checkpointed);
    const before=getSearchPublicationMetrics();
    const isWalPressure=(error:unknown)=>error instanceof Error && error.message==="wal_pressure";
    for(let attempt=0;attempt<3;attempt++) {
      assert.throws(()=>beginGeneration(db,"denied-synthetic-generation"),isWalPressure);
      assert.throws(()=>stageDocuments(db,row.id,generation,"epoch",[{chunkIndex:1,role:"user",text:"must not stage"}]),isWalPressure);
      assert.throws(()=>db.transaction(()=>publishMetadata(db,row))(),isWalPressure);
    }
    assert.equal(walBytes(),walAtPause,"repeated denied text admission must not itself append WAL frames");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM search_generations").get() as {n:number}).n,1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {n:number}).n,1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM search_session_metadata").get() as {n:number}).n,0);
    assert.equal(getSearchPublicationMetrics().stageTransactions,before.stageTransactions);
    assert.equal(getSearchPublicationMetrics().walPressurePauses-before.walPressurePauses,9);

    // This is an admission WATERMARK, not a disk quota. The last admitted
    // bounded transaction can cross it; denial/state/cleanup must remain able
    // to write even while the reader keeps WAL bytes above the watermark.
    invalidatePublication(db,row.id);
    db.prepare("UPDATE search_generations SET active=0 WHERE generation=?").run(generation);
    recordSearchOutcome(db,row.id,"synthetic-revision","failed","wal_pressure");
    assert.equal(await cleanupSearchChunks(db,{sessionId:row.id,maxBatches:1}),1);
    assert.deepEqual(visible(db),[]);
    const walAfterDenialAndCleanup=walBytes();
    assert.ok(walAfterDenialAndCleanup>walAtPause);
    assert.throws(()=>beginGeneration(db,"still-denied"),isWalPressure);

    reader.exec("ROLLBACK");
    const checkpoint=(db.pragma("wal_checkpoint(TRUNCATE)") as Checkpoint[])[0];
    assert.equal(checkpoint.busy,0);
    assert.equal(walBytes(),0,"release and explicit truncation remove the observed admission pressure");
    const recovered=beginGeneration(db,row.id);
    stageDocuments(db,row.id,recovered,"epoch",[{chunkIndex:0,role:"user",text:"recovered synthetic body"}]);
    db.transaction(()=>publishMetadata(db,row))();
    publishGeneration(db,row,recovered,()=>recordSearchOutcome(db,row.id,"recovered-revision","current"));
    assert.equal(visible(db).length,2);
    assert.ok(visible(db).some((chunk)=>chunk.text==="recovered synthetic body"));
    assert.equal(getSearchPublicationMetrics().stageTransactions,before.stageTransactions+1);
    t.diagnostic(JSON.stringify({benchmark:"synthetic-pinned-reader-wal",watermarkBytes:SEARCH_WAL_PAUSE_BYTES,
      payloadBytes,writes,walAtPause,blockedCheckpoint,walAfterDenialAndCleanup,checkpoint,
      walAfterRecovery:walBytes(),admissionRecovered:true,
      caveat:"Admission watermark, not a hard filesystem quota; release alone is insufficient evidence until checkpoint/reset/truncate reduces observed WAL size."}));
  } finally {
    if(reader?.inTransaction)reader.exec("ROLLBACK");
    reader?.close();db.close();
    // Synthetic files remain available for lead inspection; no live paths used.
  }
});

test("cleanup bounds candidate scans even when a large published prefix has no garbage",async()=>{
  const db=database();
  try {
    const insert=db.prepare(`INSERT INTO chunks(session_id,cwd,title,created_at,last_active,chunk_index,role,text) VALUES('legacy','/synthetic','title',0,0,0,'user','retained')`);
    db.transaction(()=>{for(let i=0;i<300;i++)insert.run();})();
    const generation=beginGeneration(db,row.id);
    stageDocuments(db,row.id,generation,"epoch",[{chunkIndex:0,role:"user",text:"unpublished"}]);
    db.prepare("UPDATE search_generations SET active=0").run();
    for(let i=0;i<8;i++) {
      const before=getSearchPublicationMetrics().cleanupCandidates;
      await cleanupSearchChunks(db,{maxBatches:1});
      assert.ok(getSearchPublicationMetrics().cleanupCandidates-before<=64);
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {n:number}).n,300);
  } finally {db.close();}
});

test("queued observations stay durable without discarding retry or successful revision evidence",()=>{
  const db=database();
  try {
    recordSearchOutcome(db,row.id,"r1","current");
    recordSearchQueued(db,row.id);
    assert.equal(getIndexCoverageSnapshot(db,new Set([row.id])).counts.queued,1);
    assert.equal((db.prepare("SELECT successful_revision FROM search_work_state").get() as {successful_revision:string}).successful_revision,"r1");
    recordSearchOutcome(db,row.id,"r2","partial","included_record_limit");
    assert.equal((db.prepare("SELECT successful_revision FROM search_work_state").get() as {successful_revision:string}).successful_revision,"r1");
    assert.equal(getIndexCoverageSnapshot(db,new Set([row.id])).counts.partial,1);
  } finally {db.close();}
});

test("migration adds generation columns to an actual v2-shaped table without rebuilding FTS",()=>{
  const db=new Database(":memory:");
  try {
    db.exec(`CREATE TABLE search_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO search_meta VALUES('schema_version','2');
      CREATE TABLE chunks(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,cwd TEXT NOT NULL,title TEXT NOT NULL,
        goal TEXT,model TEXT,provider TEXT,created_at INTEGER NOT NULL,last_active INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,has_error INTEGER NOT NULL DEFAULT 0,chunk_index INTEGER NOT NULL,
        role TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,source_offset INTEGER,transcript_epoch TEXT,
        active_branch INTEGER NOT NULL DEFAULT 0);
      CREATE VIRTUAL TABLE chunks_fts USING fts5(text,title,goal,content='chunks',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
      INSERT INTO chunks(id,session_id,cwd,title,created_at,last_active,chunk_index,role,text) VALUES(17,'legacy','/synthetic','old',0,0,0,'user','migration canary');
      INSERT INTO chunks_fts(rowid,text,title,goal) VALUES(17,'migration canary','old','');`);
    migrate(db);
    assert.deepEqual(db.prepare("SELECT id,generation FROM search_chunks_current").all(),[{id:17,generation:"legacy"}]);
    assert.deepEqual(db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'canary'").all(),[{rowid:17}]);
  } finally {db.close();}
});

test("additive migration preserves legacy FTS rows and rejects destructive downgrade",()=>{
  const db=database();
  try {
    db.prepare(`INSERT INTO chunks(session_id,cwd,title,created_at,last_active,chunk_index,role,text) VALUES('legacy','/synthetic','legacy title',0,0,0,'user','legacy canary')`).run();
    const before=db.prepare("SELECT id FROM chunks").get();
    db.prepare("UPDATE search_meta SET value='2' WHERE key='schema_version'").run();
    migrate(db);
    assert.deepEqual(db.prepare("SELECT id FROM chunks").get(),before);
    assert.deepEqual(visible(db),[{text:"legacy canary"}]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'canary'").get() as {n:number}).n,1);
    db.prepare("UPDATE search_meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION+1));
    assert.throws(()=>migrate(db),/refusing destructive/);
    assert.deepEqual(db.prepare("SELECT id FROM chunks").get(),before);
  } finally {db.close();}
});
