import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { close, failNextCommitStoreMutationPersistenceForTests, init } from "./db.js";
import { createAgentProfile, getAgentProfile } from "./agent-profiles.js";
import { createProject, getProject } from "./projects.js";
import { router as projectsRouter } from "./routes/projects.js";
import { router as agentProfilesRouter } from "./routes/agent-profiles.js";
import {
  RuntimeImpactConflict,
  runtimeImpactService,
  type RuntimeMutationImpactLease,
} from "./runtime-impact.js";

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

test("Project/Profile/AGENTS routes block busy runtimes and stop idle impacts after durable mutation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-runtime-impact-routes-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previousData = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  init();

  const profile = createAgentProfile({ name: "Impacted profile" });
  const project = createProject({ cwd, default_agent_profile_id: profile.id });
  const originalProjectAcquire = runtimeImpactService.acquireProject;
  const originalProfileAcquire = runtimeImpactService.acquireProfile;

  const app = express();
  app.use(express.json());
  app.use("/api", projectsRouter);
  app.use("/api", agentProfilesRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    runtimeImpactService.acquireProject = originalProjectAcquire;
    runtimeImpactService.acquireProfile = originalProfileAcquire;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
    if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousData;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const busy = () => {
    throw new RuntimeImpactConflict([
      { session_id: "streaming-session", runtime_status: "active", streaming: true, queued: false, mutation_locked: false },
      { session_id: "queued-session", runtime_status: "active", streaming: false, queued: true, mutation_locked: false },
    ]);
  };
  runtimeImpactService.acquireProject = busy;
  runtimeImpactService.acquireProfile = busy;

  // Display-only fields do not consult runtime impact and remain editable.
  const display = await fetch(`${base}/projects/${project.id}`, json("PUT", { name: "Display rename" }));
  assert.equal(display.status, 200);

  const projectConflict = await fetch(`${base}/projects/${project.id}`, json("PUT", {
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  }));
  assert.equal(projectConflict.status, 409);
  const conflictBody = await projectConflict.json() as Record<string, unknown>;
  assert.equal(conflictBody.code, "runtime_mutation_conflict");
  assert.deepEqual(conflictBody.affected_session_ids, ["streaming-session", "queued-session"]);
  assert.deepEqual(conflictBody.streaming_session_ids, ["streaming-session"]);
  assert.deepEqual(conflictBody.queued_session_ids, ["queued-session"]);
  assert.equal(getProject(project.id)?.access_policy.allowed_agent_profile_ids, null, "blocked mutation is not committed");

  const instructionsConflict = await fetch(`${base}/projects/${project.id}/instructions`, json("PUT", {
    text: "# blocked\n",
    create_if_missing: true,
  }));
  assert.equal(instructionsConflict.status, 409);
  assert.equal(fs.existsSync(path.join(cwd, "AGENTS.md")), false);

  const profileConflict = await fetch(`${base}/agent-profiles/${profile.id}`, json("PUT", {
    instructions: "blocked instructions",
  }));
  assert.equal(profileConflict.status, 409);
  assert.equal(getAgentProfile(profile.id)?.instructions, null);

  let commits = 0;
  let releases = 0;
  const idle = (): RuntimeMutationImpactLease => ({
    affected_session_ids: ["idle-session"],
    cleanup_failures: [],
    async commitAndStopIdle() { commits++; return ["idle-session"]; },
    release() { releases++; },
  });
  runtimeImpactService.acquireProject = idle;
  runtimeImpactService.acquireProfile = idle;

  const policyUpdate = await fetch(`${base}/projects/${project.id}`, json("PUT", {
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  }));
  assert.equal(policyUpdate.status, 200);

  const profileUpdate = await fetch(`${base}/agent-profiles/${profile.id}`, json("PUT", {
    instructions: "new instructions",
  }));
  assert.equal(profileUpdate.status, 200);

  const instructionsUpdate = await fetch(`${base}/projects/${project.id}/instructions`, json("PUT", {
    text: "# new instructions\n",
    create_if_missing: true,
  }));
  assert.equal(instructionsUpdate.status, 200);
  assert.equal(commits, 3, "each durable runtime-affecting mutation stops idle runtimes");
  assert.equal(releases, 0, "successful commits settle their own leases");

  failNextCommitStoreMutationPersistenceForTests(new Error("synthetic durable mutation failure"));
  const failedAfterLease = await fetch(`${base}/projects/${project.id}`, json("PUT", {
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
  }));
  assert.equal(failedAfterLease.status, 500);
  assert.match((await failedAfterLease.json() as { error: string }).error, /synthetic durable mutation failure/);
  assert.deepEqual(getProject(project.id)?.access_policy.allowed_agent_profile_ids, [profile.id]);
  assert.equal(commits, 3, "failed persistence must not stop idle runtimes");
  assert.equal(releases, 1, "failed durable mutations release their runtime gate without stopping work");
});
