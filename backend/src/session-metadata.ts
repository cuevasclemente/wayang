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

// Kept self-contained so both `tsx src/index.ts` and compiled `dist/index.js`
// execute the exact same worker code without runtime TypeScript loaders or a
// copied worker asset. Transcript bytes and parsed entries never return to the
// main thread; only bounded catalog metadata does.
const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs/promises");

function textContent(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join(" ");
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

async function parseFile(filePath, fingerprint) {
  const content = await fs.readFile(filePath, "utf8");
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
    if (entry.type === "session_info") name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textContent(entry.message);
    if (!firstMessage && role === "user" && text) firstMessage = text;
    const activity = timestampMs(entry.message.timestamp) || timestampMs(entry.timestamp);
    if (Number.isFinite(activity)) lastInteractionAt = Math.max(lastInteractionAt, activity);
  }

  let provider = null;
  let model = null;
  for (const entry of activeBranch(entries)) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      provider = entry.provider;
      model = entry.modelId;
    } else if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
      if (typeof entry.message.provider === "string") provider = entry.message.provider;
      if (typeof entry.message.model === "string") model = entry.message.model;
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

parentPort.on("message", async ({ taskId, filePath, fingerprint }) => {
  try {
    parentPort.postMessage({ taskId, metadata: await parseFile(filePath, fingerprint) });
  } catch (error) {
    parentPort.postMessage({ taskId, error: error && error.message ? error.message : String(error) });
  }
});
`;

export function fingerprintsEqual(a: FileFingerprint | null | undefined, b: FileFingerprint | null | undefined): boolean {
  return Boolean(a && b && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino);
}

export class SessionMetadataWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ taskId: number; filePath: string; fingerprint: FileFingerprint }> = [];
  private readonly pending = new Map<number, PendingTask>();
  private nextTaskId = 1;
  private closed = false;

  constructor(size = Math.max(1, Math.min(4, Number.parseInt(process.env.WAYANG_SESSION_CATALOG_WORKERS || "2", 10) || 2))) {
    for (let index = 0; index < size; index++) this.addWorker();
  }

  parse(filePath: string, fingerprint: FileFingerprint): Promise<SessionFileMetadata | null> {
    if (this.closed) return Promise.reject(new Error("Session metadata worker pool is closed"));
    const taskId = this.nextTaskId++;
    const promise = new Promise<SessionFileMetadata | null>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject });
    });
    this.queue.push({ taskId, filePath, fingerprint });
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
      worker.postMessage(task);
    }
  }
}
