import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { close, init } from "./db.js";
import { createOpenInterview, getInterviewForSession } from "./interviews.js";
import { archiveSession, createSession, deleteSession, getSessionById, listSessions, normalizeSessionCwd, syncPiSessionFiles, updatePiSessionFile } from "./sessions.js";

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
