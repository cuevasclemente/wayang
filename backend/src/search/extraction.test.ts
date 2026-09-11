import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSearchDocuments, SEARCH_MAX_DOCUMENT_BYTES, SEARCH_MAX_RECORD_BYTES } from "./extraction.js";
import type { StructuralIndexRevision, SearchSourceRow } from "../transcript-pagination/structural-index.js";
import type { Chunk } from "./types.js";
function fixture(texts: Array<{role:"user"|"assistant"|"toolResult";text:string}>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"search-extraction-synthetic-"));
  const filePath = path.join(root,"transcript.jsonl");
  const rows: SearchSourceRow[] = [];
  let offset = 0;
  const lines = texts.map((entry,index) => {
    const line=JSON.stringify({type:"message",id:`m${index}`,message:{role:entry.role,content:[{type:"text",text:entry.text},{type:"thinking",thinking:"excluded thinking"}]}})+"\n";
    if (entry.role !== "toolResult") rows.push({eventId:`m${index}`,role:entry.role,activeOrdinal:index,sourceOffset:offset,sourceLength:Buffer.byteLength(line)});
    offset+=Buffer.byteLength(line); return line;
  });
  fs.writeFileSync(filePath,lines.join(""));
  const stat = fs.statSync(filePath);
  const revision: StructuralIndexRevision={sessionId:"synthetic",filePath,device:Number(stat.dev),inode:Number(stat.ino),
    size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,headerDigest:"synthetic",mutationEpoch:"synthetic",
    transcriptEpoch:"exact",branchTipId:rows.at(-1)?.eventId ?? null,indexedSize:stat.size,complete:true,error:null};
  return {revision,rows};
}
test("exact offset extraction skips giant excluded records and preserves whole-message phrase boundaries", async () => {
  const text="alpha"+"!".repeat(8000)+" beta 🐦 café";
  const f=fixture([{role:"toolResult",text:"excluded ".repeat(SEARCH_MAX_RECORD_BYTES)}, {role:"user",text}]);
  const chunks: Chunk[]=[];
  const stats=await extractSearchDocuments({revision:f.revision,guard:()=>{},sources:(after)=>f.rows.filter(r=>r.activeOrdinal>after),stage:(batch)=>{chunks.push(...batch);}});
  assert.equal(stats.readBytes,f.rows[0].sourceLength,"excluded physical bytes are not read by extraction");
  assert.equal(stats.unsupportedRecords,0);
  assert.equal(chunks.length,1);
  assert.equal(chunks[0].text,text);
  assert.equal(chunks[0].messageId,"m1");
});
test("oversized included records/documents produce explicit partial statistics", async () => {
  const f=fixture([{role:"user",text:"x".repeat(SEARCH_MAX_RECORD_BYTES+1)},
    {role:"assistant",text:"y".repeat(SEARCH_MAX_DOCUMENT_BYTES+1)}, {role:"user",text:"retained"}]);
  const chunks: Chunk[]=[];
  const stats=await extractSearchDocuments({revision:f.revision,guard:()=>{},sources:(after)=>f.rows.filter(r=>r.activeOrdinal>after),stage:(batch)=>{chunks.push(...batch);}});
  assert.equal(stats.unsupportedRecords,2);
  assert.deepEqual(chunks.map(c=>c.text),["retained"]);
  assert.ok(stats.readBytes<f.revision.size);
});
test("worker waits for each bounded batch acknowledgement and rejects revocation at a yield", async () => {
  const f=fixture([{role:"user",text:"one"},{role:"assistant",text:"two"}]);
  let allowed=true; let staged=0;
  await assert.rejects(extractSearchDocuments({revision:f.revision,guard:()=>{if(!allowed)throw Error("revoked");},
    sources:(after)=>f.rows.filter(r=>r.activeOrdinal>after),stage:async()=>{
      staged++; await new Promise<void>((resolve)=>setImmediate(resolve)); allowed=false;
    }}),/revoked/);
  assert.equal(staged,1);
});
test("cancellation drains a pending staging callback before completing the job", async () => {
  const f=fixture([{role:"user",text:"one"}]);
  const controller=new AbortController();
  let reached!:()=>void;let release!:()=>void;
  const staged=new Promise<void>((resolve)=>{reached=resolve;});
  const gate=new Promise<void>((resolve)=>{release=resolve;});
  let settled=false;
  const work=extractSearchDocuments({revision:f.revision,signal:controller.signal,guard:()=>{},
    sources:(after)=>f.rows.filter(r=>r.activeOrdinal>after),stage:async()=>{reached();await gate;}});
  const rejected=assert.rejects(work,/cancelled/).then(()=>{settled=true;});
  await staged;controller.abort();
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(settled,false);
  release();await rejected;
});

test("invalid UTF-8 is explicit failure, never replacement-character successful content", async () => {
  const f=fixture([{role:"user",text:"selected"}]);
  const bytes=fs.readFileSync(f.revision.filePath);
  bytes[bytes.indexOf("selected")]=0xff;
  fs.writeFileSync(f.revision.filePath,bytes);
  const stat=fs.statSync(f.revision.filePath);
  f.revision.mtimeMs=stat.mtimeMs;f.revision.ctimeMs=stat.ctimeMs;
  await assert.rejects(extractSearchDocuments({revision:f.revision,guard:()=>{},
    sources:(after)=>f.rows.filter(r=>r.activeOrdinal>after),stage:()=>{assert.fail("malformed text staged");}}),/malformed_record/);
});

test("stale worker revision rejects before body admission", async () => {
  const f=fixture([{role:"user",text:"one"}]);
  fs.appendFileSync(f.revision.filePath,"\n");
  let stages=0;
  await assert.rejects(extractSearchDocuments({revision:f.revision,guard:()=>{},sources:()=>f.rows,stage:()=>{stages++;}}),/stale_file/);
  assert.equal(stages,0);
});
