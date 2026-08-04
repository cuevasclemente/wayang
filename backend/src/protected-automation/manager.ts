import { getStore } from "../db.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import { assertProtectedAutomationJobAuthority, protectedAutomationJobAuthorityIsCurrent } from "./authority.js";
import type { ProtectedAutomationBrowserLeaseBinding } from "./browser-realm.js";
import type { ProtectedAutomationBrowserLeasePort } from "./browser-rpc.js";
import {
  claimProtectedAutomationRun,
  enqueueProtectedAutomationRun,
  finishProtectedAutomationRun,
  getProtectedAutomationJob,
  getProtectedAutomationRun,
  listProtectedAutomationActiveRuns,
  recoverProtectedAutomationRuns,
  requestProtectedAutomationRunCancellation,
} from "./store.js";
import {
  runProtectedAutomation,
  type ProtectedAutomationBrowserPort,
  type ProtectedAutomationRunnerOptions,
} from "./runner.js";
import {
  ProtectedAutomationRuntimeStorage,
  type ProtectedAutomationRunStorageIdentity,
} from "./runtime-storage.js";
import type {
  ProtectedAutomationJobRow,
  ProtectedAutomationRunRow,
  ProtectedAutomationRunnerJob,
  ProtectedAutomationRunnerResult,
} from "./types.js";

export interface ProtectedAutomationBrowserLeaseFactoryInput {
  job: ProtectedAutomationJobRow;
  run: ProtectedAutomationRunRow;
  projectCwd: string;
  runRoot: string;
  signal: AbortSignal;
  assertAuthorized(binding: Readonly<ProtectedAutomationBrowserLeaseBinding>): void;
}

export interface ProtectedAutomationManagerOptions {
  browserLeaseFactory?: (
    input: ProtectedAutomationBrowserLeaseFactoryInput,
  ) => Promise<ProtectedAutomationBrowserLeasePort | undefined>;
  /** Legacy synthetic injection seam; production composition should inject a closeable lease. */
  browserPortFactory?: (
    job: ProtectedAutomationJobRow,
    run: ProtectedAutomationRunRow,
  ) => Promise<ProtectedAutomationBrowserPort | undefined>;
  runner?: (
    request: ProtectedAutomationRunnerJob,
    options: ProtectedAutomationRunnerOptions,
  ) => Promise<ProtectedAutomationRunnerResult>;
  now?: () => number;
  runtimeStorage?: ProtectedAutomationRuntimeStorage;
}

function executionHandleIsCurrent(job: ProtectedAutomationJobRow): boolean {
  const current = getProtectedAutomationJob(job.id);
  return !!current && current.enabled && current.deleted_at === null && current.revision === job.revision
    && current.source_revision === job.source_revision && current.capability_revision === job.capability_revision
    && current.source_manifest_sha256 === job.source_manifest_sha256 && protectedAutomationJobAuthorityIsCurrent(current);
}

function storageIdentity(job: ProtectedAutomationJobRow, run: ProtectedAutomationRunRow): ProtectedAutomationRunStorageIdentity {
  return { projectId: job.project_id, agentProfileId: job.agent_profile_id, jobId: job.id, runId: run.id };
}

function resultIntentionallyPublishesState(result: Pick<ProtectedAutomationRunnerResult, "status" | "outcomeCode">): boolean {
  return result.status === "completed" || (result.status === "needs_user" && result.outcomeCode.startsWith("needs_user:"));
}

export class ProtectedAutomationManager {
  private readonly active = new Map<string, AbortController>();
  private readonly runner: NonNullable<ProtectedAutomationManagerOptions["runner"]>;
  private readonly now: () => number;
  private readonly runtimeStorage: ProtectedAutomationRuntimeStorage;
  private started = false;

  constructor(private readonly options: ProtectedAutomationManagerOptions = {}) {
    this.runner = options.runner ?? runProtectedAutomation;
    this.now = options.now ?? Date.now;
    this.runtimeStorage = options.runtimeStorage ?? new ProtectedAutomationRuntimeStorage();
  }

  start(): { queued: number; interrupted: number } {
    if (this.started) return { queued: 0, interrupted: 0 };
    this.started = true;
    try {
      const recovered = recoverProtectedAutomationRuns(this.now());
      const store = getStore();
      this.runtimeStorage.reconcile(store.protectedAutomationJobs, store.protectedAutomationRuns, (job, run) => (
        job.project_id === run.project_id && job.agent_profile_id === run.agent_profile_id
        && job.revision === run.job_revision && job.capability_revision === run.capability_revision
        && (run.status !== "needs_user" || run.outcome_code?.startsWith("needs_user:") === true)
        && executionHandleIsCurrent(job)
      ));
      for (const run of recovered.queued) this.dispatch(run.id);
      return { queued: recovered.queued.length, interrupted: recovered.interrupted };
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const controller of this.active.values()) controller.abort();
    await this.waitForIdle();
  }

