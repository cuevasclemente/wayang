import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-artifacts-"));
process.env.WAYANG_DATA_DIR = path.join(root, "data");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "agent", "sessions");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });

const dbMod = await import("./db.js");
const profilesMod = await import("./agent-profiles.js");
const projectsMod = await import("./projects.js");
const sessionsMod = await import("./sessions.js");
const artifactsMod = await import("./protected-artifacts.js");
const transcriptAuthorizationMod = await import("./standard-transcript-authorization.js");

dbMod.init();

test.after(() => {
  artifactsMod.setProtectedArtifactTestHooksForTests(null);
  dbMod.close();
  fs.rmSync(root, { recursive: true, force: true });
});

class SyntheticWatcher extends EventEmitter {
  close(): void {}
  ref(): this { return this; }
  unref(): this { return this; }
}

function createProject(name: string): { cwd: string; profileId: string } {
  const cwd = path.join(root, name);
  fs.mkdirSync(cwd, { recursive: true });
  const profile = profilesMod.createAgentProfile({ name: `Profile ${name}` });
  projectsMod.createProject({ cwd, default_agent_profile_id: profile.id });
  return { cwd, profileId: profile.id };
}

test("one protected-artifact snapshot serves overlapping getters until the manifest changes", () => {
  let canonicalizations = 0;
  artifactsMod.setProtectedArtifactTestHooksForTests({
    observeCanonicalize: () => { canonicalizations++; },
    watch: () => new SyntheticWatcher() as fs.FSWatcher,
  });
  createProject("cache-a");

  const first = artifactsMod.getProtectedArtifactRootSnapshot();
  const afterFirst = canonicalizations;
  assert.ok(afterFirst > 0);
  artifactsMod.getProtectedArtifactReadRoots();
  artifactsMod.getProtectedArtifactWriteRoots();
  artifactsMod.getRestrictedAgentArtifactRoots();
  artifactsMod.getNonTranscriptUniversalReadDenyRoots();
  assert.equal(canonicalizations, afterFirst, "overlapping getters must not recanonicalize the same manifest");
  assert.equal(artifactsMod.getProtectedArtifactRootSnapshot(), first);

  createProject("cache-b");
  const second = artifactsMod.getProtectedArtifactRootSnapshot();
  assert.notEqual(second, first);
  assert.notEqual(second.manifestKey, first.manifestKey);
  assert.ok(canonicalizations > afterFirst, "Project registration must rebuild the protected-root snapshot");
});

test("unwatchable roots reuse only the current event-loop turn", async () => {
  let canonicalizations = 0;
  artifactsMod.setProtectedArtifactTestHooksForTests({
    observeCanonicalize: () => { canonicalizations++; },
    watch: () => { throw new Error("synthetic watch unavailable"); },
  });

  artifactsMod.getProtectedArtifactReadRoots();
  const firstPass = canonicalizations;
  artifactsMod.getProtectedArtifactWriteRoots();
  artifactsMod.getRestrictedAgentArtifactRoots();
  assert.equal(canonicalizations, firstPass, "nested checks in one turn must share the snapshot");

  await new Promise<void>((resolve) => setImmediate(resolve));
  artifactsMod.getProtectedArtifactReadRoots();
  assert.ok(canonicalizations > firstPass, "the next turn must rebuild when change observation is unavailable");
});

