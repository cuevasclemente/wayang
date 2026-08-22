import { Worker } from "node:worker_threads";

export interface FileFingerprint {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

export interface SessionFileMetadata {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  createdAt: number;
  lastInteractionAt: number;
  firstMessage: string;
  provider: string | null;
  model: string | null;
  fingerprint: FileFingerprint;
  approximateBytes: number;
}

interface PendingTask {
  resolve: (value: SessionFileMetadata | null) => void;
  reject: (reason: unknown) => void;
}

interface WorkerReply {
  taskId: number;
  metadata?: SessionFileMetadata | null;
  error?: string;
}

// Kept self-contained so both source and compiled layouts execute the same
// worker code. Authorized workers reopen and read one bounded file themselves;
// transcript bytes never enter the main thread and only bounded metadata returns.
const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");

function textContent(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join(" ");
}

function boundedText(value, maxCodeUnits) {
  return typeof value === "string" ? value.slice(0, maxCodeUnits) : "";
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function activeBranch(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
  }
  let current = entries.length > 0 ? entries[entries.length - 1] : null;
  const path = [];
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : null;
  }
  return path;
}

function parseFile(filePath, fingerprint, contentBuffer) {
  const content = contentBuffer.toString("utf8");
  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* tolerate partial/malformed lines like pi */ }
  }
  if (entries.length === 0) return null;
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") return null;

  let name;
  let firstMessage = "";
  let lastInteractionAt = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "session_info") name = typeof entry.name === "string" && entry.name.trim()
      ? boundedText(entry.name.trim(), 120) : undefined;
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textContent(entry.message);
    if (!firstMessage && role === "user" && text) firstMessage = boundedText(text, 4096);
    const activity = timestampMs(entry.message.timestamp) || timestampMs(entry.timestamp);
    if (Number.isFinite(activity)) lastInteractionAt = Math.max(lastInteractionAt, activity);
  }

  let provider = null;
  let model = null;
  for (const entry of activeBranch(entries)) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      provider = boundedText(entry.provider, 512);
      model = boundedText(entry.modelId, 512);
    } else if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
      if (typeof entry.message.provider === "string") provider = boundedText(entry.message.provider, 512);
      if (typeof entry.message.model === "string") model = boundedText(entry.message.model, 512);
    }
  }

  const createdAt = timestampMs(header.timestamp);
  return {
    path: filePath,
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    createdAt: Number.isFinite(createdAt) ? createdAt : fingerprint.mtimeMs,
    lastInteractionAt: lastInteractionAt > 0 ? lastInteractionAt : (Number.isFinite(createdAt) ? createdAt : fingerprint.mtimeMs),
    firstMessage: firstMessage || "(no messages)",
    provider,
    model,
    fingerprint,
    approximateBytes: Buffer.byteLength(content),
  };
}

function fingerprintMatches(stat, expected) {
  return stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs
    && stat.size === expected.size && (Number(stat.ino) || 0) === expected.ino;
}

parentPort.on("message", ({ taskId, filePath, fingerprint, maxBytes }) => {
  let fd;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(filePath, flags);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !fingerprintMatches(before, fingerprint)) {
      throw new Error("Session file changed before worker read");
    }
    if (before.size > maxBytes) throw new Error("Session file exceeds catalog body bound");
    const content = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(fd, content, offset, content.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (offset !== content.length || !fingerprintMatches(after, fingerprint)) {
      throw new Error("Session file changed during worker read");
    }
    parentPort.postMessage({ taskId, metadata: parseFile(filePath, fingerprint, content) });
  } catch (error) {
    parentPort.postMessage({ taskId, error: error && error.message ? error.message : String(error) });
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
});
`;

export function fingerprintsEqual(a: FileFingerprint | null | undefined, b: FileFingerprint | null | undefined): boolean {
  return Boolean(a && b && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino);
}

export class SessionMetadataWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ taskId: number; filePath: string; fingerprint: FileFingerprint; maxBytes: number }> = [];
  private readonly pending = new Map<number, PendingTask>();
  private nextTaskId = 1;
  private closed = false;

  readonly capacity: number;

  constructor(size = Math.max(1, Math.min(4, Number.parseInt(process.env.WAYANG_SESSION_CATALOG_WORKERS || "2", 10) || 2))) {
    this.capacity = size;
    for (let index = 0; index < size; index++) this.addWorker();
  }

  parseAuthorizedFile(filePath: string, fingerprint: FileFingerprint, maxBytes: number): Promise<SessionFileMetadata | null> {
    if (this.closed) return Promise.reject(new Error("Session metadata worker pool is closed"));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return Promise.reject(new Error("Invalid catalog body bound"));
    if (this.pending.size >= this.capacity) {
      return Promise.reject(new Error("Session metadata worker admission is full"));
    }
    const taskId = this.nextTaskId++;
    const promise = new Promise<SessionFileMetadata | null>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject });
    });
    this.queue.push({ taskId, filePath, fingerprint, maxBytes });
    this.dispatch();
    return promise;
  }

  async close(): Promise<void> {
    this.closed = true;
    const error = new Error("Session metadata worker pool closed");
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    this.queue.length = 0;
    await Promise.all(this.workers.map((worker) => worker.terminate().then(() => undefined)));
    this.workers.length = 0;
    this.idle.length = 0;
  }

  private addWorker(): void {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    this.workers.push(worker);
    this.idle.push(worker);
    worker.on("message", (reply: WorkerReply) => {
      const task = this.pending.get(reply.taskId);
      if (task) {
        this.pending.delete(reply.taskId);
        if (reply.error) task.reject(new Error(reply.error));
        else task.resolve(reply.metadata ?? null);
      }
      this.idle.push(worker);
      this.dispatch();
    });
    worker.on("error", (error) => {
      for (const [taskId, task] of this.pending) {
        task.reject(error);
        this.pending.delete(taskId);
      }
      const index = this.idle.indexOf(worker);
      if (index >= 0) this.idle.splice(index, 1);
    });
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const task = this.queue.shift()!;
      try {
        worker.postMessage(task);
      } catch (error) {
        this.pending.get(task.taskId)?.reject(error);
        this.pending.delete(task.taskId);
        this.idle.push(worker);
      }
    }
  }
}
