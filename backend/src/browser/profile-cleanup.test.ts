import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { close, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession } from "../sessions.js";
import { createManagedBrowserProfile, materializeSessionBrowserState, requestBrowserProfileTrash, setSessionBrowserProfile } from "./profile-catalog.js";
import { BrowserProfileCleanupCoordinator } from "./profile-cleanup.js";
import { browserProfileStorageRoot } from "./profile-catalog-store.js";

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
