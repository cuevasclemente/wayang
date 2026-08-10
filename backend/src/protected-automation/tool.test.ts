import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close, failNextCommitStoreMutationPersistenceForTests, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession } from "../sessions.js";
import { commitWorkspaceCapabilityActivation, revokeWorkspaceCapabilityAssociation } from "../workspace-capabilities.js";
import type { ProtectedAutomationBinding } from "./authority.js";
import { ProtectedAutomationManager, setProtectedAutomationManager } from "./manager.js";
import { installProtectedAutomationPreparationPort } from "./browser-preparation.js";
import { installProtectedAutomationPurgeIntentPort } from "./purge-intent.js";
import { captureProtectedAutomationSnapshot, verifyProtectedAutomationSnapshot } from "./snapshots.js";
import { createProtectedAutomationToolRuntime } from "./tool.js";

let root = "";
let projectRoot = "";
let previousDataDir: string | undefined;

beforeEach(() => {
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-automation-tool-"));
  projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(projectRoot, "source"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "source", "main.mjs"), "console.log('synthetic')\n");
  previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  init();
});

afterEach(() => {
  setProtectedAutomationManager(null);
  close();
  if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
  else process.env.WAYANG_DATA_DIR = previousDataDir;
  const unlock = (target: string): void => {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(target); } catch { return; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    try { fs.chmodSync(target, 0o700); } catch { return; }
    for (const name of fs.readdirSync(target)) unlock(path.join(target, name));
  };
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const profile = createAgentProfile({ name: "Synthetic automation tool owner" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
  });
  const session = createSession(projectRoot, { agentProfileId: profile.id });
  const association = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "a".repeat(64),
  });
  const binding: ProtectedAutomationBinding = {
    capabilityId: "wayang.protected-automation.v1",
    sourceSessionId: session.id,
    projectId: project.id,
    projectCwd: project.cwd,
    agentProfileId: profile.id,
    associationRevision: association.revision,
    runtimeGeneration: "synthetic-runtime-generation",
    processBootNonce: "synthetic-process-boot",
  };
  return { profile, project, session, association, binding };
}

const configuration = {
  name: "Synthetic inert job",
  source_directory: "source",
  entrypoint: "main.mjs",
  argv: ["--synthetic"],
  uses_browser_profile: false,
  allowed_https_origins: ["https://example.test"],
  cron_expr: "0 8 * * *",
  timeout_ms: 60_000,
  missed_run_policy: "skip" as const,
};

function jsonResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

function publishedRevisionNames(): string[] {
  const jobsRoot = path.join(process.env.WAYANG_DATA_DIR!, "protected-automation", "jobs");
  if (!fs.existsSync(jobsRoot)) return [];
  return fs.readdirSync(jobsRoot).flatMap((jobKey) => {
    const revisionsRoot = path.join(jobsRoot, jobKey, "revisions");
    return fs.existsSync(revisionsRoot)
      ? fs.readdirSync(revisionsRoot).filter((name) => /^[1-9][0-9]*$/u.test(name)).map((name) => `${jobKey}/${name}`)
      : [];
  }).sort();
}

test("snapshot diagnostics expose only explicit bounded capture stages through the exact-pair tool", async () => {
  const f = fixture();
  const runtime = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  const forbidden = path.join(projectRoot, "source", ".env.example");
  fs.writeFileSync(forbidden, "SYNTHETIC_NAME_WITHOUT_A_VALUE=\n");
  try {
    const error = await (runtime.tool.execute as any)("bounded-snapshot-diagnostic", {
      operation: "capture_job",
      ...configuration,
    }).then(() => null, (failure: Error) => failure);
    assert.ok(error);
    assert.equal(error.message, "Protected automation snapshot capture failed safely (source_validation)");
    assert.equal(error.message.includes(projectRoot), false);
    assert.equal(error.message.includes(".env"), false);
    assert.deepEqual(publishedRevisionNames(), []);

    fs.unlinkSync(forbidden);
    const entrypointError = await (runtime.tool.execute as any)("bounded-entrypoint-diagnostic", {
      operation: "capture_job",
      ...configuration,
      entrypoint: "missing.mjs",
    }).then(() => null, (failure: Error) => failure);
    assert.ok(entrypointError);
    assert.equal(entrypointError.message, "Protected automation snapshot capture failed safely (source_entrypoint)");
    assert.equal(entrypointError.message.includes("missing.mjs"), false);
    assert.deepEqual(publishedRevisionNames(), []);
  } finally {
    await runtime.close();
  }
});

