import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "./agent-profiles.js";
import { close, flush, getStore, getWorkspaceCapabilityStoreProjectionPath, init } from "./db.js";
import { createProject } from "./projects.js";
import { createSession } from "./sessions.js";
import { commitWorkspaceCapabilityActivation } from "./workspace-capabilities.js";
import { NEUTRAL_AGENT_PROFILE_ID, STORE_SCHEMA_VERSION, WREN_AGENT_PROFILE_ID } from "./workspace-types.js";

function legacySession(id: string, cwd: string) {
  return {
    id,
    pi_session_file: null,
    title: id,
    cwd,
    provider: null,
    model: null,
    created_at: 1,
    last_active: 2,
    archived: 0,
    goal: null,
    goal_status: null,
  };
}

function legacyStore(sessions: unknown[] = []) {
  return {
    sessions,
    agentTeams: [],
    teamMembers: [],
    goals: [],
    apps: [],
    appStates: [],
    appEvents: [],
    scheduledJobs: [],
    scheduledRuns: [],
    interviews: [],
  };
}

function withDataDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-store-migration-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  close();
  try { return fn(dir); } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function backups(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith("store.json.backup-v"));
}

test("legacy migration is private, canonical, seeded, and idempotent", () => withDataDir((dir) => {
  const project = path.join(dir, "project");
  const alias = path.join(dir, "project-alias");
  fs.mkdirSync(project);
  fs.symlinkSync(project, alias, "dir");
  const storePath = path.join(dir, "store.json");
  fs.writeFileSync(storePath, JSON.stringify(legacyStore([
    legacySession("one", project),
    legacySession("two", alias),
  ])));

  init();
  const migrated = getStore();
  assert.equal(migrated.schema_version, STORE_SCHEMA_VERSION);
  assert.deepEqual(migrated.agentProfiles.map((profile) => profile.id).sort(), [NEUTRAL_AGENT_PROFILE_ID, WREN_AGENT_PROFILE_ID].sort());
  assert.equal(migrated.projects.length, 1);
  assert.equal(migrated.projects[0]?.cwd, fs.realpathSync.native(project));
  assert.deepEqual(migrated.sessions.map((session) => session.agent_profile_id), [null, null]);
  assert.deepEqual(migrated.sessions.map((session) => session.pending_agent_switch), [null, null]);
  const firstProjectId = migrated.projects[0]?.id;
  const firstBackupNames = backups(dir);
  assert.equal(firstBackupNames.length, 1);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, firstBackupNames[0]!)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
  }

  close();
  init();
  assert.equal(getStore().projects[0]?.id, firstProjectId);
  assert.deepEqual(backups(dir), firstBackupNames);
}));

test("schema 3 migrates through current schema with no messaging or browser authority", () => withDataDir((dir) => {
  init();
  const storePath = path.join(dir, "store.json");
  close();
  const schemaThree = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;
  schemaThree.schema_version = 3;
  delete schemaThree.transcriptRecoveryJournal;
  delete schemaThree.messagingEndpoints;
  delete schemaThree.messagingEvents;
  delete schemaThree.messagingTransactions;
  delete schemaThree.messagingDeliveries;
  delete schemaThree.browserProfiles;
  delete schemaThree.projectBrowserDefaults;
  delete schemaThree.sessionBrowserStates;
  delete schemaThree.browserCleanups;
  fs.writeFileSync(storePath, JSON.stringify(schemaThree));

  init();
  const migrated = getStore();
  assert.equal(migrated.schema_version, STORE_SCHEMA_VERSION);
  assert.deepEqual(migrated.messagingEndpoints, []);
  assert.deepEqual(migrated.messagingEvents, []);
  assert.deepEqual(migrated.messagingTransactions, []);
  assert.deepEqual(migrated.messagingDeliveries, []);
  assert.deepEqual(migrated.browserProfiles, []);
  assert.deepEqual(migrated.projectBrowserDefaults, []);
  assert.deepEqual(migrated.sessionBrowserStates, []);
  assert.deepEqual(migrated.browserCleanups, []);
  assert.equal(backups(dir).filter((name) => name.includes("backup-v3-")).length, 1);
}));

