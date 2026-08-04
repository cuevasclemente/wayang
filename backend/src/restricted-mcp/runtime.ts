import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  loadRestrictedMcpConfigFromEnvironment,
  type RestrictedMcpConfig,
  type RestrictedMcpGrant,
  type RestrictedMcpServerAlias,
} from "./config.js";
import { RestrictedMcpClientPool, type RestrictedMcpClientPoolOptions } from "./client.js";
import {
  parseRestrictedMcpOperation,
  resolveRestrictedMcpGrant,
  RestrictedMcpDeniedError,
  RestrictedMcpService,
  type RestrictedMcpLiveContext,
  type RestrictedMcpOperation,
} from "./service.js";
import { createRestrictedMcpToolDefinition, RESTRICTED_MCP_TOOL_NAME } from "./tool.js";

export interface RestrictedMcpPreflightDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** The sole object the runtime owner needs to retain and identity-check. */
export interface RestrictedMcpRuntime {
  readonly tool: ToolDefinition;
  preflight(params: unknown): RestrictedMcpPreflightDecision;
  close(): Promise<void>;
}

export function includeRestrictedMcpActiveTool(
  tools: readonly string[] | undefined,
  runtime: RestrictedMcpRuntime | undefined,
): string[] | undefined {
  if (!runtime) return tools ? [...tools] : undefined;
  return [...new Set([...(tools ?? []), RESTRICTED_MCP_TOOL_NAME])];
}

export interface CreateRestrictedMcpRuntimeOptions {
  readonly sourceSessionId: string;
  readonly cwd: string;
  readonly agentProfileId: string;
  readonly runtimeGeneration: string;
  /** Must resolve the authoritative current Wayang runtime, never cached rows. */
  readonly getCurrentRuntime: () => RestrictedMcpLiveContext | null;
  /** Injection point for tests and private-policy reloads. Defaults to the optional environment path. */
  readonly loadConfig?: () => RestrictedMcpConfig | null;
  /** Injectable synthetic peer factory and lifecycle bounds; construction never connects. */
  readonly clientPoolOptions?: RestrictedMcpClientPoolOptions;
}

function matchesSource(options: CreateRestrictedMcpRuntimeOptions, context: RestrictedMcpLiveContext): boolean {
  return context.sourceSessionId === options.sourceSessionId
    && context.runtimeGeneration === options.runtimeGeneration
    && context.agentProfile.id === options.agentProfileId
    && context.project.cwd === options.cwd;
}

function operationAllowed(grant: RestrictedMcpGrant, operation: RestrictedMcpOperation): boolean {
  const getServer = (rawAlias: string | undefined) => {
    if (!rawAlias || !(rawAlias === "exasearch" || rawAlias === "mempalace" || rawAlias === "public-readonly")) return undefined;
    return grant.servers.get(rawAlias as RestrictedMcpServerAlias);
  };
  switch (operation.kind) {
    case "status":
      return true;
    case "connect":
    case "list":
      return Boolean(getServer(operation.alias));
    case "search":
      return operation.alias === undefined || Boolean(getServer(operation.alias));
    case "describe":
    case "call": {
      if (operation.alias !== undefined) return Boolean(getServer(operation.alias)?.allowedTools.has(operation.tool));
      let matches = 0;
      for (const server of grant.servers.values()) if (server.allowedTools.has(operation.tool)) matches += 1;
      return matches === 1;
    }
  }
}

/**
 * Create an eligible source-bound runtime without spawning or connecting to any
 * MCP server. Missing, malformed, or ineligible live policy returns null.
 */
export function createRestrictedMcpRuntime(options: CreateRestrictedMcpRuntimeOptions): RestrictedMcpRuntime | null {
  const loadConfig = options.loadConfig ?? (() => loadRestrictedMcpConfigFromEnvironment());
  let initialContext: RestrictedMcpLiveContext | null;
  let initialConfig: RestrictedMcpConfig | null;
  try {
    initialContext = options.getCurrentRuntime();
    initialConfig = loadConfig();
  } catch {
    return null;
  }
  if (!initialContext || !initialConfig || !matchesSource(options, initialContext)) return null;
  if (!resolveRestrictedMcpGrant(initialConfig, initialContext)) return null;

  // Pool construction allocates only in-memory maps/timers. The factory is not
  // invoked until service.execute reaches an authorized connect/list/call.
  const clients = new RestrictedMcpClientPool(options.clientPoolOptions);
  const service = new RestrictedMcpService({
    sourceSessionId: options.sourceSessionId,
    runtimeGeneration: options.runtimeGeneration,
    getLiveContext: options.getCurrentRuntime,
    loadConfig,
  }, clients);
  const tool = createRestrictedMcpToolDefinition(service);

  return Object.freeze({
    tool,
    preflight(params: unknown): RestrictedMcpPreflightDecision {
      let operation: RestrictedMcpOperation;
      try {
        operation = parseRestrictedMcpOperation(params);
      } catch (error) {
        return {
          allowed: false,
          reason: error instanceof RestrictedMcpDeniedError ? error.message : "invalid restricted MCP request",
        };
      }
      let context: RestrictedMcpLiveContext | null;
      let config: RestrictedMcpConfig | null;
      try {
        context = options.getCurrentRuntime();
        config = loadConfig();
      } catch {
        void service.disconnect();
        return { allowed: false, reason: "restricted MCP policy is unavailable" };
      }
      if (!context || !config || !matchesSource(options, context)) {
        void service.disconnect();
        return { allowed: false, reason: "restricted MCP runtime authorization was revoked" };
      }
      const grant = resolveRestrictedMcpGrant(config, context);
      if (!grant) {
        void service.disconnect();
        return { allowed: false, reason: "restricted MCP grant is unavailable" };
      }
      if (!operationAllowed(grant, operation)) return { allowed: false, reason: "restricted MCP server or tool is not granted" };
      return { allowed: true };
    },
    close(): Promise<void> {
      return service.close();
    },
  });
}
