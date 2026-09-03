import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { workspaceSettingsService, type WorkspaceReadAction, type WorkspaceSettingsService } from "./workspace-settings-service.js";
import { WorkspaceStoreError } from "./workspace-types.js";
import { WAYANG_WORKSPACE_CHANGE_TOOL_NAME, WAYANG_WORKSPACE_READ_TOOL_NAME } from "./workspace-control.js";
export { WAYANG_WORKSPACE_CHANGE_TOOL_NAME, WAYANG_WORKSPACE_READ_TOOL_NAME } from "./workspace-control.js";

// Pi 0.84.1 coerces typed string schemas before tool execution, including
// string|null unions (null becomes "" or numbers become strings). Preserve the
// raw JSON value here; the canonical workspace parser strictly enforces
// nonempty string|null semantics before preview or commit authority is issued.
const NullableString = Type.Unknown({ description: "A nonempty JSON string or null; other JSON types are rejected by the backend." });
const DefaultFields = {
  default_provider: Type.Optional(NullableString),
  default_model: Type.Optional(NullableString),
};
const AccessPolicy = Type.Object({
  privacy_mode: Type.Union([Type.Literal("standard"), Type.Literal("protected")]),
  allowed_agent_profile_ids: Type.Union([Type.Array(Type.String()), Type.Null()]),
}, { additionalProperties: false });

