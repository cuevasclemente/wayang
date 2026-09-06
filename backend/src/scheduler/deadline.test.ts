import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { SchedulerCleanupRecovery, SchedulerRuntimeDependencies, SchedulerRuntimeHandle } from "./manager.js";
import type { ScheduledJobRow } from "./types.js";

const BUDGET_MS = 100;
const EPOCH = Date.UTC(2026, 0, 1);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Only controlled promise continuations run here; no sleeps or real clock races.
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function clock(t: TestContext) {
  let monotonicNow = 0;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: EPOCH });
  t.mock.method(performance, "now", () => monotonicNow);
  return {
    advance(ms: number) {
      monotonicNow += ms;
      t.mock.timers.tick(ms);
    },
    jumpWallClock(ms: number) {
      t.mock.timers.setTime(Date.now() + ms);
    },
  };
}

// This is the proposed bridge input contract, not an implementation of it.
// Once bridge creation supports signal, its existing parameter type supplies it.
// The synthetic bridge must not settle cancelled creation until exact cleanup
// finishes. Signal delivery is denial intent, not hard cancellation of a hook.
type CreationOptions = NonNullable<Parameters<SchedulerRuntimeDependencies["createPiSession"]>[5]> & {
  signal?: AbortSignal;
};

function gatedRuntime(root: string, hooks: { afterPublication?: () => void; cleanupError?: Error } = {}) {
  const startup = gate();
  const cleanup = gate();
  const cancellations: string[] = [];
  const returnedHandles: SchedulerRuntimeHandle[] = [];
  const cancelledHandles: SchedulerRuntimeHandle[] = [];
  const cleanupAttempts: SchedulerRuntimeHandle[] = [];
  const publications: string[] = [];
  const prompts: Array<{ sessionId: string; content: string; timeoutMs: number | undefined }> = [];
  let firstSessionId: string | undefined;
  let firstSignal: AbortSignal | undefined;
  let cleanupStarted = false;
  let cleanupFinished = false;
  const runtime: SchedulerRuntimeDependencies = {
    createPiSession: async (id, _cwd, _provider, _model, _file, options: CreationOptions = {}) => {
      // Only this exact first creation is blocked; another job is independent.
      if (firstSessionId === undefined) {
        firstSessionId = id;
        firstSignal = options.signal;
      }
      if (id === firstSessionId) {
        let denied = false;
        const deny = () => {
          if (denied) return;
          denied = true;
          cancellations.push(id);
        };
        options.signal?.addEventListener("abort", deny, { once: true });
        if (options.signal?.aborted) deny();
        try {
          await startup.promise;
          if (denied) {
            cleanupStarted = true;
            await cleanup.promise;
            cleanupFinished = true;
            throw new Error("synthetic private startup detail: creation cancelled after cleanup");
          }
        } finally {
          options.signal?.removeEventListener("abort", deny);
        }
      }
      // Models the bridge publication fence; no SDK, transcript read, provider,
      // extension, approval client, or network operation is constructed here.
      const ownedHandle: SchedulerRuntimeHandle = {
        sessionFile: path.join(root, "pi", `${id}.jsonl`),
        cancel: async () => {
          cancellations.push(id);
          cancelledHandles.push(ownedHandle);
        },
        cleanup: async () => {
          cleanupAttempts.push(ownedHandle);
          cleanupStarted = true;
          await cleanup.promise;
          if (hooks.cleanupError) throw hooks.cleanupError;
          cleanupFinished = true;
        },
      };
      publications.push(id);
      returnedHandles.push(ownedHandle);
      hooks.afterPublication?.();
      return ownedHandle;
    },
    runPromptAndWait: async (sessionId, content, options = {}) => {
      prompts.push({ sessionId, content, timeoutMs: options.timeoutMs });
      return { resultSummary: "synthetic result", finalAssistantText: "synthetic result", messages: [] };
    },
  };
  return {
    runtime, startup, cleanup, cancellations, publications, prompts,
    returnedHandles, cancelledHandles, cleanupAttempts,
    get signal() { return firstSignal; },
    get cleanupStarted() { return cleanupStarted; },
    get cleanupFinished() { return cleanupFinished; },
  };
}