test("legacy migration defaults omitted nullable session provider", () => withDataDir((dir) => {
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const session = legacySession("missing-provider", project) as Partial<ReturnType<typeof legacySession>>;
  delete session.provider;
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify(legacyStore([session])));

  init();
  assert.equal(getStore().sessions[0]?.provider, null);
  assert.equal(getStore().sessions[0]?.model, null);
  assert.equal(getStore().sessions[0]?.pi_session_file, null);
}));

test("malformed JSON and unsupported future schemas abort without replacement", () => withDataDir((dir) => {
  const storePath = path.join(dir, "store.json");
  for (const contents of ["{not-json", JSON.stringify({ schema_version: STORE_SCHEMA_VERSION + 1 })]) {
    fs.writeFileSync(storePath, contents);
    assert.throws(() => init(), /malformed JSON|newer than supported/);
    assert.equal(fs.readFileSync(storePath, "utf-8"), contents);
    assert.deepEqual(backups(dir), []);
    close();
  }
}));

test("backup creation failure aborts migration and leaves legacy bytes intact", () => withDataDir((dir) => {
  const storePath = path.join(dir, "store.json");
  const contents = JSON.stringify(legacyStore());
  fs.writeFileSync(storePath, contents);
  const originalNow = Date.now;
  Date.now = () => 1_000;
  const stamp = new Date(1_000).toISOString().replace(/[:.]/g, "-");
  const blockedBackup = `${storePath}.backup-v0-${stamp}`;
  fs.writeFileSync(blockedBackup, "pre-existing backup must survive");
  try {
    assert.throws(() => init(), /migration backup failed/);
    assert.equal(fs.readFileSync(storePath, "utf-8"), contents);
    assert.equal(fs.readFileSync(blockedBackup, "utf-8"), "pre-existing backup must survive");
  } finally {
    Date.now = originalNow;
  }
}));

test("interrupted atomic writes preserve both the durable store and a pre-existing temp path", () => withDataDir((dir) => {
  init();
  const storePath = path.join(dir, "store.json");
  const durable = fs.readFileSync(storePath, "utf-8");
  const originalNow = Date.now;
  Date.now = () => 2_000;
  const temp = `${storePath}.${process.pid}.2000.tmp`;
  fs.writeFileSync(temp, "pre-existing temp must survive");
  const defaultProfileId = getStore().workspaceSettings.default_agent_profile_id;
  const defaultProfile = getStore().agentProfiles.find((profile) => profile.id === defaultProfileId)!;
  const originalName = defaultProfile.name;
  defaultProfile.name = "Uncommitted";
  try {
    assert.throws(() => flush(), /EEXIST/);
    assert.equal(fs.readFileSync(storePath, "utf-8"), durable);
    assert.equal(fs.readFileSync(temp, "utf-8"), "pre-existing temp must survive");
  } finally {
    defaultProfile.name = originalName;
    Date.now = originalNow;
  }
}));

test("current-schema structural corruption aborts without normalization", () => withDataDir((dir) => {
  const storePath = path.join(dir, "store.json");
  init();
  const current = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, unknown>;
  close();
  current.sessions = [legacySession("missing-agent-field", dir)];
  const malformedCurrent = JSON.stringify(current);
  fs.writeFileSync(storePath, malformedCurrent);
  assert.throws(() => init(), /malformed session/);
  assert.equal(fs.readFileSync(storePath, "utf-8"), malformedCurrent);
}));

