import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  historicalAgentActivationPaths,
  historicalAgentActivationStatus,
  provisionHistoricalAgentActivation,
} from "../lib/historical-agent-activation.mjs";

const PIN = "12345678";
const DEPLOYMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "wayang-historical-activation-script-"));
  const configHome = join(root, "config");
  const paths = historicalAgentActivationPaths({ configHome });
  mkdirSync(dirname(paths.pinPath), { recursive: true, mode: 0o700 });
  writeFileSync(paths.pinPath, `${PIN}\n`, { mode: 0o600 });
  try { run({ root, configHome, paths }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("normal status is inactive and provisioning requires the hidden PIN value", () => fixture(({ configHome }) => {
  assert.equal(historicalAgentActivationStatus({ configHome }).active, false);
  assert.throws(
    () => provisionHistoricalAgentActivation({ configHome, pin: "00000000", deploymentId: DEPLOYMENT_ID, now: 1_000 }),
    /verification failed/,
  );
  assert.equal(historicalAgentActivationStatus({ configHome }).active, false);
}));

test("provisioning creates one owner-private deployment-bound record and is idempotent", () => fixture(({ configHome, paths }) => {
  const created = provisionHistoricalAgentActivation({ configHome, pin: PIN, deploymentId: DEPLOYMENT_ID, now: 1_000 });
  assert.equal(created.created, true);
  assert.equal(created.deploymentCreated, true);
  const status = historicalAgentActivationStatus({ configHome });
  assert.equal(status.active, true);
  assert.equal(status.deploymentId, DEPLOYMENT_ID);
  assert.equal(status.activationRevision, 1);
  if (process.platform !== "win32") {
    assert.equal(statSync(paths.deploymentIdPath).mode & 0o777, 0o600);
    assert.equal(statSync(paths.activationPath).mode & 0o777, 0o600);
  }

  const before = readFileSync(paths.activationPath, "utf8");
  const repeated = provisionHistoricalAgentActivation({ configHome, pin: PIN, now: 2_000 });
  assert.equal(repeated.created, false);
  assert.equal(readFileSync(paths.activationPath, "utf8"), before);
}));

test("symlinked activation directories are refused before publication", () => fixture(({ root, configHome, paths }) => {
  const target = join(root, "elsewhere");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, paths.wayangConfigDir, "dir");
  assert.throws(
    () => provisionHistoricalAgentActivation({ configHome, pin: PIN, deploymentId: DEPLOYMENT_ID, now: 1_000 }),
    /activation directory/,
  );
  assert.throws(() => readFileSync(join(target, "deployment-id")), /ENOENT/);
}));

test("unsafe or deployment-mismatched existing records are never replaced", () => fixture(({ configHome, paths }) => {
  provisionHistoricalAgentActivation({ configHome, pin: PIN, deploymentId: DEPLOYMENT_ID, now: 1_000 });
  writeFileSync(paths.activationPath, `${JSON.stringify({
    schema_version: 1,
    deployment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    agent_profile_id: "00000000-0000-4000-8000-000000000001",
    activation_revision: 1,
    activated_at: 1_000,
  })}\n`, { mode: 0o600 });
  assert.throws(() => provisionHistoricalAgentActivation({ configHome, pin: PIN }), /another deployment/);

  if (process.platform !== "win32") {
    chmodSync(paths.activationPath, 0o644);
    assert.match(historicalAgentActivationStatus({ configHome }).reason, /mode-0600/);
    assert.throws(() => provisionHistoricalAgentActivation({ configHome, pin: PIN }), /mode-0600/);
  }
}));
