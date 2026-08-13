import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { close, getStore, init } from "../db.js";
import { STORE_SCHEMA_VERSION } from "../workspace-types.js";

let dataDir = "";

beforeEach(() => {
  close();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-migration-"));
  process.env.WAYANG_DATA_DIR = dataDir;
});

afterEach(() => {
  close();
  delete process.env.WAYANG_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function rewriteFreshStoreAsSchemaTwo(mutator?: (store: Record<string, unknown>) => void): void {
  init();
  close();
  const storePath = path.join(dataDir, "store.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;
  store.schema_version = 2;
  delete store.protectedAutomationJobs;
  delete store.protectedAutomationRuns;
  delete store.messagingEndpoints;
  delete store.messagingEvents;
  delete store.messagingTransactions;
  delete store.messagingDeliveries;
  mutator?.(store);
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

test("schema 2 migrates explicitly to current schema with empty inert authority and messaging arrays", () => {
  rewriteFreshStoreAsSchemaTwo();
  init();
  const store = getStore();
  assert.equal(store.schema_version, STORE_SCHEMA_VERSION);
  assert.equal(STORE_SCHEMA_VERSION, 5);
  assert.deepEqual(store.protectedAutomationJobs, []);
  assert.deepEqual(store.protectedAutomationRuns, []);
  assert.deepEqual(store.workspaceCapabilityAssociations, []);
  assert.deepEqual(store.workspaceCapabilityApprovalEvents, []);
  assert.deepEqual(store.messagingEndpoints, []);
  assert.deepEqual(store.messagingEvents, []);
  const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith("store.json.backup-v2-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.statSync(path.join(dataDir, backups[0]!)).mode & 0o777, 0o600);
});

test("schema 2 unknown automation-shaped fields are rejected instead of entering a legacy fallback", () => {
  rewriteFreshStoreAsSchemaTwo((store) => {
    store.protectedAutomationJobs = [];
  });
  assert.throws(() => init(), /Schema-2 Wayang store contains unsupported field protectedAutomationJobs/);
});

test("schema 2 cannot seed protected automation authority that did not exist in that schema", () => {
  rewriteFreshStoreAsSchemaTwo((store) => {
    (store.workspaceCapabilityAssociations as unknown[]).push({
      project_id: "forged-project",
      agent_profile_id: "forged-profile",
      capability_id: "wayang.protected-automation.v1",
      revision: 1,
      active: false,
      approved_at: 1,
      revoked_at: 2,
      updated_at: 2,
    });
  });
  assert.throws(() => init(), /cannot contain protected automation authority/);
});

test("fresh current-schema stores create no automation or messaging authority", () => {
  init();
  const store = getStore();
  assert.equal(store.schema_version, STORE_SCHEMA_VERSION);
  assert.deepEqual(store.protectedAutomationJobs, []);
  assert.deepEqual(store.protectedAutomationRuns, []);
  assert.equal(store.workspaceCapabilityAssociations.some((row) => row.capability_id === "wayang.protected-automation.v1"), false);
  assert.deepEqual(store.messagingEndpoints, []);
  assert.deepEqual(store.messagingEvents, []);
});
