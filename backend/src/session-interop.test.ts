import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "./agent-profiles.js";
import { close, commitStoreMutation, init } from "./db.js";
import { getSessionAttachmentRoot } from "./protected-artifacts.js";
import { createProject, updateProject } from "./projects.js";
import { SessionCatalog } from "./session-catalog.js";
import {
  MAX_READ_SCAN_BYTES,
  classifyReadableStandardArtifact,
  classifySessionPrivacy,
  listStandardSessionAttachments,
  listStandardSessions,
  readStandardSessionLines,
} from "./session-interop.js";
import {
  classifyCatalogDurableSession,
  createSession,
  getSessionById,
  stopSessionCatalog,
  syncPiSessionFiles,
  updatePiSessionFile,
} from "./sessions.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-interop-"));
  const previous = {
    data: process.env.WAYANG_DATA_DIR,
    agent: process.env.PI_CODING_AGENT_DIR,
    sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
  };
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "sessions");
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
  init();
  const cleanup = () => {
    close();
    if (previous.data === undefined) delete process.env.WAYANG_DATA_DIR; else process.env.WAYANG_DATA_DIR = previous.data;
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.sessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = previous.sessions;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, cleanup };
}

function materialize(row: ReturnType<typeof createSession>, lines: string[]): string {
  const filePath = path.join(process.env.PI_CODING_AGENT_SESSION_DIR!, `${row.id}.jsonl`);
  fs.writeFileSync(filePath, `${[
    JSON.stringify({ type: "session", version: 3, id: row.id, timestamp: "2026-01-01T00:00:00.000Z", cwd: row.cwd }),
    ...lines.map((line, index) => JSON.stringify({
      type: "custom",
      id: `${row.id}-${index}`,
      customType: "synthetic-session-interop",
      data: { line },
    })),
  ].join("\n")}\n`, { mode: 0o600 });
  updatePiSessionFile(row.id, filePath);
  return filePath;
}

test("privacy classification and listing expose only durable Standard sessions", () => {
  const f = fixture();
  try {
    const standardRoot = path.join(f.root, "standard");
    const protectedRoot = path.join(f.root, "protected");
    fs.mkdirSync(standardRoot);
    fs.mkdirSync(protectedRoot);
    const profile = createAgentProfile({ name: "Interop fixture" });
    createProject({ cwd: standardRoot, default_agent_profile_id: profile.id });
    createProject({
      cwd: protectedRoot,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });
    const standard = createSession(standardRoot, { title: "Standard", agentProfileId: profile.id });
    const protectedSession = createSession(protectedRoot, { title: "Protected", agentProfileId: profile.id });
    const quarantined = createSession(standardRoot, { title: "Quarantined", agentProfileId: profile.id });
    commitStoreMutation((draft) => {
      const row = draft.sessions.find((candidate) => candidate.id === quarantined.id)!;
      row.legacy_private_session_quarantine = true;
      row.legacy_capability_ineligible = true;
    });

    assert.equal(classifySessionPrivacy(getSessionById(standard.id)), "standard");
    assert.equal(classifySessionPrivacy(getSessionById(protectedSession.id)), "protected");
    assert.equal(classifySessionPrivacy(getSessionById(quarantined.id)), "unknown");
    assert.equal(classifySessionPrivacy({
      ...getSessionById(standard.id)!,
      legacy_private_session_quarantine: undefined,
    }), "unknown", "only an exact durable false escapes quarantine");
    assert.deepEqual(listStandardSessions().sessions.map((row) => row.id), [standard.id]);
  } finally { f.cleanup(); }
});

test("bounded transcript reads fail closed for Protected, quarantined, and privacy-changing targets", () => {
  const f = fixture();
  try {
    const standardRoot = path.join(f.root, "standard");
    const protectedRoot = path.join(f.root, "protected");
    fs.mkdirSync(standardRoot);
    fs.mkdirSync(protectedRoot);
    const profile = createAgentProfile({ name: "Interop reader" });
    const standardProject = createProject({ cwd: standardRoot, default_agent_profile_id: profile.id });
    createProject({
      cwd: protectedRoot,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });
    const standard = createSession(standardRoot, { agentProfileId: profile.id });
    const protectedSession = createSession(protectedRoot, { agentProfileId: profile.id });
    materialize(standard, ["one", "two", "three"]);
    materialize(protectedSession, ["private"]);

    const page = readStandardSessionLines(standard.id, { offset: 2, limit: 1 });
    assert.equal(page.lines.length, 1);
    assert.equal(page.offset, 2);
    assert.equal(page.next_offset, 3);
    assert.throws(() => readStandardSessionLines(protectedSession.id), /not available/);

    updateProject(standardProject.id, {
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });
    assert.throws(() => readStandardSessionLines(standard.id), /not available/);
  } finally { f.cleanup(); }
});