// Synthetic Error/receipt ownership stays inside this adapter, like the bridge's
// private WeakMap. Neither the scheduler store nor the fixture's public surface
// receives a raw error, partial SDK handle, or cleanup reservation.
function uncertainRuntime(options: {
  phase?: "creation" | "cleanup";
  unknownReceipt?: boolean;
  rejectedWait?: boolean;
  malformedReceipt?: boolean;
  onCreated?: () => void;
} = {}) {
  const startup = gate();
  const confirmation = gate();
  const uncertainty = Object.assign(new Error("synthetic private cleanup reservation detail"), {
    code: "pi_session_cleanup_unconfirmed",
  });
  const receipts = new WeakMap<Error, SchedulerCleanupRecovery>();
  let automaticRetries = 0;
  let explicitFailures = 0;
  let waits = 0;
  let creations = 0;
  let prompts = 0;
  let firstSessionId: string | undefined;
  const receipt: SchedulerCleanupRecovery = {
    retry: async () => {
      automaticRetries++;
      throw new Error("synthetic private retry failure");
    },
    get wait(): () => Promise<void> {
      if (options.malformedReceipt) throw new Error("synthetic malformed receipt accessor");
      return () => {
        waits++;
        return options.rejectedWait
          ? Promise.reject(new Error("synthetic unknown cleanup receipt"))
          : confirmation.promise;
      };
    },
  };
  if (!options.unknownReceipt) receipts.set(uncertainty, receipt);
  const runtime: SchedulerRuntimeDependencies = {
    createPiSession: async (id) => {
      creations++;
      if (firstSessionId === undefined) firstSessionId = id;
      if (id === firstSessionId) {
        await startup.promise;
        if (options.phase !== "cleanup") throw uncertainty;
        options.onCreated?.();
        return {
          cancel: async () => undefined,
          cleanup: async () => { throw uncertainty; },
        };
      }
      return { cancel: async () => undefined, cleanup: async () => undefined };
    },
    runPromptAndWait: async () => {
      prompts++;
      return { resultSummary: "synthetic independent result", finalAssistantText: null, messages: [] };
    },
    getCleanupRecovery: (error) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "pi_session_cleanup_unconfirmed") {
        return undefined;
      }
      // A copied code/message or unknown receipt is not identity authority.
      return receipts.get(error) ?? null;
    },
  };
  return {
    runtime,
    startup,
    confirmExplicitCleanup: () => confirmation.release(),
    failExplicitCleanup: async () => {
      explicitFailures++;
      throw new Error("synthetic explicit cleanup still unconfirmed");
    },
    get automaticRetries() { return automaticRetries; },
    get explicitFailures() { return explicitFailures; },
    get waits() { return waits; },
    get creations() { return creations; },
    get prompts() { return prompts; },
  };
}

