import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getLegacyAgentActivationStatus,
  legacyAgentActivationPaths,
  parseLegacyAgentActivationRecord,
  resetLegacyAgentActivationCacheForTests,
} from "./legacy-agent-activation.js";
import { WREN_AGENT_PROFILE_ID } from "./workspace-types.js";

const DEPLOYMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function withConfigHome(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-agent-activation-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  resetLegacyAgentActivationCacheForTests();
  try { fn(root); } finally {
    resetLegacyAgentActivationCacheForTests();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function provision(overrides: Record<string, unknown> = {}): ReturnType<typeof legacyAgentActivationPaths> {
  const paths = legacyAgentActivationPaths();
  fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.deploymentIdPath, `${DEPLOYMENT_ID}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.activationPath, `${JSON.stringify({
    schema_version: 1,
    deployment_id: DEPLOYMENT_ID,
    agent_profile_id: WREN_AGENT_PROFILE_ID,
    activation_revision: 1,
    activated_at: 1_000,
    ...overrides,
  })}\n`, { mode: 0o600 });
  return paths;
}

test("historical compatibility is inactive without deployment-local records", () => withConfigHome(() => {
  assert.deepEqual(getLegacyAgentActivationStatus(), {
    active: false,
    reason: "deployment_id_missing",
    activationRevision: null,
  });
}));

test("owner-private matching deployment records activate compatibility immutably for one process", () => withConfigHome(() => {
  const paths = provision();
  assert.deepEqual(getLegacyAgentActivationStatus(), {
    active: true,
    reason: "active",
    activationRevision: 1,
  });
  fs.unlinkSync(paths.activationPath);
  assert.equal(getLegacyAgentActivationStatus().active, true, "startup-captured status must not drift mid-process");
  resetLegacyAgentActivationCacheForTests();
  assert.deepEqual(getLegacyAgentActivationStatus(), {
    active: false,
    reason: "activation_missing",
    activationRevision: null,
  });
}));

test("unsafe, malformed, and deployment-mismatched records fail closed", () => withConfigHome(() => {
  const paths = provision({ deployment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  assert.equal(getLegacyAgentActivationStatus().reason, "deployment_mismatch");

  resetLegacyAgentActivationCacheForTests();
  fs.writeFileSync(paths.activationPath, "{}\n", { mode: 0o600 });
  assert.equal(getLegacyAgentActivationStatus().reason, "activation_malformed");

  if (process.platform !== "win32") {
    resetLegacyAgentActivationCacheForTests();
    fs.writeFileSync(paths.activationPath, `${JSON.stringify({
      schema_version: 1,
      deployment_id: DEPLOYMENT_ID,
      agent_profile_id: WREN_AGENT_PROFILE_ID,
      activation_revision: 1,
      activated_at: 1_000,
    })}\n`, { mode: 0o644 });
    fs.chmodSync(paths.activationPath, 0o644);
    assert.equal(getLegacyAgentActivationStatus().reason, "activation_unsafe");
  }
}));

test("activation parser accepts only the exact bounded schema", () => {
  const valid = JSON.stringify({
    schema_version: 1,
    deployment_id: DEPLOYMENT_ID,
    agent_profile_id: WREN_AGENT_PROFILE_ID,
    activation_revision: 1,
    activated_at: 1_000,
  });
  assert.ok(parseLegacyAgentActivationRecord(valid));
  assert.equal(parseLegacyAgentActivationRecord(valid.replace('"activation_revision":1', '"activation_revision":0')), null);
  assert.equal(parseLegacyAgentActivationRecord(valid.slice(0, -1) + ',"extra":true}'), null);
  assert.equal(parseLegacyAgentActivationRecord("not-json"), null);
});
