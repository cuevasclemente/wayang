/** Search-only single flight. Admission is bounded; callers await execution, not enqueue. */
export type SearchPriority = "mutation" | "manual" | "recent" | "background";
const priorities: Record<SearchPriority, number> = { mutation: 3, manual: 2, recent: 1, background: 0 };
export class SearchQueueUnavailableError extends Error {}
interface Job<T> {
  key: string;
  priority: SearchPriority;
  enqueuedAt: number;
  notBefore: number;
  run: (signal: AbortSignal) => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
export class SearchQueue<T> {
  private pending = new Map<string, Job<T>>();
  private active: { job: Job<T>; controller: AbortController } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private nextBackgroundAt = 0;
  private completed = 0;
  constructor(private readonly options: { capacity?: number; cooldownMs?: number; agingMs?: number } = {}) {}

  enqueue(key: string, priority: SearchPriority, run: Job<T>["run"], delayMs = 0): Promise<T> {
    if (this.stopped) return Promise.reject(new SearchQueueUnavailableError("Search queue stopped"));
    // Only pending jobs coalesce: a request arriving during extraction needs a fresh
    // row/fingerprint check after that run, not its potentially older result.
    const existing = this.pending.get(key);
    if (existing) {
      if (priorities[priority] > priorities[existing.priority]) existing.priority = priority;
      existing.notBefore = Math.min(existing.notBefore, Date.now() + delayMs);
      existing.run = run;
      this.pump();
      return existing.promise;
    }
    if (this.pending.size >= (this.options.capacity ?? 64)) {
      const evictable = [...this.pending.values()].filter((job) => priorities[job.priority] < priorities[priority])
        .sort((a,b) => priorities[a.priority] - priorities[b.priority] || b.enqueuedAt - a.enqueuedAt)[0];
      if (!evictable) return Promise.reject(new SearchQueueUnavailableError("Search queue capacity reached"));
      this.pending.delete(evictable.key);
      evictable.reject(new SearchQueueUnavailableError("Search work deferred for higher priority"));
    }
    let resolve!: Job<T>["resolve"];
    let reject!: Job<T>["reject"];
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.pending.set(key, { key, priority, run, promise, resolve, reject,
      enqueuedAt: Date.now(), notBefore: Date.now() + delayMs });
    this.pump();
    return promise;
  }

  hasPending(matches: (key: string) => boolean): boolean { return [...this.pending.keys()].some(matches); }
  hasWork(matches: (key: string) => boolean): boolean {
    return Boolean(this.active && matches(this.active.job.key)) || this.hasPending(matches);
  }

  /** Reject old pending intents and abort active work without admitting a replacement. */
  cancelWhere(matches: (key: string) => boolean): void {
    for (const [key, job] of this.pending) {
      if (!matches(key)) continue;
      this.pending.delete(key);
      job.reject(new SearchQueueUnavailableError("Search work invalidated"));
    }
    if (this.active && matches(this.active.job.key)) this.active.controller.abort();
    this.pump();
  }

  start(): void { this.stopped = false; this.pump(); }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const job of this.pending.values()) job.reject(new SearchQueueUnavailableError("Search queue stopped"));
    this.pending.clear();
    const active = this.active;
    active?.controller.abort();
    await active?.job.promise.catch(() => undefined);
  }
  status() {
    const now = Date.now();
    return { queued: this.pending.size, running: this.active ? 1 : 0, stopped: this.stopped,
      oldestQueuedAgeMs: this.pending.size ? Math.max(...[...this.pending.values()].map((j) => now - j.enqueuedAt)) : 0,
      completed: this.completed };
  }
  private pump(): void {
    if (this.active || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    const agingMs = this.options.agingMs ?? 300_000;
    const readyAt = (j: Job<T>) => Math.max(j.notBefore,
      priorities[j.priority] < 2 ? Math.min(this.nextBackgroundAt,j.enqueuedAt + agingMs) : 0);
    const ready = [...this.pending.values()].filter((j) => readyAt(j) <= now);
    // Aging eventually overtakes manual traffic, but never exact mutation recovery.
    const score = (j: Job<T>) => j.priority === "mutation" ? 1e9
      : priorities[j.priority] + Math.floor((now - j.enqueuedAt) / agingMs);
    ready.sort((a, b) => score(b) - score(a) || a.enqueuedAt - b.enqueuedAt);
    const job = ready[0];
    if (!job) {
      if (this.pending.size) {
        const delay = Math.max(1, Math.min(...[...this.pending.values()].map(readyAt)) - now);
        this.timer = setTimeout(() => this.pump(), delay);
      }
      return;
    }
    this.pending.delete(job.key);
    const controller = new AbortController();
    this.active = { job, controller };
    const completed = (): void => {
      this.completed++;
      this.active = null;
      this.nextBackgroundAt = Date.now() + (this.options.cooldownMs ?? 5_000);
      this.pump();
    };
    // Finish bookkeeping before waking completion waiters; stop() really drains
    // the active slot, and a next producer cannot observe a resolved active job.
    void Promise.resolve().then(() => job.run(controller.signal)).then((result) => {
      completed(); job.resolve(result);
    }, (error) => { completed(); job.reject(error); });
  }
}
