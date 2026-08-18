import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { close, getStore, init } from "../db.js";

function temporaryDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-schema-gate-"));
  process.env.WAYANG_DATA_DIR = dataDir;
  return dataDir;
}

function cleanup(dataDir: string): void {
  close();
  delete process.env.WAYANG_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
}

test("gate-off startup publishes schema 7 with empty browser authority and never inventories expected roots", () => {
  const dataDir = temporaryDataDir();
  try {
    const expectedRoot = path.join(dataDir, "browser-workbench", "profiles", "shared");
    fs.mkdirSync(expectedRoot, { recursive: true });
    fs.writeFileSync(path.join(expectedRoot, "CANARY"), "SYNTHETIC\n");
    init();
    assert.deepEqual(getStore().browserProfiles, []);
    close();
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "store.json"), "utf8"));
    assert.equal(persisted.schema_version, 7);
    assert.deepEqual(persisted.browserProfiles, []);
    assert.deepEqual(persisted.projectBrowserDefaults, []);
    assert.deepEqual(persisted.sessionBrowserStates, []);
    assert.deepEqual(persisted.browserCleanups, []);
    assert.deepEqual(persisted.transcriptRecoveryJournal, []);
    assert.equal(fs.readFileSync(path.join(expectedRoot, "CANARY"), "utf8"), "SYNTHETIC\n");
  } finally { cleanup(dataDir); }
});

test("gate-off startup refuses an existing legacy schema-6 browser-authority store without rewriting it", () => {
  const dataDir = temporaryDataDir();
  try {
    init({ browserProfilesEnabled: true });
    close();
    const storePath = path.join(dataDir, "store.json");
    const legacy = JSON.parse(fs.readFileSync(storePath, "utf8"));
    legacy.schema_version = 6;
    delete legacy.transcriptRecoveryJournal;
    fs.writeFileSync(storePath, JSON.stringify(legacy), { mode: 0o600 });
    const bytes = fs.readFileSync(storePath);
    assert.throws(() => init(), /schema 6 requires WAYANG_STANDARD_BROWSER_PROFILE_HOSTS=1/);
    assert.deepEqual(fs.readFileSync(storePath), bytes);
  } finally { cleanup(dataDir); }
});

test("gate-off startup refuses schema 7 with nonempty browser persistence authority", () => {
  const dataDir = temporaryDataDir();
  try {
    init({ browserProfilesEnabled: true });
    close();
    const storePath = path.join(dataDir, "store.json");
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    raw.browserProfiles = [{ id: "forbidden-browser-authority" }];
    fs.writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });
    const bytes = fs.readFileSync(storePath);
    assert.throws(() => init(), /schema 7 browser persistence requires WAYANG_STANDARD_BROWSER_PROFILE_HOSTS=1/);
    assert.deepEqual(fs.readFileSync(storePath), bytes);
  } finally { cleanup(dataDir); }
});
