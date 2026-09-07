/** One disposable READ-ONLY subprocess at a time; bounded admission and deadlines. */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SearchQueryError } from "./query-parser.js";
import { QUERY_WORKER_BUDGETS as B, type QueryWorkerEnvelope, type QueryWorkerReply,
  type QueryWorkerRequest, type QueryWorkerResult } from "./query-worker-protocol.js";

interface Job {
  payload: string;
  resolve: (value: QueryWorkerResult) => void;
  reject: (error: SearchQueryError) => void;
  signal?: AbortSignal;
  abort: () => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  response?: QueryWorkerResult;
  child?: ChildProcess;
  closed: Promise<void>;
  close: () => void;
}
export interface QueryPoolOptions {
  /** Tests may SHRINK compiled budgets, never increase them. */
  queued?: number;
  deadlineMs?: number;
  requestBytes?: number;
  resultBytes?: number;
}

export class ReadonlySearchQueryPool {
  private readonly limits: Required<QueryPoolOptions>;
  private queue: Job[] = [];
  private active: Job | null = null;
  private stopped = false;
  private epoch = 0;
  constructor(options: QueryPoolOptions = {}) {
    this.limits = { queued: options.queued ?? B.queued, deadlineMs: options.deadlineMs ?? B.deadlineMs,
      requestBytes: options.requestBytes ?? B.requestBytes, resultBytes: options.resultBytes ?? B.resultBytes };
    for (const key of Object.keys(this.limits) as Array<keyof QueryPoolOptions>) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < (key === "queued" ? 0 : 1)
        || this.limits[key] > B[key]) throw new Error("Invalid search query budget");
    }
  }
  status() { return { running: this.active ? 1 : 0, queued: this.queue.length, stopped: this.stopped, epoch: this.epoch }; }
  assertRunning(epoch = this.epoch): void {
    if (this.stopped || epoch !== this.epoch) throw new SearchQueryError("search_stopped");
  }
  start(): void {
    if (this.active || this.queue.length) throw new SearchQueryError("search_busy");
    this.stopped = false;
    this.epoch++;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.epoch++;
    for (const job of [...this.queue]) this.cancel(job, new SearchQueryError("search_stopped"));
    const active = this.active;
    if (active) {
      this.cancel(active, new SearchQueryError("search_stopped"));
      await active.closed; // OS exit releases native SQLite/WAL handles too.
    }
  }
  query(request: QueryWorkerRequest, signal?: AbortSignal): Promise<QueryWorkerResult> {
    try {
      this.assertRunning();
      if (signal?.aborted) throw new SearchQueryError("search_cancelled");
      if (this.active && this.queue.length >= this.limits.queued) throw new SearchQueryError("search_busy");
      const envelope: QueryWorkerEnvelope = { request, deadlineAt: Date.now() + this.limits.deadlineMs, resultBytes: this.limits.resultBytes };
      const payload = JSON.stringify(envelope);
      if (Buffer.byteLength(payload) > this.limits.requestBytes) throw new SearchQueryError("search_request_too_large");
      return new Promise<QueryWorkerResult>((resolve, reject) => {
        let close!: () => void;
        const closed = new Promise<void>(done => { close = done; });
        const job: Job = { payload, resolve, reject, signal, settled: false, closed, close,
          abort: () => this.cancel(job, new SearchQueryError("search_cancelled")),
          timer: setTimeout(() => this.cancel(job, new SearchQueryError("search_timeout")), this.limits.deadlineMs) };
        signal?.addEventListener("abort", job.abort, { once: true });
        this.queue.push(job);
        this.pump();
      });
    } catch (error) {
      return Promise.reject(error instanceof SearchQueryError ? error : new SearchQueryError("search_unavailable"));
    }
  }
  private settle(job: Job, error?: SearchQueryError): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error); else job.resolve(job.response!);
  }
  private cancel(job: Job, error: SearchQueryError): void {
    if (job.settled) return;
    this.settle(job, error);
    if (job === this.active) {
      // Worker.terminate() cannot guarantee interruption of better-sqlite3's
      // synchronous native call. Kill the disposable process, not the backend.
      job.child?.kill("SIGKILL");
    } else {
      this.queue = this.queue.filter(candidate => candidate !== job);
      job.close();
    }
  }
  private pump(): void {
    if (this.stopped || this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    const finish = (code: number | null) => {
      if (this.active !== job) return;
      this.settle(job, code === 0 && job.response ? undefined : new SearchQueryError("search_unavailable"));
      this.active = null;
      job.close();
      this.pump();
    };
    try {
      const source = fileURLToPath(import.meta.url).endsWith(".ts");
      const entry = fileURLToPath(new URL(source ? "./query-worker.ts" : "./query-worker.js", import.meta.url));
      const child = fork(entry, [], {
        execArgv: [`--max-old-space-size=${B.heapMb}`, "--max-semi-space-size=8", ...(source ? ["--import", import.meta.resolve("tsx")] : [])],
        // No provider keys, private runtime configuration, NODE_OPTIONS, query
        // text, or database paths in argv/environment. Only bounded IPC input.
        env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
      });
      job.child = child;
      child.once("close", finish);
      child.once("error", () => {
        this.cancel(job, new SearchQueryError("search_unavailable"));
        if (!child.pid) finish(null);
      });
      child.on("message", (value: unknown) => {
        if (job.settled) return;
        try {
          if (job.response || !value || typeof value !== "object") throw new SearchQueryError("search_unavailable");
          const reply = value as QueryWorkerReply;
          if (reply.kind === "failure") {
            const code = ["search_changed", "search_timeout", "search_result_too_large", "search_request_too_large"].includes(reply.code)
              ? reply.code : "search_unavailable";
            this.cancel(job, new SearchQueryError(code));
            return;
          }
          if (reply.kind !== "result" || typeof reply.json !== "string") throw new SearchQueryError("search_unavailable");
          if (Buffer.byteLength(reply.json) > this.limits.resultBytes) throw new SearchQueryError("search_result_too_large");
          const result = JSON.parse(reply.json) as QueryWorkerResult;
          if (!Array.isArray(result.rows) || result.rows.length > 100
            || !Array.isArray(result.facets?.cwds) || !Array.isArray(result.facets?.models)) throw new SearchQueryError("search_unavailable");
          job.response = result;
          // Resolve only after process exit: no success while a reader is pinned.
        } catch (error) {
          this.cancel(job, error instanceof SearchQueryError ? error : new SearchQueryError("search_unavailable"));
        }
      });
      child.send(job.payload, error => { if (error) this.cancel(job, new SearchQueryError("search_unavailable")); });
    } catch {
      this.cancel(job, new SearchQueryError("search_unavailable"));
      if (!job.child) finish(null);
    }
  }
}

const pool = new ReadonlySearchQueryPool();
export function getSearchQueryPool(): ReadonlySearchQueryPool { return pool; }
/** App shutdown MUST await this before search DB/structural teardown. */
export function stopSearchQueryWorker(): Promise<void> { return pool.stop(); }
export function startSearchQueryWorker(): void { pool.start(); }
