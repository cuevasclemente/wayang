import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { installAttachmentArtifactObserver, prepareAttachments } from "../attachments.js";
import { close, init } from "../db.js";
import { createProject } from "../projects.js";
import { getSessionAttachmentRoot } from "../protected-artifacts.js";
import { createSession } from "../sessions.js";
import { closeOpenArtifact } from "./file.js";
import { onArtifactCatalogChanged } from "./events.js";
import { createArtifactToolRuntime } from "./tool.js";
import {
  closeArtifactRegistry,
  getArtifactCatalogRevision,
  getArtifactRegistry,
  initArtifactRegistry,
  listArtifactRows,
} from "./registry.js";
import {
  listSessionArtifacts,
  openSessionArtifact,
  presentArtifacts,
  readArtifactTextPreview,
  registerUploadedArtifacts,
} from "./service.js";

let root = "";
let projectRoot = "";
let sessionId = "";
let projectId = "";
let profileId = "";
let oldHome: string | undefined;
let oldDataDir: string | undefined;

beforeEach(() => {
  closeArtifactRegistry();
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-artifacts-"));
  projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  oldHome = process.env.HOME;
  oldDataDir = process.env.WAYANG_DATA_DIR;
  process.env.HOME = root;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  init();
  const profile = createAgentProfile({ name: "Artifact fixture", resource_mode: "project_only" });
  profileId = profile.id;
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  projectId = project.id;
  sessionId = createSession(projectRoot, { agentProfileId: profile.id }).id;
  initArtifactRegistry(process.env.WAYANG_DATA_DIR);
});