test("capture/update/list expose only exact-pair metadata and strict schemas reject authority smuggling", async () => {
  const f = fixture();
  const runtime = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  try {
    const status = jsonResult(await (runtime.tool.execute as any)("status", { operation: "status" }));
    assert.equal(status.activationAvailable, true);
    assert.equal(status.milestone, 5);
    const captured = jsonResult(await (runtime.tool.execute as any)("capture", {
      operation: "capture_job",
      ...configuration,
    }));
    assert.equal(captured.job.project_id, f.project.id);
    assert.equal(captured.job.agent_profile_id, f.profile.id);
    assert.equal(captured.job.revision, 1);
    assert.equal(captured.job.enabled, false);
    assert.equal(captured.job.blocked_reason, "paused");
    assert.equal(captured.job.source_revision, 1);
    assert.equal(captured.snapshot.revision, 1);
    assert.equal("created" in captured.snapshot, false);
    assert.equal("allocatedBytes" in captured.snapshot, false);
    assert.equal("source_directory" in captured.job, false);
    assert.equal("path" in captured.snapshot, false);
    assert.equal(JSON.stringify(captured).includes(projectRoot), false);
    assert.equal(JSON.stringify(captured).includes("console.log"), false);

    fs.writeFileSync(path.join(projectRoot, "source", "main.mjs"), "console.log('updated synthetic')\n");
    const updated = jsonResult(await (runtime.tool.execute as any)("update", {
      operation: "update_job",
      job_id: captured.job.id,
      expected_revision: 1,
      ...configuration,
      name: "Updated inert job",
    }));
    assert.equal(updated.job.revision, 2);
    assert.equal(updated.job.source_revision, 2);
    assert.equal(updated.snapshot.revision, 2);
    assert.notEqual(updated.job.source_manifest_sha256, captured.job.source_manifest_sha256);

    const listed = jsonResult(await (runtime.tool.execute as any)("list", { operation: "list_jobs" }));
    assert.deepEqual(listed.jobs.map((job: any) => job.id), [captured.job.id]);
    assert.equal(listed.next_after_job_id, null);
    const runs = jsonResult(await (runtime.tool.execute as any)("runs", {
      operation: "list_runs",
      job_id: captured.job.id,
    }));
    assert.deepEqual(runs.runs, []);

    for (const forbidden of [
      { project_id: f.project.id }, { agent_profile_id: f.profile.id }, { capability_id: f.binding.capabilityId },
      { source_session_id: f.session.id }, { cwd: projectRoot }, { provider: "synthetic" }, { model: "synthetic" },
      { prompt: "synthetic" }, { runtime: "node" }, { runtime_generation: f.binding.runtimeGeneration },
      { executable: "/usr/bin/node" }, { env: {} }, { shell: "bash" },
    ]) {
      await assert.rejects(
        () => (runtime.tool.execute as any)("forged", { operation: "capture_job", ...configuration, ...forbidden }),
        /validation|schema|union|additional|failed safely/i,
      );
    }
    await assert.rejects(
      () => (runtime.tool.execute as any)("strict-run-revision", {
        operation: "run_now",
        job_id: captured.job.id,
        expected_revision: captured.job.revision,
      }),
      /conflict|failed safely/i,
    );
    await assert.rejects(
      () => (runtime.tool.execute as any)("paused-run", {
        operation: "run_now",
        job_id: updated.job.id,
        expected_revision: updated.job.revision,
      }),
      /job is paused; enable it before run_now/i,
    );
    await assert.rejects(
      () => (runtime.tool.execute as any)("missing", { operation: "capture_job", name: "incomplete" }),
      /failed safely/i,
    );
    await assert.rejects(
      () => (runtime.tool.execute as any)("array", []),
      /failed safely/i,
    );
  } finally {
    await runtime.close();
  }
});

