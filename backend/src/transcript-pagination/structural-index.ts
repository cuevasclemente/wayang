import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { getConfig } from "../config.js";
import {
  isStructurallyVisibleTranscriptEntry,
  readTranscriptFileRevision,
  sameTranscriptIdentity,
  TRANSCRIPT_PAGE_MAX_BYTES,
  type TranscriptFileRevision,
} from "./reverse-reader.js";

const INDEX_SCHEMA_VERSION = 1;
const TAIL_WITNESS_BYTES = 4_096;
export const TRANSCRIPT_INDEX_MAX_TOPOLOGY_ENTRIES = 25_000;
const TRANSCRIPT_INDEX_PUBLISH_BATCH_SIZE = 1_000;
const TRANSCRIPT_INDEX_MAX_WORKER_CONCURRENCY = 2;
const TRANSCRIPT_INDEX_MAX_QUEUED_BUILDS = 64;
export const TRANSCRIPT_INDEX_MAX_READ_BYTES = 384 * 1024;
export const TRANSCRIPT_APPEND_REFRESH_MAX_BYTES = 1024 * 1024;

export type IndexedReadPreference = "latest" | "earliest" | "around";

export interface StructuralIndexRevision extends TranscriptFileRevision {
  sessionId: string;
  filePath: string;
  transcriptEpoch: string;
  branchTipId: string | null;
  indexedSize: number;
  complete: boolean;
  error: string | null;
}

export interface IndexedSourceRow {
  eventId: string;
  activeOrdinal: number;
  visibleOrdinal: number;
  sourceOffset: number;
  sourceLength: number;
}

export interface IndexedReadResult {
  entries: any[];
  rows: IndexedSourceRow[];
  sourceBytesRead: number;
}