afterEach(() => {
  closeArtifactRegistry();
  close();
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
  else process.env.WAYANG_DATA_DIR = oldDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

test("newer artifact registry schemas fail startup closed", () => {
  getArtifactRegistry().prepare("UPDATE artifact_meta SET schema_version=2").run();
  closeArtifactRegistry();
  assert.throws(() => initArtifactRegistry(process.env.WAYANG_DATA_DIR), /newer than this Wayang build/iu);
});

test("presented Markdown is durable, session-scoped, previewable, and path-free in tool metadata", () => {
  const report = path.join(projectRoot, "report.md");
  fs.writeFileSync(report, "# Synthetic report\n\nHello.\n", { mode: 0o600 });
  const presented = presentArtifacts(sessionId, [{ path: report, title: "Final report", description: "Synthetic" }], "tool-call-1");
  assert.equal(presented.length, 1);
  assert.equal(JSON.stringify(presented).includes(report), false);

  const catalog = listSessionArtifacts(sessionId);
  assert.equal(catalog.revision, 1);
  assert.equal(catalog.artifacts.length, 1);
  assert.equal(catalog.artifacts[0].renderer, "markdown");
  assert.equal(catalog.artifacts[0].display_path, "report.md");
  assert.equal(catalog.artifacts[0].preview_available, true);

  const opened = openSessionArtifact(sessionId, presented[0].id);
  try {
    const preview = readArtifactTextPreview(opened);
    assert.equal(preview.text, "# Synthetic report\n\nHello.\n");
    assert.match(preview.sha256, /^[a-f0-9]{64}$/u);
  } finally {
    closeOpenArtifact(opened);
  }

  closeArtifactRegistry();
  initArtifactRegistry(process.env.WAYANG_DATA_DIR);
  assert.equal(listArtifactRows(sessionId).length, 1);
  assert.equal(getArtifactCatalogRevision(sessionId), 1);
});

test("authorized home files work while secret, symlink, and hard-linked files remain denied", () => {
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "outside", { mode: 0o600 });
  assert.equal(presentArtifacts(sessionId, [{ path: outside }]).length, 1,
    "current Standard-resource policy permits an ordinary owner-home file");

  const env = path.join(projectRoot, ".env");
  fs.writeFileSync(env, "SYNTHETIC=not-a-secret", { mode: 0o600 });
  assert.throws(() => presentArtifacts(sessionId, [{ path: env }]), /unavailable/iu);

  const target = path.join(projectRoot, "target.txt");
  const symlink = path.join(projectRoot, "symlink.txt");
  fs.writeFileSync(target, "target", { mode: 0o600 });
  fs.symlinkSync(target, symlink);
  assert.throws(() => presentArtifacts(sessionId, [{ path: symlink }]), /safe single-link|unavailable/iu);

  const hardlink = path.join(projectRoot, "hardlink.txt");
  fs.linkSync(target, hardlink);
  assert.throws(() => presentArtifacts(sessionId, [{ path: target }]), /safe single-link/iu);
});

test("completed uploads register passively and animated GIF remains download-only", () => {
  const attachmentRoot = getSessionAttachmentRoot(sessionId);
  fs.mkdirSync(attachmentRoot, { recursive: true, mode: 0o700 });
  const upload = path.join(attachmentRoot, "fixture.gif");
  fs.writeFileSync(upload, Buffer.from("GIF89a", "ascii"), { mode: 0o600 });
  registerUploadedArtifacts(sessionId, [{ filePath: upload, displayName: "fixture.gif", attachmentId: "attachment-1" }]);

  const catalog = listSessionArtifacts(sessionId);
  assert.equal(catalog.artifacts.length, 1);
  assert.equal(catalog.artifacts[0].source, "upload");
  assert.equal(catalog.artifacts[0].preview_available, false);
  assert.equal(catalog.artifacts[0].download_available, true);
  assert.equal(catalog.artifacts[0].display_path, "fixture.gif");
});

test("source-bound present_artifact runtime publishes opaque details and denies stale execution", async () => {
  const report = path.join(projectRoot, "tool-report.md");
  fs.writeFileSync(report, "# Tool report\n", { mode: 0o600 });
  let current = true;
  const runtime = createArtifactToolRuntime({
    binding: {
      sourceSessionId: sessionId,
      projectId,
      projectCwd: projectRoot,
      agentProfileId: profileId,
      runtimeGeneration: "runtime-1",
      processBootNonce: "boot-1",
    },
    isCurrent: () => current,
  });
  const result = await (runtime.tool.execute as any)("call-1", { artifacts: [{ path: report, title: "Tool report" }] });
  assert.equal(result.details.kind, "wayang_artifact_presentation");
  assert.equal(JSON.stringify(result.details).includes(report), false);
  current = false;
  await assert.rejects(() => (runtime.tool.execute as any)("call-2", { artifacts: [{ path: report }] }), /stale/iu);
  await runtime.close();
});

test("completed attachment persistence commits its artifact registry entry atomically", () => {
  const uninstall = installAttachmentArtifactObserver(registerUploadedArtifacts);
  const stopThrowingListener = onArtifactCatalogChanged(() => { throw new Error("synthetic listener failure"); });
  try {
    const prepared = prepareAttachments(sessionId, [{
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("uploaded notes", "utf8").toString("base64"),
    }]);
    assert.equal(prepared.count, 1);
    const catalog = listSessionArtifacts(sessionId);
    assert.equal(catalog.artifacts.length, 1);
    assert.equal(catalog.artifacts[0].source, "upload");
    assert.equal(catalog.artifacts[0].name, "notes.txt");
  } finally {
    stopThrowingListener();
    uninstall();
  }
});

test("same-path replacement after registration is reclassified as the current authorized target", () => {
  const report = path.join(projectRoot, "report.txt");
  fs.writeFileSync(report, "first", { mode: 0o600 });
  const [artifact] = presentArtifacts(sessionId, [{ path: report }]);
  fs.writeFileSync(report, "second", { mode: 0o600 });
  const opened = openSessionArtifact(sessionId, artifact.id);
  try { assert.equal(readArtifactTextPreview(opened).text, "second"); }
  finally { closeOpenArtifact(opened); }
});
