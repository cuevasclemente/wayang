import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, init } from "./db.js";
import {
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  getWorkspaceDefaultAgentProfileId,
  listAgentProfiles,
  updateAgentProfile,
} from "./agent-profiles.js";
import { createProject, getProject, listProjects, updateProject } from "./projects.js";
import { readProjectInstructions, writeProjectInstructions } from "./project-instructions.js";
import { createSession, getSessionById } from "./sessions.js";

function withStore(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-workspace-repo-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try { init(); fn(dir); } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("project/profile invariants and session default precedence", () => withStore((dir) => {
  const cwd = path.join(dir, "finance");
  fs.mkdirSync(cwd);
  const replacementProfileId = getWorkspaceDefaultAgentProfileId();
  const finance = createAgentProfile({
    name: "Finance",
    resource_mode: "project_only",
    memory_access: "read",
    default_provider: "anthropic",
    default_model: "profile-model",
    instructions: "Private profile instructions",
  });
  const project = createProject({ cwd });
  const protectedProject = updateProject(project.id, {
    default_agent_profile_id: finance.id,
    default_provider: "openai-codex",
    default_model: "project-model",
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [finance.id] },
  });
  assert.equal(protectedProject.cwd, fs.realpathSync.native(cwd));
  assert.throws(() => updateProject(project.id, {
    default_agent_profile_id: replacementProfileId,
  }), /allowlist/);

  const projectDefault = createSession(cwd, { title: "project defaults" });
  assert.equal(projectDefault.agent_profile_id, finance.id);
  assert.deepEqual([projectDefault.provider, projectDefault.model], ["openai-codex", "project-model"]);
  const explicit = createSession(cwd, { provider: "local", model: "explicit-model", agentProfileId: finance.id });
  assert.deepEqual([explicit.provider, explicit.model], ["local", "explicit-model"]);
  assert.throws(() => createSession(cwd, { agentProfileId: replacementProfileId }), /not allowed/);

  updateProject(project.id, { default_provider: null, default_model: null });
  const profileDefault = createSession(cwd, { agentProfileId: finance.id });
  assert.deepEqual([profileDefault.provider, profileDefault.model], ["anthropic", "profile-model"]);
  assert.equal(listProjects().length, 1, "session creation upserts rather than duplicates the project");

  assert.throws(() => deleteAgentProfile(finance.id), /replacement_agent_profile_id/);
  deleteAgentProfile(finance.id, replacementProfileId);
  assert.equal(getAgentProfile(finance.id), undefined);
  assert.equal(getProject(project.id)?.default_agent_profile_id, replacementProfileId);
  assert.equal(getSessionById(profileDefault.id)?.agent_profile_id, replacementProfileId);
  assert.throws(() => deleteAgentProfile(replacementProfileId), /replacement_agent_profile_id/);
}));

test("profile names, default pairs, and disabling in-use profiles are validated", () => withStore((dir) => {
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const replacementProfileId = getWorkspaceDefaultAgentProfileId();
  const profile = createAgentProfile({ name: "Analyst" });
  assert.throws(() => createAgentProfile({ name: "analyst" }), /already exists/);
  assert.throws(() => updateAgentProfile(profile.id, { name: "Must not stick", default_provider: "anthropic" }), /must both be set/);
  assert.equal(getAgentProfile(profile.id)?.name, "Analyst", "rejected updates are atomic");
  const project = createProject({ cwd, default_agent_profile_id: profile.id });
  assert.throws(() => updateProject(project.id, { name: "Must not stick", default_provider: "anthropic" }), /must both be set/);
  assert.equal(getProject(project.id)?.name, "project", "rejected project updates are atomic");
  assert.throws(() => updateAgentProfile(profile.id, { enabled: false }), /defaults must be changed/i);
  updateProject(project.id, { default_agent_profile_id: replacementProfileId });
  updateAgentProfile(profile.id, { enabled: false });
  assert.equal(getAgentProfile(profile.id)?.enabled, false);
  assert.equal(getProject(project.id)?.default_agent_profile_id, replacementProfileId);
  assert.equal(listAgentProfiles().length, 2);
  assert.throws(() => updateAgentProfile(replacementProfileId, { enabled: false }), /defaults must be changed/i);
}));

test("project AGENTS.md editing is optimistic, atomic, and symlink-safe", () => withStore((dir) => {
  const cwd = path.join(dir, "instructions-project");
  fs.mkdirSync(cwd);
  const project = createProject({ cwd });
  const missing = readProjectInstructions(project.id);
  assert.equal(missing.exists, false);
  assert.equal(missing.text, null);
  assert.throws(() => writeProjectInstructions(project.id, { text: "first" }), /create_if_missing/);

  const created = writeProjectInstructions(project.id, { text: "first", create_if_missing: true });
  assert.equal(created.text, "first");
  assert.match(created.sha256!, /^[a-f0-9]{64}$/);
  assert.throws(() => writeProjectInstructions(project.id, { text: "stale", expected_sha256: "0".repeat(64) }), /changed externally/);
  const updated = writeProjectInstructions(project.id, { text: "second", expected_sha256: created.sha256 });
  assert.equal(updated.text, "second");

  const agentsPath = path.join(cwd, "AGENTS.md");
  const outside = path.join(dir, "outside.md");
  fs.writeFileSync(outside, "outside");
  fs.unlinkSync(agentsPath);
  fs.symlinkSync(outside, agentsPath);
  assert.throws(() => readProjectInstructions(project.id), /not a symlink/);
  assert.equal(fs.readFileSync(outside, "utf-8"), "outside");
}));
