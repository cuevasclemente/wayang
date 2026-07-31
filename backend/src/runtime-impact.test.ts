import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireRuntimeMutationImpact,
  capabilityPairRuntimeSessionIds,
  RuntimeImpactConflict,
  type RuntimeImpactAdapter,
} from "./runtime-impact.js";
import type { RuntimeMutationSessionState } from "./pi-bridge.js";
import { createAgentProfile } from "./agent-profiles.js";
import { close, init } from "./db.js";
import { createProject } from "./projects.js";
import { createSession } from "./sessions.js";

function state(sessionId: string, overrides: Partial<RuntimeMutationSessionState> = {}): RuntimeMutationSessionState {
  return {
    session_id: sessionId,
    runtime_status: "active",
    streaming: false,
    queued: false,
    mutation_locked: false,
    ...overrides,
  };
}

test("runtime impact rejects streaming, queued, and starting sessions with structured IDs", () => {
  const states = new Map([
    ["streaming", state("streaming", { streaming: true })],
    ["queued", state("queued", { queued: true })],
    ["starting", state("starting", { runtime_status: "starting" })],
    ["idle", state("idle")],
  ]);
  const adapter: RuntimeImpactAdapter = {
    getState: (id) => states.get(id)!,
    lock: () => true,
    unlock() {},
    async stopIfIdle() { return true; },
  };

  assert.throws(
    () => acquireRuntimeMutationImpact(states.keys(), adapter),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeImpactConflict);
      assert.deepEqual(error.body.affected_session_ids, ["streaming", "queued", "starting", "idle"]);
      assert.deepEqual(error.body.streaming_session_ids, ["streaming"]);
      assert.deepEqual(error.body.queued_session_ids, ["queued"]);
      assert.deepEqual(error.body.starting_session_ids, ["starting"]);
      return true;
    },
  );
});

test("runtime cleanup attempts every affected session and records failures without undoing applied settings", async () => {
  const locked = new Set<string>();
  const attempted: string[] = [];
  const adapter: RuntimeImpactAdapter = {
    getState: (id) => state(id),
    lock(id) { locked.add(id); return true; },
    unlock(id) { locked.delete(id); },
    async stopIfIdle(id) {
      attempted.push(id);
      if (id === "failure-a" || id === "failure-c") throw new Error(`synthetic stop failure ${id}`);
      return true;
    },
  };

  const lease = acquireRuntimeMutationImpact(["failure-a", "success-b", "failure-c"], adapter);
  assert.deepEqual(await lease.commitAndStopIdle(), ["success-b"]);
  assert.deepEqual(attempted, ["failure-a", "success-b", "failure-c"]);
  assert.deepEqual(lease.cleanup_failures, [
    { session_id: "failure-a", error: "runtime_cleanup_failed" },
    { session_id: "failure-c", error: "runtime_cleanup_failed" },
  ]);
  assert.equal(locked.size, 0);
});

test("pair runtime impact resolves immutable project ID and ignores provider/model variation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-runtime-impact-pair-"));
  const projectCwd = path.join(root, "project");
  const otherCwd = path.join(root, "other");
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  fs.mkdirSync(projectCwd);
  fs.mkdirSync(otherCwd);
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  try {
    init();
    const profile = createAgentProfile({ name: "Pair impact profile" });
    const otherProfile = createAgentProfile({ name: "Other impact profile" });
    const project = createProject({ cwd: projectCwd, default_agent_profile_id: profile.id });
    const otherProject = createProject({ cwd: otherCwd, default_agent_profile_id: profile.id });
    const modelA = createSession(projectCwd, { agentProfileId: profile.id, provider: "provider-a", model: "model-a" });
    const modelB = createSession(projectCwd, { agentProfileId: profile.id, provider: "provider-b", model: "model-b" });
    createSession(projectCwd, { agentProfileId: otherProfile.id, provider: "provider-a", model: "model-a" });
    createSession(otherCwd, { agentProfileId: profile.id, provider: "provider-a", model: "model-a" });

    assert.deepEqual(new Set(capabilityPairRuntimeSessionIds(project.id, profile.id)), new Set([modelA.id, modelB.id]));
    assert.deepEqual(capabilityPairRuntimeSessionIds(otherProject.id, profile.id).length, 1);
    assert.deepEqual(capabilityPairRuntimeSessionIds("missing-project-id", profile.id), []);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime impact locks affected idle sessions, stops them after commit, and always releases", async () => {
  const locked = new Set<string>();
  const stopped: string[] = [];
  const adapter: RuntimeImpactAdapter = {
    getState: (id) => state(id),
    lock(id) {
      if (locked.has(id)) return false;
      locked.add(id);
      return true;
    },
    unlock(id) { locked.delete(id); },
    async stopIfIdle(id) { stopped.push(id); return true; },
  };

  const lease = acquireRuntimeMutationImpact(["idle-a", "idle-b", "idle-a"], adapter);
  assert.deepEqual(lease.affected_session_ids, ["idle-a", "idle-b"]);
  assert.deepEqual([...locked], ["idle-a", "idle-b"]);
  assert.deepEqual(await lease.commitAndStopIdle(), ["idle-a", "idle-b"]);
  assert.deepEqual(stopped, ["idle-a", "idle-b"]);
  assert.equal(locked.size, 0);

  const released = acquireRuntimeMutationImpact(["idle-a"], adapter);
  released.release();
  assert.equal(locked.size, 0);
  assert.deepEqual(await released.commitAndStopIdle(), []);
});
