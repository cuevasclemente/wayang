import test from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { authorizeAgentToolCall } from "./agent-runtime.js";
import { createWorkspaceToolDefinitions, workspaceToolsAllowedForRuntime } from "./workspace-tools.js";
import { canonicalizeWorkspaceMutation, WAYANG_WORKSPACE_CHANGE_TOOL_NAME, WAYANG_WORKSPACE_READ_TOOL_NAME } from "./workspace-control.js";
import type { AgentProfileRow, ProjectRow } from "./workspace-types.js";

const project: ProjectRow = {
  id: "project",
  cwd: "/synthetic/project",
  name: "Synthetic",
  description: null,
  color: null,
  default_agent_profile_id: "standard",
  default_provider: null,
  default_model: null,
  access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
  created_at: 1,
  updated_at: 1,
};

function profile(id: string, resourceMode: AgentProfileRow["resource_mode"]): AgentProfileRow {
  return {
    id,
    name: id,
    description: null,
    builtin_kind: null,
    deletable: true,
    enabled: true,
    resource_mode: resourceMode,
    instructions: null,
    memory_access: "none",
    default_provider: null,
    default_model: null,
    allowed_tools: resourceMode === "standard" ? null : [],
    allowed_extensions: resourceMode === "standard" ? null : [],
    created_at: 1,
    updated_at: 1,
  };
}

test("workspace tool assembly is Standard-interactive only and preserves exact names", () => {
  assert.equal(workspaceToolsAllowedForRuntime({ restricted: false, scheduledJobId: null, scheduledRunId: null }), true);
  assert.equal(workspaceToolsAllowedForRuntime({ restricted: true, scheduledJobId: null, scheduledRunId: null }), false);
  assert.equal(workspaceToolsAllowedForRuntime({ restricted: false, scheduledJobId: "job", scheduledRunId: null }), false);
  assert.equal(workspaceToolsAllowedForRuntime({ restricted: false, scheduledJobId: null, scheduledRunId: "run" }), false);
  assert.deepEqual(createWorkspaceToolDefinitions({ sourceSessionId: "immutable-source" }).map((tool) => tool.name), [
    WAYANG_WORKSPACE_READ_TOOL_NAME,
    WAYANG_WORKSPACE_CHANGE_TOOL_NAME,
  ]);
});

test("workspace tool schemas use provider-compatible top-level objects", () => {
  for (const tool of createWorkspaceToolDefinitions({ sourceSessionId: "immutable-source" })) {
    const parameters = tool.parameters as Record<string, unknown>;
    assert.equal(parameters.type, "object", `${tool.name} parameters must be a top-level object`);
    assert.equal("anyOf" in parameters, false, `${tool.name} must not use a top-level anyOf`);
    assert.equal("oneOf" in parameters, false, `${tool.name} must not use a top-level oneOf`);
  }
});

test("workspace read tool retains strict action-specific fields behind its object schema", async () => {
  const calls: Array<{ sourceSessionId: string; request: unknown }> = [];
  const service = {
    async read(sourceSessionId: string, request: unknown) {
      calls.push({ sourceSessionId, request });
      return { ok: true };
    },
  };
  const read = createWorkspaceToolDefinitions({ sourceSessionId: "immutable-source", service: service as any })
    .find((tool) => tool.name === WAYANG_WORKSPACE_READ_TOOL_NAME)!;
  const execute = read.execute as any;
  const valid = [
    { action: "get_workspace_settings" },
    { action: "get_agent_profile_references", id: "profile" },
    { action: "list_projects" },
    { action: "get_project", id: "project" },
    { action: "list_agent_profiles" },
    { action: "get_agent_profile", id: "profile" },
    { action: "get_project_instructions_metadata", project_id: "project" },
    { action: "get_project_instructions", project_id: "project" },
  ];

  for (const params of valid) await execute("synthetic-call", params);
  assert.deepEqual(calls, valid.map((request) => ({ sourceSessionId: "immutable-source", request })));

  for (const params of [
    { action: "get_project" },
    { action: "list_projects", id: "incompatible" },
    { action: "get_project", id: "project", project_id: "incompatible" },
  ]) {
    await assert.rejects(() => execute("synthetic-invalid", params), /requires id|incompatible fields/);
  }
  assert.equal(calls.length, valid.length, "invalid action shapes must not reach the workspace service");
});