test("enable, run_now, cancel, and pause require strict effective revisions", async () => {
  const f = fixture();
  const manager = new ProtectedAutomationManager({
    runner: async (_request, options) => await new Promise((resolve) => {
      const cancelled = () => resolve({
        status: "cancelled" as const,
        outcomeCode: "cancelled",
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      options.signal?.addEventListener("abort", cancelled, { once: true });
      if (options.signal?.aborted) cancelled();
    }),
  });
  manager.start();
  setProtectedAutomationManager(manager);
  const runtime = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  try {
    const captured = jsonResult(await (runtime.tool.execute as any)("capture", { operation: "capture_job", ...configuration }));
    const enabled = jsonResult(await (runtime.tool.execute as any)("enable", {
      operation: "enable", job_id: captured.job.id, expected_revision: captured.job.revision,
    }));
    assert.equal(enabled.job.enabled, true);
    assert.equal(enabled.job.revision, captured.job.revision + 1);
    await assert.rejects(
      () => (runtime.tool.execute as any)("stale-enable", {
        operation: "enable", job_id: captured.job.id, expected_revision: captured.job.revision,
      }),
      /conflict|failed safely/i,
    );
    const running = jsonResult(await (runtime.tool.execute as any)("run", {
      operation: "run_now", job_id: captured.job.id, expected_revision: enabled.job.revision,
    }));
    const cancelled = jsonResult(await (runtime.tool.execute as any)("cancel", {
      operation: "cancel", job_id: captured.job.id, run_id: running.run.id, expected_revision: enabled.job.revision,
    }));
    assert.ok(["running", "cancelled"].includes(cancelled.run.status));
    const paused = jsonResult(await (runtime.tool.execute as any)("pause", {
      operation: "pause", job_id: captured.job.id, expected_revision: enabled.job.revision,
    }));
    assert.equal(paused.job.enabled, false);
    assert.equal(paused.job.revision, enabled.job.revision + 1);
    await manager.waitForIdle();
  } finally {
    await runtime.close();
    await manager.stop();
  }
});

test("request_purge creates an owner-PIN intent without accepting PIN material", async () => {
  const f = fixture();
  let observed: any;
  const uninstall = installProtectedAutomationPurgeIntentPort({
    async request(input) {
      observed = input;
      await input.assertAuthorized();
      return {
        request_id: "synthetic-purge-intent",
        job_id: input.job.id,
        state: "awaiting_owner_pin" as const,
        requested_at: 100,
        expires_at: 200,
      };
    },
  });
  const runtime = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  try {
    const captured = jsonResult(await (runtime.tool.execute as any)("capture", {
      operation: "capture_job", ...configuration,
    }));
    const tombstoned = jsonResult(await (runtime.tool.execute as any)("tombstone", {
      operation: "tombstone_job", job_id: captured.job.id, expected_revision: captured.job.revision,
    }));
    const requested = jsonResult(await (runtime.tool.execute as any)("request-purge", {
      operation: "request_purge", job_id: captured.job.id, expected_revision: tombstoned.job.revision,
    }));
    assert.equal(requested.purge_request.state, "awaiting_owner_pin");
    assert.equal(observed.binding.projectId, f.project.id);
    assert.equal(observed.binding.agentProfileId, f.profile.id);
    assert.equal(observed.job.deleted_at !== null, true);
    await assert.rejects(
      () => (runtime.tool.execute as any)("smuggled-pin", {
        operation: "request_purge", job_id: captured.job.id,
        expected_revision: tombstoned.job.revision, pin: "synthetic-must-not-enter-tool",
      }),
      /validation|schema|additional|failed safely/i,
    );
  } finally {
    await runtime.close();
    uninstall();
  }
});

test("prepare_browser_profile delegates only the implicit exact binding and exact job revision", async () => {
  const f = fixture();
  const runtime = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  let observed = false;
  const uninstall = installProtectedAutomationPreparationPort({
    jobChanged() {},
    async prepare(input) {
      observed = input.binding.sourceSessionId === f.session.id
        && input.binding.projectId === f.project.id
        && input.job.project_id === f.project.id
        && input.job.agent_profile_id === f.profile.id;
      input.assertAuthorized();
      return {
        preparation_id: "synthetic-preparation", source_session_id: f.session.id,
        job_id: input.job.id, job_revision: input.job.revision, state: "waiting_for_owner" as const,
        websocket_path: "/ws/protected-automations/preparations/synthetic-preparation",
      };
    },
  });
  try {
    const captured = jsonResult(await (runtime.tool.execute as any)("capture", {
      operation: "capture_job", ...configuration, uses_browser_profile: true,
    }));
    const prepared = jsonResult(await (runtime.tool.execute as any)("prepare", {
      operation: "prepare_browser_profile", job_id: captured.job.id, expected_revision: captured.job.revision,
    }));
    assert.equal(observed, true);
    assert.equal(prepared.preparation.job_id, captured.job.id);
    await assert.rejects(
      () => (runtime.tool.execute as any)("stale", {
        operation: "prepare_browser_profile", job_id: captured.job.id, expected_revision: captured.job.revision + 1,
      }),
      /conflict|failed safely/i,
    );
  } finally {
    uninstall();
    await runtime.close();
  }
});

test("update, enable, pause, and tombstone synchronously publish jobChanged before returning", async () => {
  const f = fixture();
  const runtime = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  const changed: string[] = [];
  const uninstall = installProtectedAutomationPreparationPort({
    jobChanged(jobId) { changed.push(jobId); },
    async prepare() { throw new Error("not used"); },
  });
  try {
    const captured = jsonResult(await (runtime.tool.execute as any)("capture", {
      operation: "capture_job", ...configuration,
    }));
    assert.deepEqual(changed, []);

    const updatePromise = (runtime.tool.execute as any)("update", {
      operation: "update_job", job_id: captured.job.id, expected_revision: captured.job.revision,
      ...configuration, name: "Changed job",
    });
    assert.deepEqual(changed, [captured.job.id], "update latches before its tool promise is released");
    const updated = jsonResult(await updatePromise);

    const enablePromise = (runtime.tool.execute as any)("enable", {
      operation: "enable", job_id: captured.job.id, expected_revision: updated.job.revision,
    });
    assert.deepEqual(changed, [captured.job.id, captured.job.id], "enable latches before its tool promise is released");
    const enabled = jsonResult(await enablePromise);

    const pausePromise = (runtime.tool.execute as any)("pause", {
      operation: "pause", job_id: captured.job.id, expected_revision: enabled.job.revision,
    });
    assert.deepEqual(changed, [captured.job.id, captured.job.id, captured.job.id], "pause latches before its tool promise is released");
    const paused = jsonResult(await pausePromise);

    const tombstonePromise = (runtime.tool.execute as any)("tombstone", {
      operation: "tombstone_job", job_id: captured.job.id, expected_revision: paused.job.revision,
    });
    assert.deepEqual(changed, [captured.job.id, captured.job.id, captured.job.id, captured.job.id],
      "tombstone latches before its tool promise is released");
    await tombstonePromise;
  } finally {
    uninstall();
    await runtime.close();
  }
});

test("rebind synchronously publishes jobChanged for the retained exact job", async () => {
  const f = fixture();
  const first = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  const captured = jsonResult(await (first.tool.execute as any)("capture", {
    operation: "capture_job", ...configuration,
  }));
  await first.close();
  revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.protected-automation.v1", project_id: f.project.id,
    agent_profile_id: f.profile.id, expected_revision: f.association.revision,
  });
  const regranted = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1", project_id: f.project.id,
    agent_profile_id: f.profile.id, operation_digest: "d".repeat(64),
  });
  const fresh = createProtectedAutomationToolRuntime({
    binding: { ...f.binding, associationRevision: regranted.revision, runtimeGeneration: "rebind-runtime" },
    isRuntimeCurrent: () => true,
  });
  const changed: string[] = [];
  const uninstall = installProtectedAutomationPreparationPort({
    jobChanged(jobId) { changed.push(jobId); },
    async prepare() { throw new Error("not used"); },
  });
  try {
    const retained = jsonResult(await (fresh.tool.execute as any)("get", {
      operation: "get_job", job_id: captured.job.id,
    }));
    const rebindPromise = (fresh.tool.execute as any)("rebind", {
      operation: "rebind_job", job_id: captured.job.id, expected_revision: retained.job.revision,
    });
    assert.deepEqual(changed, [captured.job.id], "rebind latches before its tool promise is released");
    const rebound = jsonResult(await rebindPromise);
    assert.equal(rebound.job.capability_revision, regranted.revision);
  } finally {
    uninstall();
    await fresh.close();
  }
});

