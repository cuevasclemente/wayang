import test from "node:test";
import assert from "node:assert/strict";
import {
  createWayangRuntimeContextToolDefinition,
  createWayangSessionCustomTools,
  WAYANG_RUNTIME_CONTEXT_TOOL_NAME,
  type WayangRuntimeContextResult,
} from "./wayang-runtime-context.js";

async function executeContextTool(tool: ReturnType<typeof createWayangRuntimeContextToolDefinition>): Promise<{
  result: WayangRuntimeContextResult;
  raw: string;
  details: unknown;
}> {
  const execution = await (tool.execute as any)("synthetic-call", {}, undefined, undefined, {});
  assert.equal(execution.content.length, 1);
  assert.equal(execution.content[0]?.type, "text");
  const raw = execution.content[0].text as string;
  return { result: JSON.parse(raw) as WayangRuntimeContextResult, raw, details: execution.details };
}

test("same-cwd runtime tools remain bound to different exact sessions under concurrency", async () => {
  const cwd = "/synthetic/same-project";
  const first = createWayangRuntimeContextToolDefinition({
    webSessionId: "11111111-1111-4111-8111-111111111111",
    cwd,
    scheduledJobId: "job-first",
    scheduledRunId: "run-first",
    agentProfileId: "profile-first",
  });
  const second = createWayangRuntimeContextToolDefinition({
    webSessionId: "22222222-2222-4222-8222-222222222222",
    cwd,
    scheduledJobId: "job-second",
    scheduledRunId: "run-second",
    agentProfileId: "profile-second",
  });

  const [firstResults, secondResults] = await Promise.all([
    Promise.all(Array.from({ length: 25 }, () => executeContextTool(first))),
    Promise.all(Array.from({ length: 25 }, () => executeContextTool(second))),
  ]);

  const expectedFirst: WayangRuntimeContextResult = {
    session_id: "11111111-1111-4111-8111-111111111111",
    cwd,
    scheduled: true,
    scheduled_job_id: "job-first",
    scheduled_run_id: "run-first",
    agent_profile_id: "profile-first",
  };
  const expectedSecond: WayangRuntimeContextResult = {
    session_id: "22222222-2222-4222-8222-222222222222",
    cwd,
    scheduled: true,
    scheduled_job_id: "job-second",
    scheduled_run_id: "run-second",
    agent_profile_id: "profile-second",
  };
  for (const execution of firstResults) assert.deepEqual(execution.result, expectedFirst);
  for (const execution of secondResults) assert.deepEqual(execution.result, expectedSecond);
});

test("runtime context output is minimal and never includes environment or caller data", async () => {
  const envName = "WAYANG_RUNTIME_CONTEXT_SYNTHETIC_SECRET";
  const canary = "synthetic-environment-secret-must-not-appear";
  const previous = process.env[envName];
  process.env[envName] = canary;
  try {
    const tool = createWayangRuntimeContextToolDefinition({
      webSessionId: "33333333-3333-4333-8333-333333333333",
      cwd: "/synthetic/ad-hoc-project",
      scheduledJobId: null,
      scheduledRunId: null,
      agentProfileId: "profile-ad-hoc",
      secret: "synthetic-caller-secret-must-not-appear",
    } as any);
    const execution = await executeContextTool(tool);

    assert.deepEqual(execution.result, {
      session_id: "33333333-3333-4333-8333-333333333333",
      cwd: "/synthetic/ad-hoc-project",
      scheduled: false,
      agent_profile_id: "profile-ad-hoc",
    });
    assert.deepEqual(Object.keys(execution.result).sort(), [
      "agent_profile_id",
      "cwd",
      "scheduled",
      "session_id",
    ]);
    assert.deepEqual(execution.details, {});
    assert.doesNotMatch(execution.raw, /secret|environment/i);
    assert.equal(execution.raw.includes(canary), false);
    assert.equal(execution.raw.includes("synthetic-caller-secret-must-not-appear"), false);
    assert.deepEqual(tool.parameters, {
      additionalProperties: false,
      type: "object",
      properties: {},
    });
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("required runtime context composes with rather than replacing sandboxed bash", () => {
  const sandboxedBash = { name: "bash", execute: async () => ({ content: [] }) } as any;
  const tools = createWayangSessionCustomTools({
    webSessionId: "44444444-4444-4444-8444-444444444444",
    cwd: "/synthetic/project",
  }, [sandboxedBash]);

  assert.deepEqual(tools.map((tool) => tool.name), [WAYANG_RUNTIME_CONTEXT_TOOL_NAME, "bash"]);
  assert.equal(tools[1], sandboxedBash);
});
