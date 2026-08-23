import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { SerializedTodoState } from "../pi-bridge.js";
import {
  readTranscriptFileRevision,
  sameTranscriptIdentity,
  type TranscriptFileRevision,
} from "./reverse-reader.js";

const MAX_CACHE_ENTRIES = 64;

export interface DerivedTodoProjection {
  fingerprint: TranscriptFileRevision;
  todoState: SerializedTodoState;
}

interface WorkerReply {
  fingerprint?: TranscriptFileRevision;
  todoState?: SerializedTodoState;
  error?: string;
}

export interface DerivedTodoProjectionOptions {
  /** @internal Deterministic post-worker revision race seam. */
  beforeCachePublishForTests?: (filePath: string) => void | Promise<void>;
}

const WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_CANDIDATES = 4096;
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_TODOS = 500;
const MAX_RESULT_BYTES = 128 * 1024;
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function compactTodo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  if (typeof value.id === "number") result.id = value.id;
  for (const key of ["text", "status", "priority", "assignee", "notes"]) {
    if (typeof value[key] === "string") result[key] = value[key];
  }
  if (Array.isArray(value.dependencies)) {
    result.dependencies = value.dependencies.filter((item) => typeof item === "number");
  }
  return result;
}
function compactTodos(value) {
  if (!Array.isArray(value) || value.length > MAX_TODOS) throw new Error("TODO candidate exceeds item bounds");
  return value.map(compactTodo).filter(Boolean);
}
function normalizeTodo(raw, fallbackId) {
  if (!raw || typeof raw.text !== "string" || raw.text.trim() === "") return null;
  return {
    id: typeof raw.id === "number" ? raw.id : fallbackId,
    text: raw.text.trim(),
    status: typeof raw.status === "string" ? raw.status : "pending",
    priority: typeof raw.priority === "string" ? raw.priority : undefined,
    assignee: typeof raw.assignee === "string" ? raw.assignee : undefined,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((item) => typeof item === "number")
      : undefined,
  };
}
function candidateFromEntry(entry) {
  if (entry?.type === "custom" && entry.customType === "todo-preseed") {
    return { kind: "preseed", todos: compactTodos(Array.isArray(entry.data?.todos) ? entry.data.todos : []) };
  }
  if (entry?.type === "custom" && entry.customType === "todo-state") {
    return {
      kind: "state",
      todos: compactTodos(Array.isArray(entry.data?.todos) ? entry.data.todos : []),
      nextId: typeof entry.data?.nextId === "number" ? entry.data.nextId : undefined,
    };
  }
  const message = entry?.type === "message" ? entry.message : null;
  if (message?.role === "toolResult" && message.toolName === "todo" && Array.isArray(message.details?.todos)) {
    return {
      kind: "tool",
      todos: compactTodos(message.details.todos),
      nextId: typeof message.details?.nextId === "number" ? message.details.nextId : undefined,
    };
  }
  return null;
}
let fd;
try {
  fd = fs.openSync(workerData.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const before = fs.fstatSync(fd);
  if (!before.isFile()) throw new Error("Transcript is not a regular file");
  const entries = [];
  const candidates = new Map();
  let candidateBytes = 0;
  let branchTipId = null;
  let ordinal = 0;
  let lineStartOffset = 0;
  let lineParts = [];
  let lineBytes = 0;
  let header = Buffer.alloc(0);
  function appendPart(part) {
    if (!part.length) return;
    const copy = Buffer.from(part);
    lineParts.push(copy);
    lineBytes += copy.length;
  }
  function consumeLine(sourceLength) {
    const physical = lineParts.length === 0 ? Buffer.alloc(0)
      : lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts, lineBytes);
    if (ordinal === 0) header = Buffer.from(physical);
    const raw = physical.length > 0 && physical[physical.length - 1] === 13
      ? physical.subarray(0, physical.length - 1) : physical;
    if (raw.length) {
      try {
        const value = JSON.parse(raw.toString("utf8"));
        if (value && typeof value.id === "string") {
          const eventType = typeof value.type === "string" ? value.type : "unknown";
          entries.push({ id: value.id, parentId: typeof value.parentId === "string" ? value.parentId : null });
          if (eventType !== "session" && eventType !== "session_info") branchTipId = value.id;
          const candidate = candidateFromEntry(value);
          if (candidate) {
            if (candidates.size >= MAX_CANDIDATES) throw new Error("TODO candidate count exceeds bounds");
            const bytes = Buffer.byteLength(JSON.stringify(candidate));
            candidateBytes += bytes;
            if (candidateBytes > MAX_CANDIDATE_BYTES) throw new Error("TODO candidates exceed byte bounds");
            candidates.set(value.id, candidate);
          }
        }
      } catch (error) {
        if (error && typeof error.message === "string" && error.message.startsWith("TODO ")) throw error;
        // Malformed and unrelated physical lines retain Pi's tolerant behavior.
      }
    }
    ordinal++;
    lineParts = [];
    lineBytes = 0;
    lineStartOffset += sourceLength;
  }
  let position = 0;
  const block = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  while (position < before.size) {
    const requested = Math.min(block.length, before.size - position);
    const count = fs.readSync(fd, block, 0, requested, position);
    if (!count) break;
    const chunk = block.subarray(0, count);
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      appendPart(chunk.subarray(segmentStart, index));
      const absoluteEnd = position + index + 1;
      consumeLine(absoluteEnd - lineStartOffset);
      segmentStart = index + 1;
    }
    appendPart(chunk.subarray(segmentStart));
    position += count;
  }
  if (position !== before.size) throw new Error("Transcript ended during TODO projection");
  if (lineStartOffset < before.size) consumeLine(before.size - lineStartOffset);
  let mutationEpoch = sha(header);
  try {
    const headerJson = header.length && header[header.length - 1] === 13 ? header.subarray(0, header.length - 1) : header;
    const parsed = JSON.parse(headerJson.toString("utf8"));
    const explicit = parsed?.mutationEpoch ?? parsed?.mutation_epoch ?? parsed?.wayangMutationEpoch;
    if (typeof explicit === "string" || typeof explicit === "number") mutationEpoch = String(explicit);
  } catch {}
  const byId = new Map();
  let duplicate = false;
  for (const entry of entries) {
    if (byId.has(entry.id)) duplicate = true;
    else byId.set(entry.id, entry);
  }
  if (duplicate) throw new Error("Duplicate transcript event id in TODO projection");
  const newest = [];
  const seen = new Set();
  let current = branchTipId;
  while (current) {
    if (seen.has(current)) throw new Error("Cyclic transcript topology in TODO projection");
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) throw new Error("Missing transcript parent in TODO projection");
    newest.push(current);
    current = entry.parentId;
  }
  const activeIds = newest.reverse();
  let todos = [];
  let nextId;
  let source = "none";
  const preseedByText = new Map();
  for (const eventId of activeIds) {
    const candidate = candidates.get(eventId);
    if (!candidate) continue;
    if (candidate.kind === "preseed") {
      for (const raw of candidate.todos) {
        const todo = normalizeTodo(raw, preseedByText.size + 1);
        if (todo && !preseedByText.has(todo.text)) preseedByText.set(todo.text, todo);
      }
      continue;
    }
    todos = candidate.todos.map((raw, index) => normalizeTodo(raw, index + 1)).filter(Boolean);
    if (candidate.kind === "state") nextId = candidate.nextId;
    else if (typeof candidate.nextId === "number") nextId = candidate.nextId;
    source = candidate.kind === "state" ? "todo-state" : "tool-result";
  }
  if (todos.length === 0 && preseedByText.size > 0) {
    todos = [...preseedByText.values()];
    nextId = todos.length + 1;
    source = "todo-preseed";
  }
  const todoState = { type: "todo_state", todos, nextId, source };
  if (todos.length > MAX_TODOS || Buffer.byteLength(JSON.stringify(todoState)) > MAX_RESULT_BYTES) {
    throw new Error("TODO projection result exceeds bounds");
  }
  const after = fs.fstatSync(fd);
  const pathStat = fs.lstatSync(workerData.filePath);
  if (!pathStat.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    || pathStat.dev !== before.dev || pathStat.ino !== before.ino || pathStat.size !== before.size) {
    throw new Error("Transcript changed during TODO projection");
  }
  parentPort.postMessage({
    fingerprint: {
      device: Number(before.dev) || 0,
      inode: Number(before.ino) || 0,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      headerDigest: sha(header),
      mutationEpoch,
    },
    todoState,
  });
} catch (error) {
  parentPort.postMessage({ error: error && error.message ? error.message : String(error) });
} finally { if (fd !== undefined) fs.closeSync(fd); }
`;

function fingerprintsEqual(left: TranscriptFileRevision, right: TranscriptFileRevision): boolean {
  return sameTranscriptIdentity(left, right)
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function cacheKey(filePath: string, fingerprint: TranscriptFileRevision): string {
  return JSON.stringify([
    filePath, fingerprint.device, fingerprint.inode, fingerprint.size,
    fingerprint.mtimeMs, fingerprint.ctimeMs, fingerprint.headerDigest, fingerprint.mutationEpoch,
  ]);
}

export class DerivedTodoProjectionService {
  private readonly cache = new Map<string, DerivedTodoProjection>();
  private readonly inFlight = new Map<string, Promise<DerivedTodoProjection | null>>();
  private readonly workers = new Map<Worker, (error: Error) => void>();
  private closed = false;
  private workersStarted = 0;
  private cacheHits = 0;
  private inFlightHits = 0;

  constructor(private readonly options: DerivedTodoProjectionOptions = {}) {}

  project(filePath: string): Promise<DerivedTodoProjection | null> {
    if (this.closed) return Promise.resolve(null);
    const canonicalPath = path.resolve(filePath);
    let expected: TranscriptFileRevision;
    try { expected = readTranscriptFileRevision(canonicalPath); }
    catch { return Promise.resolve(null); }
    const key = cacheKey(canonicalPath, expected);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.cacheHits++;
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      this.inFlightHits++;
      return pending;
    }
    const work = this.runWorker(canonicalPath)
      .then(async (projection) => {
        if (!projection || this.closed) return null;
        await this.options.beforeCachePublishForTests?.(canonicalPath);
        if (this.closed || !fingerprintsEqual(expected, projection.fingerprint)) return null;
        let current: TranscriptFileRevision;
        try { current = readTranscriptFileRevision(canonicalPath); }
        catch { return null; }
        if (!fingerprintsEqual(expected, current)) return null;
        this.cache.set(key, projection);
        while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        return projection;
      })
      .catch(() => null)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  getInstrumentation(): { workersStarted: number; cacheHits: number; inFlightHits: number } {
    return { workersStarted: this.workersStarted, cacheHits: this.cacheHits, inFlightHits: this.inFlightHits };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    const pending = [...this.inFlight.values()];
    for (const [worker, reject] of this.workers) {
      reject(new Error("TODO projection service closed"));
      void worker.terminate();
    }
    this.workers.clear();
    await Promise.allSettled(pending);
    this.inFlight.clear();
  }

  private runWorker(filePath: string): Promise<DerivedTodoProjection | null> {
    this.workersStarted++;
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { filePath } });
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.workers.delete(worker);
        reject(error);
      };
      this.workers.set(worker, fail);
      worker.once("message", (reply: WorkerReply) => {
        if (settled) return;
        settled = true;
        this.workers.delete(worker);
        void worker.terminate();
        if (reply.error || !reply.fingerprint || !reply.todoState) resolve(null);
        else resolve({ fingerprint: reply.fingerprint, todoState: reply.todoState });
      });
      worker.once("error", (error) => fail(
        error instanceof Error ? error : new Error(String(error)),
      ));
      worker.once("exit", () => {
        if (!settled) fail(new Error("TODO projection worker exited unexpectedly"));
      });
    });
  }
}

let singleton: DerivedTodoProjectionService | null = null;

export function getDerivedTodoProjectionService(): DerivedTodoProjectionService {
  return singleton ??= new DerivedTodoProjectionService();
}

export async function closeDerivedTodoProjectionService(): Promise<void> {
  const service = singleton;
  singleton = null;
  await service?.close();
}
