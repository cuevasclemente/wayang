import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "./agent-profiles.js";
import { close, commitStoreMutation, init } from "./db.js";
import { getSessionAttachmentRoot } from "./protected-artifacts.js";
import { createProject, updateProject } from "./projects.js";
import {
  classifyReadableStandardArtifact,
  classifySessionPrivacy,
  listStandardSessionAttachments,
  listStandardSessions,
  readStandardSessionLines,
} from "./session-interop.js";
import { createSession, getSessionById, updatePiSessionFile } from "./sessions.js";

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
  fs.writeFileSync(filePath, `${lines.map((line, index) => JSON.stringify({
    type: "custom",
    id: `${row.id}-${index}`,
    customType: "synthetic-session-interop",
    data: { line },
  })).join("\n")}\n`, { mode: 0o600 });
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
      draft.sessions.find((row) => row.id === quarantined.id)!.legacy_private_session_quarantine = true;
    });

    assert.equal(classifySessionPrivacy(getSessionById(standard.id)), "standard");
    assert.equal(classifySessionPrivacy(getSessionById(protectedSession.id)), "protected");
    assert.equal(classifySessionPrivacy(getSessionById(quarantined.id)), "unknown");
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
