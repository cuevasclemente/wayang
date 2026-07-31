import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
  capabilityApprovalPaths,
  diagnoseCapabilityApprovalMetadata,
  provisionCapabilityApprovalState,
} from "../lib/capability-approval.mjs";

const roots = [];
const setupScript = fileURLToPath(new URL("../setup-capability-approval.mjs", import.meta.url));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ pinContents = "opaque-existing-pin-material\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wayang-capability-approval-"));
  roots.push(root);
  const configHome = join(root, "config");
  const pinDirectory = join(configHome, "pi");
  const dataDir = join(root, "data");
  mkdirSync(pinDirectory, { recursive: true, mode: 0o700 });
  chmodSync(configHome, 0o700);
  chmodSync(pinDirectory, 0o700);
  writeFileSync(join(pinDirectory, "command-guard-identity-pin"), pinContents, { mode: 0o600 });
  const options = {
    env: { XDG_CONFIG_HOME: configHome, WAYANG_DATA_DIR: dataDir },
    home: root,
  };
  return { root, configHome, dataDir, options, paths: capabilityApprovalPaths(options) };
}

test("provisions owner-only cooldown state without inspecting opaque PIN contents", () => {
  const synthetic = fixture();
  const result = provisionCapabilityApprovalState(synthetic.options);
  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(readFileSync(synthetic.paths.statePath, "utf8")), {
    version: 1,
    attemptCount: 0,
    lastAttemptAtMs: 0,
    reservation: null,
  });
  assert.equal(lstatSync(synthetic.dataDir).mode & 0o7777, 0o700);
  assert.equal(lstatSync(synthetic.paths.stateDirectory).mode & 0o7777, 0o700);
  const stateMetadata = lstatSync(synthetic.paths.statePath);
  assert.equal(stateMetadata.mode & 0o7777, 0o600);
  assert.equal(stateMetadata.nlink, 1);
});

