import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES,
  ProtectedAutomationDownloadRegistry,
} from "./browser-downloads.js";
import { MAX_PROTECTED_AUTOMATION_INCOMING_FILES } from "./types.js";

function complete(
  registry: ProtectedAutomationDownloadRegistry,
  downloadsDir: string,
  guid: string,
  bytes: Buffer,
  filename = "export.csv",
): void {
  assert.equal(registry.begin({
    frameId: "synthetic-frame", guid, url: "https://allowed.example.test/export", suggestedFilename: filename,
  }), true);
  fs.writeFileSync(path.join(downloadsDir, guid), bytes, { mode: 0o600 });
  assert.equal(
    registry.progress({ guid, totalBytes: bytes.length, receivedBytes: bytes.length, state: "completed" }),
    false,
    "completed progress does not request Chromium cancellation",
  );
}

test("completed downloads receive one-use run-bound handles and materialize without overwrite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-download-"));
  try {
    const downloads = path.join(root, "downloads");
    const runRoot = path.join(root, "run");
    fs.mkdirSync(downloads);
    fs.mkdirSync(runRoot);
    const registry = new ProtectedAutomationDownloadRegistry(
      downloads, new Set(["https://allowed.example.test"]), "run-a", "generation-a",
    );
    complete(registry, downloads, "guid-a", Buffer.from("synthetic,export\n", "utf8"));
    const listed = registry.listCompleted();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sourceOrigin, "https://allowed.example.test");
    assert.equal("path" in listed[0], false, "browser-owned host paths are never returned");

    const result = registry.materialize(listed[0].handle, "received.csv", runRoot);
    assert.equal(result.name, "received.csv");
    assert.equal(result.sizeBytes, 17);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(fs.readFileSync(path.join(runRoot, "incoming", "received.csv"), "utf8"), "synthetic,export\n");
    assert.equal(fs.statSync(path.join(runRoot, "incoming", "received.csv")).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(downloads, "guid-a")), false, "successful materialization unlinks browser staging");
    assert.deepEqual(registry.listCompleted(), [], "successful materialization consumes the record and every handle");
    assert.throws(() => registry.materialize(listed[0].handle, "second.csv", runRoot), /unavailable/i);

    complete(registry, downloads, "guid-b", Buffer.from("second"));
    const replacement = registry.listCompleted()[0];
    assert.ok(replacement);
    fs.writeFileSync(path.join(runRoot, "incoming", "occupied.csv"), "existing", { mode: 0o600 });
    assert.throws(() => registry.materialize(replacement.handle, "occupied.csv", runRoot), /EEXIST|exist/i);
    assert.equal(fs.readFileSync(path.join(runRoot, "incoming", "occupied.csv"), "utf8"), "existing");
    assert.throws(() => registry.materialize(replacement.handle, "retry.csv", runRoot), /unavailable/i, "failed attempts also consume handles");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("downloads fail closed for foreign origins, symlinks, oversized files, traversal, and revocation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-download-denials-"));
  try {
    const downloads = path.join(root, "downloads");
    const runRoot = path.join(root, "run");
    fs.mkdirSync(downloads);
    fs.mkdirSync(runRoot);
    const registry = new ProtectedAutomationDownloadRegistry(
      downloads, new Set(["https://allowed.example.test"]), "run-a", "generation-a",
    );
    assert.equal(registry.begin({
      frameId: "frame", guid: "foreign", url: "https://foreign.example.test/export", suggestedFilename: "foreign.csv",
    }), false);

    assert.equal(registry.begin({
      frameId: "frame", guid: "linked", url: "https://allowed.example.test/export", suggestedFilename: "linked.csv",
    }), true);
    const external = path.join(root, "external");
    fs.writeFileSync(external, "external");
    fs.symlinkSync(external, path.join(downloads, "linked"));
    assert.equal(registry.progress({ guid: "linked", totalBytes: 8, receivedBytes: 8, state: "completed" }), false);
    assert.deepEqual(registry.listCompleted(), []);

    assert.equal(registry.begin({
      frameId: "frame", guid: "oversized", url: "https://allowed.example.test/export", suggestedFilename: "large.bin",
    }), true);
    fs.writeFileSync(path.join(downloads, "oversized"), "x");
    fs.truncateSync(path.join(downloads, "oversized"), MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES + 1);
    assert.equal(registry.progress({
      guid: "oversized", totalBytes: MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES + 1,
      receivedBytes: MAX_PROTECTED_AUTOMATION_DOWNLOAD_BYTES + 1, state: "completed",
    }), true, "oversized progress requests Chromium cancellation");
    assert.deepEqual(registry.listCompleted(), []);

    assert.equal(registry.begin({
      frameId: "frame", guid: "cancelled", url: "https://allowed.example.test/export", suggestedFilename: "cancelled.bin",
    }), true);
    fs.writeFileSync(path.join(downloads, "cancelled"), "partial", { mode: 0o600 });
    assert.equal(registry.progress({ guid: "cancelled", totalBytes: 7, receivedBytes: 7, state: "canceled" }), false,
      "browser cancellation does not request a redundant cancellation");
    assert.equal(fs.existsSync(path.join(downloads, "cancelled")), false);

    complete(registry, downloads, "safe", Buffer.from("safe"));
    const handle = registry.listCompleted()[0].handle;
    assert.throws(() => registry.materialize(handle, "../escape", runRoot), /name is invalid/i);
    assert.equal(fs.existsSync(path.join(root, "escape")), false);
    registry.revoke();
    assert.deepEqual(registry.listCompleted(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("incoming materializations reject hardlinks and enforce the aggregate count bound", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-download-quota-"));
  try {
    const downloads = path.join(root, "downloads");
    const runRoot = path.join(root, "run");
    fs.mkdirSync(downloads);
    fs.mkdirSync(runRoot);
    const registry = new ProtectedAutomationDownloadRegistry(
      downloads, new Set(["https://allowed.example.test"]), "run-a", "generation-a",
    );
    const hardlinkSource = path.join(root, "hardlink-source");
    fs.writeFileSync(hardlinkSource, "linked");
    assert.equal(registry.begin({ frameId: "frame", guid: "hardlink", url: "https://allowed.example.test/export", suggestedFilename: "linked" }), true);
    fs.linkSync(hardlinkSource, path.join(downloads, "hardlink"));
    assert.equal(registry.progress({ guid: "hardlink", totalBytes: 6, receivedBytes: 6, state: "completed" }), false);
    assert.deepEqual(registry.listCompleted(), []);

    complete(registry, downloads, "bounded", Buffer.from("bounded"));
    const handle = registry.listCompleted()[0].handle;
    const incoming = path.join(runRoot, "incoming");
    fs.mkdirSync(incoming);
    for (let index = 0; index < MAX_PROTECTED_AUTOMATION_INCOMING_FILES; index += 1) {
      fs.writeFileSync(path.join(incoming, `existing-${index}`), "x", { mode: 0o600 });
    }
    assert.throws(() => registry.materialize(handle, "one-too-many", runRoot), /count quota/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("constructor deletes crash-left regular GUID staging and rejects unsafe staging entries", () => {
  const regularRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-download-reconcile-"));
  try {
    const downloads = path.join(regularRoot, "downloads");
    fs.mkdirSync(downloads);
    fs.writeFileSync(path.join(downloads, "prior_guid-1"), "crash-left", { mode: 0o600 });
    assert.doesNotThrow(() => new ProtectedAutomationDownloadRegistry(
      downloads, new Set(["https://allowed.example.test"]), "run-a", "generation-a",
    ));
    assert.deepEqual(fs.readdirSync(downloads), [], "constructor removes prior regular GUID staging bytes");
  } finally {
    fs.rmSync(regularRoot, { recursive: true, force: true });
  }

  const rejectEntry = (kind: "symlink" | "special" | "unsafe-name"): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wayang-automation-download-${kind}-`));
    try {
      const downloads = path.join(root, "downloads");
      fs.mkdirSync(downloads);
      if (kind === "symlink") {
        const external = path.join(root, "external");
        fs.writeFileSync(external, "external", { mode: 0o600 });
        fs.symlinkSync(external, path.join(downloads, "safe-guid"));
      } else if (kind === "special") {
        fs.mkdirSync(path.join(downloads, "safe-guid"));
      } else {
        fs.writeFileSync(path.join(downloads, "unsafe.name"), "staging", { mode: 0o600 });
      }
      assert.throws(() => new ProtectedAutomationDownloadRegistry(
        downloads, new Set(["https://allowed.example.test"]), "run-a", "generation-a",
      ), /staging contains an unsafe entry/i, `${kind} staging is rejected`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  rejectEntry("symlink");
  rejectEntry("special");
  rejectEntry("unsafe-name");
});

test("preparation registries never issue run materialization handles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-prepare-download-"));
  try {
    const downloads = path.join(root, "downloads");
    fs.mkdirSync(downloads);
    const registry = new ProtectedAutomationDownloadRegistry(
      downloads, new Set(["https://allowed.example.test"]), null, "prepare-generation",
    );
    complete(registry, downloads, "prepare-guid", Buffer.from("not run-bound"));
    assert.deepEqual(registry.listCompleted(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
