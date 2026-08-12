import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { close, failNextCommitStoreMutationPersistenceForTests, flush, getStore, init } from "./db.js";
import { createOpenInterview, getInterviewForSession } from "./interviews.js";
import { createAgentProfile } from "./agent-profiles.js";
import type { MessagingEndpointDeclaration } from "./messaging/contracts.js";
import {
  activateMessagingSession,
  bindMessagingConversation,
  messagingDeclarationSha256,
  reconcileMessagingEndpointDeclarations,
} from "./messaging/store.js";
import {
  archiveSession,
  beginAgentSwitch,
  createSession,
  deleteSession,
  getSessionById,
  isLegacyPrivateSessionQuarantined,
  listSessions,
  normalizeSessionCwd,
  syncPiSessionFiles,
  updatePiSessionFile,
  updateSessionAgentProfile,
  updateSessionModel,
} from "./sessions.js";

// These regression cases exercise the rollback-only SDK scanner with mocked
// SessionInfo values. Incremental-catalog behavior has isolated tests in
// session-catalog.test.ts and never scans the developer's canonical directory.
const previousLegacyScan = process.env.WAYANG_LEGACY_SESSION_SCAN;
process.env.WAYANG_LEGACY_SESSION_SCAN = "1";
after(() => {
  if (previousLegacyScan === undefined) delete process.env.WAYANG_LEGACY_SESSION_SCAN;
  else process.env.WAYANG_LEGACY_SESSION_SCAN = previousLegacyScan;
});

test("normalizeSessionCwd expands tilde project paths before pi sees them", () => {
  assert.equal(normalizeSessionCwd("~/src/saqi"), path.join(os.homedir(), "src/saqi"));
});

test("normalizeSessionCwd repairs missing /src project paths", () => {
  assert.equal(normalizeSessionCwd("/src/saqi"), path.join(os.homedir(), "src/saqi"));
});

