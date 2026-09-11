import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StructuralTranscriptIndex } from "../transcript-pagination/structural-index.js";
function fixture(entries: unknown[]) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"search-offset-synthetic-"));
  const file=path.join(root,"session.jsonl");
  const header={type:"session",version:3,id:"synthetic",cwd:root};
  fs.writeFileSync(file,[header,...entries].map((e)=>JSON.stringify(e)).join("\n")+"\n");
  return {root,file};
}
function fingerprint(file:string) {const s=fs.statSync(file);return {ino:Number(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs};}
const message=(id:string,parentId:string|null,role:string,text:string)=>({type:"message",id,parentId,message:{role,content:[{type:"text",text}]}});

test("search offsets are exact active user/assistant records, never tool or sibling samples",async()=>{
  const f=fixture([message("root",null,"user","root text"),message("sibling","root","assistant","off branch"),
    message("tool","root","toolResult","excluded ".repeat(256*1024)),message("active","tool","assistant","active text")]);
  const index=new StructuralTranscriptIndex(path.join(f.root,"structure.db"));
  try {
    const revision=await index.searchRevision("synthetic",f.file,fingerprint(f.file),()=>true);
    const {rows}=index.searchSourcePage(revision,-1,()=>true);
    assert.deepEqual(rows.map(r=>r.eventId),["root","active"]);
    for(const row of rows) {
      const fd=fs.openSync(f.file,"r");
      try {const bytes=Buffer.alloc(row.sourceLength);fs.readSync(fd,bytes,0,bytes.length,row.sourceOffset);
        assert.equal(JSON.parse(bytes.toString()).id,row.eventId);} finally {fs.closeSync(fd);}
    }
    fs.appendFileSync(f.file,JSON.stringify(message("later","active","user","new"))+"\n");
    assert.throws(()=>index.searchSourcePage(revision,-1,()=>true),/changed|stale/);
  } finally {await index.close();}
});

test("tool-only pages advance a bounded candidate cursor without losing later included messages",async()=>{
  const entries=Array.from({length:200},(_,i)=>message(`t${i}`,i ? `t${i-1}` : null,"toolResult","excluded"));
  entries.push(message("included","t199","assistant","last included text"));
  const f=fixture(entries);
  const index=new StructuralTranscriptIndex(path.join(f.root,"structure.db"));
  try {
    const revision=await index.searchRevision("synthetic",f.file,fingerprint(f.file),()=>true);
    let after=-1;let pages=0;const ids:string[]=[];
    while(true) {
      const page=index.searchSourcePage(revision,after,()=>true);
      pages++;assert.ok(page.nextOrdinal-after<=64);
      ids.push(...page.rows.map(row=>row.eventId));
      after=page.nextOrdinal;if(page.done)break;
    }
    assert.equal(pages,4);assert.deepEqual(ids,["included"]);
    assert.equal(index.getReadInstrumentation().totalSourceBytesRead,0,"offset iteration never calls sampled UI body reads");
  } finally {await index.close();}
});

test("search does not inherit UI append evidence that lacks a verified full prefix",async()=>{
  const f=fixture([message("root",null,"user","alpha "+"padding ".repeat(1500)),message("tip","root","assistant","tail")]);
  let appends=0;
  const index=new StructuralTranscriptIndex(path.join(f.root,"structure.db"),{onAppendRefreshForTests:()=>{appends++;}});
  try {
    await index.ensure("synthetic",f.file,fingerprint(f.file),()=>true);
    fs.writeFileSync(f.file,fs.readFileSync(f.file,"utf8").replace("alpha","bravo")+JSON.stringify(message("later","tip","user","new"))+"\n");
    await index.ensure("synthetic",f.file,fingerprint(f.file),()=>true);
    assert.equal(appends,1,"synthetic rewrite is outside the old tail witness");
    const workers=index.getWorkerInstrumentation().workersStarted;
    const revision=await index.searchRevision("synthetic",f.file,fingerprint(f.file),()=>true);
    assert.equal(index.getWorkerInstrumentation().workersStarted,workers+1);
    assert.deepEqual(index.searchSourcePage(revision,-1,()=>true).rows.map(r=>r.eventId),["root","tip","later"]);
  } finally {await index.close();}
});

test("malformed records and cold oversized physical records cannot claim complete search evidence",async()=>{
  const malformed=fixture([message("root",null,"user","valid")]);
  fs.appendFileSync(malformed.file,'{"type":"message",');
  const a=new StructuralTranscriptIndex(path.join(malformed.root,"structure.db"));
  try {await assert.rejects(a.searchRevision("synthetic",malformed.file,fingerprint(malformed.file),()=>true),/unsupported/);}
  finally {await a.close();}
  const giant=fixture([message("tool",null,"toolResult","x".repeat(9*1024*1024))]);
  let read=0;
  const b=new StructuralTranscriptIndex(path.join(giant.root,"structure.db"),{observeWorkerBodyBytesForTests:(_id,n)=>{read+=n;}});
  try {
    await assert.rejects(b.searchRevision("synthetic",giant.file,fingerprint(giant.file),()=>true),/unsupported/);
    assert.ok(read<=8*1024*1024+64*1024,"cold search record bound rejects before whole-record accumulation");
  } finally {await b.close();}
});

test("cold search cannot inherit an in-flight UI worker without search resource limits",async()=>{
  const f=fixture([message("tool",null,"toolResult","x".repeat(9*1024*1024)),message("active","tool","user","included")]);
  let reached!:()=>void;let release!:()=>void;
  const paused=new Promise<void>((resolve)=>{reached=resolve;});
  const gate=new Promise<void>((resolve)=>{release=resolve;});
  const index=new StructuralTranscriptIndex(path.join(f.root,"structure.db"),{beforePublishForTests:async()=>{reached();await gate;}});
  const ui=index.ensure("synthetic",f.file,fingerprint(f.file),()=>true);
  try {
    await paused;
    const workers=index.getWorkerInstrumentation().workersStarted;
    await assert.rejects(index.searchRevision("synthetic",f.file,fingerprint(f.file),()=>true),/another admission mode/);
    assert.equal(index.getWorkerInstrumentation().workersStarted,workers,"search neither joins nor starts/cancels the UI build");
    release();
    assert.equal((await ui).complete,true,"existing UI limits remain unchanged for the 9 MiB fixture");
    const warm=await index.searchRevision("synthetic",f.file,fingerprint(f.file),()=>true);
    assert.equal(index.getWorkerInstrumentation().workersStarted,workers,"completed exact full-build evidence can be reused without cold body work");
    assert.deepEqual(index.searchSourcePage(warm,-1,()=>true).rows.map(row=>row.eventId),["active"]);
  } finally {release();await ui.catch(()=>undefined);await index.close();}
});

test("purge cancels a running structural search worker rather than waiting for its full build",async()=>{
  const f=fixture([message("root",null,"user","body")]);
  const index=new StructuralTranscriptIndex(path.join(f.root,"structure.db"),{workerDelayMsForTests:1000});
  try {
    const work=index.searchRevision("synthetic",f.file,fingerprint(f.file),()=>true);
    const rejected=assert.rejects(work,/cancel|invalidat/);
    await new Promise<void>((r)=>setImmediate(r));
    index.purge("synthetic");
    await rejected;
  } finally {await index.close();}
});
