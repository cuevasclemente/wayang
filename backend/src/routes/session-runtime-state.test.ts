import test from "node:test";
import assert from "node:assert/strict";
import type { SessionRow } from "../sessions.js";
import { serializeSession } from "./sessions.js";
import { serializeSessionRuntimeState } from "./ws.js";

function stoppedSessionRow(id: string): SessionRow {
  return {
    id,
    pi_session_file: null,
    title: "Synthetic stopped Wren-shaped session",
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