test("high line offsets stop at the total scan-byte ceiling", () => {
  const f = fixture();
  try {
    const standardRoot = path.join(f.root, "scan-ceiling-standard");
    fs.mkdirSync(standardRoot);
    const profile = createAgentProfile({ name: "Scan ceiling reader" });
    createProject({ cwd: standardRoot, default_agent_profile_id: profile.id });
    const session = createSession(standardRoot, { agentProfileId: profile.id });
    const filePath = path.join(process.env.PI_CODING_AGENT_SESSION_DIR!, `${session.id}.jsonl`);
    const header = JSON.stringify({ type: "session", version: 3, id: session.id, timestamp: "2026-01-01T00:00:00.000Z", cwd: session.cwd });
    fs.writeFileSync(filePath, `${header}\n${"{}\n".repeat(MAX_READ_SCAN_BYTES)}`, { mode: 0o600 });
    updatePiSessionFile(session.id, filePath);

    const page = readStandardSessionLines(session.id, { offset: MAX_READ_SCAN_BYTES, limit: 1 });
    assert.deepEqual(page.lines, []);
    assert.equal(page.next_offset, null);
    assert.equal(page.scanned_bytes, MAX_READ_SCAN_BYTES);
    assert.equal(page.scan_byte_limit, MAX_READ_SCAN_BYTES);
    assert.equal(page.scan_limited, true);
    assert.ok(page.scanned_bytes < fs.statSync(filePath).size);
  } finally { f.cleanup(); }
});

test("catalog durable classification denies every non-Standard or conflicting file before body transfer", async () => {
  const f = fixture();
  try {
    const standardRoot = path.join(f.root, "catalog-standard");
    const protectedRoot = path.join(f.root, "catalog-protected");
    fs.mkdirSync(standardRoot);
    fs.mkdirSync(protectedRoot);
    const profile = createAgentProfile({ name: "Catalog privacy gate" });
    createProject({ cwd: standardRoot, default_agent_profile_id: profile.id });
    createProject({
      cwd: protectedRoot,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });

    const writeCatalogFile = (name: string, id: string, cwd: string) => {
      const filePath = path.join(process.env.PI_CODING_AGENT_SESSION_DIR!, `${name}.jsonl`);
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
        JSON.stringify({ type: "message", id: `${name}-body`, message: { role: "user", content: "BODY_MUST_NOT_PARSE ".repeat(20_000) } }),
      ].join("\n") + "\n", { mode: 0o600 });
      return filePath;
    };

    const quarantined = createSession(standardRoot, { agentProfileId: profile.id });
    const quarantinedPath = writeCatalogFile("quarantined", quarantined.id, standardRoot);
    updatePiSessionFile(quarantined.id, quarantinedPath);
    commitStoreMutation((draft) => {
      const row = draft.sessions.find((candidate) => candidate.id === quarantined.id)!;
      row.legacy_private_session_quarantine = true;
      row.legacy_capability_ineligible = true;
    });

    const protectedSession = createSession(protectedRoot, { agentProfileId: profile.id });
    const protectedPath = writeCatalogFile("protected", protectedSession.id, protectedRoot);
    updatePiSessionFile(protectedSession.id, protectedPath);

    writeCatalogFile("unclassified", "unclassified-session", standardRoot);

    const projectless = createSession(standardRoot, { agentProfileId: profile.id });
    const projectlessPath = writeCatalogFile("projectless", projectless.id, standardRoot);
    updatePiSessionFile(projectless.id, projectlessPath);
    commitStoreMutation((draft) => {
      const row = draft.sessions.find((candidate) => candidate.id === projectless.id)!;
      row.project_id = null;
      row.legacy_capability_ineligible = true;
    });

    const pathOwner = createSession(standardRoot, { agentProfileId: profile.id });
    const idOwner = createSession(standardRoot, { agentProfileId: profile.id });
    const conflictPath = writeCatalogFile("path-id-conflict", idOwner.id, standardRoot);
    updatePiSessionFile(pathOwner.id, conflictPath);

    const moved = createSession(standardRoot, { agentProfileId: profile.id });
    const movedPath = writeCatalogFile("forged-moved-header", moved.id, protectedRoot);
    updatePiSessionFile(moved.id, movedPath);

    const duplicate = createSession(standardRoot, { agentProfileId: profile.id });
    const duplicatePath = writeCatalogFile("duplicate-path", duplicate.id, standardRoot);
    updatePiSessionFile(duplicate.id, duplicatePath);
    const duplicateAlias = createSession(standardRoot, { agentProfileId: profile.id });
    commitStoreMutation((draft) => {
      draft.sessions.find((row) => row.id === duplicateAlias.id)!.pi_session_file = duplicatePath;
    });

    let bodyTransfers = 0;
    const catalog = new SessionCatalog({
      getKnownFile: () => ({ fingerprint: null, mutationVersion: 0 }),
      classifyDurableSession: classifyCatalogDurableSession,
      stageDurableSession: () => null,
      commit: () => ({ imported: 0, updated: 0, archivedLegacy: 0, changed: false }),
    }, process.env.PI_CODING_AGENT_SESSION_DIR!, {
      authorizeCwd: () => true,
      getPolicyGeneration: () => 1,
      refreshProjection: () => undefined,
      onAuthorizedBodyTransferred: () => { bodyTransfers++; },
    });
    try {
      const result = await catalog.scan();
      assert.equal(result.discovered, 7);
      assert.equal(result.parsed, 0);
      assert.equal(result.parseBytes, 0);
      assert.equal(bodyTransfers, 0);
    } finally {
      await catalog.stop();
    }
  } finally { f.cleanup(); }
});