test("list_jobs is bounded to 50 and uses a stable exact-owner cursor", async () => {
  const f = fixture();
  const runtime = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  try {
    for (let index = 0; index < 51; index += 1) {
      await (runtime.tool.execute as any)(`capture-${index}`, {
        operation: "capture_job",
        ...configuration,
        name: `Synthetic job ${String(index).padStart(2, "0")}`,
      });
    }
    const first = jsonResult(await (runtime.tool.execute as any)("first", { operation: "list_jobs" }));
    assert.equal(first.jobs.length, 50);
    assert.equal(first.next_after_job_id, first.jobs[49].id);
    const second = jsonResult(await (runtime.tool.execute as any)("second", {
      operation: "list_jobs",
      after_job_id: first.next_after_job_id,
    }));
    assert.equal(second.jobs.length, 1);
    assert.equal(second.next_after_job_id, null);
    assert.equal(new Set([...first.jobs, ...second.jobs].map((job: any) => job.id)).size, 51);

    await assert.rejects(
      () => (runtime.tool.execute as any)("too-many", { operation: "list_jobs", limit: 51 }),
      /validation|failed safely/i,
    );
    await assert.rejects(
      () => (runtime.tool.execute as any)("foreign-cursor", { operation: "list_jobs", after_job_id: "not-owned" }),
      /not found|failed safely/i,
    );
    await assert.rejects(
      () => (runtime.tool.execute as any)("smuggled", { operation: "list_jobs", after_job_id: first.jobs[0].id, offset: 1 }),
      /validation|schema|additional|failed safely/i,
    );
  } finally {
    await runtime.close();
  }
});