test("scheduler acceptance deadline includes runtime startup", async (t) => {
  // Install synthetic roots before importing runtime modules. Store and policy
  // are production implementations; only create/run effects are substituted.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-scheduler-deadline-"));
  const roots = {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    PI_CODING_AGENT_DIR: path.join(root, "pi"),
    WAYANG_DATA_DIR: path.join(root, "data"),
  };
  const previous = new Map(Object.keys(roots).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(roots)) {
    fs.mkdirSync(value, { recursive: true });
    process.env[key] = value;
  }
  const { close, init } = await import("../db.js");
  t.after(() => {
    close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { createAgentProfile } = await import("../agent-profiles.js");
  const { createProject } = await import("../projects.js");
  const { getSessionById } = await import("../sessions.js");
  const { SchedulerManager } = await import("./manager.js");
  const { createScheduledJob, hasRunningRun, listScheduledRuns, updateScheduledRun } = await import("./store.js");
  close();
  init();
  let fixtureNumber = 0;
  function job(protectedProject = false): ScheduledJobRow {
    const cwd = path.join(root, `project-${++fixtureNumber}`);
    fs.mkdirSync(cwd);
    const profile = createAgentProfile({ name: `Synthetic deadline profile ${fixtureNumber}` });
    createProject({
      cwd,
      default_agent_profile_id: profile.id,
      access_policy: {
        privacy_mode: protectedProject ? "protected" : "standard",
        allowed_agent_profile_ids: [profile.id],
      },
    });
    return createScheduledJob({
      name: `Synthetic deadline job ${fixtureNumber}`,
      cwd,
      agent_profile_id: profile.id,
      cron_expr: "0 9 * * *",
      prompt: "Finish independent synthetic work without waiting for human input",
      timeout_ms: BUDGET_MS,
      command_guard_mode: "default",
      enabled: false,
    });
  }
  function row(jobId: string, runId: string) {
    const value = listScheduledRuns(jobId).find((run) => run.id === runId);
    assert.ok(value, "real scheduler store must retain the accepted row");
    return value;
  }
  async function releaseAndDrain(fake: ReturnType<typeof gatedRuntime>, jobs: ScheduledJobRow[]) {
    // Always release both gates, including when a baseline assertion fails.
    fake.startup.release();
    fake.cleanup.release();
    await drainMicrotasks();
    for (const value of jobs) assert.equal(hasRunningRun(value.id), false, "fixture run must settle before store teardown");
  }

  await t.test("requests cancellation at the deadline while startup remains gated; unrelated jobs run", async (t) => {
    const time = clock(t);
    const blocked = job();
    const unrelated = job();
    const fake = gatedRuntime(root);
    const manager = new SchedulerManager(fake.runtime);
    const accepted = manager.triggerRun(blocked.id);
    try {
      assert.equal(accepted.status, "running");
      const sessionId = row(blocked.id, accepted.id).session_id;
      assert.ok(sessionId);
      time.advance(BUDGET_MS - 1);
      assert.deepEqual(fake.cancellations, []);
      time.advance(1);
      // No microtask drain: cancellation/denial must be attempted by the timer,
      // not deferred until the blocked creation promise eventually returns.
      assert.deepEqual(fake.cancellations, [sessionId], "deadline must cancel pending creation immediately");
      assert.equal(row(blocked.id, accepted.id).status, "running");
      assert.equal(row(blocked.id, accepted.id).finished_at, null);
      assert.match(row(blocked.id, accepted.id).error_message ?? "", /cleanup pending/);
      assert.equal(manager.triggerRun(blocked.id).status, "skipped");
      const independent = manager.triggerRun(unrelated.id);
      await drainMicrotasks();
      assert.equal(row(unrelated.id, independent.id).status, "completed");
      assert.equal(row(blocked.id, accepted.id).status, "running");
      assert.deepEqual(fake.publications, [row(unrelated.id, independent.id).session_id]);
    } finally {
      await releaseAndDrain(fake, [blocked, unrelated]);
    }
  });

  for (const protectedProject of [false, true]) {
    await t.test(`late ${protectedProject ? "Protected" : "Standard"} startup cannot publish or prompt; failure waits for cleanup`, async (t) => {
      const time = clock(t);
      const blocked = job(protectedProject);
      const unrelated = job(protectedProject);
      const fake = gatedRuntime(root);
      const manager = new SchedulerManager(fake.runtime);
      const accepted = manager.triggerRun(blocked.id);
      const sessionId = row(blocked.id, accepted.id).session_id;
      assert.ok(sessionId);
      try {
        time.advance(BUDGET_MS + 1);
        fake.startup.release();
        await drainMicrotasks();
        assert.deepEqual(fake.publications, [], "expired creation must never publish a live runtime");
        assert.deepEqual(fake.prompts, [], "expired budget must not dispatch a prompt (including timeoutMs: 0)");
        assert.equal(getSessionById(sessionId)?.pi_session_file, null, "late transcript locator must not be published");
        assert.equal(fake.cleanupStarted, true);
        assert.equal(fake.cleanupFinished, false);
        assert.equal(row(blocked.id, accepted.id).status, "running");
        assert.equal(row(blocked.id, accepted.id).finished_at, null);
        assert.equal(row(blocked.id, accepted.id).result_summary, null);
        assert.match(row(blocked.id, accepted.id).error_message ?? "", /cleanup pending/);
        assert.doesNotMatch(row(blocked.id, accepted.id).error_message ?? "", /synthetic private/);
        assert.equal(hasRunningRun(blocked.id), true);
        assert.equal(manager.triggerRun(blocked.id).status, "skipped");
        const independent = manager.triggerRun(unrelated.id);
        await drainMicrotasks();
        assert.equal(row(unrelated.id, independent.id).status, "completed", "cleanup must not block an unrelated job");
        // A long/uncooperative cleanup is not proof of cancellation completion.
        time.advance(10 * BUDGET_MS);
        await drainMicrotasks();
        assert.equal(row(blocked.id, accepted.id).status, "running");
        assert.equal(hasRunningRun(blocked.id), true);
        fake.cleanup.release();
        await drainMicrotasks();
        assert.equal(fake.cleanupFinished, true);
        const terminal = row(blocked.id, accepted.id);
        assert.equal(terminal.status, "failed");
        assert.notEqual(terminal.finished_at, null);
        assert.equal(terminal.result_summary, null);
        assert.equal(hasRunningRun(blocked.id), false);
        if (protectedProject) {
          assert.equal(terminal.error_message, "Protected scheduled run failed; inspect the linked Protected session");
        } else {
          assert.match(terminal.error_message ?? "", /timed out|deadline/i);
        }
        const fresh = manager.triggerRun(blocked.id);
        assert.equal(fresh.status, "running", "proven cleanup releases only this job's overlap guard");
        await drainMicrotasks();
        assert.equal(row(blocked.id, fresh.id).status, "completed");
      } finally {
        await releaseAndDrain(fake, [blocked, unrelated]);
      }
    });
  }

  await t.test("expiry between runtime publication and scheduler continuation cleans only the returned handle", async (t) => {
    const time = clock(t);
    const value = job();
    const fake = gatedRuntime(root, { afterPublication: () => time.advance(BUDGET_MS) });
    const manager = new SchedulerManager(fake.runtime);
    const accepted = manager.triggerRun(value.id);
    try {
      fake.startup.release();
      await drainMicrotasks();
      assert.equal(fake.returnedHandles.length, 1);
      assert.deepEqual(fake.cancelledHandles, [fake.returnedHandles[0]]);
      assert.deepEqual(fake.cleanupAttempts, [fake.returnedHandles[0]]);
      assert.deepEqual(fake.prompts, []);
      const pending = row(value.id, accepted.id);
      assert.ok(pending.session_id);
      assert.equal(getSessionById(pending.session_id)?.pi_session_file, null);
      assert.equal(pending.status, "running");
      assert.equal(pending.finished_at, null);
      assert.match(pending.error_message ?? "", /cleanup pending/);
      assert.equal(manager.triggerRun(value.id).status, "skipped");
      fake.cleanup.release();
      await drainMicrotasks();
      assert.equal(row(value.id, accepted.id).status, "failed");
      assert.equal(hasRunningRun(value.id), false);
    } finally {
      await releaseAndDrain(fake, [value]);
    }
  });

  await t.test("prompt expiry aborts immediately but waits for original prompt and exact cleanup", async (t) => {
    const time = clock(t);
    const value = job();
    const fake = gatedRuntime(root);
    const prompt = gate();
    let promptEntered = false;
    const manager = new SchedulerManager({
      ...fake.runtime,
      runPromptAndWait: async () => {
        promptEntered = true;
        await prompt.promise;
        throw new Error("synthetic prompt cancelled");
      },
    });
    const accepted = manager.triggerRun(value.id);
    try {
      fake.startup.release();
      await drainMicrotasks();
      assert.equal(promptEntered, true);
      time.advance(BUDGET_MS);
      assert.deepEqual(fake.cancelledHandles, [fake.returnedHandles[0]]);
      await drainMicrotasks();
      assert.equal(row(value.id, accepted.id).status, "running");
      assert.equal(fake.cleanupStarted, false, "abort acknowledgement is not prompt settlement");
      assert.equal(manager.triggerRun(value.id).status, "skipped");
      prompt.release();
      await drainMicrotasks();
      assert.equal(fake.cleanupStarted, true);
      assert.equal(fake.cleanupFinished, false);
      assert.equal(row(value.id, accepted.id).status, "running");
      fake.cleanup.release();
      await drainMicrotasks();
      assert.equal(row(value.id, accepted.id).status, "failed");
      assert.match(row(value.id, accepted.id).error_message ?? "", /timed out/);
    } finally {
      prompt.release();
      await releaseAndDrain(fake, [value]);
    }
  });

  await t.test("failed exact cleanup retains a content-free Protected overlap guard", async (t) => {
    const time = clock(t);
    const value = job(true);
    const fake = gatedRuntime(root, {
      afterPublication: () => time.advance(BUDGET_MS),
      cleanupError: new Error("synthetic private cleanup error"),
    });
    const manager = new SchedulerManager(fake.runtime);
    const accepted = manager.triggerRun(value.id);
    try {
      fake.startup.release();
      fake.cleanup.release();
      await drainMicrotasks();
      const pending = row(value.id, accepted.id);
      assert.equal(pending.status, "running");
      assert.equal(pending.finished_at, null);
      assert.equal(pending.result_summary, null);
      assert.match(pending.error_message ?? "", /Protected.*cleanup unconfirmed/);
      assert.doesNotMatch(pending.error_message ?? "", /synthetic private/);
      assert.equal(manager.triggerRun(value.id).status, "skipped");
      assert.deepEqual(fake.cleanupAttempts, [fake.returnedHandles[0]]);
    } finally {
      fake.startup.release();
      fake.cleanup.release();
      await drainMicrotasks();
      // No live synthetic work remains, but cleanup rejection deliberately
      // retains the durable row; only the synthetic store is removed at teardown.
    }
  });

  for (const protectedProject of [false, true]) {
    await t.test(`unconfirmed ${protectedProject ? "Protected" : "Standard"} creation rejection retains ownership`, async (t) => {
      const time = clock(t);
      const value = job(protectedProject);
      const unrelated = job(protectedProject);
      const fake = uncertainRuntime();
      const manager = new SchedulerManager(fake.runtime);
      const accepted = manager.triggerRun(value.id);
      try {
        time.advance(BUDGET_MS + 1);
        fake.startup.release();
        await drainMicrotasks();
        const pending = row(value.id, accepted.id);
        assert.equal(pending.status, "running", "rejected creation is not proof that partial SDK cleanup succeeded");
        assert.equal(pending.finished_at, null);
        assert.equal(pending.result_summary, null);
        assert.match(pending.error_message ?? "", /cleanup unconfirmed/);
        assert.doesNotMatch(pending.error_message ?? "", /synthetic private|pi_session_cleanup_unconfirmed/);
        assert.ok((pending.error_message?.length ?? 0) <= 256);
        assert.equal(hasRunningRun(value.id), true);
        assert.equal(manager.triggerRun(value.id).status, "skipped");
        assert.equal(fake.creations, 1, "uncertainty must not restart the job or runtime");
        assert.equal(fake.prompts, 0);
        const independent = manager.triggerRun(unrelated.id);
        await drainMicrotasks();
        assert.equal(row(unrelated.id, independent.id).status, "completed");
        assert.equal(row(value.id, accepted.id).status, "running");
        fake.confirmExplicitCleanup();
        await drainMicrotasks();
        const terminal = row(value.id, accepted.id);
        assert.equal(terminal.status, "failed", "creation cleanup receipt must release the same run after confirmation");
        assert.equal(hasRunningRun(value.id), false);
        assert.doesNotMatch(terminal.error_message ?? "", /synthetic private|pi_session_cleanup_unconfirmed/);
        if (protectedProject) {
          assert.equal(terminal.error_message, "Protected scheduled run failed; inspect the linked Protected session");
        } else {
          assert.match(terminal.error_message ?? "", /timed out/);
        }
      } finally {
        fake.startup.release();
        fake.confirmExplicitCleanup();
        await drainMicrotasks();
      }
    });
  }

  await t.test("explicit later cleanup confirmation finalizes the exact Protected run", async (t) => {
    const time = clock(t);
    const value = job(true);
    const fake = uncertainRuntime({ phase: "cleanup", onCreated: () => time.advance(BUDGET_MS) });
    const manager = new SchedulerManager(fake.runtime);
    const accepted = manager.triggerRun(value.id);
    try {
      fake.startup.release();
      await drainMicrotasks();
      assert.equal(row(value.id, accepted.id).status, "running");
      assert.match(row(value.id, accepted.id).error_message ?? "", /cleanup unconfirmed/);
      assert.equal(manager.triggerRun(value.id).status, "skipped");
      // Models explicit destroy retrying the bridge's retained exact record.
      // No new trigger or scheduler replay is allowed to drive this completion.
      fake.confirmExplicitCleanup();
      await drainMicrotasks();
      const terminal = row(value.id, accepted.id);
      assert.equal(terminal.status, "failed", "the retained receipt must observe explicit cleanup completed later");
      assert.notEqual(terminal.finished_at, null);
      assert.equal(terminal.error_message, "Protected scheduled run failed; inspect the linked Protected session");
      assert.equal(terminal.result_summary, null);
      assert.equal(hasRunningRun(value.id), false);
      assert.equal(fake.waits, 1);
      assert.ok(fake.automaticRetries <= 1);
      assert.equal(fake.creations, 1);
      assert.equal(fake.prompts, 0);
      const fresh = manager.triggerRun(value.id);
      await drainMicrotasks();
      assert.equal(row(value.id, fresh.id).status, "completed");
      const snapshot = row(value.id, accepted.id);
      fake.confirmExplicitCleanup();
      await drainMicrotasks();
      assert.deepEqual(row(value.id, accepted.id), snapshot, "duplicate receipt notification must not rewrite the terminal row");
    } finally {
      fake.startup.release();
      fake.confirmExplicitCleanup();
      await drainMicrotasks();
    }
  });

  await t.test("repeated cleanup failure cannot release ownership or start a retry loop", async (t) => {
    const time = clock(t);
    const value = job();
    const fake = uncertainRuntime();
    const manager = new SchedulerManager(fake.runtime);
    const accepted = manager.triggerRun(value.id);
    try {
      // This is cleanup uncertainty before the acceptance deadline, not timeout.
      fake.startup.release();
      await drainMicrotasks();
      assert.equal(row(value.id, accepted.id).status, "running");
      assert.match(row(value.id, accepted.id).error_message ?? "", /cleanup unconfirmed/);
      assert.doesNotMatch(row(value.id, accepted.id).error_message ?? "", /timed out/);
      const retries = fake.automaticRetries;
      assert.ok(retries <= 1, "at most one scheduler-owned cleanup retry");
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(fake.failExplicitCleanup(), /still unconfirmed/);
        time.advance(10 * BUDGET_MS);
        await drainMicrotasks();
        assert.equal(row(value.id, accepted.id).status, "running");
        assert.equal(row(value.id, accepted.id).finished_at, null);
        assert.match(row(value.id, accepted.id).error_message ?? "", /cleanup unconfirmed/);
        assert.equal(fake.automaticRetries, retries, "clock advancement cannot restart automatic cleanup");
        assert.equal(manager.triggerRun(value.id).status, "skipped");
      }
      assert.equal(fake.explicitFailures, 3);
      assert.equal(fake.waits, 1, "one receipt observer survives failed cleanup attempts");
      assert.equal(fake.creations, 1);
      assert.equal(fake.prompts, 0);
      fake.confirmExplicitCleanup();
      await drainMicrotasks();
      const terminal = row(value.id, accepted.id);
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.error_message, "Scheduled run failed; runtime cleanup confirmed");
      assert.equal(hasRunningRun(value.id), false);
    } finally {
      fake.startup.release();
      fake.confirmExplicitCleanup();
      await drainMicrotasks();
    }
  });

  for (const invalid of ["unknown", "rejected", "malformed"] as const) {
    await t.test(`${invalid} cleanup receipt cannot certify release`, async (t) => {
      clock(t);
      const value = job(true);
      const fake = uncertainRuntime({
        unknownReceipt: invalid === "unknown",
        rejectedWait: invalid === "rejected",
        malformedReceipt: invalid === "malformed",
      });
      const manager = new SchedulerManager(fake.runtime);
      const accepted = manager.triggerRun(value.id);
      try {
        fake.startup.release();
        await drainMicrotasks();
        // Even an apparent completion elsewhere is irrelevant when this Error
        // has no trusted receipt, or exact-receipt lookup/wait itself rejected.
        fake.confirmExplicitCleanup();
        await drainMicrotasks();
        const pending = row(value.id, accepted.id);
        assert.equal(pending.status, "running", "unknown/rejected receipt is not cleanup confirmation");
        assert.equal(pending.finished_at, null);
        assert.equal(pending.result_summary, null);
        assert.match(pending.error_message ?? "", /cleanup unconfirmed/);
        assert.doesNotMatch(pending.error_message ?? "", /synthetic|reservation|pi_session_cleanup_unconfirmed/);
        assert.equal(manager.triggerRun(value.id).status, "skipped");
        assert.ok(fake.automaticRetries <= 1);
        if (invalid === "unknown") assert.equal(fake.automaticRetries, 0);
        assert.equal(fake.creations, 1);
      } finally {
        fake.startup.release();
        fake.confirmExplicitCleanup();
        await drainMicrotasks();
        // Deliberately retain this synthetic active row: no trusted receipt has
        // confirmed it. There are no real resources or pending fixture gates.
      }
    });
  }

  await t.test("late cleanup receipt cannot overwrite a terminal row or a later independent run", async (t) => {
    clock(t);
    const value = job();
    const fake = uncertainRuntime();
    const manager = new SchedulerManager(fake.runtime);
    const accepted = manager.triggerRun(value.id);
    try {
      fake.startup.release();
      await drainMicrotasks();
      assert.equal(row(value.id, accepted.id).status, "running");
      // Controlled synthetic intervention models a newer authoritative terminal
      // decision; the old executor no longer owns a running row to finalize.
      updateScheduledRun(accepted.id, {
        status: "failed",
        finished_at: Date.now(),
        error_message: "synthetic newer terminal decision",
      });
      const fresh = manager.triggerRun(value.id);
      await drainMicrotasks();
      assert.equal(row(value.id, fresh.id).status, "completed");
      const oldSnapshot = row(value.id, accepted.id);
      const newSnapshot = row(value.id, fresh.id);
      fake.confirmExplicitCleanup();
      await drainMicrotasks();
      assert.deepEqual(row(value.id, accepted.id), oldSnapshot, "receipt must compare exact run ownership before publication");
      assert.deepEqual(row(value.id, fresh.id), newSnapshot);
      assert.equal(fake.creations, 2);
    } finally {
      fake.startup.release();
      fake.confirmExplicitCleanup();
      await drainMicrotasks();
    }
  });

  await t.test("prompt receives only the remaining monotonic budget, not a fresh timeout", async (t) => {
    const time = clock(t);
    const value = job();
    const fake = gatedRuntime(root);
    const manager = new SchedulerManager(fake.runtime);
    const accepted = manager.triggerRun(value.id);
    try {
      time.advance(40);
      // Wall time may move backwards; elapsed runtime budget must not grow.
      time.jumpWallClock(-60_000);
      fake.startup.release();
      await drainMicrotasks();
      assert.equal(fake.prompts.length, 1);
      assert.equal(fake.prompts[0].timeoutMs, 60, "startup must consume the one acceptance budget");
      assert.equal(row(value.id, accepted.id).status, "completed");
      assert.equal(row(value.id, accepted.id).result_summary, "synthetic result");
    } finally {
      await releaseAndDrain(fake, [value]);
    }
  });

  await t.test("in-budget completion retains the linked runtime and clears the deadline", async (t) => {
    const time = clock(t);
    const value = job();
    const fake = gatedRuntime(root);
    const manager = new SchedulerManager(fake.runtime);
    const accepted = manager.triggerRun(value.id);
    try {
      fake.startup.release();
      await drainMicrotasks();
      const completed = row(value.id, accepted.id);
      assert.equal(completed.status, "completed");
      assert.equal(completed.result_summary, "synthetic result");
      assert.ok(completed.session_id);
      assert.equal(getSessionById(completed.session_id)?.scheduled_run_id, accepted.id);
      assert.equal(getSessionById(completed.session_id)?.pi_session_file, path.join(root, "pi", `${completed.session_id}.jsonl`));
      assert.equal(fake.prompts[0]?.content, value.prompt);
      assert.equal(hasRunningRun(value.id), false);
      time.advance(2 * BUDGET_MS);
      await drainMicrotasks();
      assert.equal(row(value.id, accepted.id).status, "completed");
      assert.equal(fake.cleanupStarted, false, "successful linked runtime remains available");
      assert.notEqual(fake.signal?.aborted, true, "completion must disarm the acceptance deadline");
      assert.deepEqual(fake.cancellations, []);
    } finally {
      await releaseAndDrain(fake, [value]);
    }
  });
});