test("central transcript authorization rejects duplicate mixed-privacy owners and arbitrary or universal-deny files", () => {
  const f = fixture();
  try {
    const standardRoot = path.join(f.root, "central-standard");
    const protectedRoot = path.join(f.root, "central-protected");
    fs.mkdirSync(standardRoot);
    fs.mkdirSync(protectedRoot);
    const profile = createAgentProfile({ name: "Central transcript authorization" });
    createProject({ cwd: standardRoot, default_agent_profile_id: profile.id });
    createProject({
      cwd: protectedRoot,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });

    const standard = createSession(standardRoot, { agentProfileId: profile.id });
    const duplicateProtected = createSession(protectedRoot, { agentProfileId: profile.id });
    const sharedPath = materialize(standard, ["shared synthetic body"]);
    commitStoreMutation((draft) => {
      draft.sessions.find((row) => row.id === duplicateProtected.id)!.pi_session_file = sharedPath;
    });
    assert.equal(classifyReadableStandardArtifact(sharedPath), null);
    assert.throws(() => readStandardSessionLines(standard.id), /authorization failed/);

    const arbitrary = createSession(standardRoot, { agentProfileId: profile.id });
    const arbitraryPath = path.join(f.root, "arbitrary-valid-header.jsonl");
    fs.writeFileSync(arbitraryPath, `${JSON.stringify({ type: "session", version: 3, id: arbitrary.id, timestamp: "2026-01-01T00:00:00.000Z", cwd: standardRoot })}\n`, { mode: 0o600 });
    updatePiSessionFile(arbitrary.id, arbitraryPath);
    assert.equal(classifyReadableStandardArtifact(arbitraryPath), null);
    assert.throws(() => readStandardSessionLines(arbitrary.id), /authorization failed/);

    const universal = createSession(standardRoot, { agentProfileId: profile.id });
    const universalPath = path.join(process.env.WAYANG_DATA_DIR!, "synthetic-denied-transcript.jsonl");
    fs.writeFileSync(universalPath, `${JSON.stringify({ type: "session", version: 3, id: universal.id, timestamp: "2026-01-01T00:00:00.000Z", cwd: standardRoot })}\n`, { mode: 0o600 });
    updatePiSessionFile(universal.id, universalPath);
    assert.equal(classifyReadableStandardArtifact(universalPath), null);
    assert.throws(() => readStandardSessionLines(universal.id), /authorization failed/);
  } finally { f.cleanup(); }
});