test("gate-off new stores use schema 7 with one generic restricted workspace default and empty Browser catalog", () => withDataDir((dir) => {
  init();
  const store = getStore();
  assert.equal(store.agentProfiles.length, 1);
  assert.equal(store.agentProfiles[0]?.id, store.workspaceSettings.default_agent_profile_id);
  assert.equal(store.agentProfiles[0]?.builtin_kind, null);
  assert.equal(store.agentProfiles[0]?.resource_mode, "project_only");
  assert.equal("capability_grants" in store.agentProfiles[0]!, false);
  assert.equal("authorization_revision" in store.agentProfiles[0]!, false);
  assert.deepEqual(store.workspaceCapabilityAssociations, []);
  assert.deepEqual(store.workspaceCapabilityApprovalEvents, []);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf-8"));
  assert.equal(persisted.schema_version, 7);
  assert.deepEqual(persisted.browserProfiles, []);
  assert.deepEqual(persisted.projectBrowserDefaults, []);
  assert.deepEqual(persisted.sessionBrowserStates, []);
  assert.deepEqual(persisted.browserCleanups, []);
  assert.deepEqual(persisted.transcriptRecoveryJournal, []);
  assert.equal(persisted.agentProfiles.length, 1);
  assert.deepEqual(persisted.workspaceCapabilityAssociations, []);
  assert.deepEqual(persisted.workspaceCapabilityApprovalEvents, []);
}));

test("exact capability projection contains only its model-independent project/profile pair and no approval or instruction evidence", () => withDataDir((dir) => {
  init();
  const exactCwd = path.join(dir, "exact-project");
  const unrelatedCwd = path.join(dir, "unrelated-project");
  fs.mkdirSync(exactCwd);
  fs.mkdirSync(unrelatedCwd);
  const exactProfile = createAgentProfile({
    name: "Exact profile",
    resource_mode: "standard",
    instructions: "SYNTHETIC_EXACT_INSTRUCTIONS_CANARY",
  });
  const unrelatedProfile = createAgentProfile({
    name: "Unrelated profile",
    instructions: "SYNTHETIC_UNRELATED_INSTRUCTIONS_CANARY",
  });
  const exactProject = createProject({
    cwd: exactCwd,
    default_agent_profile_id: exactProfile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [exactProfile.id] },
  });
  createProject({
    cwd: unrelatedCwd,
    default_agent_profile_id: unrelatedProfile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [unrelatedProfile.id] },
  });
  const exactSession = createSession(exactCwd, {
    title: "Exact session",
    agentProfileId: exactProfile.id,
    provider: "synthetic-provider",
    model: "synthetic-model",
  });
  createSession(unrelatedCwd, {
    title: "SYNTHETIC_UNRELATED_SESSION_CANARY",
    agentProfileId: unrelatedProfile.id,
    provider: "other-provider",
    model: "other-model",
  });
  const binding = {
    capability_id: "wayang.standard-resources.v1" as const,
    project_id: exactProject.id,
    agent_profile_id: exactProfile.id,
  };
  commitWorkspaceCapabilityActivation({ ...binding, operation_digest: "a".repeat(64) });

  const projectionPath = getWorkspaceCapabilityStoreProjectionPath(binding);
  const projection = JSON.parse(fs.readFileSync(projectionPath, "utf-8"));
  assert.deepEqual(Object.keys(projection).sort(), [
    "active", "agent_profile", "association_revision", "available", "binding", "project", "schema_version", "sessions",
  ]);
  assert.equal(projection.active, true);
  assert.equal(projection.available, true);
  assert.equal(projection.association_revision, 1);
  assert.equal(projection.project.id, exactProject.id);
  assert.equal(projection.agent_profile.id, exactProfile.id);
  assert.deepEqual(projection.sessions.map((item: { id: string }) => item.id), [exactSession.id]);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /SYNTHETIC_(?:EXACT|UNRELATED)_INSTRUCTIONS_CANARY/);
  assert.doesNotMatch(serialized, /SYNTHETIC_UNRELATED_SESSION_CANARY/);
  assert.equal("workspaceCapabilityApprovalEvents" in projection, false);
  assert.equal(serialized.includes("operation_digest"), false);
  assert.equal(serialized.includes("capability_grants"), false);
  assert.equal(serialized.includes("synthetic-provider"), false);
  assert.equal(serialized.includes("synthetic-model"), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(projectionPath).mode & 0o777, 0o600);
  }
}));