  runNow(jobId: string, expectedRevision: number): ProtectedAutomationRunRow {
    const job = this.requireEffectiveJob(jobId, expectedRevision);
    assertProtectedAutomationJobAuthority(job);
    const run = enqueueProtectedAutomationRun({
      jobId: job.id,
      expectedRevision: job.revision,
      trigger: "manual",
      scheduledFor: null,
      occurrenceKey: null,
      now: this.now(),
    });
    if (run.status === "queued") this.dispatch(run.id);
    return run;
  }

  enqueueScheduled(
    jobId: string,
    expectedRevision: number,
    scheduledFor: number,
    occurrenceKey: string,
  ): ProtectedAutomationRunRow {
    const job = this.requireEffectiveJob(jobId, expectedRevision);
    if (!protectedAutomationJobAuthorityIsCurrent(job)) {
      throw new WorkspaceStoreError("Protected automation exact-pair authority is no longer current", 403);
    }
    const run = enqueueProtectedAutomationRun({
      jobId: job.id,
      expectedRevision: job.revision,
      trigger: "schedule",
      scheduledFor,
      occurrenceKey,
      now: this.now(),
    });
    if (run.status === "queued") this.dispatch(run.id);
    return run;
  }

  cancel(runId: string): ProtectedAutomationRunRow {
    const row = requestProtectedAutomationRunCancellation(runId, this.now());
    if (!row) throw new WorkspaceStoreError("Protected automation run not found", 404);
    this.active.get(runId)?.abort();
    return row;
  }

