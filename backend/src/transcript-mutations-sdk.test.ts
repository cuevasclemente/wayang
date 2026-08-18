import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CanonicalEntry, CanonicalEntryReplacement } from "./transcript-mutations.js";

interface InstalledMultiEntryCasManager {
  getEntries(): CanonicalEntry[];
  replaceEntriesIfCurrent(
    replacements: readonly CanonicalEntryReplacement[],
  ): void | boolean | { replaced: boolean };
}

test("installed Pi SDK atomically replaces an exact entry set and rejects stale expected entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-installed-pi-multi-cas-"));
  const cwd = path.join(root, "project");
  const transcript = path.join(root, "session.jsonl");
  fs.mkdirSync(cwd, { recursive: true });
  const target: CanonicalEntry = {
    type: "message",
    id: "target",
    parentId: null,
    timestamp: "2026-08-18T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "old synthetic content" }] },
  };
  const summary: CanonicalEntry = {
    type: "branch_summary",
    id: "summary",
    parentId: "target",
    timestamp: "2026-08-18T00:00:01.000Z",
    summary: "old synthetic summary",
  };
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "installed-sdk-multi-cas",
      timestamp: "2026-08-18T00:00:00.000Z",
      cwd,
    }),
    JSON.stringify(target),
    JSON.stringify(summary),
  ].join("\n") + "\n", { mode: 0o600 });

  try {
    const manager = SessionManager.open(transcript, undefined, cwd) as unknown as InstalledMultiEntryCasManager;
    assert.equal(typeof manager.replaceEntriesIfCurrent, "function", "vendored Pi must expose atomic multi-entry CAS");
    const replacementTarget: CanonicalEntry = {
      ...target,
      message: { role: "user", content: [{ type: "text", text: "new synthetic content" }] },
    };
    const replacementSummary: CanonicalEntry = {
      type: "custom",
      id: summary.id,
      parentId: summary.parentId,
      timestamp: summary.timestamp,
      customType: "wayang-invalidated-derived-event-v1",
      data: { version: 1 },
    };
    const result = manager.replaceEntriesIfCurrent([
      { expectedEntry: target, replacement: replacementTarget },
      { expectedEntry: summary, replacement: replacementSummary },
    ]);
    assert.notEqual(result, false);
    if (result && typeof result === "object") assert.equal(result.replaced, true);

    const reopened = SessionManager.open(transcript, undefined, cwd) as unknown as InstalledMultiEntryCasManager;
    assert.deepEqual(reopened.getEntries(), [replacementTarget, replacementSummary]);
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      ["project", "session.jsonl"],
      "atomic rewrite must not retain backup/revision files",
    );
    const beforeConflict = fs.readFileSync(transcript, "utf8");
    let conflicted = false;
    try {
      const staleResult = reopened.replaceEntriesIfCurrent([
        { expectedEntry: target, replacement: replacementTarget },
        { expectedEntry: replacementSummary, replacement: summary },
      ]);
      conflicted = staleResult === false || Boolean(staleResult && typeof staleResult === "object" && staleResult.replaced === false);
    } catch (error) {
      const candidate = error as { statusCode?: unknown; code?: unknown };
      conflicted = candidate.statusCode === 409
        || candidate.code === "CAS_CONFLICT"
        || candidate.code === "ERR_SESSION_ENTRY_CONFLICT";
    }
    assert.equal(conflicted, true, "a stale member must reject the complete replacement set");
    assert.equal(fs.readFileSync(transcript, "utf8"), beforeConflict, "conflict must not partially rewrite any entry");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