test("CLI reports only generic created/idempotent outcomes", () => {
  const synthetic = fixture({ pinContents: "synthetic-pin-that-must-not-appear\n" });
  const env = {
    PATH: process.env.PATH || "",
    HOME: synthetic.root,
    XDG_CONFIG_HOME: synthetic.configHome,
    WAYANG_DATA_DIR: synthetic.dataDir,
  };
  const created = execFileSync(process.execPath, [setupScript], { encoding: "utf8", env });
  assert.match(created, /Provisioned private workspace capability approval cooldown state/);
  assert.doesNotMatch(created, /synthetic-pin-that-must-not-appear/);
  assert.doesNotMatch(created, new RegExp(synthetic.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const idempotent = execFileSync(process.execPath, [setupScript], { encoding: "utf8", env });
  assert.match(idempotent, /already safely provisioned; left unchanged/);
  assert.doesNotMatch(idempotent, /synthetic-pin-that-must-not-appear/);
});

test("safe rerun preserves valid live cooldown state exactly", () => {
  const synthetic = fixture();
  provisionCapabilityApprovalState(synthetic.options);
  const liveState = {
    version: 1,
    attemptCount: 7,
    lastAttemptAtMs: 12345,
    reservation: {
      realm: "wayang.workspace-capabilities.v1",
      reservationId: "reservation",
      requestId: "request",
      operationDigest: "a".repeat(64),
      expiresAt: 9999999999999,
    },
  };
  const encoded = `${JSON.stringify(liveState)}\n`;
  writeFileSync(synthetic.paths.statePath, encoded, { mode: 0o600 });
  const result = provisionCapabilityApprovalState(synthetic.options);
  assert.equal(result.created, false);
  assert.equal(readFileSync(synthetic.paths.statePath, "utf8"), encoded);
});

test("missing or symlinked PIN refuses without creating cooldown authority", () => {
  const missing = fixture();
  rmSync(join(missing.configHome, "pi", "command-guard-identity-pin"));
  assert.throws(() => provisionCapabilityApprovalState(missing.options), /PIN metadata is unavailable or unsafe/);
  assert.throws(() => lstatSync(missing.paths.statePath));

  const linked = fixture();
  const expectedPin = join(linked.configHome, "pi", "command-guard-identity-pin");
  const alternatePin = join(linked.configHome, "pi", "alternate-pin");
  rmSync(expectedPin);
  writeFileSync(alternatePin, "synthetic\n", { mode: 0o600 });
  symlinkSync(alternatePin, expectedPin);
  assert.throws(() => provisionCapabilityApprovalState(linked.options), /PIN metadata is unavailable or unsafe/);
  assert.throws(() => lstatSync(linked.paths.statePath));
});

test("symlinked data directory is refused instead of followed", () => {
  const synthetic = fixture();
  const alternateData = join(synthetic.root, "alternate-data");
  mkdirSync(alternateData, { mode: 0o700 });
  symlinkSync(alternateData, synthetic.dataDir);
  assert.throws(() => provisionCapabilityApprovalState(synthetic.options), /unsafe capability approval directory/);
  assert.throws(() => lstatSync(join(alternateData, "workspace-capability-approval")));
});

test("hard-linked PIN authority is refused without creating state", () => {
  const synthetic = fixture();
  const pinPath = join(synthetic.configHome, "pi", "command-guard-identity-pin");
  linkSync(pinPath, join(synthetic.configHome, "pi", "second-pin-link"));
  assert.throws(() => provisionCapabilityApprovalState(synthetic.options), /more than one hard link/);
  assert.throws(() => lstatSync(synthetic.paths.statePath));
});

test("unsafe or malformed existing state is preserved and refused", () => {
  const unsafe = fixture();
  mkdirSync(unsafe.paths.stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(unsafe.paths.statePath, "do-not-replace\n", { mode: 0o644 });
  assert.throws(() => provisionCapabilityApprovalState(unsafe.options), /cooldown state is unsafe/);
  assert.equal(readFileSync(unsafe.paths.statePath, "utf8"), "do-not-replace\n");

  const malformed = fixture();
  mkdirSync(malformed.paths.stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(malformed.paths.statePath, "{}\n", { mode: 0o600 });
  assert.throws(() => provisionCapabilityApprovalState(malformed.options), /invalid schema/);
  assert.equal(readFileSync(malformed.paths.statePath, "utf8"), "{}\n");

  const linked = fixture();
  mkdirSync(linked.paths.stateDirectory, { recursive: true, mode: 0o700 });
  const alternate = join(linked.paths.stateDirectory, "alternate-state.json");
  const initial = `${JSON.stringify({ version: 1, attemptCount: 0, lastAttemptAtMs: 0, reservation: null })}\n`;
  writeFileSync(alternate, initial, { mode: 0o600 });
  symlinkSync(alternate, linked.paths.statePath);
  assert.throws(() => provisionCapabilityApprovalState(linked.options), /cooldown state is unsafe/);
  assert.equal(readFileSync(alternate, "utf8"), initial);
});

test("doctor diagnostics inspect approval authority metadata only", () => {
  const synthetic = fixture();
  let diagnostics = diagnoseCapabilityApprovalMetadata(synthetic.options);
  assert.equal(diagnostics.pin.ok, true);
  assert.equal(diagnostics.state.ok, false);

  provisionCapabilityApprovalState(synthetic.options);
  diagnostics = diagnoseCapabilityApprovalMetadata(synthetic.options);
  assert.equal(diagnostics.pin.ok, true);
  assert.equal(diagnostics.state.ok, true);

  chmodSync(synthetic.paths.statePath, 0o640);
  diagnostics = diagnoseCapabilityApprovalMetadata(synthetic.options);
  assert.equal(diagnostics.state.ok, false);
  assert.match(diagnostics.state.reason, /0600/);
});

test("configured capability data directory must be absolute", () => {
  assert.throws(
    () => capabilityApprovalPaths({ env: { WAYANG_DATA_DIR: "relative-data" }, home: "/synthetic-home" }),
    /absolute path/,
  );
});
