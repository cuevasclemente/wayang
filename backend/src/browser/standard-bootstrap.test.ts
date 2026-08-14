import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { bootstrapStandardBrowserProduction, createProductionStandardBrowserCatalog } from "./standard-bootstrap.js";
import type { InteractiveBrowserFactory } from "../pi-bridge.js";
import { close as closeStore, getStore, init as initStore } from "../db.js";

const protectedFactory: InteractiveBrowserFactory = async () => { throw new Error("synthetic protected factory"); };

test("disabled Standard production installs only a delegating factory and no lifecycle service", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-standard-bootstrap-disabled-"));
  let installedFactory: InteractiveBrowserFactory | null = null;
  let lifecycleInstalls = 0;
  const bootstrap = bootstrapStandardBrowserProduction({
    enabled: false,
    dataDir,
    protectedFactory,
    installFactory(factory) { installedFactory = factory; return () => { installedFactory = null; }; },
    installLifecycle() { lifecycleInstalls += 1; return () => undefined; },
  });
  assert.equal(bootstrap.service, null);
  assert.equal(installedFactory, bootstrap.factory);
  assert.equal(lifecycleInstalls, 0);
  assert.deepEqual(fs.readdirSync(dataDir), [], "disabled bootstrap touched browser storage");
  await bootstrap.close();
  assert.equal(installedFactory, null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("archived sessions cannot recover detached owner authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-standard-bootstrap-archived-"));
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  try {
    initStore({ browserProfilesEnabled: true });
    const profile = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Archived test",
      storage_source: { kind: "managed" as const, storage_key: "archived-test" },
      storage_identity_digest: "a".repeat(64),
      state: "active" as const,
      revision: 1,
      created_at: 1,
      updated_at: 1,
    };
    getStore().browserProfiles.push(profile);
    getStore().sessions.push({
      id: "archived-session",
      archived: true,
      project_id: "project",
      agent_profile_id: "agent",
      pending_agent_switch: null,
      legacy_capability_ineligible: false,
      legacy_private_session_quarantine: false,
      cwd: "/synthetic/project",
    } as any);
    assert.equal(createProductionStandardBrowserCatalog().ownerAuthority("archived-session", profile), null);
    getStore().sessions.length = 0;
    getStore().browserProfiles.length = 0;
  } finally {
    closeStore();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enabled Standard production composes the service without opening profile storage", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-standard-bootstrap-enabled-"));
  let lifecycleInstalls = 0;
  const bootstrap = bootstrapStandardBrowserProduction({
    enabled: true,
    dataDir,
    protectedFactory,
    backendFactory: () => { throw new Error("backend factory must remain lazy"); },
    installFactory: () => () => undefined,
    installLifecycle() { lifecycleInstalls += 1; return () => { lifecycleInstalls -= 1; }; },
  });
  assert.ok(bootstrap.service);
  assert.equal(lifecycleInstalls, 1);
  assert.deepEqual(fs.readdirSync(dataDir), [], "enabled composition opened profile storage before runtime use");
  await bootstrap.close();
  assert.equal(lifecycleInstalls, 0);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