const Mutation = Type.Union([
  Type.Object({
    mutation_type: Type.Literal("workspace_default_agent_profile_update"),
    mutation: Type.Object({
      default_agent_profile_id: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    mutation_type: Type.Literal("project_create"),
    mutation: Type.Object({
      cwd: Type.String(),
      name: Type.Optional(Type.String()),
      description: Type.Optional(NullableString),
      color: Type.Optional(NullableString),
      default_agent_profile_id: Type.Optional(Type.String()),
      ...DefaultFields,
      access_policy: Type.Optional(AccessPolicy),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    mutation_type: Type.Literal("project_update"),
    mutation: Type.Object({
      id: Type.String(),
      updates: Type.Object({
        name: Type.Optional(Type.String()),
        description: Type.Optional(NullableString),
        color: Type.Optional(NullableString),
        default_agent_profile_id: Type.Optional(Type.String()),
        ...DefaultFields,
        access_policy: Type.Optional(AccessPolicy),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    mutation_type: Type.Literal("project_delete_registration"),
    mutation: Type.Object({ id: Type.String() }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    mutation_type: Type.Literal("agent_profile_create"),
    mutation: Type.Object({
      name: Type.String(),
      description: Type.Optional(NullableString),
      resource_mode: Type.Optional(Type.Union([Type.Literal("project_only"), Type.Literal("custom")])),
      instructions: Type.Optional(NullableString),
      memory_access: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("read_write")])),
      ...DefaultFields,
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    mutation_type: Type.Literal("agent_profile_update"),
    mutation: Type.Object({
      id: Type.String(),
      updates: Type.Object({
        name: Type.Optional(Type.String()),
        description: Type.Optional(NullableString),
        enabled: Type.Optional(Type.Boolean()),
        resource_mode: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("project_only"), Type.Literal("custom")])),
        instructions: Type.Optional(NullableString),
        memory_access: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("read_write")])),
        ...DefaultFields,
      }, { additionalProperties: false }),
      replacement_agent_profile_id: Type.Optional(NullableString),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    mutation_type: Type.Literal("agent_profile_delete"),
    mutation: Type.Object({
      id: Type.String(),
      replacement_agent_profile_id: Type.Optional(NullableString),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    mutation_type: Type.Literal("project_instructions_write"),
    mutation: Type.Object({
      project_id: Type.String(),
      text: Type.String(),
      expected_sha256: Type.Optional(NullableString),
      create_if_missing: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

const ReadParameters = Type.Union([
  Type.Object({ action: Type.Literal("get_workspace_settings") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("get_agent_profile_references"), id: Type.String() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list_projects") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("get_project"), id: Type.String() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list_agent_profiles") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("get_agent_profile"), id: Type.String() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("get_project_instructions_metadata"), project_id: Type.String() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("get_project_instructions"), project_id: Type.String() }, { additionalProperties: false }),
]);

function textResult(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new WorkspaceStoreError("Workspace tool result is not JSON-serializable");
  return { content: [{ type: "text" as const, text: serialized }], details: {} };
}

export interface WorkspaceToolFactoryOptions {
  sourceSessionId: string;
  service?: WorkspaceSettingsService;
}

export function createWorkspaceToolDefinitions(options: WorkspaceToolFactoryOptions): ToolDefinition[] {
  const service = options.service ?? workspaceSettingsService;
  const sourceSessionId = options.sourceSessionId;
  const read = defineTool({
    name: WAYANG_WORKSPACE_READ_TOOL_NAME,
    label: "Wayang Workspace Read",
    description: "Read bounded Wayang workspace-default, project, agent-profile, redacted profile-reference, and project-root AGENTS.md state for this exact authorized Standard interactive session. Profile instructions and AGENTS.md content enter the session transcript when detail/content actions are used; prefer metadata actions unless content is necessary.",
    promptSnippet: "Read Wayang workspace registration and agent profile settings",
    promptGuidelines: [
      "Prefer list and project-instructions metadata actions; request private instruction text only when the task requires it.",
      "Never use workspace reads to reproduce control-plane text in approval prompts.",
    ],
    parameters: ReadParameters,
    async execute(_toolCallId, params) {
      return textResult(await service.read(sourceSessionId, params as WorkspaceReadAction));
    },
  });

  const change = defineTool({
    name: WAYANG_WORKSPACE_CHANGE_TOOL_NAME,
    label: "Wayang Workspace Change",
    description: "Preview or commit one Wayang workspace-default, project, agent-profile, or project-root AGENTS.md mutation. Every commit requires the exact one-question approval returned by preview to be submitted through Wayang questionnaire/interview UI with the predefined APPROVE option. This tool never creates or deletes project directories.",
    promptSnippet: "Preview and commit exact human-approved Wayang workspace settings changes",
    promptGuidelines: [
      "Always call preview first, then submit exactly its questionnaire schema through questionnaire (preferred) or interview in this same session.",
      "After the human submits, pass the questionnaire request_id and server submission_id, the unchanged mutation, and preview expires_at to commit.",
      "Approval summaries must never contain profile instruction text, AGENTS.md text, transcripts, financial data, credentials, or secrets.",
    ],
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("preview"), Type.Literal("commit")]),
      proposal: Mutation,
      request_id: Type.Optional(Type.String()),
      submission_id: Type.Optional(Type.String()),
      expires_at: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const value = params as {
        mode: "preview" | "commit";
        proposal: unknown;
        request_id?: string;
        submission_id?: string;
        expires_at?: string;
      };
      if (value.mode === "preview") {
        if (value.request_id !== undefined || value.submission_id !== undefined || value.expires_at !== undefined) {
          throw new WorkspaceStoreError("Preview does not accept approval result fields");
        }
        return textResult(service.previewAgentMutation(sourceSessionId, value.proposal));
      }
      if (!value.request_id?.trim() || !value.submission_id?.trim() || !value.expires_at?.trim()) {
        throw new WorkspaceStoreError("Commit requires request_id, submission_id, and expires_at");
      }
      const result = await service.commitAgentMutation({
        sourceSessionId,
        raw: value.proposal,
        requestId: value.request_id.trim(),
        submissionId: value.submission_id.trim(),
        expiresAt: value.expires_at.trim(),
      });
      return textResult(result);
    },
  });
  return [read, change];
}

export function workspaceToolsAllowedForRuntime(options: {
  restricted: boolean;
  scheduledJobId: string | null;
  scheduledRunId: string | null;
}): boolean {
  return !options.restricted && options.scheduledJobId === null && options.scheduledRunId === null;
}
