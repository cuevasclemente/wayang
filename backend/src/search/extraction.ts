import { Worker } from "node:worker_threads";
import type { StructuralIndexRevision, SearchSourceRow, SearchSourcePage } from "../transcript-pagination/structural-index.js";
import type { Chunk } from "./types.js";

export const SEARCH_MAX_DOCUMENT_BYTES = 128 * 1024;
export const SEARCH_MAX_RECORD_BYTES = 1024 * 1024;
export const SEARCH_MAX_GENERATION_BYTES = 32 * 1024 * 1024;
export interface ExtractionStats { readBytes: number; textBytes: number; documents: number; unsupportedRecords: number }

// One exact message document preserves every supported phrase boundary, even
// when arbitrarily long punctuation separates its tokens. No synthetic role tokens.
const SOURCE = String.raw`
const fs = require('node:fs');
const { parentPort, workerData: d } = require('node:worker_threads');
const stats = { readBytes: 0, textBytes: 0, documents: 0, unsupportedRecords: 0 };
let fd;
function matches(s) { const r=d.revision; return s.isFile() && s.nlink===1 && Number(s.dev)===r.device
  && Number(s.ino)===r.inode && s.size===r.size && s.mtimeMs===r.mtimeMs && s.ctimeMs===r.ctimeMs; }
function check() { if (!matches(fs.fstatSync(fd)) || !matches(fs.lstatSync(d.revision.filePath))) throw Error('stale_file'); }
function exchange(message) { return new Promise(resolve => { parentPort.once('message', resolve); parentPort.postMessage(message); }); }
(async () => {
 try {
  fd=fs.openSync(d.revision.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  check();
  let after=-1;
  let limited=false;
  while (!limited) {
   const reply=await exchange({ kind:'sources', after });
   check();
   if (!reply.rows.length) { if (reply.done) break; after=reply.nextOrdinal; continue; }
   for (const row of reply.rows) {
    after=row.activeOrdinal;
    if (!Number.isSafeInteger(row.sourceLength) || !Number.isSafeInteger(row.sourceOffset) || row.sourceLength<1 || row.sourceOffset<0
      || row.sourceOffset+row.sourceLength>d.revision.size) throw Error('invalid_offset');
    if (row.sourceLength>d.maxRecord) { stats.unsupportedRecords++; continue; }
    if (stats.readBytes+row.sourceLength>64*1024*1024) { stats.unsupportedRecords++; limited=true; break; }
    check();
    const bytes=Buffer.allocUnsafe(row.sourceLength);
    let read=0;
    while(read<bytes.length) { const n=fs.readSync(fd,bytes,read,Math.min(64*1024,bytes.length-read),row.sourceOffset+read);
      if(!n) throw Error('stale_file'); read+=n; stats.readBytes+=n; }
    check();
    let value;
    try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw Error('malformed_record'); }
    if(value.type!=='message' || value.id!==row.eventId || value.message?.role!==row.role) throw Error('stale_offset');
    const content=value.message.content;
    if (typeof content!=='string' && !Array.isArray(content)) { stats.unsupportedRecords++; continue; }
    if (Array.isArray(content) && content.some(p=>!p || typeof p!=='object' || (p.type==='text' && typeof p.text!=='string'))) stats.unsupportedRecords++;
    const text=typeof content==='string' ? content : Array.isArray(content)
      ? content.filter(p=>p && p.type==='text' && typeof p.text==='string').map(p=>p.text).join('\n\n') : '';
    if(!text.trim()) continue;
    const size=Buffer.byteLength(text);
    if(size>d.maxDocument) { stats.unsupportedRecords++; continue; }
    if(stats.textBytes+size>d.maxGeneration) { stats.unsupportedRecords++; limited=true; break; }
    await exchange({kind:'batch', chunks:[{chunkIndex:stats.documents++,role:row.role,text,
      messageId:row.eventId,sourceOffset:row.sourceOffset}]});
    check();
    stats.textBytes+=size;
   }
   after=reply.nextOrdinal;
   if(reply.done) break;
  }
  check();
  fs.closeSync(fd); fd=undefined;
  parentPort.postMessage({kind:'done',stats});
 } catch(error) {
  if(fd!==undefined) fs.closeSync(fd);
  parentPort.postMessage({kind:'failure',code:['stale_file','stale_offset','invalid_offset','malformed_record'].includes(error.message)?error.message:'extraction_failed'});
 }
})();
`;

/** The worker cannot read another source page or emit another batch until acknowledged. */
export async function extractSearchDocuments(options: {
  revision: StructuralIndexRevision;
  signal?: AbortSignal;
  guard: () => void;
  sources: (after: number) => SearchSourcePage | SearchSourceRow[];
  stage: (chunks: Chunk[]) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<ExtractionStats> {
  options.guard();
  if (options.signal?.aborted) throw new Error("search_cancelled");
  const worker = new Worker(SOURCE, { eval: true, workerData: { revision: options.revision,
    maxDocument: SEARCH_MAX_DOCUMENT_BYTES, maxRecord: SEARCH_MAX_RECORD_BYTES, maxGeneration: SEARCH_MAX_GENERATION_BYTES },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
  const handlers = new Set<Promise<void>>();
  try {
    return await new Promise<ExtractionStats>((resolve, reject) => {
      let settled = false;
      let handling = false;
      const finish = (error?: Error, stats?: ExtractionStats) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(stats!);
      };
      const abort = () => finish(new Error("search_cancelled"));
      const timer = setTimeout(() => finish(new Error("extraction_timeout")), options.timeoutMs ?? 60_000);
      options.signal?.addEventListener("abort", abort, { once: true });
      const handleMessage = async (message: any): Promise<void> => {
        if (settled) return;
        if (handling) { finish(new Error("extraction_protocol")); return; }
        handling = true;
        try {
          options.guard();
          if (message.kind === "sources") {
            const selected = options.sources(message.after);
            const page: SearchSourcePage = Array.isArray(selected)
              ? {rows:selected,nextOrdinal:selected.at(-1)?.activeOrdinal ?? message.after,done:selected.length===0} : selected;
            if (page.rows.length > 64 || !Number.isSafeInteger(page.nextOrdinal)
              || (!page.done && page.nextOrdinal <= message.after)) throw new Error("extraction_protocol");
            worker.postMessage(page);
          } else if (message.kind === "batch") {
            const chunks = message.chunks as Chunk[];
            if (chunks.length !== 1 || Buffer.byteLength(chunks[0].text) > SEARCH_MAX_DOCUMENT_BYTES) throw new Error("extraction_protocol");
            await options.stage(chunks);
            options.guard();
            if (!settled) worker.postMessage({ ack: true });
          } else if (message.kind === "done") finish(undefined, message.stats);
          else finish(new Error(message.code ?? "extraction_protocol"));
        } catch (error) { finish(error instanceof Error ? error : new Error("extraction_failed")); }
        finally { handling = false; }
      };
      worker.on("message", (message) => {
        const work = handleMessage(message);
        handlers.add(work);
        void work.finally(() => handlers.delete(work));
      });
      worker.once("error", () => finish(new Error("extraction_worker_failed")));
      worker.once("exit", () => { if (!settled) finish(new Error("extraction_worker_exited")); });
    });
  } finally {
    await worker.terminate();
    // A cancelled worker cannot leave its async staging callback running into
    // the next queue job (or after SQLite closes during shutdown).
    await Promise.allSettled([...handlers]);
  }
}
