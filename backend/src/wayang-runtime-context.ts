import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const WAYANG_RUNTIME_CONTEXT_TOOL_NAME = "wayang_runtime_context";

export interface WayangRuntimeContext {
  webSessionId: string;
  cwd: string;
  scheduledJobId?: string | null;
  scheduledRunId?: string | null;
  agentProfileId?: string | null;
}

export interface WayangRuntimeContextResult {
  session_id: string;
  cwd: string;
  scheduled: boolean;
  scheduled_job_id?: string;
  scheduled_run_id?: string;
  agent_profile_id?: string;
}

/**
 * Create one immutable, session-bound context tool. The result is constructed
 * only from values supplied by createPiSession; execution performs no lookup or
 * I/O and therefore cannot drift to another same-cwd session.
 */
export function createWayangRuntimeContextToolDefinition(context: WayangRuntimeContext) {
  const result: WayangRuntimeContextResult = {
    session_id: context.webSessionId,
    cwd: context.cwd,
    scheduled: Boolean(context.scheduledJobId || context.scheduledRunId),
  };
  if (context.scheduledJobId) result.scheduled_job_id = context.scheduledJobId;
  if (context.scheduledRunId) result.scheduled_run_id = context.scheduledRunId;
  if (context.agentProfileId) result.agent_profile_id = context.agentProfileId;

  // Close over the final serialized value rather than mutable runtime/store state.
  const serializedResult = JSON.stringify(result);
  return defineTool({
    name: WAYANG_RUNTIME_CONTEXT_TOOL_NAME,
    label: "Wayang Runtime Context",
    description: "Return the immutable durable Wayang session binding for this exact runtime. Takes no input and performs no filesystem, transcript, environment, credential, or network access.",
    promptSnippet: "Return this exact runtime's durable Wayang session ID and scheduling metadata",
    promptGuidelines: [
      "Use wayang_runtime_context when a workflow must bind an audit, gateway, or mutation to the exact current durable Wayang session; never infer a session ID from cwd or history.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return {
        content: [{ type: "text", text: serializedResult }],
        details: {},
      };
    },
  });
}

/** Keep required Wayang tools additive to session-specific tools such as bash. */
export function createWayangSessionCustomTools(
  context: WayangRuntimeContext,
  supplementalTools: ToolDefinition[] = [],
): ToolDefinition[] {
  return [createWayangRuntimeContextToolDefinition(context), ...supplementalTools];
}
