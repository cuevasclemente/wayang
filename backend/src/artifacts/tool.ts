import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { authorizeArtifactSession } from "./authorization.js";
import { presentArtifacts, type PresentArtifactInput } from "./service.js";

export const PRESENT_ARTIFACT_TOOL_NAME = "present_artifact";

export interface ArtifactToolBinding {
  readonly sourceSessionId: string;
  readonly projectId: string;
  readonly projectCwd: string;
  readonly agentProfileId: string;
  readonly runtimeGeneration: string;
  readonly processBootNonce: string;
}

export interface ArtifactToolRuntime {
  readonly binding: ArtifactToolBinding;
  readonly tool: ToolDefinition;
  preflight(): { allowed: boolean; reason?: string };
  close(): Promise<void>;
}

export function createArtifactToolRuntime(input: {
  binding: ArtifactToolBinding;
  isCurrent(): boolean;
}): ArtifactToolRuntime {
  const binding = Object.freeze({ ...input.binding });
  let closed = false;
  const preflight = (): { allowed: boolean; reason?: string } => {
    if (closed) return { allowed: false, reason: "Artifact presentation runtime is closed" };
    try {
      if (!input.isCurrent()) return { allowed: false, reason: "Artifact presentation runtime is stale" };
      const current = authorizeArtifactSession(binding.sourceSessionId, "present");
      if (current.project.id !== binding.projectId || current.project.cwd !== binding.projectCwd
        || current.profile.id !== binding.agentProfileId) {
        return { allowed: false, reason: "Artifact presentation authority changed" };
      }
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : "Artifact presentation is unavailable" };
    }
  };

  const tool = defineTool({
    name: PRESENT_ARTIFACT_TOOL_NAME,
    label: "Present Artifact",
    description: "Deliberately share one or more completed files with the owner in this session's Artifacts pane. Registration does not change or copy source bytes; each later preview/download is reauthorized.",
    promptSnippet: "Present completed files in this session's Artifacts pane",
    promptGuidelines: [
      "Use present_artifact when a completed file would be useful for the owner to preview or download; ordinary file writes do not publish artifacts.",
      "Do not present credentials, secret-bearing files, browser profiles, transcripts, control-plane data, or files unrelated to the current task.",
    ],
    parameters: Type.Object({
      artifacts: Type.Array(Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        title: Type.Optional(Type.String({ maxLength: 120 })),
        description: Type.Optional(Type.String({ maxLength: 1000 })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params) {
      const before = preflight();
      if (!before.allowed) throw new Error(before.reason ?? "Artifact presentation is unavailable");
      const artifacts = presentArtifacts(
        binding.sourceSessionId,
        (params as { artifacts: PresentArtifactInput[] }).artifacts,
        toolCallId,
      );
      const after = preflight();
      if (!after.allowed) throw new Error(after.reason ?? "Artifact presentation result was suppressed");
      const details = {
        schema_version: 1 as const,
        kind: "wayang_artifact_presentation" as const,
        session_id: binding.sourceSessionId,
        artifacts,
      };
      return {
        content: [{
          type: "text" as const,
          text: artifacts.length === 1
            ? `Presented ${artifacts[0].name} in this session's Artifacts pane.`
            : `Presented ${artifacts.length} files in this session's Artifacts pane.`,
        }],
        details,
      };
    },
  });

  return {
    binding,
    tool,
    preflight,
    async close() { closed = true; },
  };
}
