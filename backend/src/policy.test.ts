import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "./agent-profiles.js";
import { close, init } from "./db.js";
import { createProject, updateProject } from "./projects.js";
import {
  authorizeProjectAction,
  buildProjectPolicyProjection,
  canonicalizePolicyPath,
  getPolicyGeneration,
  onPolicyChanged,
  pathIsWithin,
  projectAllowsAgentProfile,
  resolveEffectiveSessionConfig,
} from "./policy.js";

function withStore(name: string, run: (fixture: { dir: string; cwd: string }) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  try {
    init();
    run({ dir, cwd });
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("central policy applies allowlists in standard mode and protected actor invariants", () => {
  withStore("wayang-policy-auth-", ({ cwd }) => {
    const allowedProfile = createAgentProfile({ name: "Allowed profile", memory_access: "read" });
    const unlistedProfile = createAgentProfile({ name: "Unlisted profile" });
    const project = createProject({ cwd });
    updateProject(project.id, {
      default_agent_profile_id: allowedProfile.id,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [allowedProfile.id] },
    });
    const configuredProject = authorizeProjectAction({ cwd, actor: "interactive", agentProfileId: allowedProfile.id }).project!;

    assert.equal(projectAllowsAgentProfile(configuredProject, allowedProfile.id), true);
    assert.equal(projectAllowsAgentProfile(configuredProject, unlistedProfile.id), false);
    assert.equal(authorizeProjectAction({ cwd, actor: "interactive", agentProfileId: allowedProfile.id }).allowed, true);
    const deniedUnlistedProfile = authorizeProjectAction({ cwd, actor: "interactive", agentProfileId: unlistedProfile.id });
    assert.equal(deniedUnlistedProfile.allowed, false);
    assert.equal(deniedUnlistedProfile.code, "agent_not_allowed");

    updateProject(project.id, {
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [allowedProfile.id] },
    });
    assert.equal(authorizeProjectAction({ cwd, actor: "interactive", agentProfileId: allowedProfile.id }).allowed, true);
    assert.equal(authorizeProjectAction({ cwd, actor: "scheduled", agentProfileId: allowedProfile.id }).allowed, true);
    assert.equal(authorizeProjectAction({ cwd, actor: "scheduled", agentProfileId: null }).allowed, false);
    for (const actor of ["dream", "subagent", "indexer"] as const) {
      const decision = authorizeProjectAction({ cwd, actor, agentProfileId: allowedProfile.id });
      assert.equal(decision.allowed, false, actor);
      assert.equal(decision.code, "protected_actor_denied");
    }

    const projection = buildProjectPolicyProjection();
    const entry = projection.projects.find((candidate) => candidate.cwd === fs.realpathSync(cwd));
    assert.deepEqual(
      { dream: entry?.dream, scheduled: entry?.scheduled, subagents: entry?.subagents, global_index: entry?.global_index },
      { dream: false, scheduled: true, subagents: false, global_index: false },
    );
  });
});

test("project repository transactions notify only for policy-bearing create/update changes", () => {
  withStore("wayang-policy-notifications-", ({ cwd }) => {
    const before = getPolicyGeneration();
    const observed: number[] = [];
    const unsubscribe = onPolicyChanged((generation) => observed.push(generation));
    try {
      const project = createProject({ cwd });
      assert.equal(observed.length, 1, "create publishes a new policy surface");
      assert.ok(observed[0]! > before);

      const afterCreate = getPolicyGeneration();
      updateProject(project.id, { name: "Display-only rename", color: "blue" });
      assert.equal(observed.length, 1, "display metadata does not notify policy watchers");
      assert.equal(getPolicyGeneration(), afterCreate);

      updateProject(project.id, {
        access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
      });
      assert.equal(observed.length, 1, "an unchanged policy payload does not notify");

      updateProject(project.id, {
        access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [project.default_agent_profile_id] },
      });
      assert.equal(observed.length, 2);
      assert.equal(observed.at(-1), getPolicyGeneration());

      updateProject(project.id, { default_provider: "anthropic", default_model: "policy-model" });
      assert.equal(observed.length, 3, "runtime defaults are policy-bearing");
    } finally {
      unsubscribe();
    }
  });
});

test("policy generation increments for successive project policy updates", () => {
  withStore("wayang-policy-generation-", ({ cwd }) => {
    const project = createProject({ cwd });
    const before = getPolicyGeneration();
    updateProject(project.id, {
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [project.default_agent_profile_id] },
    });
    const afterAllowlist = getPolicyGeneration();
    assert.ok(afterAllowlist > before);
    updateProject(project.id, {
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [project.default_agent_profile_id] },
    });
    assert.ok(getPolicyGeneration() > afterAllowlist);
  });
});

test("switch defaults prefer the target profile before project defaults", () => {
  withStore("wayang-policy-switch-default-", ({ cwd }) => {
    const target = createAgentProfile({
      name: "Target",
      default_provider: "profile-provider",
      default_model: "profile-model",
    });
    const project = createProject({
      cwd,
      default_provider: "project-provider",
      default_model: "project-model",
    });
    const switchConfig = resolveEffectiveSessionConfig({ project, agentProfile: target, purpose: "switch" });
    assert.deepEqual([switchConfig.provider, switchConfig.model], ["profile-provider", "profile-model"]);
    const createConfig = resolveEffectiveSessionConfig({ project, agentProfile: target, purpose: "create" });
    assert.deepEqual([createConfig.provider, createConfig.model], ["project-provider", "project-model"]);
  });
});

test("mutation canonicalization resolves a symlinked nearest parent for nonexistent children", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-policy-path-"));
  const denied = path.join(dir, "denied");
  const project = path.join(dir, "project");
  fs.mkdirSync(denied);
  fs.mkdirSync(project);
  fs.symlinkSync(denied, path.join(project, "linked"), "dir");
  try {
    const target = canonicalizePolicyPath("linked/new/note.md", { cwd: project, forMutation: true });
    assert.equal(target, path.join(fs.realpathSync(denied), "new", "note.md"));
    assert.equal(pathIsWithin(target, fs.realpathSync(denied)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