test("new captures are discarded on authority or store failure while idempotent revisions are retained", async () => {
  const f = fixture();
  let authorityChecks = 0;
  const drifting = createProtectedAutomationToolRuntime({
    binding: f.binding,
    isRuntimeCurrent: () => ++authorityChecks === 1,
  });
  await assert.rejects(
    () => (drifting.tool.execute as any)("authority-failure", { operation: "capture_job", ...configuration }),
    /result was suppressed|authority changed/,
  );
  assert.deepEqual(publishedRevisionNames(), []);
  assert.equal(fs.existsSync(path.join(process.env.WAYANG_DATA_DIR!, "protected-automation")), false);
  await drifting.close();

  const current = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  failNextCommitStoreMutationPersistenceForTests();
  await assert.rejects(
    () => (current.tool.execute as any)("store-failure", { operation: "capture_job", ...configuration }),
    /failed safely/,
  );
  assert.deepEqual(publishedRevisionNames(), []);

  const created = jsonResult(await (current.tool.execute as any)("capture", { operation: "capture_job", ...configuration }));
  fs.writeFileSync(path.join(projectRoot, "source", "main.mjs"), "console.log('revision two')\n");
  failNextCommitStoreMutationPersistenceForTests();
  await assert.rejects(
    () => (current.tool.execute as any)("new-update-store-failure", {
      operation: "update_job",
      job_id: created.job.id,
      expected_revision: 1,
      ...configuration,
    }),
    /failed safely/,
  );
  assert.equal(publishedRevisionNames().length, 1);

  const preexisting = captureProtectedAutomationSnapshot({
    projectRoot,
    projectId: f.project.id,
    agentProfileId: f.profile.id,
    jobId: created.job.id,
    revision: 2,
    sourceDirectory: "source",
    entrypoint: "main.mjs",
  });
  assert.equal(preexisting.created, true);
  const reused = captureProtectedAutomationSnapshot({
    projectRoot,
    projectId: f.project.id,
    agentProfileId: f.profile.id,
    jobId: created.job.id,
    revision: 2,
    sourceDirectory: "source",
    entrypoint: "main.mjs",
  });
  assert.equal(reused.created, false);
  failNextCommitStoreMutationPersistenceForTests();
  await assert.rejects(
    () => (current.tool.execute as any)("idempotent-store-failure", {
      operation: "update_job",
      job_id: created.job.id,
      expected_revision: 1,
      ...configuration,
    }),
    /failed safely/,
  );
  assert.equal(verifyProtectedAutomationSnapshot({
    projectId: f.project.id,
    agentProfileId: f.profile.id,
    jobId: created.job.id,
    revision: 2,
    expectedManifestSha256: preexisting.manifestSha256,
  }).manifestSha256, preexisting.manifestSha256);
  await current.close();
});