  terminateJobs(predicate: (job: ProtectedAutomationJobRow) => boolean): number {
    let stopped = 0;
    for (const run of listProtectedAutomationActiveRuns()) {
      const durable = getProtectedAutomationJob(run.job_id);
      if (durable && predicate(durable)) {
        requestProtectedAutomationRunCancellation(run.id, this.now());
        this.active.get(run.id)?.abort();
        stopped += 1;
      }
    }
    return stopped;
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  isRunActive(runId: string): boolean { return this.active.has(runId); }

  hasActiveJob(jobId: string): boolean { return this.activeRunIdsForJob(jobId).size > 0; }

  activeRunIdsForJob(jobId: string): ReadonlySet<string> {
    const result = new Set<string>();
    for (const runId of this.active.keys()) if (getProtectedAutomationRun(runId)?.job_id === jobId) result.add(runId);
    return result;
  }

  hasRunStorage(runId: string): boolean { return this.runtimeStorage.hasRunStorage(runId); }

  retireJobStorage(identity: { projectId: string; agentProfileId: string; jobId: string }): boolean {
    return this.runtimeStorage.retireJob(identity, this.activeRunIdsForJob(identity.jobId));
  }

  private requireEffectiveJob(jobId: string, expectedRevision: number): ProtectedAutomationJobRow {
    const job = getProtectedAutomationJob(jobId);
    if (!job) throw new WorkspaceStoreError("Protected automation job not found", 404);
    if (!job.enabled || job.revision !== expectedRevision || job.deleted_at !== null) {
      throw new WorkspaceStoreError("Protected automation job revision conflict or job is paused", 409);
    }
    return job;
  }

  private dispatch(runId: string): void {
    if (!this.started || this.active.has(runId)) return;
    const controller = new AbortController();
    this.active.set(runId, controller);
    void this.execute(runId, controller).catch(() => undefined).finally(() => {
      this.active.delete(runId);
      this.runtimeStorage.flushDeferred((jobId) => this.activeRunIdsForJob(jobId));
    });
  }

  private async execute(runId: string, controller: AbortController): Promise<void> {
    const claimed = claimProtectedAutomationRun(runId, this.now());
    if (!claimed || claimed.status !== "running") return;
    const durable = getProtectedAutomationJob(claimed.job_id);
    if (!durable) {
      finishProtectedAutomationRun(runId, "denied", "job_unavailable", null, this.now());
      return;
    }
    const job = durable;
    if (!job.enabled || job.revision !== claimed.job_revision
      || job.capability_revision !== claimed.capability_revision || !executionHandleIsCurrent(job)) {
      finishProtectedAutomationRun(runId, "denied", "authority_unavailable", null, this.now());
      return;
    }

    const identity = storageIdentity(job, claimed);
    const projectCwd = getStore().projects.find((candidate) => candidate.id === job.project_id)?.cwd ?? "";
    if (!projectCwd) {
      finishProtectedAutomationRun(runId, "denied", "project_unavailable", null, this.now());
      return;
    }
    let roots: { runRoot: string; stateRoot: string };
    try { roots = this.runtimeStorage.prepareRun(job, claimed); }
    catch {
      this.runtimeStorage.retireRun(identity);
      finishProtectedAutomationRun(runId, "failed", "storage_preflight_failed", null, this.now());
      return;
    }
    try {
      const assertBrowserLeaseAuthorized = (binding: Readonly<ProtectedAutomationBrowserLeaseBinding>): void => {
        assertProtectedAutomationJobAuthority(job);
        if (binding.projectId !== job.project_id || binding.projectCwd !== projectCwd
          || binding.agentProfileId !== job.agent_profile_id || binding.jobId !== job.id || binding.capabilityRevision !== job.capability_revision
          || binding.jobRevision !== job.revision || binding.sourceRevision !== job.source_revision
          || binding.sourceManifestSha256 !== job.source_manifest_sha256 || binding.kind !== "run"
          || binding.ownerId !== claimed.id || !executionHandleIsCurrent(job)) {
          throw new Error("Protected automation browser lease revision is stale");
        }
      };
      let browserPort: ProtectedAutomationBrowserPort | undefined;
      let browserLease: ProtectedAutomationBrowserLeasePort | undefined;
      if (job.uses_browser_profile && this.options.browserLeaseFactory) {
        try {
          browserLease = await this.options.browserLeaseFactory({
            job, run: claimed, projectCwd, runRoot: roots.runRoot, signal: controller.signal,
            assertAuthorized: assertBrowserLeaseAuthorized,
          });
          browserPort = browserLease;
        } catch { browserLease = undefined; browserPort = undefined; }
      } else if (job.uses_browser_profile && this.options.browserPortFactory) {
        try { browserPort = await this.options.browserPortFactory(job, claimed); } catch { browserPort = undefined; }
      }
      if (!executionHandleIsCurrent(job)) {
        await browserLease?.close().catch(() => undefined);
        finishProtectedAutomationRun(runId, "denied", "authority_unavailable", null, this.now());
        this.runtimeStorage.discardStagedState(identity);
        return;
      }
      const authorityPoll = setInterval(() => {
        if (!executionHandleIsCurrent(job)) controller.abort();
      }, 100);
      authorityPoll.unref();
      let result: ProtectedAutomationRunnerResult;
      try {
        result = await this.runner({ job, run: claimed, projectRoot: projectCwd }, {
          ...roots,
          signal: controller.signal,
          browserPort,
          assertAuthorized: () => {
            assertProtectedAutomationJobAuthority(job);
            if (!executionHandleIsCurrent(job)) throw new Error("Protected automation job revision is stale");
          },
        });
      } catch {
        result = {
          status: controller.signal.aborted ? "cancelled" : "failed",
          outcomeCode: controller.signal.aborted ? "cancelled" : "runner_failed",
          exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        };
      } finally {
        clearInterval(authorityPoll);
        await browserLease?.close().catch(() => undefined);
      }

      const currentRun = getProtectedAutomationRun(runId);
      if (!currentRun || currentRun.status !== "running" || !executionHandleIsCurrent(job)) {
        finishProtectedAutomationRun(runId, "denied", "authority_revoked", null, this.now());
        this.runtimeStorage.discardStagedState(identity);
        return;
      }
      try {
        this.runtimeStorage.persistDiagnostics(identity, result.stdout, result.stderr);
      } catch {
        this.runtimeStorage.retireRun(identity);
        finishProtectedAutomationRun(runId, "failed", "output_persistence_failed", null, this.now());
        return;
      }
      if (resultIntentionallyPublishesState(result)) {
        try { this.runtimeStorage.sealState(identity, result.status as "completed" | "needs_user"); }
        catch {
          result = { ...result, status: "failed", outcomeCode: "state_persistence_failed", exitCode: null };
          this.runtimeStorage.discardStagedState(identity);
        }
      } else this.runtimeStorage.discardStagedState(identity);

      const precommitRun = getProtectedAutomationRun(runId);
      if (!precommitRun || precommitRun.status !== "running" || !executionHandleIsCurrent(job)) {
        finishProtectedAutomationRun(runId, "denied", "authority_revoked", null, this.now());
        this.runtimeStorage.discardStagedState(identity);
        return;
      }
      const finished = finishProtectedAutomationRun(runId, result.status, result.outcomeCode, result.exitCode, this.now());
      if (finished && finished.status === result.status && resultIntentionallyPublishesState(result)
        && (finished.status === "completed" || finished.status === "needs_user") && executionHandleIsCurrent(job)) {
        try { this.runtimeStorage.publishState(identity, finished.status); } catch { /* startup reconciliation retries sealed state */ }
      } else this.runtimeStorage.discardStagedState(identity);
    } finally {
      this.runtimeStorage.cleanupRunScratch(identity);
    }
  }
}

let assembledManager: ProtectedAutomationManager | null = null;

export function setProtectedAutomationManager(manager: ProtectedAutomationManager | null): void {
  assembledManager = manager;
}

export function getProtectedAutomationManager(): ProtectedAutomationManager | null {
  return assembledManager;
}