export interface IndexedWindowSelection {
  revision: StructuralIndexRevision;
  rows: IndexedSourceRow[];
  anchor: {
    requested_id: string;
    resolved_id: string | null;
    status: "found" | "missing" | "off_branch";
  } | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

interface WorkerEntry {
  eventId: string;
  parentId: string | null;
  physicalOrdinal: number;
  sourceOffset: number;
  sourceLength: number;
  eventType: string;
  displayClass: string;
  visible: number;
}

interface WorkerResult {
  revision: TranscriptFileRevision;
  entries: WorkerEntry[];
  activeIds: string[];
  branchTipId: string | null;
  complete: boolean;
  error: string | null;
  endedNewline: boolean;
  tailDigest: string;
}

const WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
if (workerData.delayMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.delayMs);
}
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_TOPOLOGY_ENTRIES = ${TRANSCRIPT_INDEX_MAX_TOPOLOGY_ENTRIES};
const TAIL_WITNESS_BYTES = ${TAIL_WITNESS_BYTES};
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function visible(e) {
  if (!e || typeof e !== "object") return 0;
  if (e.type === "message" || e.type === "custom_message") return 1;
  if ((e.type === "branch_summary" || e.type === "compaction") && typeof e.summary === "string" && e.summary.length) return 1;
  return e.type === "custom" && (e.customType === "wayang-deleted-event-v1" || e.customType === "wayang-agent-change") ? 1 : 0;
}
function displayClass(e) {
  if (e.type === "message") return typeof e.message?.role === "string" ? e.message.role : "message";
  if (e.type === "custom_message") return "custom_message";
  if (e.type === "compaction") return "compaction_summary";
  if (e.type === "branch_summary") return "branch_summary";
  if (e.type === "custom") return String(e.customType || "custom");
  return "hidden";
}
let fd;
try {
  fd = fs.openSync(workerData.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const before = fs.fstatSync(fd);
  if (!before.isFile()) throw new Error("Transcript is not a regular file");

  const entries = [];
  let topologyLimitExceeded = false;
  let branchTipId = null;
  let ordinal = 0;
  let lineStartOffset = 0;
  let lineParts = [];
  let lineBytes = 0;
  let header = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let endedNewline = before.size === 0;

  function appendLinePart(part) {
    if (!part.length) return;
    const copy = Buffer.from(part);
    lineParts.push(copy);
    lineBytes += copy.length;
  }

  function consumeLine(sourceLength) {
    const physicalRaw = lineParts.length === 0
      ? Buffer.alloc(0)
      : lineParts.length === 1
        ? lineParts[0]
        : Buffer.concat(lineParts, lineBytes);
    if (ordinal === 0) header = Buffer.from(physicalRaw);
    const raw = physicalRaw.length > 0 && physicalRaw[physicalRaw.length - 1] === 13
      ? physicalRaw.subarray(0, physicalRaw.length - 1)
      : physicalRaw;
    if (raw.length > 0) {
      try {
        const value = JSON.parse(raw.toString("utf8"));
        if (value && typeof value.id === "string") {
          const eventType = typeof value.type === "string" ? value.type : "unknown";
          if (entries.length >= MAX_TOPOLOGY_ENTRIES) {
            topologyLimitExceeded = true;
          } else entries.push({
            eventId: value.id,
            parentId: typeof value.parentId === "string" ? value.parentId : null,
            physicalOrdinal: ordinal,
            sourceOffset: lineStartOffset,
            sourceLength,
            eventType,
            displayClass: displayClass(value),
            visible: visible(value),
          });
          if (eventType !== "session_info" && eventType !== "session") branchTipId = value.id;
        }
      } catch { /* Pi tolerates malformed physical lines */ }
    }
    ordinal++;
    lineParts = [];
    lineBytes = 0;
    lineStartOffset += sourceLength;
  }

  function updateTail(chunk) {
    if (chunk.length >= TAIL_WITNESS_BYTES) {
      tail = Buffer.from(chunk.subarray(chunk.length - TAIL_WITNESS_BYTES));
      return;
    }
    const combined = Buffer.concat([tail, chunk], tail.length + chunk.length);
    tail = combined.length > TAIL_WITNESS_BYTES
      ? Buffer.from(combined.subarray(combined.length - TAIL_WITNESS_BYTES))
      : combined;
  }

  let position = 0;
  const block = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  while (position < before.size) {
    const requested = Math.min(block.length, before.size - position);
    const count = fs.readSync(fd, block, 0, requested, position);
    if (count === 0) break;
    const chunk = block.subarray(0, count);
    updateTail(chunk);
    endedNewline = chunk[chunk.length - 1] === 10;
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      appendLinePart(chunk.subarray(segmentStart, index));
      const absoluteEnd = position + index + 1;
      consumeLine(absoluteEnd - lineStartOffset);
      segmentStart = index + 1;
    }
    appendLinePart(chunk.subarray(segmentStart));
    position += count;
  }
  if (position !== before.size) throw new Error("Transcript ended during structural indexing");
  if (lineStartOffset < before.size) consumeLine(before.size - lineStartOffset);

  let mutationEpoch = sha(header);
  try {
    const headerJson = header.length > 0 && header[header.length - 1] === 13
      ? header.subarray(0, header.length - 1)
      : header;
    const h = JSON.parse(headerJson.toString("utf8"));
    const explicit = h?.mutationEpoch ?? h?.mutation_epoch ?? h?.wayangMutationEpoch;
    if (typeof explicit === "string" || typeof explicit === "number") mutationEpoch = String(explicit);
  } catch {}
  const byId = new Map();
  let duplicate = false;
  for (const entry of entries) {
    if (byId.has(entry.eventId)) duplicate = true;
    else byId.set(entry.eventId, entry);
  }
  const newest = [];
  const seen = new Set();
  let current = branchTipId;
  let error = topologyLimitExceeded ? "topology_entry_limit" : duplicate ? "duplicate_event_id" : null;
  while (current) {
    if (seen.has(current)) { error = error || "cyclic_parent_topology"; break; }
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) { error = error || "missing_parent"; break; }
    newest.push(current);
    current = entry.parentId;
  }
  const after = fs.fstatSync(fd);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error("Transcript changed during structural indexing");
  }
  parentPort.postMessage({
    revision: { device: Number(before.dev) || 0, inode: Number(before.ino) || 0, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, headerDigest: sha(header), mutationEpoch },
    entries,
    activeIds: newest.reverse(),
    branchTipId,
    complete: !error,
    error,
    endedNewline,
    tailDigest: sha(tail),
  });
} catch (error) {
  parentPort.postMessage({ workerError: error && error.message ? error.message : String(error) });
} finally { if (fd !== undefined) fs.closeSync(fd); }
`;

function revisionsExactlyEqual(left: TranscriptFileRevision, right: TranscriptFileRevision): boolean {
  return sameTranscriptIdentity(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function tailDigest(filePath: string, end: number): string {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < end) throw new Error("Transcript revision changed");
    const start = Math.max(0, end - TAIL_WITNESS_BYTES);
    const bytes = Buffer.allocUnsafe(end - start);
    const read = fs.readSync(fd, bytes, 0, bytes.length, start);
    return createHash("sha256").update(bytes.subarray(0, read)).digest("hex");
  } finally { fs.closeSync(fd); }
}

function structuralBuildKey(sessionId: string, filePath: string, revision: TranscriptFileRevision): string {
  return JSON.stringify([
    sessionId, filePath, revision.device, revision.inode, revision.size,
    revision.mtimeMs, revision.ctimeMs, revision.headerDigest, revision.mutationEpoch,
  ]);
}

interface StructuralWorkerTask {
  key: string;
  sessionId: string;
  filePath: string;
  promise: Promise<WorkerResult>;
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
  cancelWorker?: () => void;
}

export interface StructuralTranscriptIndexOptions {
  /** @internal Deterministic publication race seam; receives canonical paths. */
  beforePublishForTests?: (sessionId: string, filePath: string) => void | Promise<void>;
  /** @internal Proves the synchronous append seam was selected. */
  onAppendRefreshForTests?: (sessionId: string, appendedBytes: number) => void;
  /** @internal Proves append parsing stopped before over-limit topology work. */
  onAppendTopologyLimitForTests?: (sessionId: string, existingEntries: number, attemptedEntries: number) => void;
  workerTimeoutMs?: number;
  /** @internal Worker-side delay for concurrency/timeout tests. */
  workerDelayMsForTests?: number;
  /** @internal Called after each staged SQL publication batch. */
  afterPublishBatchForTests?: (sessionId: string, batchNumber: number) => void | Promise<void>;
}

export class StructuralTranscriptIndex {
  private readonly db: DatabaseType;
  private readonly builds = new Map<string, Promise<StructuralIndexRevision>>();
  private readonly latestBuildKeys = new Map<string, string>();
  private readonly workerQueue: StructuralWorkerTask[] = [];
  private readonly activeWorkerTasks = new Map<string, StructuralWorkerTask>();
  private activeWorkerCount = 0;
  private peakWorkerCount = 0;
  private workerTimeouts = 0;
  private workersStarted = 0;
  private readonly invalidationGenerations = new Map<string, number>();
  private lastSourceBytesRead = 0;
  private totalSourceBytesRead = 0;

  constructor(
    dbPath = path.join(getConfig().dataDir, "transcript-index.db"),
    private readonly options: StructuralTranscriptIndexOptions = {},
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    fs.chmodSync(dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  async ensure(sessionId: string, filePath: string): Promise<StructuralIndexRevision> {
    const canonicalPath = path.resolve(filePath);
    const current = readTranscriptFileRevision(canonicalPath);
    const key = structuralBuildKey(sessionId, canonicalPath, current);
    this.latestBuildKeys.set(sessionId, key);
    this.cancelSupersededWorkerTasks(sessionId, key);
    const existingBuild = this.builds.get(key);
    if (existingBuild) return existingBuild;
    const stored = this.readRevision(sessionId);
    if (stored && stored.filePath === canonicalPath && revisionsExactlyEqual(stored, current)
      && (stored.complete || stored.error !== "building")) return stored;
    if (stored?.error === "building") {
      this.db.prepare("DELETE FROM transcript_revisions WHERE session_id=?").run(sessionId);
    }
    if (stored && stored.filePath === canonicalPath && current.size > stored.indexedSize
      && current.size - stored.indexedSize <= TRANSCRIPT_APPEND_REFRESH_MAX_BYTES
      && sameTranscriptIdentity(stored, current) && this.canAppend(stored, canonicalPath)) {
      try {
        this.options.onAppendRefreshForTests?.(sessionId, current.size - stored.indexedSize);
        return this.appendRefresh(stored, current);
      }
      catch { /* unsafe append falls through to an epoch rebuild */ }
    }
    const build = this.fullBuild(sessionId, canonicalPath, key);
    this.builds.set(key, build);
    try { return await build; }
    finally { if (this.builds.get(key) === build) this.builds.delete(key); }
  }

  async around(sessionId: string, filePath: string, anchorId: string, limit = 200): Promise<IndexedWindowSelection> {
    const revision = await this.ensure(sessionId, filePath);
    if (!revision.complete) throw new Error(`Transcript topology is incomplete: ${revision.error ?? "unknown"}`);
    const anyEntry = this.db.prepare(
      "SELECT display_class FROM transcript_entries WHERE session_id = ? AND transcript_epoch = ? AND event_id = ?",
    ).get(sessionId, revision.transcriptEpoch, anchorId) as { display_class: string } | undefined;
    if (anyEntry?.display_class === "wayang-deleted-event-v1"
      || anyEntry?.display_class === "wayang-invalidated-derived-event-v1") {
      return { revision, rows: [], anchor: { requested_id: anchorId, resolved_id: null, status: "missing" }, hasOlder: false, hasNewer: false };
    }
    const active = this.db.prepare(
      "SELECT active_ordinal, visible_ordinal FROM active_branch_entries WHERE session_id = ? AND transcript_epoch = ? AND event_id = ?",
    ).get(sessionId, revision.transcriptEpoch, anchorId) as { active_ordinal: number; visible_ordinal: number | null } | undefined;
    if (!active) {
      return { revision, rows: [], anchor: { requested_id: anchorId, resolved_id: null, status: anyEntry ? "off_branch" : "missing" }, hasOlder: false, hasNewer: false };
    }
    const resolved = active.visible_ordinal === null
      ? this.db.prepare(
          `SELECT event_id, visible_ordinal FROM active_branch_entries
           WHERE session_id = ? AND transcript_epoch = ? AND visible_ordinal IS NOT NULL
           ORDER BY ABS(active_ordinal - ?) ASC LIMIT 1`,
        ).get(sessionId, revision.transcriptEpoch, active.active_ordinal) as { event_id: string; visible_ordinal: number } | undefined
      : { event_id: anchorId, visible_ordinal: active.visible_ordinal };
    if (!resolved) return { revision, rows: [], anchor: { requested_id: anchorId, resolved_id: null, status: "missing" }, hasOlder: false, hasNewer: false };
    const before = Math.floor((limit - 1) / 2);
    const start = Math.max(0, resolved.visible_ordinal - before);
    const rows = this.visibleRange(revision, start, limit);
    return {
      revision,
      rows,
      anchor: { requested_id: anchorId, resolved_id: resolved.event_id, status: "found" },
      hasOlder: rows.length > 0 && rows[0].visibleOrdinal > 0,
      hasNewer: rows.length > 0 && this.hasVisibleAfter(revision, rows.at(-1)!.visibleOrdinal),
    };
  }

  async adjacent(
    sessionId: string,
    filePath: string,
    direction: "before" | "after",
    boundaryVisibleOrdinal: number,
    limit = 200,
  ): Promise<IndexedWindowSelection> {
    const revision = await this.ensure(sessionId, filePath);
    if (!revision.complete) throw new Error(`Transcript topology is incomplete: ${revision.error ?? "unknown"}`);
    let rows: IndexedSourceRow[];
    if (direction === "before") {
      rows = (this.db.prepare(
        `SELECT event_id, active_ordinal, visible_ordinal, source_offset, source_length
         FROM active_branch_entries WHERE session_id = ? AND transcript_epoch = ?
           AND visible_ordinal IS NOT NULL AND visible_ordinal < ?
         ORDER BY visible_ordinal DESC LIMIT ?`,
      ).all(sessionId, revision.transcriptEpoch, boundaryVisibleOrdinal, limit) as any[]).reverse().map(this.mapRow);
    } else {
      rows = (this.db.prepare(
        `SELECT event_id, active_ordinal, visible_ordinal, source_offset, source_length
         FROM active_branch_entries WHERE session_id = ? AND transcript_epoch = ?
           AND visible_ordinal IS NOT NULL AND visible_ordinal > ?
         ORDER BY visible_ordinal ASC LIMIT ?`,
      ).all(sessionId, revision.transcriptEpoch, boundaryVisibleOrdinal, limit) as any[]).map(this.mapRow);
    }
    return {
      revision,
      rows,
      anchor: null,
      hasOlder: rows.length > 0 && rows[0].visibleOrdinal > 0,
      hasNewer: rows.length > 0 && this.hasVisibleAfter(revision, rows.at(-1)!.visibleOrdinal),
    };
  }

  tryLatestCurrent(sessionId: string, filePath: string, limit = 200): IndexedWindowSelection | null {
    const canonicalPath = path.resolve(filePath);
    let current: TranscriptFileRevision;
    try { current = readTranscriptFileRevision(canonicalPath); }
    catch { return null; }
    const revision = this.readRevision(sessionId);
    if (!revision || revision.filePath !== canonicalPath || !revision.complete || !revisionsExactlyEqual(revision, current)) return null;
    const rows = (this.db.prepare(
      `SELECT event_id,active_ordinal,visible_ordinal,source_offset,source_length FROM active_branch_entries
       WHERE session_id=? AND transcript_epoch=? AND visible_ordinal IS NOT NULL
       ORDER BY visible_ordinal DESC LIMIT ?`,
    ).all(sessionId, revision.transcriptEpoch, limit) as any[]).reverse().map(this.mapRow);
    return {
      revision,
      rows,
      anchor: null,
      hasOlder: rows.length > 0 && rows[0].visibleOrdinal > 0,
      hasNewer: false,
    };
  }

  tryBeforeEventCurrent(
    sessionId: string,
    filePath: string,
    eventId: string,
    limit = 200,
  ): IndexedWindowSelection | null {
    const latest = this.tryLatestCurrent(sessionId, filePath, 1);
    if (!latest) return null;
    const target = this.db.prepare(
      `SELECT visible_ordinal FROM active_branch_entries
       WHERE session_id=? AND transcript_epoch=? AND event_id=? AND visible_ordinal IS NOT NULL`,
    ).get(sessionId, latest.revision.transcriptEpoch, eventId) as { visible_ordinal: number } | undefined;
    if (!target) return null;
    const rows = (this.db.prepare(
      `SELECT event_id,active_ordinal,visible_ordinal,source_offset,source_length FROM active_branch_entries
       WHERE session_id=? AND transcript_epoch=? AND visible_ordinal IS NOT NULL AND visible_ordinal<=?
       ORDER BY visible_ordinal DESC LIMIT ?`,
    ).all(sessionId, latest.revision.transcriptEpoch, target.visible_ordinal, limit) as any[]).reverse().map(this.mapRow);
    return {
      revision: latest.revision,
      rows,
      anchor: null,
      hasOlder: rows.length > 0 && rows[0].visibleOrdinal > 0,
      hasNewer: this.hasVisibleAfter(latest.revision, rows.at(-1)?.visibleOrdinal ?? target.visible_ordinal),
    };
  }

  async activeProjection(sessionId: string, filePath: string): Promise<{
    revision: StructuralIndexRevision;
    eventIds: Set<string>;
  }> {
    const revision = await this.ensure(sessionId, filePath);
    if (!revision.complete) throw new Error(`Transcript topology is incomplete: ${revision.error ?? "unknown"}`);
    const eventIds = new Set((this.db.prepare(
      "SELECT event_id FROM active_branch_entries WHERE session_id=? AND transcript_epoch=?",
    ).all(sessionId, revision.transcriptEpoch) as Array<{ event_id: string }>).map((row) => row.event_id));
    return { revision, eventIds };
  }

  async activeEventIds(sessionId: string, filePath: string): Promise<Set<string>> {
    return (await this.activeProjection(sessionId, filePath)).eventIds;
  }

  readBoundedEntries(
    revision: StructuralIndexRevision,
    rows: readonly IndexedSourceRow[],
    options: {
      preference: IndexedReadPreference;
      anchorEventId?: string | null;
      maxSourceBytes?: number;
    },
  ): IndexedReadResult {
    if (rows.length === 0) {
      this.lastSourceBytesRead = 0;
      return { entries: [], rows: [], sourceBytesRead: 0 };
    }
    const maxSourceBytes = options.maxSourceBytes ?? TRANSCRIPT_INDEX_MAX_READ_BYTES;
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > TRANSCRIPT_PAGE_MAX_BYTES) {
      throw new Error("Indexed transcript read budget is invalid");
    }
    const current = readTranscriptFileRevision(revision.filePath);
    if (!revisionsExactlyEqual(revision, current)) throw new Error("Transcript index revision is stale");

    const cost = (row: IndexedSourceRow) => row.sourceLength > maxSourceBytes ? 0 : row.sourceLength;
    let retained: IndexedSourceRow[] = [];
    let retainedCost = 0;
    if (options.preference === "latest") {
      for (let index = rows.length - 1; index >= 0; index--) {
        const nextCost = cost(rows[index]);
        if (retained.length > 0 && retainedCost + nextCost > maxSourceBytes) break;
        retained.unshift(rows[index]);
        retainedCost += nextCost;
      }
    } else if (options.preference === "earliest") {
      for (const row of rows) {
        const nextCost = cost(row);
        if (retained.length > 0 && retainedCost + nextCost > maxSourceBytes) break;
        retained.push(row);
        retainedCost += nextCost;
      }
    } else {
      const anchorIndex = Math.max(0, rows.findIndex((row) => row.eventId === options.anchorEventId));
      let left = anchorIndex;
      let right = anchorIndex;
      retained = [rows[anchorIndex]];
      retainedCost = cost(rows[anchorIndex]);
      let blockLeft = false;
      let blockRight = false;
      while ((!blockLeft && left > 0) || (!blockRight && right + 1 < rows.length)) {
        const preferLeft = !blockLeft && left > 0 && (blockRight || right - anchorIndex >= anchorIndex - left);
        const candidate = preferLeft ? rows[left - 1] : rows[right + 1];
        const nextCost = cost(candidate);
        if (retainedCost + nextCost > maxSourceBytes) {
          if (preferLeft) blockLeft = true;
          else blockRight = true;
          continue;
        }
        retainedCost += nextCost;
        if (preferLeft) left--;
        else right++;
        retained = rows.slice(left, right + 1);
      }
    }
    if (retained.length === 0) retained = [options.preference === "latest" ? rows.at(-1)! : rows[0]];

    type SourceRow = {
      source_offset: number;
      source_length: number;
      event_id: string;
      parent_id: string | null;
      display_class: string;
      visible_ordinal: number | null;
    };
    const selectSources = (selectedRows: readonly IndexedSourceRow[]): SourceRow[] => {
      const firstOrdinal = selectedRows[0].activeOrdinal;
      const lastOrdinal = selectedRows.at(-1)!.activeOrdinal;
      return this.db.prepare(
        `SELECT a.source_offset,a.source_length,a.visible_ordinal,t.event_id,t.parent_id,t.display_class
         FROM active_branch_entries AS a
         JOIN transcript_entries AS t ON t.session_id=a.session_id AND t.transcript_epoch=a.transcript_epoch AND t.event_id=a.event_id
         WHERE a.session_id=? AND a.transcript_epoch=?
           AND (a.visible_ordinal IS NOT NULL OR t.display_class='wayang-overflow-retry-v1')
           AND a.active_ordinal > COALESCE((SELECT MAX(active_ordinal) FROM active_branch_entries
             WHERE session_id=? AND transcript_epoch=? AND visible_ordinal IS NOT NULL AND active_ordinal < ?), -1)
           AND a.active_ordinal < COALESCE((SELECT MIN(active_ordinal) FROM active_branch_entries
             WHERE session_id=? AND transcript_epoch=? AND visible_ordinal IS NOT NULL AND active_ordinal > ?), 9223372036854775807)
         ORDER BY a.active_ordinal`,
      ).all(revision.sessionId, revision.transcriptEpoch,
        revision.sessionId, revision.transcriptEpoch, firstOrdinal,
        revision.sessionId, revision.transcriptEpoch, lastOrdinal) as SourceRow[];
    };
    let sources = selectSources(retained);
    const aggregateCost = (values: readonly SourceRow[]) => values.reduce((total, row) => (
      total + (row.source_length > maxSourceBytes && row.visible_ordinal !== null ? 0 : row.source_length)
    ), 0);
    while (retained.length > 1 && aggregateCost(sources) > maxSourceBytes) {
      if (options.preference === "latest") retained.shift();
      else if (options.preference === "earliest") retained.pop();
      else {
        const anchorIndex = retained.findIndex((row) => row.eventId === options.anchorEventId);
        if (anchorIndex < 0 || anchorIndex >= retained.length / 2) retained.shift();
        else retained.pop();
      }
      sources = selectSources(retained);
    }
    if (aggregateCost(sources) > maxSourceBytes) {
      // Overflow-retry markers are serializer context, not visible rows. If a
      // pathological marker alone exceeds the aggregate budget, omit it rather
      // than violating the disk-read ceiling.
      sources = sources.filter((row) => row.visible_ordinal !== null);
    }

    const fd = fs.openSync(revision.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const entries: any[] = [];
    let sourceBytesRead = 0;
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error("Transcript is not a regular file");
      for (const row of sources) {
        if (row.source_length > maxSourceBytes && row.visible_ordinal !== null) {
          entries.push({
            type: "custom_message",
            id: row.event_id,
            parentId: row.parent_id,
            customType: "wayang-transcript-event-placeholder-v1",
            content: "This transcript event is too large to include in a bounded window.",
            display: true,
            details: { reason: "payload_limit", encoded_bytes: row.source_length },
          });
          continue;
        }
        if (sourceBytesRead + row.source_length > maxSourceBytes) continue;
        const bytes = Buffer.allocUnsafe(row.source_length);
        let read = 0;
        while (read < bytes.length) {
          const count = fs.readSync(fd, bytes, read, bytes.length - read, row.source_offset + read);
          if (count === 0) break;
          read += count;
          sourceBytesRead += count;
        }
        if (read !== bytes.length) throw new Error("Indexed transcript source row was truncated");
        entries.push(JSON.parse(bytes.toString("utf8").trim()));
      }
      const after = fs.fstatSync(fd);
      if (Number(after.dev) !== revision.device || Number(after.ino) !== revision.inode
        || after.size !== revision.size || after.mtimeMs !== revision.mtimeMs || after.ctimeMs !== revision.ctimeMs) {
        throw new Error("Transcript changed while indexed entries were read");
      }
    } finally { fs.closeSync(fd); }
    if (!revisionsExactlyEqual(revision, readTranscriptFileRevision(revision.filePath))) {
      throw new Error("Transcript path changed while indexed entries were read");
    }
    this.lastSourceBytesRead = sourceBytesRead;
    this.totalSourceBytesRead += sourceBytesRead;
    return { entries, rows: retained, sourceBytesRead };
  }

  getReadInstrumentation(): { lastSourceBytesRead: number; totalSourceBytesRead: number } {
    return { lastSourceBytesRead: this.lastSourceBytesRead, totalSourceBytesRead: this.totalSourceBytesRead };
  }

  purge(sessionId: string): void {
    this.invalidationGenerations.set(sessionId, (this.invalidationGenerations.get(sessionId) ?? 0) + 1);
    this.latestBuildKeys.delete(sessionId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM transcript_revisions WHERE session_id = ?").run(sessionId);
    })();
  }

  async close(): Promise<void> {
    for (const task of this.workerQueue.splice(0)) {
      task.cancelled = true;
      task.reject(new Error("Structural index closed"));
    }
    for (const task of this.activeWorkerTasks.values()) {
      task.cancelled = true;
      task.cancelWorker?.();
    }
    const pending = [...this.builds.values()];
    await Promise.allSettled(pending);
    this.builds.clear();
    this.latestBuildKeys.clear();
    this.activeWorkerTasks.clear();
    try { this.db.close(); } catch { /* already closed */ }
  }

  getWorkerInstrumentation(): {
    active: number;
    peakActive: number;
    queued: number;
    timeouts: number;
    workersStarted: number;
  } {
    return {
      active: this.activeWorkerCount,
      peakActive: this.peakWorkerCount,
      queued: this.workerQueue.length,
      timeouts: this.workerTimeouts,
      workersStarted: this.workersStarted,
    };
  }

  private cancelSupersededWorkerTasks(sessionId: string, currentKey: string): void {
    for (let index = this.workerQueue.length - 1; index >= 0; index--) {
      const task = this.workerQueue[index];
      if (task.sessionId !== sessionId || task.key === currentKey) continue;
      this.workerQueue.splice(index, 1);
      task.cancelled = true;
      task.reject(new Error("Structural index build superseded"));
    }
    for (const task of this.activeWorkerTasks.values()) {
      if (task.sessionId !== sessionId || task.key === currentKey) continue;
      task.cancelled = true;
      task.cancelWorker?.();
    }
  }

  private scheduleWorkerBuild(sessionId: string, filePath: string, key: string): Promise<WorkerResult> {
    let resolveTask!: (result: WorkerResult) => void;
    let rejectTask!: (error: Error) => void;
    const promise = new Promise<WorkerResult>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const task: StructuralWorkerTask = {
      key, sessionId, filePath, promise,
      resolve: resolveTask,
      reject: rejectTask,
      cancelled: false,
    };
    if (this.workerQueue.length >= TRANSCRIPT_INDEX_MAX_QUEUED_BUILDS) {
      const evicted = this.workerQueue.shift()!;
      evicted.cancelled = true;
      evicted.reject(new Error("Structural index build queue is full"));
    }
    this.workerQueue.push(task);
    this.pumpWorkerQueue();
    return promise;
  }

  private pumpWorkerQueue(): void {
    while (this.activeWorkerCount < TRANSCRIPT_INDEX_MAX_WORKER_CONCURRENCY && this.workerQueue.length > 0) {
      const task = this.workerQueue.shift()!;
      if (task.cancelled) continue;
      this.activeWorkerCount++;
      this.peakWorkerCount = Math.max(this.peakWorkerCount, this.activeWorkerCount);
      this.activeWorkerTasks.set(task.key, task);
      void this.executeWorkerTask(task).finally(() => {
        this.activeWorkerTasks.delete(task.key);
        this.activeWorkerCount = Math.max(0, this.activeWorkerCount - 1);
        this.pumpWorkerQueue();
      });
    }
  }

  private async executeWorkerTask(task: StructuralWorkerTask): Promise<void> {
    try {
      const result = await new Promise<WorkerResult>((resolve, reject) => {
        this.workersStarted++;
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { filePath: task.filePath, delayMs: Math.max(0, this.options.workerDelayMsForTests ?? 0) },
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
        });
        let settled = false;
        let timer: NodeJS.Timeout | null = null;
        const terminate = (error: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          void worker.terminate().finally(() => reject(error));
        };
        task.cancelWorker = () => terminate(new Error("Structural index build cancelled"));
        const timeoutMs = Math.max(100, Math.min(this.options.workerTimeoutMs ?? 30_000, 120_000));
        timer = setTimeout(() => {
          this.workerTimeouts++;
          terminate(new Error("Structural index worker timed out"));
        }, timeoutMs);
        timer.unref?.();
        worker.once("message", (message: WorkerResult & { workerError?: string }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          task.cancelWorker = undefined;
          void worker.terminate().finally(() => {
            if (message.workerError) reject(new Error(message.workerError));
            else resolve(message);
          });
        });
        worker.once("error", (error) => terminate(
          error instanceof Error ? error : new Error(String(error)),
        ));
        worker.once("exit", () => {
          if (!settled) terminate(new Error("Structural index worker exited unexpectedly"));
        });
      });
      if (task.cancelled) throw new Error("Structural index build cancelled");
      task.resolve(result);
    } catch (error) {
      task.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      task.cancelWorker = undefined;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_revisions (
        session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, device INTEGER NOT NULL, inode INTEGER NOT NULL,
        file_size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL, header_digest TEXT NOT NULL,
        mutation_epoch TEXT NOT NULL, transcript_epoch TEXT NOT NULL, branch_tip_id TEXT, indexed_size INTEGER NOT NULL,
        complete INTEGER NOT NULL, error TEXT, ended_newline INTEGER NOT NULL, tail_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_entries (
        session_id TEXT NOT NULL, transcript_epoch TEXT NOT NULL, event_id TEXT NOT NULL, parent_id TEXT,
        physical_ordinal INTEGER NOT NULL, source_offset INTEGER NOT NULL, source_length INTEGER NOT NULL,
        event_type TEXT NOT NULL, display_class TEXT NOT NULL, visible INTEGER NOT NULL,
        PRIMARY KEY(session_id, transcript_epoch, event_id),
        FOREIGN KEY(session_id) REFERENCES transcript_revisions(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS transcript_entries_parent ON transcript_entries(session_id, transcript_epoch, parent_id);
      CREATE TABLE IF NOT EXISTS active_branch_entries (
        session_id TEXT NOT NULL, transcript_epoch TEXT NOT NULL, active_ordinal INTEGER NOT NULL,
        visible_ordinal INTEGER, event_id TEXT NOT NULL, source_offset INTEGER NOT NULL, source_length INTEGER NOT NULL,
        PRIMARY KEY(session_id, transcript_epoch, active_ordinal),
        UNIQUE(session_id, transcript_epoch, event_id),
        FOREIGN KEY(session_id) REFERENCES transcript_revisions(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS active_visible ON active_branch_entries(session_id, transcript_epoch, visible_ordinal);
    `);
    const version = this.db.prepare("SELECT value FROM transcript_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (version && Number(version.value) !== INDEX_SCHEMA_VERSION) {
      this.db.exec("DELETE FROM transcript_revisions");
    }
    this.db.prepare("INSERT INTO transcript_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(INDEX_SCHEMA_VERSION));
  }

  private async fullBuild(sessionId: string, filePath: string, buildKey: string): Promise<StructuralIndexRevision> {
    const generation = this.invalidationGenerations.get(sessionId) ?? 0;
    const result = await this.scheduleWorkerBuild(sessionId, filePath, buildKey);
    await this.options.beforePublishForTests?.(sessionId, filePath);
    if ((this.invalidationGenerations.get(sessionId) ?? 0) !== generation
      || this.latestBuildKeys.get(sessionId) !== buildKey) {
      throw new Error("Transcript structural index build was invalidated");
    }
    const current = readTranscriptFileRevision(filePath);
    if (!revisionsExactlyEqual(result.revision, current)
      || structuralBuildKey(sessionId, filePath, current) !== buildKey) {
      throw new Error("Transcript changed before structural index publication");
    }
    const epoch = randomUUID();
    try {
      await this.publishStaged(sessionId, filePath, epoch, result, generation, buildKey);
    } catch (error) {
      this.db.prepare("DELETE FROM transcript_revisions WHERE session_id=? AND transcript_epoch=?").run(sessionId, epoch);
      throw error;
    }
    return this.readRevision(sessionId)!;
  }

  private assertBuildCurrent(
    sessionId: string,
    filePath: string,
    generation: number,
    buildKey: string,
    expected: TranscriptFileRevision,
  ): void {
    if ((this.invalidationGenerations.get(sessionId) ?? 0) !== generation
      || this.latestBuildKeys.get(sessionId) !== buildKey) {
      throw new Error("Transcript structural index build was invalidated");
    }
    const current = readTranscriptFileRevision(filePath);
    if (!revisionsExactlyEqual(expected, current)
      || structuralBuildKey(sessionId, filePath, current) !== buildKey) {
      throw new Error("Transcript changed during staged structural publication");
    }
  }

  private async publishStaged(
    sessionId: string,
    filePath: string,
    epoch: string,
    result: WorkerResult,
    generation: number,
    buildKey: string,
  ): Promise<void> {
    this.assertBuildCurrent(sessionId, filePath, generation, buildKey, result.revision);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM transcript_revisions WHERE session_id=?").run(sessionId);
      this.db.prepare(`INSERT INTO transcript_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        sessionId, filePath, result.revision.device, result.revision.inode, result.revision.size,
        result.revision.mtimeMs, result.revision.ctimeMs, result.revision.headerDigest, result.revision.mutationEpoch,
        epoch, result.branchTipId, result.revision.size, 0, "building",
        result.endedNewline ? 1 : 0, result.tailDigest,
      );
    })();

    const insertEntry = this.db.prepare(`INSERT INTO transcript_entries VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let batchNumber = 0;
    for (let offset = 0; offset < result.entries.length; offset += TRANSCRIPT_INDEX_PUBLISH_BATCH_SIZE) {
      this.assertBuildCurrent(sessionId, filePath, generation, buildKey, result.revision);
      const batch = result.entries.slice(offset, offset + TRANSCRIPT_INDEX_PUBLISH_BATCH_SIZE);
      this.db.transaction(() => {
        for (const entry of batch) insertEntry.run(sessionId, epoch, entry.eventId, entry.parentId,
          entry.physicalOrdinal, entry.sourceOffset, entry.sourceLength, entry.eventType, entry.displayClass, entry.visible);
      })();
      batchNumber++;
      await this.options.afterPublishBatchForTests?.(sessionId, batchNumber);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const byId = new Map(result.entries.map((entry) => [entry.eventId, entry]));
    const insertActive = this.db.prepare(`INSERT INTO active_branch_entries VALUES (?,?,?,?,?,?,?)`);
    let visibleOrdinal = 0;
    for (let offset = 0; offset < result.activeIds.length; offset += TRANSCRIPT_INDEX_PUBLISH_BATCH_SIZE) {
      this.assertBuildCurrent(sessionId, filePath, generation, buildKey, result.revision);
      const batch = result.activeIds.slice(offset, offset + TRANSCRIPT_INDEX_PUBLISH_BATCH_SIZE);
      this.db.transaction(() => {
        batch.forEach((eventId, index) => {
          const entry = byId.get(eventId);
          if (!entry) return;
          const visible = entry.visible ? visibleOrdinal++ : null;
          insertActive.run(sessionId, epoch, offset + index, visible, eventId, entry.sourceOffset, entry.sourceLength);
        });
      })();
      batchNumber++;
      await this.options.afterPublishBatchForTests?.(sessionId, batchNumber);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    this.assertBuildCurrent(sessionId, filePath, generation, buildKey, result.revision);
    this.db.prepare(`UPDATE transcript_revisions SET complete=?,error=? WHERE session_id=? AND transcript_epoch=?`).run(
      result.complete ? 1 : 0,
      result.error,
      sessionId,
      epoch,
    );
  }

  private canAppend(stored: StructuralIndexRevision, filePath: string): boolean {
    const row = this.db.prepare("SELECT ended_newline, tail_digest FROM transcript_revisions WHERE session_id = ?").get(stored.sessionId) as { ended_newline: number; tail_digest: string } | undefined;
    return Boolean(row?.ended_newline && row.tail_digest === tailDigest(filePath, stored.indexedSize));
  }

  private appendRefresh(stored: StructuralIndexRevision, current: TranscriptFileRevision): StructuralIndexRevision {
    // Appends are parsed from the previous newline boundary; existing message bodies are never reread.
    const countRow = this.db.prepare(
      "SELECT COUNT(*) AS count FROM transcript_entries WHERE session_id=? AND transcript_epoch=?",
    ).get(stored.sessionId, stored.transcriptEpoch) as { count: number };
    const existingEntryCount = countRow.count;
    if (!Number.isSafeInteger(existingEntryCount) || existingEntryCount > TRANSCRIPT_INDEX_MAX_TOPOLOGY_ENTRIES) {
      throw new Error("Existing structural topology exceeds the compiled limit");
    }
    const remainingEntryCapacity = TRANSCRIPT_INDEX_MAX_TOPOLOGY_ENTRIES - existingEntryCount;
    const fd = fs.openSync(stored.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let content: Buffer;
    try {
      content = Buffer.allocUnsafe(current.size - stored.indexedSize);
      const read = fs.readSync(fd, content, 0, content.length, stored.indexedSize);
      content = content.subarray(0, read);
    } finally { fs.closeSync(fd); }
    const maxOrdinal = this.db.prepare("SELECT MAX(physical_ordinal) AS value FROM transcript_entries WHERE session_id = ? AND transcript_epoch = ?")
      .get(stored.sessionId, stored.transcriptEpoch) as { value: number | null };
    let ordinal = (maxOrdinal.value ?? -1) + 1;
    let lineStart = 0;
    const appended: WorkerEntry[] = [];
    for (let index = 0; index <= content.length; index++) {
      if (index !== content.length && content[index] !== 0x0a) continue;
      const raw = content.subarray(lineStart, index).toString("utf8").replace(/\r$/u, "");
      if (raw) {
        const value = JSON.parse(raw);
        if (typeof value?.id === "string") {
          if (appended.length >= remainingEntryCapacity) {
            this.options.onAppendTopologyLimitForTests?.(
              stored.sessionId,
              existingEntryCount,
              appended.length + 1,
            );
            throw new Error("Appended structural topology exceeds the compiled limit");
          }
          appended.push({
            eventId: value.id, parentId: typeof value.parentId === "string" ? value.parentId : null,
            physicalOrdinal: ordinal, sourceOffset: stored.indexedSize + lineStart,
            sourceLength: index - lineStart + (index < content.length ? 1 : 0), eventType: String(value.type || "unknown"),
            displayClass: value.type === "message" ? String(value.message?.role || "message") : String(value.customType || value.type || "hidden"),
            visible: isStructurallyVisibleTranscriptEntry(value) ? 1 : 0,
          });
        }
      }
      ordinal++;
      lineStart = index + 1;
    }
    const existingTopology = this.db.prepare("SELECT event_id,parent_id FROM transcript_entries WHERE session_id = ? AND transcript_epoch = ?")
      .all(stored.sessionId, stored.transcriptEpoch) as Array<{ event_id: string; parent_id: string | null }>;
    const existingIds = new Set(existingTopology.map((row) => row.event_id));
    if (appended.some((entry) => existingIds.has(entry.eventId))) throw new Error("Append contains a duplicate event id");
    const appendedTip = [...appended].reverse().find((entry) => entry.eventType !== "session_info");
    const branchTipId = appendedTip?.eventId ?? stored.branchTipId;
    if (stored.branchTipId && appendedTip) {
      const parents = new Map<string, string | null>([
        ...existingTopology.map((row) => [row.event_id, row.parent_id] as const),
        ...appended.map((entry) => [entry.eventId, entry.parentId] as const),
      ]);
      let current: string | null = appendedTip.eventId;
      const seen = new Set<string>();
      while (current && current !== stored.branchTipId && !seen.has(current)) {
        seen.add(current);
        current = parents.get(current) ?? null;
      }
      if (current !== stored.branchTipId) throw new Error("Append changed the active branch rather than extending its tip");
    }
    if (!revisionsExactlyEqual(current, readTranscriptFileRevision(stored.filePath))) {
      throw new Error("Transcript changed during append indexing");
    }
    this.db.transaction(() => {
      const insert = this.db.prepare("INSERT INTO transcript_entries VALUES (?,?,?,?,?,?,?,?,?,?)");
      for (const entry of appended) insert.run(stored.sessionId, stored.transcriptEpoch, entry.eventId, entry.parentId,
        entry.physicalOrdinal, entry.sourceOffset, entry.sourceLength, entry.eventType, entry.displayClass, entry.visible);
      this.db.prepare(`UPDATE transcript_revisions SET file_size=?,mtime_ms=?,ctime_ms=?,branch_tip_id=?,indexed_size=?,ended_newline=?,tail_digest=? WHERE session_id=?`)
        .run(current.size, current.mtimeMs, current.ctimeMs, branchTipId, current.size,
          content.length === 0 || content.at(-1) === 0x0a ? 1 : 0, tailDigest(stored.filePath, current.size), stored.sessionId);
      this.recomputeActive(stored.sessionId, stored.transcriptEpoch, branchTipId);
    })();
    return this.readRevision(stored.sessionId)!;
  }

  private recomputeActive(sessionId: string, epoch: string, tip: string | null): void {
    const entries = this.db.prepare(
      "SELECT event_id,parent_id,source_offset,source_length,visible FROM transcript_entries WHERE session_id=? AND transcript_epoch=?",
    ).all(sessionId, epoch) as Array<{ event_id: string; parent_id: string | null; source_offset: number; source_length: number; visible: number }>;
    const byId = new Map(entries.map((entry) => [entry.event_id, entry]));
    const newest: typeof entries = [];
    const seen = new Set<string>();
    let current = tip;
    while (current) {
      if (seen.has(current)) throw new Error("Cyclic append topology");
      seen.add(current);
      const entry = byId.get(current);
      if (!entry) throw new Error("Missing append parent");
      newest.push(entry);
      current = entry.parent_id;
    }
    this.db.prepare("DELETE FROM active_branch_entries WHERE session_id=? AND transcript_epoch=?").run(sessionId, epoch);
    const insert = this.db.prepare("INSERT INTO active_branch_entries VALUES (?,?,?,?,?,?,?)");
    let visibleOrdinal = 0;
    newest.reverse().forEach((entry, activeOrdinal) => insert.run(sessionId, epoch, activeOrdinal,
      entry.visible ? visibleOrdinal++ : null, entry.event_id, entry.source_offset, entry.source_length));
  }

  private readRevision(sessionId: string): StructuralIndexRevision | null {
    const row = this.db.prepare("SELECT * FROM transcript_revisions WHERE session_id = ?").get(sessionId) as any;
    if (!row) return null;
    return {
      sessionId, filePath: row.file_path, device: row.device, inode: row.inode, size: row.file_size,
      mtimeMs: row.mtime_ms, ctimeMs: row.ctime_ms, headerDigest: row.header_digest,
      mutationEpoch: row.mutation_epoch, transcriptEpoch: row.transcript_epoch,
      branchTipId: row.branch_tip_id, indexedSize: row.indexed_size, complete: Boolean(row.complete), error: row.error,
    };
  }

  private visibleRange(revision: StructuralIndexRevision, start: number, limit: number): IndexedSourceRow[] {
    return (this.db.prepare(
      `SELECT event_id,active_ordinal,visible_ordinal,source_offset,source_length FROM active_branch_entries
       WHERE session_id=? AND transcript_epoch=? AND visible_ordinal>=? ORDER BY visible_ordinal LIMIT ?`,
    ).all(revision.sessionId, revision.transcriptEpoch, start, limit) as any[]).map(this.mapRow);
  }

  private hasVisibleAfter(revision: StructuralIndexRevision, ordinal: number): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM active_branch_entries WHERE session_id=? AND transcript_epoch=? AND visible_ordinal>? LIMIT 1",
    ).get(revision.sessionId, revision.transcriptEpoch, ordinal));
  }

  private readonly mapRow = (row: any): IndexedSourceRow => ({
    eventId: row.event_id, activeOrdinal: row.active_ordinal, visibleOrdinal: row.visible_ordinal,
    sourceOffset: row.source_offset, sourceLength: row.source_length,
  });
}

let sharedStructuralIndex: StructuralTranscriptIndex | null = null;

export function getStructuralTranscriptIndex(): StructuralTranscriptIndex {
  return sharedStructuralIndex ??= new StructuralTranscriptIndex();
}

export function purgeSharedStructuralTranscriptSession(sessionId: string): void {
  sharedStructuralIndex?.purge(sessionId);
}

export async function closeStructuralTranscriptIndex(): Promise<void> {
  const index = sharedStructuralIndex;
  sharedStructuralIndex = null;
  await index?.close();
}