test("a post-capture stale-capability conflict is sanitized while the private orphan stays undisclosed", async () => {
  const f = fixture();
  const first = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  const captured = jsonResult(await (first.tool.execute as any)("capture", {
    operation: "capture_job",
    ...configuration,
  }));
  revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.protected-automation.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    expected_revision: f.association.revision,
  });
  const regranted = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    operation_digest: "c".repeat(64),
  });
  const fresh = createProtectedAutomationToolRuntime({
    binding: { ...f.binding, associationRevision: regranted.revision, runtimeGeneration: "fresh-generation" },
    isRuntimeCurrent: () => true,
  });
  const error = await (fresh.tool.execute as any)("stale-update", {
    operation: "update_job",
    job_id: captured.job.id,
    expected_revision: 1,
    ...configuration,
  }).then(() => null, (failure: Error) => failure);
  assert.ok(error);
  assert.equal(error.message, "Protected automation conflict; refresh exact job metadata and retry");
  assert.equal(error.message.includes(projectRoot), false);
  assert.equal(error.message.includes("snapshot"), false);
  const retained = jsonResult(await (fresh.tool.execute as any)("get", {
    operation: "get_job",
    job_id: captured.job.id,
  }));
  assert.ok(retained.job.revision > captured.job.revision);
  assert.equal(retained.job.blocked_reason, "capability_revoked");
  const rebound = jsonResult(await (fresh.tool.execute as any)("rebind", {
    operation: "rebind_job",
    job_id: captured.job.id,
    expected_revision: retained.job.revision,
  }));
  assert.equal(rebound.job.capability_revision, regranted.revision);
  assert.equal(rebound.job.enabled, false);
  assert.equal(rebound.job.source_revision, captured.job.source_revision);
  const enabled = jsonResult(await (fresh.tool.execute as any)("enable-rebound", {
    operation: "enable",
    job_id: captured.job.id,
    expected_revision: rebound.job.revision,
  }));
  assert.equal(enabled.job.enabled, true);
});

test("revocation and prerelease drift permanently suppress stale runtime results", async () => {
  const f = fixture();
  let checks = 0;
  const drifting = createProtectedAutomationToolRuntime({
    binding: f.binding,
    isRuntimeCurrent: () => ++checks === 1,
  });
  await assert.rejects(
    () => (drifting.tool.execute as any)("drift", { operation: "status" }),
    /result was suppressed|authority changed/,
  );
  assert.equal(drifting.preflight().allowed, false);

  const current = createProtectedAutomationToolRuntime({ binding: f.binding, isRuntimeCurrent: () => true });
  revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.protected-automation.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    expected_revision: f.association.revision,
  });
  assert.equal(current.preflight().allowed, false);
  await assert.rejects(
    () => (current.tool.execute as any)("revoked", { operation: "status" }),
    /revoked|authority changed/,
  );
});