test("workspace change tool schema accepts explicit null default pairs and stays strict", () => {
  const change = createWorkspaceToolDefinitions({ sourceSessionId: "immutable-source" })
    .find((tool) => tool.name === WAYANG_WORKSPACE_CHANGE_TOOL_NAME)!;
  const validate = (proposal: Record<string, unknown>) => validateToolArguments(change as any, {
    type: "toolCall",
    id: "nullable-defaults",
    name: change.name,
    arguments: { mode: "preview", proposal },
  });

  const workspaceDefaultProposal = {
    mutation_type: "workspace_default_agent_profile_update",
    mutation: { default_agent_profile_id: "stable-profile-id" },
  };
  assert.deepEqual(validate(workspaceDefaultProposal), { mode: "preview", proposal: workspaceDefaultProposal });
  assert.throws(() => validate({
    mutation_type: "workspace_default_agent_profile_update",
    mutation: { default_agent_profile_id: "stable-profile-id", replace_references: true },
  }), /Validation failed/);

  for (const proposal of [
    {
      mutation_type: "project_create",
      mutation: { cwd: "/synthetic/project", default_provider: null, default_model: null },
    },
    {
      mutation_type: "project_update",
      mutation: { id: "project", updates: { default_provider: null, default_model: null } },
    },
    {
      mutation_type: "agent_profile_create",
      mutation: { name: "Synthetic", default_provider: null, default_model: null },
    },
    {
      mutation_type: "agent_profile_update",
      mutation: { id: "profile", updates: { default_provider: null, default_model: null } },
    },
  ]) {
    assert.deepEqual(validate(proposal), { mode: "preview", proposal });
  }

  for (const invalid of [42, true, {}, []]) {
    const validated = validate({
      mutation_type: "project_create",
      mutation: { cwd: "/synthetic/project", default_provider: invalid, default_model: null },
    }) as any;
    assert.deepEqual(validated.proposal.mutation.default_provider, invalid);
    assert.throws(() => canonicalizeWorkspaceMutation(validated.proposal), /default_provider must be a nonempty string or null/);
  }
  assert.throws(() => validate({
    mutation_type: "project_create",
    mutation: { cwd: "/synthetic/project", default_provider: null, default_model: null, forged: true },
  }), /Validation failed/);
});

test("final live policy permits workspace tools only with exact standard-resource authority", () => {
  for (const toolName of [WAYANG_WORKSPACE_READ_TOOL_NAME, WAYANG_WORKSPACE_CHANGE_TOOL_NAME]) {
    const standardProfile = profile("standard", "standard");
    const standardWithoutAuthority = authorizeAgentToolCall({
      cwd: project.cwd,
      project,
      agentProfile: standardProfile,
      toolName,
      params: {},
      sourceSessionId: "source",
    });
    assert.equal(standardWithoutAuthority.allowed, false, "resource_mode alone must not grant workspace tools");
    assert.equal(authorizeAgentToolCall({
      cwd: project.cwd,
      project,
      agentProfile: standardProfile,
      toolName,
      params: {},
      sourceSessionId: "source",
      standardResourcesAuthorized: true,
    }).allowed, true);
    const restricted = authorizeAgentToolCall({
      cwd: project.cwd,
      project: { ...project, default_agent_profile_id: "restricted" },
      agentProfile: profile("restricted", "project_only"),
      toolName,
      params: {},
      sourceSessionId: "source",
    });
    assert.equal(restricted.allowed, false);
    assert.match(restricted.reason ?? "", /unavailable for restricted/);
  }
});