test("createSession persists normalized cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-cwd-test-"));
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;

  try {
    init();
    const session = createSession("~/src/saqi", "cwd test");
    assert.equal(session.cwd, path.join(os.homedir(), "src/saqi"));
    assert.equal(session.project_id, getStore().projects.find((project) => project.cwd === session.cwd)?.id);
  } finally {
    close();
    if (previousDataDir === undefined) {
      delete process.env.WAYANG_DATA_DIR;
    } else {
      process.env.WAYANG_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync imports current model from canonical pi sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-model-sync-test-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "canonical-pi-id",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: projectDir,
      }),
      JSON.stringify({
        type: "model_change",
        id: "model-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      }),
      JSON.stringify({
        type: "model_change",
        id: "model-2",
        parentId: "model-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        provider: "local-example",
        modelId: "example-model",
      }),
    ].join("\n") + "\n",
  );

  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  const originalListAll = SessionManager.listAll;

  try {
    init();
    SessionManager.listAll = async () => [
      {
        path: sessionFile,
        id: "canonical-pi-id",
        cwd: projectDir,
        name: "Imported TUI session",
        created: new Date(1_000),
        modified: new Date(2_000),
        messageCount: 1,
        firstMessage: "hello",
        allMessagesText: "hello",
      } satisfies SessionInfo,
    ];

    await syncPiSessionFiles();

    const imported = getSessionById("canonical-pi-id");
    assert.equal(imported?.project_id, getStore().projects.find((project) => project.cwd === projectDir)?.id);
    assert.equal(imported?.provider, "local-example");
    assert.equal(imported?.model, "example-model");
  } finally {
    SessionManager.listAll = originalListAll;
    close();
    if (previousDataDir === undefined) {
      delete process.env.WAYANG_DATA_DIR;
    } else {
      process.env.WAYANG_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync updates file-linked web session model after TUI activity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-model-sync-web-id-test-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "canonical-pi-id",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: projectDir,
      }),
      JSON.stringify({
        type: "model_change",
        id: "model-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "openai-codex",
        modelId: "gpt-5.5",
      }),
    ].join("\n") + "\n",
  );

  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  const originalListAll = SessionManager.listAll;

  try {
    init();
    const session = createSession(projectDir, { title: "Web id row", provider: "anthropic", model: "claude-opus-4-7" });
    updatePiSessionFile(session.id, sessionFile);

    SessionManager.listAll = async () => [
      {
        path: sessionFile,
        id: "canonical-pi-id",
        cwd: projectDir,
        name: "Web id row",
        created: new Date(1_000),
        modified: new Date(Date.now() + 1_000),
        messageCount: 1,
        firstMessage: "hello",
        allMessagesText: "hello",
      } satisfies SessionInfo,
    ];

    await syncPiSessionFiles();

    const updated = getSessionById(session.id);
    assert.equal(updated?.provider, "openai-codex");
    assert.equal(updated?.model, "gpt-5.5");
  } finally {
    SessionManager.listAll = originalListAll;
    close();
    if (previousDataDir === undefined) {
      delete process.env.WAYANG_DATA_DIR;
    } else {
      process.env.WAYANG_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync never transfers an existing session to the Project at a changed transcript cwd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-project-move-test-"));
  const originalProjectDir = path.join(dir, "original-project");
  const movedProjectDir = path.join(dir, "moved-project");
  fs.mkdirSync(originalProjectDir, { recursive: true });
  fs.mkdirSync(movedProjectDir, { recursive: true });
  const sessionFile = path.join(dir, "moved-session.jsonl");
  fs.writeFileSync(sessionFile, "");
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  const originalListAll = SessionManager.listAll;

  try {
    init();
    const session = createSession(originalProjectDir, "Moved transcript");
    updatePiSessionFile(session.id, sessionFile);
    SessionManager.listAll = async () => [{
      path: sessionFile,
      id: session.id,
      cwd: movedProjectDir,
      name: "Moved transcript",
      created: new Date(session.created_at),
      modified: new Date(session.last_active + 1_000),
      messageCount: 1,
      firstMessage: "hello",
      allMessagesText: "hello",
    } satisfies SessionInfo];

    await syncPiSessionFiles();

    const movedProject = getStore().projects.find((project) => project.cwd === movedProjectDir)!;
    const updated = getSessionById(session.id)!;
    assert.equal(updated.cwd, movedProjectDir);
    assert.equal(updated.project_id, null);
    assert.notEqual(updated.project_id, movedProject.id);
    assert.equal(updated.legacy_capability_ineligible, true);
  } finally {
    SessionManager.listAll = originalListAll;
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync restores archived file-linked session after post-archive TUI activity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-active-archive-restore-test-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionFile, "");

  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  const originalListAll = SessionManager.listAll;

  try {
    init();
    const session = createSession(projectDir, "Archived then resumed");
    updatePiSessionFile(session.id, sessionFile);
    archiveSession(session.id);
    const archivedAt = getSessionById(session.id)?.archived_at;
    assert.equal(getSessionById(session.id)?.archived, 1);

    SessionManager.listAll = async () => [
      {
        path: sessionFile,
        id: "canonical-pi-id",
        cwd: projectDir,
        name: "Archived then resumed",
        created: new Date(1_000),
        modified: new Date((archivedAt ?? Date.now()) + 1_000),
        messageCount: 2,
        firstMessage: "hello again",
        allMessagesText: "hello again",
      } satisfies SessionInfo,
    ];

    await syncPiSessionFiles();

    assert.equal(getSessionById(session.id)?.archived, 0);
    assert.equal(listSessions().some((row) => row.id === session.id), true);
  } finally {
    SessionManager.listAll = originalListAll;
    close();
    if (previousDataDir === undefined) {
      delete process.env.WAYANG_DATA_DIR;
    } else {
      process.env.WAYANG_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteSession permanently deletes transcript and sync skips stale discoveries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-delete-test-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionFile, "{}");

  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  const originalListAll = SessionManager.listAll;

  try {
    init();
    const session = createSession(projectDir, "Delete me");
    updatePiSessionFile(session.id, sessionFile);
    createOpenInterview({
      requestId: "delete-session-interview",
      sessionId: session.id,
      toolName: "interview",
      questions: [{ id: "q", label: "Question", prompt: "Question?", options: [{ value: "yes", label: "Yes" }], allowOther: false }],
    });

    const deleted = deleteSession(session.id);
    assert.equal(deleted?.session.id, session.id);
    assert.equal(deleted?.deletedSessionFile, sessionFile);
    assert.equal(getSessionById(session.id), undefined);
    assert.equal(getInterviewForSession(session.id, "delete-session-interview"), undefined);
    assert.equal(fs.existsSync(sessionFile), false);

    SessionManager.listAll = async () => [
      {
        path: sessionFile,
        id: session.id,
        cwd: projectDir,
        name: "Stale deleted session",
        created: new Date(1_000),
        modified: new Date(2_000),
        messageCount: 1,
        firstMessage: "hello",
        allMessagesText: "hello",
      } satisfies SessionInfo,
    ];

    await syncPiSessionFiles();

    assert.equal(getSessionById(session.id), undefined);
  } finally {
    SessionManager.listAll = originalListAll;
    close();
    if (previousDataDir === undefined) {
      delete process.env.WAYANG_DATA_DIR;
    } else {
      process.env.WAYANG_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy private quarantine fails closed unless the durable marker is exactly false", () => {
  assert.equal(isLegacyPrivateSessionQuarantined({ legacy_private_session_quarantine: false }), false);
  assert.equal(isLegacyPrivateSessionQuarantined({ legacy_private_session_quarantine: true }), true);
  assert.equal(isLegacyPrivateSessionQuarantined({} as any), true);
  assert.equal(isLegacyPrivateSessionQuarantined({ legacy_private_session_quarantine: null } as any), true);
  assert.equal(isLegacyPrivateSessionQuarantined(undefined), true);
  assert.equal(isLegacyPrivateSessionQuarantined(null), true);
});

test("quarantined sessions deny assignment changes while archive and delete remain available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-quarantine-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const session = createSession(projectDir, "Quarantined fixture");
    const alternate = createAgentProfile({ name: "Synthetic alternate profile" });
    const row = getStore().sessions.find((candidate) => candidate.id === session.id)!;
    row.legacy_private_session_quarantine = true;
    row.legacy_capability_ineligible = true;

    assert.throws(
      () => updateSessionAgentProfile(session.id, alternate.id),
      /Quarantined legacy sessions cannot switch agent profiles/,
    );
    assert.throws(
      () => updateSessionModel(session.id, "alternate-model", "synthetic-provider"),
      /Quarantined legacy sessions cannot change models/,
    );

    archiveSession(session.id);
    assert.equal(getSessionById(session.id)?.archived, 1);
    assert.equal(deleteSession(session.id)?.session.id, session.id);
    assert.equal(getSessionById(session.id), undefined);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("active messaging bindings preflight archive, delete, and profile switch before side effects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-messaging-lifecycle-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(dir, "bound-session.jsonl");
  fs.writeFileSync(transcript, "synthetic transcript\n");
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const profile = createAgentProfile({ name: "Bound messaging profile" });
    const alternate = createAgentProfile({ name: "Alternate messaging profile" });
    const session = createSession(projectDir, { title: "Actively bound", agentProfileId: profile.id });
    updatePiSessionFile(session.id, transcript);
    const project = getStore().projects.find((candidate) => candidate.cwd === projectDir)!;
    const declaration: MessagingEndpointDeclaration = {
      endpointId: "matrix-lifecycle-test",
      connectorId: "matrix",
      provisioningKey: "lifecycle-test",
      projectId: project.id,
      agentProfileId: profile.id,
      displayName: "Lifecycle test",
      conversationMode: "shared",
      allowedSubjectIds: ["@alice:example.test"],
      transportSecurity: "unencrypted_accepted",
    };
    const [created] = reconcileMessagingEndpointDeclarations([declaration], 100);
    const digest = messagingDeclarationSha256(declaration);
    const bound = bindMessagingConversation({
      endpointId: declaration.endpointId,
      declarationSha256: digest,
      expectedRevision: created!.revision,
      externalConversationId: "!lifecycle:example.test",
      now: 101,
    });
    const active = activateMessagingSession({
      endpointId: declaration.endpointId,
      declarationSha256: digest,
      expectedRevision: bound.revision,
      sessionId: session.id,
      now: 102,
    });

    assert.throws(() => archiveSession(session.id), /Actively messaging-bound sessions cannot archive/);
    assert.throws(() => deleteSession(session.id), /Actively messaging-bound sessions cannot delete/);
    assert.throws(() => updateSessionAgentProfile(session.id, alternate.id), /Actively messaging-bound sessions cannot switch/);
    assert.throws(() => beginAgentSwitch(session.id, {
      switch_id: "synthetic-switch",
      from_agent_profile_id: profile.id,
      from_provider: session.provider,
      from_model: session.model,
      to_agent_profile_id: alternate.id,
      target_provider: "synthetic-provider",
      target_model: "synthetic-model",
      changed_at: 103,
    }), /Actively messaging-bound sessions cannot switch/);
    assert.equal(getSessionById(session.id)?.archived, 0);
    assert.equal(getSessionById(session.id)?.pending_agent_switch, null);
    assert.equal(getSessionById(session.id)?.agent_profile_id, profile.id);
    assert.equal(fs.existsSync(transcript), true, "delete preflight must precede transcript unlink");

    activateMessagingSession({
      endpointId: declaration.endpointId,
      declarationSha256: digest,
      expectedRevision: active.revision,
      sessionId: null,
      now: 104,
    });
    archiveSession(session.id);
    assert.equal(getSessionById(session.id)?.archived, 1);
    assert.equal(deleteSession(session.id)?.session.id, session.id);
    assert.equal(fs.existsSync(transcript), false);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("schema-0 migration binds generated Projects by exact canonical cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-project-id-v0-migration-"));
  const projectDir = path.join(dir, "legacy-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({
      sessions: [{
        id: "legacy-session",
        title: "Legacy",
        cwd: projectDir,
        created_at: 1,
        last_active: 1,
        archived: 0,
      }],
    }), { mode: 0o600 });
    init();
    const migrated = getSessionById("legacy-session")!;
    assert.equal(migrated.project_id, getStore().projects.find((project) => project.cwd === projectDir)?.id);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("schema-3 migration binds only exact Project cwd matches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-project-id-migration-"));
  const projectDir = path.join(dir, "project");
  const unresolvedDir = path.join(dir, "unresolved");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(unresolvedDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const resolved = createSession(projectDir, "Resolved legacy row");
    const unresolved = createSession(projectDir, "Unresolved legacy row");
    const projectId = resolved.project_id;
    close();

    const storePath = path.join(dir, "store.json");
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, any>;
    raw.schema_version = 3;
    delete raw.messagingEndpoints;
    delete raw.messagingEvents;
    delete raw.messagingTransactions;
    delete raw.messagingDeliveries;
    for (const session of raw.sessions as Record<string, any>[]) delete session.project_id;
    (raw.sessions as Record<string, any>[]).find((session) => session.id === unresolved.id)!.cwd = unresolvedDir;
    fs.writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });

    init();
    assert.equal(getSessionById(resolved.id)?.project_id, projectId);
    assert.equal(getSessionById(unresolved.id)?.project_id, null);
    assert.equal(getSessionById(unresolved.id)?.legacy_capability_ineligible, true);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current schema rejects sessions missing durable Project attribution", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-project-id-validation-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    createSession(projectDir, "Missing Project ID");
    close();
    const storePath = path.join(dir, "store.json");
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, any>;
    delete raw.sessions[0].project_id;
    fs.writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });
    assert.throws(() => init(), /malformed session/);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current schema rejects a non-null Project ID that does not own the session cwd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-project-mismatch-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const session = createSession(projectDir, "Mismatched Project ID");
    const stored = getStore().sessions.find((row) => row.id === session.id)!;
    const projectId = stored.project_id;
    stored.project_id = "different-project-id";
    assert.throws(() => flush(), /Project attribution does not match its canonical cwd/);
    stored.project_id = projectId;
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotent session creation compares immutable Project ID", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-project-idempotency-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const first = createSession(projectDir, { title: "Idempotent", idempotencyKey: "project-scope" });
    const stored = getStore().sessions.find((session) => session.id === first.id)!;
    const projectId = stored.project_id;
    stored.project_id = null;
    stored.legacy_capability_ineligible = true;
    assert.throws(
      () => createSession(projectDir, { title: "Idempotent retry", idempotencyKey: "project-scope" }),
      /different scope/,
    );
    stored.project_id = projectId;
    stored.legacy_capability_ineligible = false;
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new sessions carry explicit capability eligibility markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-capability-markers-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const session = createSession(projectDir, "Capability markers");
    assert.equal(session.project_id, getStore().projects.find((project) => project.cwd === projectDir)?.id);
    assert.equal(session.legacy_private_session_quarantine, false);
    assert.equal(session.legacy_capability_ineligible, false);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync keeps user-archived pi sessions hidden when rediscovered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-sessions-test-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionFile, "");

  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  const originalListAll = SessionManager.listAll;

  try {
    init();
    const session = createSession(projectDir, "Archived session");
    updatePiSessionFile(session.id, sessionFile);
    archiveSession(session.id);

    SessionManager.listAll = async () => [
      {
        path: sessionFile,
        id: "canonical-pi-id",
        cwd: projectDir,
        name: "Rediscovered title",
        created: new Date(1_000),
        modified: new Date(2_000),
        messageCount: 1,
        firstMessage: "hello",
        allMessagesText: "hello",
      } satisfies SessionInfo,
    ];

    assert.equal(listSessions().length, 0);

    await syncPiSessionFiles();

    assert.equal(getSessionById(session.id)?.archived, 1);
    assert.equal(listSessions().length, 0);
  } finally {
    SessionManager.listAll = originalListAll;
    close();
    if (previousDataDir === undefined) {
      delete process.env.WAYANG_DATA_DIR;
    } else {
      process.env.WAYANG_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
