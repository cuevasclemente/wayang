import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close, commitStoreMutation, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession } from "../sessions.js";
import { commitWorkspaceCapabilityActivation } from "../workspace-capabilities.js";
import { STORE_SCHEMA_VERSION } from "../workspace-types.js";
import {
  createManagedBrowserProfile,
  getProjectBrowserDefault,
  getSessionBrowserState,
  listBrowserProfiles,
  markBrowserProfileTrashed,
  materializeSessionBrowserState,
  renameBrowserProfile,
  requestBrowserProfileTrash,
  restoreTrashedBrowserProfile,
  setBrowserProfileEnabled,
  setProjectBrowserDefault,
  setSessionBrowserProfile,
} from "./profile-catalog.js";
import {
  browserProfileStorageRoot,
  type BrowserProfileStorageSource,
} from "./profile-catalog-store.js";

let root = "";
let dataDir = "";
let projectRoot = "";

beforeEach(() => {
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-profile-catalog-"));
  dataDir = path.join(root, "data");
  projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  process.env.WAYANG_DATA_DIR = dataDir;
  init({ browserProfilesEnabled: true });
});

afterEach(() => {
  close();
  delete process.env.WAYANG_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

test("managed Browser Profile catalog uses CAS and project defaults affect only unassigned sessions", () => {
  const profile = createAgentProfile({ name: "Catalog agent" });
  const project = createProject({ cwd: projectRoot, default_agent_profile_id: profile.id });
  const firstSession = createSession(projectRoot, { agentProfileId: profile.id });
  const first = materializeSessionBrowserState(firstSession.id, 10);
  assert.equal(first.active_profile_id, null);

  const alpha = createManagedBrowserProfile("Alpha", 20);
  assert.equal(alpha.storage_source, "managed");
  assert.equal(fs.existsSync(path.join(dataDir, "browser-profiles")), false, "catalog create opened profile storage");
  const renamed = renameBrowserProfile(alpha.id, alpha.revision, "Shared login", 21);
  assert.equal(renamed.name, "Shared login");
  assert.throws(() => renameBrowserProfile(alpha.id, alpha.revision, "stale"), /changed; refresh/);

  const projectDefault = setProjectBrowserDefault({
    projectId: project.id,
    profileId: alpha.id,
    expectedRevision: null,
    updatedBy: "agent",
    now: 22,
  });
  assert.equal(projectDefault.profile_id, alpha.id);
  assert.equal(getSessionBrowserState(firstSession.id)?.active_profile_id, null, "default silently retargeted existing session");

  const secondSession = createSession(projectRoot, { agentProfileId: profile.id });
  assert.equal(materializeSessionBrowserState(secondSession.id, 23).active_profile_id, alpha.id);
  assert.equal(setSessionBrowserProfile({
    sessionId: firstSession.id,
    profileId: alpha.id,
    expectedRevision: first.revision,
    now: 24,
  }).active_profile_id, alpha.id);

  const disabled = setBrowserProfileEnabled(alpha.id, renamed.revision, false, 25);
  assert.equal(disabled.state, "disabled");
  assert.throws(() => setSessionBrowserProfile({
    sessionId: firstSession.id,
    profileId: alpha.id,
    expectedRevision: 2,
  }), /not active/);
  const enabled = setBrowserProfileEnabled(alpha.id, disabled.revision, true, 26);
  assert.equal(enabled.state, "active");
  assert.equal(getProjectBrowserDefault(project.id)?.updated_by, "agent");
  assert.deepEqual(listBrowserProfiles().map((row) => row.name), ["Shared login"]);
});

test("trash is recoverable, reference-safe, and does not mutate profile bytes", () => {
  const profile = createManagedBrowserProfile("Disposable", 10);
  const storage = getStore().browserProfiles.find((row) => row.id === profile.id)!;
  const storageRoot = browserProfileStorageRoot(dataDir, storage.storage_source);
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const sentinel = path.join(storageRoot, "synthetic-profile-byte");
  fs.writeFileSync(sentinel, "do-not-read-or-change", { mode: 0o600 });

  const requested = requestBrowserProfileTrash(profile.id, profile.revision, 11);
  assert.equal(requested.profile.state, "trash_pending");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "do-not-read-or-change");
  const trashed = markBrowserProfileTrashed(profile.id, requested.cleanup.id, 12);
  assert.equal(trashed.state, "trashed");
  const restored = restoreTrashedBrowserProfile(profile.id, trashed.revision, 13);
  assert.equal(restored.state, "disabled");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "do-not-read-or-change");
});

test("schema 5 to 7 migration preserves title provenance and inventories only expected profile directory metadata", () => {
  const agent = createAgentProfile({ name: "Migrated agent" });
  const project = createProject({ cwd: projectRoot, name: "Migrated project", default_agent_profile_id: agent.id });
  commitWorkspaceCapabilityActivation({
    capability_id: "wayang.standard-browser.v1",
    project_id: project.id,
    agent_profile_id: agent.id,
    operation_digest: "a".repeat(64),
  });
  close();

  const sharedSource: BrowserProfileStorageSource = { kind: "legacy_shared" };
  const pairSource: BrowserProfileStorageSource = { kind: "standard_pair_v1", project_id: project.id, agent_profile_id: agent.id };
  for (const source of [sharedSource, pairSource]) {
    const directory = browserProfileStorageRoot(dataDir, source);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "opaque-profile-data"), "{not-json-and-never-opened", { mode: 0o000 });
  }

  const storePath = path.join(dataDir, "store.json");
  const schemaFive = JSON.parse(fs.readFileSync(storePath, "utf8"));
  schemaFive.schema_version = 5;
  delete schemaFive.historicalAgentCutovers;
  delete schemaFive.transcriptRecoveryJournal;
  delete schemaFive.browserProfiles;
  delete schemaFive.projectBrowserDefaults;
  delete schemaFive.sessionBrowserStates;
  delete schemaFive.browserCleanups;
  fs.writeFileSync(storePath, `${JSON.stringify(schemaFive, null, 2)}\n`, { mode: 0o600 });

  init({ browserProfilesEnabled: true });
  const store = getStore();
  assert.equal(store.schema_version, STORE_SCHEMA_VERSION);
  assert.deepEqual(store.browserProfiles.map((row) => row.storage_source.kind).sort(), ["legacy_shared", "standard_pair_v1"]);
  assert.deepEqual(store.projectBrowserDefaults, []);
  assert.deepEqual(store.sessionBrowserStates, []);
  assert.deepEqual(store.browserCleanups, []);
  assert.deepEqual(store.transcriptRecoveryJournal, []);
  const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith("store.json.backup-v5-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.statSync(path.join(dataDir, backups[0]!)).mode & 0o777, 0o600);
});

test("strict store validation rejects aliased Browser Profile storage identities atomically", () => {
  const first = createManagedBrowserProfile("First");
  assert.throws(() => commitStoreMutation((draft) => {
    const source = draft.browserProfiles.find((row) => row.id === first.id)!;
    draft.browserProfiles.push({ ...structuredClone(source), id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alias" });
  }), /duplicate browser profile identity/);
  assert.equal(getStore().browserProfiles.length, 1);
});
