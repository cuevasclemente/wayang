import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { RestrictedMcpDeniedError, RestrictedMcpService } from "./service.js";

export const RESTRICTED_MCP_TOOL_NAME = "mcp";

const RestrictedMcpParameters = Type.Object({
  tool: Type.Optional(Type.String({ maxLength: 128, description: "Exact granted underlying MCP tool name" })),
  args: Type.Optional(Type.String({ maxLength: 65_536, description: "JSON object arguments for an exact tool call" })),
  connect: Type.Optional(Type.String({ maxLength: 128, description: "Exact granted server alias to connect" })),
  describe: Type.Optional(Type.String({ maxLength: 128, description: "Exact granted tool name to describe" })),
  search: Type.Optional(Type.String({ maxLength: 256, description: "Case-insensitive literal search over granted tool names; regular expressions are unavailable" })),
  includeSchemas: Type.Optional(Type.Boolean({ description: "Include bounded input schemas in metadata results" })),
  server: Type.Optional(Type.String({ maxLength: 128, description: "Exact granted server alias for list/search/describe/call" })),
}, { additionalProperties: false });

/** Create the sole source-bound generic proxy definition for one live runtime. */
export function createRestrictedMcpToolDefinition(service: RestrictedMcpService) {
  return defineTool({
    name: RESTRICTED_MCP_TOOL_NAME,
    label: "MCP",
    description: "List, literal-search, describe, connect to, or call only the reviewed MCP servers and tools granted to this exact live Wayang runtime. Empty input returns status. Use server to list one server, or tool plus JSON-string args to call an exact tool name. Regex search is unavailable.",
    promptSnippet: "Access the exact backend-granted restricted MCP servers through one filtered proxy",
    promptGuidelines: [
      "The mcp proxy is an enforced allowlist, not a general MCP adapter; do not attempt aliases, global configuration, mutation tools, resources, auth, UI, sampling, or elicitation.",
      "Exa queries and fetched URLs are disclosed to Exa; never include credentials, recovery data, or secret values.",
      "A denied or unavailable MCP operation is not permission to bypass the restriction through bash, SDKs, gateways, or another tool.",
    ],
    parameters: RestrictedMcpParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      try {
        const result = await service.execute(params, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          // Raw MCP values are intentionally absent from details.
          details: { restricted: true },
        };
      } catch (error) {
        if (error instanceof RestrictedMcpDeniedError) throw new Error(`${error.code}: ${error.message}`);
        throw new Error("operation_failed: restricted MCP operation failed");
      }
    },
  });
}
