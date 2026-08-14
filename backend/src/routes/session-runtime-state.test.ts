import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close as closeStore } from "../db.js";
import type { SessionRow } from "../sessions.js";
import { serializeSession } from "./sessions.js";
import { serializeSessionRuntimeState } from "./ws.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-session-runtime-state-"));
const previousDataDir = process.env.WAYANG_DATA_DIR;
process.env.WAYANG_DATA_DIR = path.join(fixtureRoot, "data");

test.after(() => {
  closeStore();
  if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
  else process.env.WAYANG_DATA_DIR = previousDataDir;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function stoppedSessionRow(id: string): SessionRow {
  return {
    id,
    pi_session_file: null,
    title: "Synthetic stopped Wren-shaped session",
    title_source: "explicit",
    cwd: "/synthetic/standard-project",
    provider: null,
    model: null,
    agent_profile_id: "lookalike-wren-profile",
    pending_agent_switch: null,
    created_at: 1,
    last_active: 1,
    archived: 0,
    archived_at: null,
    goal: null,
    goal_status: null,
    scheduled_job_id: null,
    scheduled_run_id: null,
    error: null,
  };
}

test("session HTTP projection reports unavailable without an active PiSessionHandle", () => {
  const serialized = serializeSession(stoppedSessionRow("slice-c-http-stopped"));

  assert.equal(serialized.runtime_status, "stopped");
  assert.equal(serialized.bash_mode, "unavailable");
  assert.equal(serialized.agent_profile_id, "lookalike-wren-profile");
});

test("session HTTP projection classifies terminal context overflow without exposing provider details", () => {
  const row = stoppedSessionRow("slice-c-context-overflow");
  row.error = "Codex error: Your input exceeds the context window of this model.";
  const serialized = serializeSession(row);
  assert.equal(serialized.error_kind, "context_overflow");
  assert.equal(serializeSession(stoppedSessionRow("slice-c-no-error")).error_kind, null);
});

test("session runtime WebSocket projection is selection-scoped and fail-closed", () => {
  assert.deepEqual(
    serializeSessionRuntimeState("slice-c-ws-stopped", "selection-123"),
    {
      type: "session_runtime_state",
      session_id: "slice-c-ws-stopped",
      selection_id: "selection-123",
      bash_mode: "unavailable",
    },
  );
  assert.deepEqual(
    serializeSessionRuntimeState("slice-c-ws-stopped", null),
    {
      type: "session_runtime_state",
      session_id: "slice-c-ws-stopped",
      bash_mode: "unavailable",
    },
  );
});
