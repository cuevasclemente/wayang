import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { close, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession } from "../sessions.js";
import { createManagedBrowserProfile, materializeSessionBrowserState, requestBrowserProfilePurge, requestBrowserProfileTrash, setSessionBrowserProfile } from "./profile-catalog.js";
import { BrowserProfileCleanupCoordinator } from "./profile-cleanup.js";
import { browserProfileStorageIdentityDigest, browserProfileStorageRoot } from "./profile-catalog-store.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-cleanup-"));
  const dataDir = path.join(root, "data");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  process.env.WAYANG_DATA_DIR = dataDir;
  init({ browserProfilesEnabled: true });
  const project = createProject({ cwd: projectDir });
  const session = createSession(projectDir);
  const profile = createManagedBrowserProfile("Cleanup synthetic");
  const row = getStore().browserProfiles.find((candidate) => candidate.id === profile.id)!;
  const liveRoot = browserProfileStorageRoot(dataDir, row.storage_source);
  fs.mkdirSync(liveRoot, { recursive: true });
  fs.writeFileSync(path.join(liveRoot, "CANARY"), "SYNTHETIC\n");
  return { root, dataDir, project, session, profile, liveRoot, cleanup() { close(); delete process.env.WAYANG_DATA_DIR; fs.rmSync(root, { recursive: true, force: true }); } };
}

test("cleanup coordinator moves profile storage to recovery and restores it disabled", async () => {
  const f = fixture();
  try {
    const requested = requestBrowserProfileTrash(f.profile.id, f.profile.revision);
    const coordinator = new BrowserProfileCleanupCoordinator(f.dataDir);
    await coordinator.executeTrash(f.profile.id, requested.cleanup.id);
    const trashed = getStore().browserProfiles.find((candidate) => candidate.id === f.profile.id)!;
    assert.equal(trashed.state, "trashed");
    assert.equal(fs.existsSync(f.liveRoot), false);
    assert.equal(getStore().browserCleanups.find((candidate) => candidate.id === requested.cleanup.id)?.state, "verified");

    await coordinator.restore(f.profile.id, trashed.revision);
    const restored = getStore().browserProfiles.find((candidate) => candidate.id === f.profile.id)!;
    assert.equal(restored.state, "disabled");
    assert.equal(fs.readFileSync(path.join(f.liveRoot, "CANARY"), "utf8"), "SYNTHETIC\n");
    assert.equal(getStore().browserCleanups.find((candidate) => candidate.id === requested.cleanup.id)?.recovery_entry_id, null);
  } finally { f.cleanup(); }
});

test("never-materialized and migrated pair profiles use exact atomic recovery without content inspection", async () => {
  const f = fixture();
  try {
    fs.rmSync(f.liveRoot, { recursive: true, force: true });
    const coordinator = new BrowserProfileCleanupCoordinator(f.dataDir);
    const absent = requestBrowserProfileTrash(f.profile.id, f.profile.revision);
    await coordinator.executeTrash(f.profile.id, absent.cleanup.id);
    const absentTrashed = getStore().browserProfiles.find((candidate) => candidate.id === f.profile.id)!;
    await coordinator.restore(f.profile.id, absentTrashed.revision);
    assert.equal(fs.lstatSync(f.liveRoot).isDirectory(), true, "empty recovery payload was not restored");

    const source = { kind: "standard_pair_v1" as const, project_id: "historical-project", agent_profile_id: "historical-agent" };
    const migrated = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Migrated pair",
      storage_source: source,
      storage_identity_digest: browserProfileStorageIdentityDigest(f.dataDir, source),
      state: "disabled" as const,
      revision: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    getStore().browserProfiles.push(migrated);
    const migratedRoot = browserProfileStorageRoot(f.dataDir, source);
    fs.mkdirSync(migratedRoot, { recursive: true });
    const requested = requestBrowserProfileTrash(migrated.id, migrated.revision);
    await coordinator.executeTrash(migrated.id, requested.cleanup.id);
    const trashed = getStore().browserProfiles.find((candidate) => candidate.id === migrated.id)!;
    assert.equal(trashed.state, "trashed");
    assert.equal(fs.existsSync(migratedRoot), false);
    await coordinator.restore(migrated.id, trashed.revision);
    assert.equal(fs.lstatSync(migratedRoot).isDirectory(), true);
  } finally { f.cleanup(); }
});

test("verified recovery payload can be permanently purged after durable request", async () => {
  const f = fixture();
  try {
    const coordinator = new BrowserProfileCleanupCoordinator(f.dataDir);
    const trash = requestBrowserProfileTrash(f.profile.id, f.profile.revision);
    await coordinator.executeTrash(f.profile.id, trash.cleanup.id);
    const trashed = getStore().browserProfiles.find((candidate) => candidate.id === f.profile.id)!;
    const purge = requestBrowserProfilePurge(f.profile.id, trashed.revision);
    await coordinator.purge(f.profile.id, purge.cleanup.id);
    assert.equal(getStore().browserProfiles.some((candidate) => candidate.id === f.profile.id), false);
    assert.equal(getStore().browserCleanups.some((candidate) => candidate.profile_id === f.profile.id), false);
    assert.equal(fs.existsSync(f.liveRoot), false);
  } finally { f.cleanup(); }
});

test("referenced profiles are refused before cleanup moves any bytes", async () => {
  const f = fixture();
  try {
    const initial = materializeSessionBrowserState(f.session.id);
    const state = setSessionBrowserProfile({ sessionId: f.session.id, profileId: f.profile.id, expectedRevision: initial.revision });
    assert.equal(state.active_profile_id, f.profile.id);
    assert.throws(() => requestBrowserProfileTrash(f.profile.id, f.profile.revision), /still referenced/);
    assert.equal(fs.readFileSync(path.join(f.liveRoot, "CANARY"), "utf8"), "SYNTHETIC\n");
  } finally { f.cleanup(); }
});