test("registered secret symlink retargeting invalidates canonical deny roots", async () => {
  const invalidations: string[] = [];
  artifactsMod.setProtectedArtifactTestHooksForTests({
    observeInvalidation: (reason) => invalidations.push(reason),
  });
  const project = createProject("symlink-project");
  const firstTarget = path.join(project.cwd, "secret-a");
  const secondTarget = path.join(project.cwd, "secret-b");
  const alias = path.join(project.cwd, ".env");
  fs.writeFileSync(firstTarget, "synthetic-a\n");
  fs.writeFileSync(secondTarget, "synthetic-b\n");
  fs.symlinkSync(firstTarget, alias);

  const before = artifactsMod.getRegisteredProjectSecretPaths();
  assert.ok(before.includes(fs.realpathSync(firstTarget)));
  fs.unlinkSync(alias);
  fs.symlinkSync(secondTarget, alias);

  const deadline = Date.now() + 3_000;
  let after = before;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    after = artifactsMod.getRegisteredProjectSecretPaths();
    if (after.includes(fs.realpathSync(secondTarget))) break;
  }
  assert.ok(
    invalidations.some((reason) => reason === "filesystem_change" || reason === "symlink_alias"),
    "a watched or turn-scoped alias snapshot must invalidate before later reuse",
  );
  assert.ok(after.includes(fs.realpathSync(secondTarget)));
  assert.equal(after.includes(fs.realpathSync(firstTarget)), false);

  const piRoot = path.join(project.cwd, ".pi");
  const firstBrowserTarget = path.join(project.cwd, "browser-a");
  const secondBrowserTarget = path.join(project.cwd, "browser-b");
  const browserAlias = path.join(piRoot, "browser-workbench");
  fs.mkdirSync(piRoot);
  fs.mkdirSync(firstBrowserTarget);
  fs.mkdirSync(secondBrowserTarget);
  fs.symlinkSync(firstBrowserTarget, browserAlias, "dir");
  let browserRoots: string[] = [];
  const browserCreateDeadline = Date.now() + 3_000;
  while (Date.now() < browserCreateDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    browserRoots = artifactsMod.getRegisteredProjectBrowserRoots();
    if (browserRoots.includes(fs.realpathSync(firstBrowserTarget))) break;
  }
  assert.ok(browserRoots.includes(fs.realpathSync(firstBrowserTarget)));
  fs.unlinkSync(browserAlias);
  fs.symlinkSync(secondBrowserTarget, browserAlias, "dir");

  const browserDeadline = Date.now() + 3_000;
  while (Date.now() < browserDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    browserRoots = artifactsMod.getRegisteredProjectBrowserRoots();
    if (browserRoots.includes(fs.realpathSync(secondBrowserTarget))) break;
  }
  assert.ok(browserRoots.includes(fs.realpathSync(secondBrowserTarget)));
  assert.equal(browserRoots.includes(fs.realpathSync(firstBrowserTarget)), false);
});

test("canonical symlink aliases force a fresh snapshot on the next turn even without watcher events", async () => {
  artifactsMod.setProtectedArtifactTestHooksForTests({
    watch: () => new SyntheticWatcher() as fs.FSWatcher,
  });
  const project = createProject("turn-scoped-symlink");
  const firstTarget = path.join(project.cwd, "nested-a");
  const secondTarget = path.join(project.cwd, "nested-b");
  const alias = path.join(project.cwd, ".env");
  fs.writeFileSync(firstTarget, "a\n");
  fs.writeFileSync(secondTarget, "b\n");
  fs.symlinkSync(firstTarget, alias);
  assert.ok(artifactsMod.getRegisteredProjectSecretPaths().includes(fs.realpathSync(firstTarget)));

  fs.unlinkSync(alias);
  fs.symlinkSync(secondTarget, alias);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const refreshed = artifactsMod.getRegisteredProjectSecretPaths();
  assert.ok(refreshed.includes(fs.realpathSync(secondTarget)));
  assert.equal(refreshed.includes(fs.realpathSync(firstTarget)), false);
});

test("repeated transcript authorization reuses the protected-root snapshot", () => {
  let canonicalizations = 0;
  artifactsMod.setProtectedArtifactTestHooksForTests({
    observeCanonicalize: () => { canonicalizations++; },
    watch: () => new SyntheticWatcher() as fs.FSWatcher,
  });
  const project = createProject("transcript-project");
  const row = sessionsMod.createSession(project.cwd, { agentProfileId: project.profileId });
  const transcriptDir = path.join(process.env.PI_CODING_AGENT_SESSION_DIR!, "transcript-project");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const transcript = path.join(transcriptDir, "session.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: "session",
    version: 3,
    id: row.id,
    cwd: project.cwd,
  })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "synthetic" } })}\n`);
  sessionsMod.updatePiSessionFile(row.id, transcript);

  assert.ok(transcriptAuthorizationMod.authorizeExactStandardTranscript(transcript, { expectedSessionId: row.id }));
  const firstPass = canonicalizations;
  for (let index = 0; index < 20; index++) {
    assert.ok(transcriptAuthorizationMod.authorizeExactStandardTranscript(transcript, { expectedSessionId: row.id }));
  }
  assert.equal(canonicalizations, firstPass, "transcript count must not multiply all-Project root canonicalization");
});
