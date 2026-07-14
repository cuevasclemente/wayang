import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getSessionFileMessageHistory, getSessionFileSnapshot, invalidateSessionFileSnapshot } from "./pi-bridge.js";

test("stopped session snapshot parses once for messages and todos and invalidates on fingerprint change", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-snapshot-test-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const manager = SessionManager.create(projectDir, dir);
  manager.appendMessage({ role: "user", content: "public snapshot fixture", timestamp: Date.now() } as any);
  manager.appendMessage({ role: "assistant", content: "public synthetic response", provider: "offline", model: "fixture", timestamp: Date.now() } as any);
  manager.appendCustomEntry("todo-state", { todos: [{ id: 1, text: "Synthetic todo", status: "pending" }], nextId: 2 });
  const file = manager.getSessionFile()!;
  const originalOpen = SessionManager.open;
  let opens = 0;
  SessionManager.open = ((...args: Parameters<typeof SessionManager.open>) => {
    opens++;
    return originalOpen(...args);
  }) as typeof SessionManager.open;

  try {
    invalidateSessionFileSnapshot(file);
    const first = getSessionFileSnapshot(file, projectDir);
    assert.equal(first?.messages.length, 2);
    assert.equal(first?.todoState.todos[0]?.text, "Synthetic todo");
    assert.equal(getSessionFileMessageHistory(file, projectDir).length, 2);
    assert.equal(getSessionFileSnapshot(file, projectDir)?.todoState.todos.length, 1);
    assert.equal(opens, 1);

    fs.appendFileSync(file, JSON.stringify({
      type: "session_info",
      id: "snapshot-name",
      parentId: manager.getLeafId(),
      timestamp: new Date().toISOString(),
      name: "Changed synthetic fixture",
    }) + "\n");
    assert.equal(getSessionFileSnapshot(file, projectDir)?.messages.length, 2);
    assert.equal(opens, 2);
  } finally {
    SessionManager.open = originalOpen;
    invalidateSessionFileSnapshot(file);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("file history shows the full active branch after compaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-history-test-"));
  const projectDir = path.join(dir, "project");
  const sessionDir = path.join(dir, "sessions");
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    const manager = SessionManager.create(projectDir, sessionDir);
    manager.appendMessage({ role: "user", content: "first user turn", timestamp: "2026-01-01T00:00:00.000Z" } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: "2026-01-01T00:00:01.000Z" } as any);
    manager.appendMessage({ role: "user", content: "second user turn", timestamp: "2026-01-01T00:00:02.000Z" } as any);
    const keptId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: "2026-01-01T00:00:03.000Z" } as any);
    manager.appendCompaction("Summary only for model context", keptId, 1234, undefined, undefined);

    const compactedContext = manager.buildSessionContext().messages;
    assert.deepEqual(compactedContext.map((message: any) => message.role), ["compactionSummary", "assistant"]);

    const history = getSessionFileMessageHistory(manager.getSessionFile(), projectDir);
    assert.deepEqual(history.map((message) => message.type), ["user", "assistant", "user", "assistant", "custom"]);
    assert.equal((history[0].message as any)?.content, "first user turn");
    assert.equal((history[2].message as any)?.content, "second user turn");
    assert.equal((history[4].message as any)?.customType, "compaction-summary");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
