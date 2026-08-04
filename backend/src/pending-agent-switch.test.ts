import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  getWorkspaceDefaultAgentProfileId,
  updateAgentProfile,
} from "./agent-profiles.js";
import { close, init } from "./db.js";
import {
  beginAgentSwitch,
  completeAgentSwitch,
  createSession,
  getSessionById,
  rollbackAgentSwitch,
} from "./sessions.js";
import type { PendingAgentSwitch } from "./workspace-types.js";

test("pending agent switches persist and complete or roll back only by matching switch id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-pending-agent-switch-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const sourceProfileId = getWorkspaceDefaultAgentProfileId();
    const target = createAgentProfile({ name: "Switch target" });
    const session = createSession(cwd, {
      agentProfileId: sourceProfileId,
      provider: "anthropic",
      model: "source-model",
    });
    assert.equal(session.pending_agent_switch, null);

    const pending: PendingAgentSwitch = {
      switch_id: "switch-1",
      from_agent_profile_id: sourceProfileId,
      from_provider: "anthropic",
      from_model: "source-model",
      to_agent_profile_id: target.id,
      target_provider: "openai-codex",
      target_model: "target-model",
      changed_at: 1_000,
    };
    assert.deepEqual(beginAgentSwitch(session.id, pending).pending_agent_switch, pending);
    assert.deepEqual(beginAgentSwitch(session.id, { ...pending }).pending_agent_switch, pending, "same-id retry is idempotent");
    assert.throws(() => beginAgentSwitch(session.id, { ...pending, switch_id: "switch-other" }), /different agent switch/);
    assert.throws(() => beginAgentSwitch(session.id, { ...pending, target_model: "conflict" }), /payload conflicts/);
    assert.throws(() => completeAgentSwitch(session.id, "stale"), /Stale or missing/);

    close();
    init();
    assert.deepEqual(getSessionById(session.id)?.pending_agent_switch, pending);
    const completed = completeAgentSwitch(session.id, pending.switch_id);
    assert.equal(completed.pending_agent_switch, null);
    assert.deepEqual(
      [completed.agent_profile_id, completed.provider, completed.model],
      [target.id, "openai-codex", "target-model"],
    );
    assert.throws(() => completeAgentSwitch(session.id, pending.switch_id), /Stale or missing/);

    const rollbackPending: PendingAgentSwitch = {
      switch_id: "switch-2",
      from_agent_profile_id: target.id,
      from_provider: "openai-codex",
      from_model: "target-model",
      to_agent_profile_id: sourceProfileId,
      target_provider: "anthropic",
      target_model: "return-model",
      changed_at: 2_000,
    };
    beginAgentSwitch(session.id, rollbackPending);
    assert.throws(() => rollbackAgentSwitch(session.id, "stale"), /Stale or missing/);
    const rolledBack = rollbackAgentSwitch(session.id, rollbackPending.switch_id);
    assert.equal(rolledBack.pending_agent_switch, null);
    assert.deepEqual(
      [rolledBack.agent_profile_id, rolledBack.provider, rolledBack.model],
      [target.id, "openai-codex", "target-model"],
    );
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("profiles referenced by a pending switch cannot be updated, disabled, or deleted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-pending-profile-concurrency-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const replacementProfileId = getWorkspaceDefaultAgentProfileId();
    const source = createAgentProfile({ name: "Pending source" });
    const target = createAgentProfile({ name: "Pending target" });
    const session = createSession(cwd, {
      agentProfileId: source.id,
      provider: "anthropic",
      model: "source-model",
    });
    const pending: PendingAgentSwitch = {
      switch_id: "profile-concurrency",
      from_agent_profile_id: source.id,
      from_provider: "anthropic",
      from_model: "source-model",
      to_agent_profile_id: target.id,
      target_provider: "openai-codex",
      target_model: "target-model",
      changed_at: 3_000,
    };
    beginAgentSwitch(session.id, pending);

    for (const profile of [source, target]) {
      assert.throws(
        () => updateAgentProfile(profile.id, { description: "must not commit" }),
        /while an agent switch references it/,
      );
      assert.throws(
        () => updateAgentProfile(profile.id, { enabled: false }, replacementProfileId),
        /while an agent switch references it/,
      );
      assert.throws(
        () => deleteAgentProfile(profile.id, replacementProfileId),
        /while an agent switch references it/,
      );
      assert.equal(getAgentProfile(profile.id)?.enabled, true);
      assert.equal(getAgentProfile(profile.id)?.description, null);
    }
    assert.deepEqual(getSessionById(session.id)?.pending_agent_switch, pending);

    rollbackAgentSwitch(session.id, pending.switch_id);
    updateAgentProfile(target.id, { description: "allowed after rollback" });
    assert.equal(getAgentProfile(target.id)?.description, "allowed after rollback");
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("beginAgentSwitch rejects a stale source assignment before writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-pending-agent-switch-stale-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const target = createAgentProfile({ name: "Target" });
    const session = createSession(cwd, { provider: "anthropic", model: "actual-model" });
    assert.throws(() => beginAgentSwitch(session.id, {
      switch_id: "stale-source",
      from_agent_profile_id: session.agent_profile_id ?? null,
      from_provider: "anthropic",
      from_model: "stale-model",
      to_agent_profile_id: target.id,
      target_provider: "openai-codex",
      target_model: "target-model",
      changed_at: Date.now(),
    }), /assignment changed/);
    assert.equal(getSessionById(session.id)?.pending_agent_switch, null);
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
