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
  listAgentProfiles,
  updateAgentProfile,
} from "./agent-profiles.js";
import { close, init } from "./db.js";
import { createProject, getProject, listProjects, updateProject } from "./projects.js";
import {
  beginAgentSwitch,
  completeAgentSwitch,
  createSession,
  getSessionById,
  listSessions,
  rollbackAgentSwitch,
  updateSessionAgentProfile,
} from "./sessions.js";
import type { PendingAgentSwitch } from "./workspace-types.js";

function withStore(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-workspace-transaction-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    fn(dir);
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let failureTimestamp = 10_000;
function withFailedFlush(dir: string, mutation: () => unknown): void {
  const originalNow = Date.now;
  const timestamp = failureTimestamp++;
  Date.now = () => timestamp;
  const tempPath = path.join(dir, `store.json.${process.pid}.${timestamp}.tmp`);
  fs.writeFileSync(tempPath, "block the synthetic atomic write");
  try {
    assert.throws(mutation, /EEXIST/);
  } finally {
    Date.now = originalNow;
    fs.unlinkSync(tempPath);
  }
}

test("failed project and profile flushes do not leak into a later commit", () => withStore((dir) => {
  const cwd = path.join(dir, "project");
  const failedProjectCwd = path.join(dir, "failed-project-create");
  fs.mkdirSync(cwd);
  fs.mkdirSync(failedProjectCwd);
  const replacementProfileId = getWorkspaceDefaultAgentProfileId();
  const profile = createAgentProfile({ name: "Transactional profile" });
  const project = createProject({ cwd, default_agent_profile_id: profile.id });

  withFailedFlush(dir, () => createProject({ cwd: failedProjectCwd }));
  assert.equal(listProjects().some((candidate) => candidate.cwd === failedProjectCwd), false);

  withFailedFlush(dir, () => createAgentProfile({ name: "Failed profile create" }));
  assert.equal(listAgentProfiles().some((candidate) => candidate.name === "Failed profile create"), false);
  assert.equal(getAgentProfile(profile.id)?.name, "Transactional profile");
  assert.equal(
    getAgentProfile(profile.id)?.description,
    null,
  );

  withFailedFlush(dir, () => updateAgentProfile(profile.id, { description: "failed profile update" }));
  assert.equal(getAgentProfile(profile.id)?.description, null);

  withFailedFlush(dir, () => updateProject(project.id, { name: "failed project update" }));
  assert.equal(getProject(project.id)?.name, "project");

  withFailedFlush(dir, () => deleteAgentProfile(profile.id, replacementProfileId));
  assert.ok(getAgentProfile(profile.id), "failed deletion keeps the profile");
  assert.equal(getProject(project.id)?.default_agent_profile_id, profile.id, "failed replacement keeps project references");

  createAgentProfile({ name: "Later successful commit" });
  close();
  init();
  assert.equal(getProject(project.id)?.name, "project");
  assert.equal(getProject(project.id)?.default_agent_profile_id, profile.id);
  assert.equal(getAgentProfile(profile.id)?.description, null);
  assert.equal(
    getAgentProfile(profile.id)?.name,
    "Transactional profile",
    "failed create/update/delete mutations were not persisted later",
  );
  assert.equal(listAgentProfiles().some((candidate) => candidate.name === "Failed profile create"), false);
  assert.equal(listProjects().some((candidate) => candidate.cwd === failedProjectCwd), false);
}));

test("failed first-session flush commits neither the session nor its implicit project", () => withStore((dir) => {
  const cwd = path.join(dir, "new-project");
  fs.mkdirSync(cwd);

  withFailedFlush(dir, () => createSession(cwd, { title: "failed session" }));
  assert.equal(listSessions(true).length, 0);
  assert.equal(listProjects().length, 0);

  const committed = createSession(cwd, { title: "committed session" });
  close();
  init();
  assert.equal(listProjects().length, 1);
  assert.equal(listSessions(true).length, 1);
  assert.equal(getSessionById(committed.id)?.title, "committed session");
}));

test("failed session assignment and pending-switch flushes retain the last durable state", () => withStore((dir) => {
  const cwd = path.join(dir, "switch-project");
  fs.mkdirSync(cwd);
  const source = createAgentProfile({ name: "Transaction source" });
  const target = createAgentProfile({ name: "Transaction target" });
  const session = createSession(cwd, {
    agentProfileId: source.id,
    provider: "anthropic",
    model: "source-model",
  });
  const pending: PendingAgentSwitch = {
    switch_id: "transaction-switch",
    from_agent_profile_id: source.id,
    from_provider: "anthropic",
    from_model: "source-model",
    to_agent_profile_id: target.id,
    target_provider: "openai-codex",
    target_model: "target-model",
    changed_at: 5_000,
  };

  withFailedFlush(dir, () => updateSessionAgentProfile(session.id, target.id));
  assert.equal(getSessionById(session.id)?.agent_profile_id, source.id);

  withFailedFlush(dir, () => beginAgentSwitch(session.id, pending));
  assert.equal(getSessionById(session.id)?.pending_agent_switch, null);

  beginAgentSwitch(session.id, pending);
  withFailedFlush(dir, () => completeAgentSwitch(session.id, pending.switch_id));
  assert.deepEqual(getSessionById(session.id)?.pending_agent_switch, pending);
  assert.equal(getSessionById(session.id)?.agent_profile_id, source.id);

  withFailedFlush(dir, () => rollbackAgentSwitch(session.id, pending.switch_id));
  assert.deepEqual(getSessionById(session.id)?.pending_agent_switch, pending);
  assert.equal(getSessionById(session.id)?.agent_profile_id, source.id);

  rollbackAgentSwitch(session.id, pending.switch_id);
  createAgentProfile({ name: "Flush after switch failures" });
  close();
  init();
  const durable = getSessionById(session.id);
  assert.equal(durable?.pending_agent_switch, null);
  assert.equal(durable?.agent_profile_id, source.id);
  assert.deepEqual([durable?.provider, durable?.model], ["anthropic", "source-model"]);
}));
