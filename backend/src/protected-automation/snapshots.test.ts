import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { close, getStore } from "../db.js";
import type { ProtectedAutomationJobRow } from "./types.js";
import {
  PROTECTED_AUTOMATION_SNAPSHOT_LIMITS,
  captureProtectedAutomationSnapshot,
  discardProtectedAutomationSnapshot,
  finalizeProtectedAutomationSnapshotCapture,
  reconcileProtectedAutomationSnapshots,
  stageProtectedAutomationSnapshotJobPurge,
  verifyProtectedAutomationSnapshot,
} from "./snapshots.js";

let fixtureRoot = "";
let dataRoot = "";
let projectRoot = "";

const OWNER = Object.freeze({
  projectId: "synthetic-project-id",
  agentProfileId: "synthetic-profile-id",
  jobId: "synthetic-job-id",
});

beforeEach(() => {
  close();
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-snapshot-test-"));
  dataRoot = path.join(fixtureRoot, "private-data");
  projectRoot = path.join(fixtureRoot, "project");
  fs.mkdirSync(projectRoot, { mode: 0o700 });
  process.env.WAYANG_DATA_DIR = dataRoot;
});

afterEach(() => {
  try { getStore().protectedAutomationJobs.length = 0; } catch { /* store may not have initialized */ }
  close();
  delete process.env.WAYANG_DATA_DIR;
  const unlockSyntheticTree = (target: string): void => {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(target); } catch { return; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    try { fs.chmodSync(target, 0o700); } catch { return; }
    for (const name of fs.readdirSync(target)) unlockSyntheticTree(path.join(target, name));
  };
  unlockSyntheticTree(fixtureRoot);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeSource(relativePath: string, content: string | Buffer): void {
  const target = path.join(projectRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content);
}

function capture(revision = 1, sourceDirectory = "automation", entrypoint = "job.mjs") {
  return captureProtectedAutomationSnapshot({
    projectRoot,
    ...OWNER,
    revision,
    sourceDirectory,
    entrypoint,
  });
}

function revisionRoot(revision = 1): string {
  const jobsRoot = path.join(dataRoot, "protected-automation", "jobs");
  const opaqueJobs = fs.readdirSync(jobsRoot);
  assert.equal(opaqueJobs.length, 1);
  assert.match(opaqueJobs[0]!, /^[a-f0-9]{64}$/u);
  return path.join(jobsRoot, opaqueJobs[0]!, "revisions", String(revision));
}

function verify(revision: number, manifestSha256: string) {
  return verifyProtectedAutomationSnapshot({ ...OWNER, revision, expectedManifestSha256: manifestSha256 });
}

function setDurableJob(jobId: string, revision: number, deletedAt: number | null = null, sourceRevision = revision): void {
  getStore().protectedAutomationJobs.push({
    id: jobId,
    project_id: OWNER.projectId,
    agent_profile_id: OWNER.agentProfileId,
    revision,
    source_revision: sourceRevision,
    deleted_at: deletedAt,
  } as unknown as ProtectedAutomationJobRow);
}

function metadata(captureResult: ReturnType<typeof captureProtectedAutomationSnapshot>) {
  const { created: _created, allocatedBytes: _allocatedBytes, ...snapshot } = captureResult;
  return snapshot;
}

test("captures a stable owner-bound sorted manifest without exposing a private path", () => {
  writeSource("automation/lib/helper.mjs", "export const answer = 42;\n");
  writeSource("automation/job.mjs", "import './lib/helper.mjs';\n");
  writeSource("outside.txt", "must not be captured\n");

  const captured = capture();
  assert.deepEqual(captured, {
    revision: 1,
    entrypoint: "job.mjs",
    manifestSha256: captured.manifestSha256,
    entrypointSha256: captured.entrypointSha256,
    fileCount: 2,
    directoryCount: 1,
    totalBytes: 53,
    created: true,
    allocatedBytes: captured.allocatedBytes,
  });
  assert.ok(captured.allocatedBytes > captured.totalBytes);
  assert.match(captured.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.match(captured.entrypointSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(captured).includes(dataRoot), false);
  assert.equal(JSON.stringify(captured).includes(projectRoot), false);

  const root = revisionRoot();
  assert.equal(fs.statSync(root).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.join(root, "manifest.json")).mode & 0o777, 0o400);
  assert.equal(fs.statSync(path.join(root, "source", "job.mjs")).mode & 0o777, 0o400);
  assert.equal(fs.existsSync(path.join(root, "source", "outside.txt")), false);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as {
    projectId: string;
    agentProfileId: string;
    jobId: string;
    revision: number;
    entrypoint: string;
    directories: string[];
    files: Array<{ path: string }>;
  };
  assert.equal(manifest.projectId, OWNER.projectId);
  assert.equal(manifest.agentProfileId, OWNER.agentProfileId);
  assert.equal(manifest.jobId, OWNER.jobId);
  assert.equal(manifest.revision, 1);
  assert.equal(manifest.entrypoint, "job.mjs");
  assert.deepEqual(manifest.directories, ["lib"]);
  assert.deepEqual(manifest.files.map((file) => file.path), ["job.mjs", "lib/helper.mjs"]);
  assert.deepEqual(verify(1, captured.manifestSha256), metadata(captured));
});

test("exact recapture is idempotent while different content cannot overwrite an immutable revision", () => {
  writeSource("automation/job.mjs", "console.log('first');\n");
  const captured = capture();
  const reused = capture();
  assert.equal(reused.created, false);
  assert.deepEqual(metadata(reused), metadata(captured));

  writeSource("automation/job.mjs", "console.log('second');\n");
  assert.deepEqual(verify(1, captured.manifestSha256), metadata(captured));
  assert.equal(fs.readFileSync(path.join(revisionRoot(), "source", "job.mjs"), "utf8"), "console.log('first');\n");
  assert.throws(() => capture(), /already exists with different exact content/);
  assert.deepEqual(verify(1, captured.manifestSha256), metadata(captured));
});

test("verification detects captured-byte, manifest, and added-entry tampering", () => {
  writeSource("automation/job.mjs", "export default 1;\n");
  const first = capture(1);
  const firstRoot = revisionRoot(1);
  const capturedFile = path.join(firstRoot, "source", "job.mjs");
  fs.chmodSync(capturedFile, 0o600);
  fs.writeFileSync(capturedFile, "export default 2;\n");
  fs.chmodSync(capturedFile, 0o400);
  assert.throws(() => verify(1, first.manifestSha256), /does not match its immutable manifest/);

  writeSource("automation/job.mjs", "export default 3;\n");
  const second = capture(2);
  const secondManifest = path.join(revisionRoot(2), "manifest.json");
  const secondManifestBytes = fs.readFileSync(secondManifest);
  fs.chmodSync(secondManifest, 0o600);
  fs.appendFileSync(secondManifest, " ");
  fs.chmodSync(secondManifest, 0o400);
  assert.throws(
    () => verify(2, second.manifestSha256),
    /manifest hash mismatch|manifest is not canonically encoded/,
  );
  fs.chmodSync(secondManifest, 0o600);
  fs.writeFileSync(secondManifest, secondManifestBytes);
  fs.chmodSync(secondManifest, 0o400);

  writeSource("automation/job.mjs", "export default 4;\n");
  const third = capture(3);
  const thirdSource = path.join(revisionRoot(3), "source");
  fs.chmodSync(thirdSource, 0o700);
  fs.writeFileSync(path.join(thirdSource, "injected.mjs"), "synthetic\n", { mode: 0o400 });
  fs.chmodSync(thirdSource, 0o500);
  assert.throws(() => verify(3, third.manifestSha256), /does not match its immutable manifest/);
});

test("verification requires the exact owner, revision, and store-held manifest hash", () => {
  writeSource("automation/job.mjs", "export {};\n");
  const captured = capture();
  assert.throws(
    () => verifyProtectedAutomationSnapshot({
      ...OWNER,
      jobId: "different-job-id",
      revision: 1,
      expectedManifestSha256: captured.manifestSha256,
    }),
    /Private snapshot storage is unsafe/,
  );
  assert.throws(() => verify(1, "0".repeat(64)), /manifest hash mismatch/);
  assert.throws(
    () => verifyProtectedAutomationSnapshot({ ...OWNER, revision: 2, expectedManifestSha256: captured.manifestSha256 }),
    /removed or replaced/,
  );
});

test("rejects non-canonical, absolute, escaping, and out-of-subtree entrypoints", () => {
  writeSource("automation/job.mjs", "export {};\n");
  writeSource("outside.mjs", "export {};\n");
  for (const sourceDirectory of ["", "/automation", "automation/../automation", "automation/", "automation\\nested"]) {
    assert.throws(
      () => captureProtectedAutomationSnapshot({ ...OWNER, projectRoot, revision: 1, sourceDirectory, entrypoint: "job.mjs" }),
      /canonical project-relative path/,
    );
  }
  for (const entrypoint of ["", "/job.mjs", "../outside.mjs", "./job.mjs", "nested/../../outside.mjs", "job\\mjs"]) {
    assert.throws(
      () => captureProtectedAutomationSnapshot({ ...OWNER, projectRoot, revision: 1, sourceDirectory: "automation", entrypoint }),
      /canonical project-relative path/,
    );
  }
  assert.throws(() => capture(1, "automation", "outside.mjs"), /must be one regular file inside/);
});

test("rejects symlinks, hardlinks, and non-regular source entries", async (t) => {
  writeSource("automation/job.mjs", "export {};\n");
  fs.symlinkSync(path.join(projectRoot, "outside"), path.join(projectRoot, "automation", "linked-dir"));
  assert.throws(() => capture(), /symbolic links/);
  fs.unlinkSync(path.join(projectRoot, "automation", "linked-dir"));

  fs.symlinkSync(path.join(projectRoot, "outside.mjs"), path.join(projectRoot, "automation", "linked-file.mjs"));
  assert.throws(() => capture(), /symbolic links/);
  fs.unlinkSync(path.join(projectRoot, "automation", "linked-file.mjs"));

  fs.linkSync(path.join(projectRoot, "automation", "job.mjs"), path.join(projectRoot, "automation", "hardlink.mjs"));
  assert.throws(() => capture(), /hardlinked files/);
  fs.unlinkSync(path.join(projectRoot, "automation", "hardlink.mjs"));

  if (process.platform === "win32") {
    t.diagnostic("Unix sockets are unavailable on Windows");
    return;
  }
  const socketPath = path.join(projectRoot, "automation", "local.sock");
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    assert.throws(() => capture(), /only regular files and directories/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rejects source trees that overlap private Wayang data", () => {
  const nestedDataRoot = path.join(projectRoot, "automation", "private-wayang-data");
  process.env.WAYANG_DATA_DIR = nestedDataRoot;
  writeSource("automation/job.mjs", "export {};\n");
  assert.throws(() => capture(), /must not overlap private Wayang data/);
});

test("rejects documented secret-bearing names before capture", () => {
  const forbidden = [
    "automation/.env",
    "automation/.env.backup",
    "automation/.pi/settings.json",
    "automation/auth.json",
    "automation/.npmrc",
  ];
  for (const [index, secretPath] of forbidden.entries()) {
    fs.rmSync(path.join(projectRoot, "automation"), { recursive: true, force: true });
    writeSource("automation/job.mjs", "export {};\n");
    writeSource(secretPath, "synthetic secret that must never be captured\n");
    assert.throws(() => capture(index + 1), /forbidden secret-bearing path/);
    assert.equal(fs.existsSync(path.join(dataRoot, "protected-automation", "jobs")) &&
      fs.readdirSync(path.join(dataRoot, "protected-automation", "jobs")).some((job) =>
        fs.existsSync(path.join(dataRoot, "protected-automation", "jobs", job, "revisions", String(index + 1)))), false);
  }
});

test("enforces file-count, per-file, and total source bounds without publishing a revision", () => {
  writeSource(
    "automation/job.mjs",
    Buffer.alloc(PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes + 1, 0x61),
  );
  assert.throws(() => capture(), /per-file byte bound/);

  fs.rmSync(path.join(projectRoot, "automation"), { recursive: true, force: true });
  writeSource("automation/job.mjs", "export {};\n");
  for (let index = 1; index <= PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFiles; index += 1) {
    writeSource(`automation/file-${String(index).padStart(4, "0")}.txt`, "x");
  }
  assert.throws(() => capture(2), /file count bound/);

  fs.rmSync(path.join(projectRoot, "automation"), { recursive: true, force: true });
  const chunkBytes = PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes;
  for (let index = 0; index <= Math.floor(PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxTotalBytes / chunkBytes); index += 1) {
    writeSource(`automation/${index === 0 ? "job.mjs" : `chunk-${index}.bin`}`, Buffer.alloc(chunkBytes, index));
  }
  assert.throws(() => capture(3), /total byte bound/);
});

test("discard removes only its newly-created verified revision and preserves idempotent or other revisions", () => {
  writeSource("automation/job.mjs", "export {};\n");
  const first = capture(1);
  const second = capture(2);
  const reused = capture(1);
  assert.equal(reused.created, false);
  assert.equal(discardProtectedAutomationSnapshot({
    ...OWNER,
    revision: 1,
    expectedManifestSha256: reused.manifestSha256,
    capture: reused,
  }), false);
  assert.equal(discardProtectedAutomationSnapshot({
    ...OWNER,
    revision: 2,
    expectedManifestSha256: second.manifestSha256,
    capture: second,
  }), true);
  assert.deepEqual(verify(1, first.manifestSha256), metadata(first));
  assert.equal(fs.existsSync(revisionRoot(2)), false);
});

test("reconciliation removes an inactive crash temp while skipping an active published receipt", () => {
  writeSource("automation/job.mjs", "export {};\n");
  const active = capture(1);
  const activeRoot = revisionRoot(1);
  const revisionsRoot = path.dirname(activeRoot);
  const crashTemp = path.join(revisionsRoot, ".2.tmp-00000000-0000-4000-8000-000000000001");
  fs.mkdirSync(path.join(crashTemp, "source"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(crashTemp, "source", "partial.mjs"), "partial\n", { mode: 0o600 });

  reconcileProtectedAutomationSnapshots();
  assert.equal(fs.existsSync(crashTemp), false);
  assert.equal(fs.existsSync(activeRoot), true);
  assert.equal(active.created, true);
});

test("reconciliation restores a pre-commit staged purge or removes it after durable row deletion", () => {
  writeSource("automation/job.mjs", "export {};\n");
  const captured = capture(1);
  finalizeProtectedAutomationSnapshotCapture(captured);
  setDurableJob(OWNER.jobId, 1);
  stageProtectedAutomationSnapshotJobPurge(OWNER);
  reconcileProtectedAutomationSnapshots();
  assert.deepEqual(verify(1, captured.manifestSha256), metadata(captured));

  stageProtectedAutomationSnapshotJobPurge(OWNER);
  getStore().protectedAutomationJobs.length = 0;
  reconcileProtectedAutomationSnapshots();
  assert.equal(fs.existsSync(path.join(dataRoot, "protected-automation")), false);
});

test("reconciliation removes a verified published revision for a missing durable job", () => {
  writeSource("automation/job.mjs", "export {};\n");
  const orphan = capture(1);
  const orphanRoot = revisionRoot(1);
  finalizeProtectedAutomationSnapshotCapture(orphan);

  reconcileProtectedAutomationSnapshots();
  assert.equal(fs.existsSync(orphanRoot), false);
  assert.equal(fs.existsSync(path.join(dataRoot, "protected-automation")), false);
});

test("reconciliation removes only revisions newer than the durable source revision", () => {
  writeSource("automation/job.mjs", "export {};\n");
  const first = capture(1);
  const second = capture(2);
  const future = capture(3);
  const firstRoot = revisionRoot(1);
  const secondRoot = revisionRoot(2);
  const futureRoot = revisionRoot(3);
  setDurableJob(OWNER.jobId, 2);
  for (const snapshot of [first, second, future]) finalizeProtectedAutomationSnapshotCapture(snapshot);

  reconcileProtectedAutomationSnapshots();
  assert.equal(fs.existsSync(firstRoot), true);
  assert.equal(fs.existsSync(secondRoot), true);
  assert.equal(fs.existsSync(futureRoot), false);
});

test("reconciliation retains current and historical revisions for a tombstoned durable job", () => {
  writeSource("automation/job.mjs", "export {};\n");
  const snapshots = [capture(1), capture(2), capture(3)];
  const roots = snapshots.map((snapshot) => revisionRoot(snapshot.revision));
  setDurableJob(OWNER.jobId, 4, Date.now(), 3);
  for (const snapshot of snapshots) finalizeProtectedAutomationSnapshotCapture(snapshot);

  reconcileProtectedAutomationSnapshots();
  assert.ok(roots.every((root) => fs.existsSync(root)));
});

test("many zero-byte source files consume nonzero allocated quota", () => {
  writeSource("automation/job.mjs", Buffer.alloc(0));
  for (let index = 1; index < PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFiles; index += 1) {
    writeSource(`automation/empty-${String(index).padStart(4, "0")}.txt`, Buffer.alloc(0));
  }
  const captured = capture(1);
  assert.equal(captured.totalBytes, 0);
  assert.ok(captured.allocatedBytes > 0);
  assert.ok(captured.allocatedBytes >= fs.statSync(path.join(revisionRoot(1), "manifest.json")).size);
});

test("fails closed on malformed private metadata before another capture", () => {
  writeSource("automation/job.mjs", "export {};\n");
  capture(1);
  const manifestPath = path.join(revisionRoot(1), "manifest.json");
  const malformed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  malformed.unexpected = true;
  fs.chmodSync(manifestPath, 0o600);
  fs.writeFileSync(manifestPath, `${JSON.stringify(malformed)}\n`);
  fs.chmodSync(manifestPath, 0o400);
  assert.throws(() => captureProtectedAutomationSnapshot({
    projectRoot,
    ...OWNER,
    jobId: "another-job",
    revision: 1,
    sourceDirectory: "automation",
    entrypoint: "job.mjs",
  }), /invalid schema/);
});

test("enforces the compiled revision count before copying another revision", () => {
  writeSource("automation/job.mjs", "export {};\n");
  for (let revision = 1; revision <= PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxRevisionsPerJob; revision += 1) {
    assert.equal(capture(revision).created, true);
  }
  assert.equal(capture(PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxRevisionsPerJob).created, false);
  assert.throws(
    () => capture(PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxRevisionsPerJob + 1),
    /revision limit is exhausted/,
  );
});

test("aggregate bytes are bounded per exact Project-Agent pair without charging another pair", () => {
  writeSource("automation/job.mjs", Buffer.alloc(PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes, 0x61));
  const logicalCaptures = PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxProjectAgentBytes /
    PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes;
  assert.equal(Number.isInteger(logicalCaptures), true);
  let created = 0;
  for (let index = 0; index < logicalCaptures; index += 1) {
    try {
      assert.equal(captureProtectedAutomationSnapshot({
        projectRoot,
        ...OWNER,
        jobId: `quota-job-${index}`,
        revision: 1,
        sourceDirectory: "automation",
        entrypoint: "job.mjs",
      }).created, true);
      created += 1;
    } catch (error) {
      assert.match((error as Error).message, /Exact Project-Agent snapshot byte quota would be exceeded/);
      break;
    }
  }
  assert.ok(created > 0 && created < logicalCaptures);
  assert.equal(captureProtectedAutomationSnapshot({
    projectRoot,
    ...OWNER,
    jobId: "quota-job-0",
    revision: 1,
    sourceDirectory: "automation",
    entrypoint: "job.mjs",
  }).created, false);
  assert.throws(() => captureProtectedAutomationSnapshot({
    projectRoot,
    ...OWNER,
    jobId: "quota-overflow-job",
    revision: 1,
    sourceDirectory: "automation",
    entrypoint: "job.mjs",
  }), /Exact Project-Agent snapshot byte quota would be exceeded/);
  assert.equal(captureProtectedAutomationSnapshot({
    projectRoot,
    ...OWNER,
    agentProfileId: "another-synthetic-profile",
    jobId: "other-pair-job",
    revision: 1,
    sourceDirectory: "automation",
    entrypoint: "job.mjs",
  }).created, true);
});

test("different exact owners receive different opaque private job roots", () => {
  writeSource("automation/job.mjs", "export {};\n");
  capture();
  captureProtectedAutomationSnapshot({
    projectRoot,
    projectId: OWNER.projectId,
    agentProfileId: OWNER.agentProfileId,
    jobId: "second-synthetic-job",
    revision: 1,
    sourceDirectory: "automation",
    entrypoint: "job.mjs",
  });
  const names = fs.readdirSync(path.join(dataRoot, "protected-automation", "jobs")).sort();
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  assert.ok(names.every((name) => /^[a-f0-9]{64}$/u.test(name)));
  assert.ok(names.every((name) => !name.includes(OWNER.jobId)));
});