test("fresh-store catalog stages eligible external Standard sessions before body parsing", async () => {
  const f = fixture();
  try {
    const standardRoot = path.join(f.root, "external-standard");
    const protectedRoot = path.join(f.root, "external-protected");
    const unknownRoot = path.join(f.root, "external-unknown");
    fs.mkdirSync(standardRoot);
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(unknownRoot);
    const profile = createAgentProfile({ name: "External discovery" });
    const standardProject = createProject({ cwd: standardRoot, default_agent_profile_id: profile.id });
    createProject({
      cwd: protectedRoot,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });
    const writeExternal = (name: string, id: string, cwd: string) => {
      const target = path.join(process.env.PI_CODING_AGENT_SESSION_DIR!, `${name}.jsonl`);
      fs.writeFileSync(target, [
        JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
        JSON.stringify({ type: "message", id: `${id}-user`, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Fresh external Standard fixture" } }),
      ].join("\n") + "\n", { mode: 0o600 });
      return target;
    };
    const standardPath = writeExternal("standard-external", "standard-external-id", standardRoot);
    writeExternal("protected-external", "protected-external-id", protectedRoot);
    writeExternal("unknown-external", "unknown-external-id", unknownRoot);

    const result = await syncPiSessionFiles();
    const imported = getSessionById("standard-external-id");
    assert.equal(result.imported, 1);
    assert.equal(result.parsed, 1);
    assert.equal(imported?.pi_session_file, standardPath);
    assert.equal(imported?.project_id, standardProject.id);
    assert.equal(imported?.legacy_private_session_quarantine, false);
    assert.equal(imported?.title, "Fresh external Standard fixture");
    assert.equal(getSessionById("protected-external-id"), undefined);
    assert.equal(getSessionById("unknown-external-id"), undefined);
  } finally {
    await stopSessionCatalog();
    f.cleanup();
  }
});

test("Standard transcript and attachment paths classify read-only while Protected artifacts remain private", () => {
  const f = fixture();
  try {
    const standardRoot = path.join(f.root, "standard");
    const protectedRoot = path.join(f.root, "protected");
    fs.mkdirSync(standardRoot);
    fs.mkdirSync(protectedRoot);
    const profile = createAgentProfile({ name: "Interop paths" });
    createProject({ cwd: standardRoot, default_agent_profile_id: profile.id });
    createProject({
      cwd: protectedRoot,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });
    const standard = createSession(standardRoot, { agentProfileId: profile.id });
    const protectedSession = createSession(protectedRoot, { agentProfileId: profile.id });
    const standardTranscript = materialize(standard, ["public"]);
    const protectedTranscript = materialize(protectedSession, ["private"]);
    const standardAttachmentRoot = getSessionAttachmentRoot(standard.id);
    const protectedAttachmentRoot = getSessionAttachmentRoot(protectedSession.id);
    fs.mkdirSync(standardAttachmentRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(protectedAttachmentRoot, { recursive: true, mode: 0o700 });
    const standardAttachment = path.join(standardAttachmentRoot, "standard.txt");
    const protectedAttachment = path.join(protectedAttachmentRoot, "protected.txt");
    fs.writeFileSync(standardAttachment, "standard", { mode: 0o600 });
    fs.writeFileSync(protectedAttachment, "protected", { mode: 0o600 });

    assert.deepEqual(classifyReadableStandardArtifact(standardTranscript), { kind: "transcript", sessionId: standard.id });
    assert.deepEqual(classifyReadableStandardArtifact(standardAttachment), { kind: "attachment", sessionId: standard.id });
    assert.equal(classifyReadableStandardArtifact(protectedTranscript), null);
    assert.equal(classifyReadableStandardArtifact(protectedAttachment), null);
    assert.equal(listStandardSessionAttachments(standard.id).attachments[0]?.path, standardAttachment);
    assert.throws(() => listStandardSessionAttachments(protectedSession.id), /not available/);
  } finally { f.cleanup(); }
});
