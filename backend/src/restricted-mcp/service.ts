import * as fs from "node:fs";
import type {
  RestrictedMcpConfig,
  RestrictedMcpGrant,
  RestrictedMcpServerAlias,
  RestrictedMcpServerGrant,
} from "./config.js";
import { RestrictedMcpClientPool, type RestrictedMcpToolMetadata } from "./client.js";
import { renderRestrictedMcpOutput, type RestrictedMcpRenderedOutput } from "./output.js";

export interface RestrictedMcpLiveContext {
  readonly sourceSessionId: string;
  readonly runtimeGeneration: string;
  readonly scheduledJobId?: string | null;
  readonly scheduledRunId?: string | null;
  readonly isSubagent: boolean;
  readonly agentProfile: {
    readonly id: string;
    readonly enabled: boolean;
    readonly resourceMode: "standard" | "project_only" | "custom";
    readonly memoryAccess: "none" | "read" | "read_write";
  };
  readonly project: {
    readonly cwd: string;
    readonly privacyMode: "standard" | "protected";
    readonly allowedAgentProfileIds: readonly string[] | null;
  };
}

export interface RestrictedMcpSourceBinding {
  readonly sourceSessionId: string;
  readonly runtimeGeneration: string;
  readonly getLiveContext: () => RestrictedMcpLiveContext | null;
  readonly loadConfig: () => RestrictedMcpConfig | null;
}

export interface RestrictedMcpToolParams {
  readonly tool?: string;
  readonly args?: string;
  readonly connect?: string;
  readonly describe?: string;
  readonly search?: string;
  readonly includeSchemas?: boolean;
  readonly server?: string;
}

export type RestrictedMcpOperation =
  | { readonly kind: "status" }
  | { readonly kind: "connect"; readonly alias: string }
  | { readonly kind: "list"; readonly alias: string; readonly includeSchemas: boolean }
  | { readonly kind: "search"; readonly query: string; readonly alias?: string; readonly includeSchemas: boolean }
  | { readonly kind: "describe"; readonly tool: string; readonly alias?: string; readonly includeSchemas: boolean }
  | { readonly kind: "call"; readonly tool: string; readonly alias?: string; readonly args: Record<string, unknown> };

export class RestrictedMcpDeniedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RestrictedMcpDeniedError";
    this.code = code;
  }
}

const PARAM_KEYS = new Set(["tool", "args", "connect", "describe", "search", "regex", "includeSchemas", "server"]);
const TOOL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function denied(code: string, message: string): never {
  throw new RestrictedMcpDeniedError(code, message);
}

function boundedName(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOOL_NAME_RE.test(value)) denied("invalid_request", `${label} is invalid`);
  return value;
}

/** Independent validation for callers that bypass the TypeBox tool schema. */
export function parseRestrictedMcpOperation(input: unknown): RestrictedMcpOperation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) denied("invalid_request", "mcp input must be an object");
  const params = input as Record<string, unknown>;
  for (const key of Object.keys(params)) if (!PARAM_KEYS.has(key)) denied("invalid_request", `unsupported mcp field ${key}`);
  for (const key of ["regex", "includeSchemas"] as const) {
    if (params[key] !== undefined && typeof params[key] !== "boolean") denied("invalid_request", `${key} must be boolean`);
  }
  const tool = params.tool === undefined ? undefined : boundedName(params.tool, "tool");
  const connect = params.connect === undefined ? undefined : boundedName(params.connect, "connect");
  const describe = params.describe === undefined ? undefined : boundedName(params.describe, "describe");
  const server = params.server === undefined ? undefined : boundedName(params.server, "server");
  const search = params.search;
  if (search !== undefined && (typeof search !== "string" || search.length === 0 || Buffer.byteLength(search) > 256)) denied("invalid_request", "search must be a bounded nonempty string");
  const primaryCount = [tool, connect, describe, search].filter((value) => value !== undefined).length;
  if (primaryCount > 1) denied("invalid_request", "mcp modes are mutually exclusive");
  if (params.args !== undefined && tool === undefined) denied("invalid_request", "args is valid only with tool");
  if ((params.regex !== undefined) && search === undefined) denied("invalid_request", "regex is valid only with search");
  if (params.regex === true) denied("invalid_request", "regex search is unavailable; use literal search");
  if (connect !== undefined && (server !== undefined || params.includeSchemas !== undefined)) denied("invalid_request", "connect cannot be combined with metadata options");
  if (tool !== undefined) {
    if (params.includeSchemas !== undefined) denied("invalid_request", "includeSchemas is invalid for calls");
    let args: unknown = {};
    if (params.args !== undefined) {
      if (typeof params.args !== "string" || Buffer.byteLength(params.args) > 64 * 1024) denied("invalid_request", "args must be bounded JSON");
      try { args = JSON.parse(params.args); } catch { denied("invalid_request", "args must be valid JSON"); }
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) denied("invalid_request", "args JSON must be an object");
    return { kind: "call", tool, alias: server, args: args as Record<string, unknown> };
  }
  if (connect !== undefined) return { kind: "connect", alias: connect };
  if (describe !== undefined) return { kind: "describe", tool: describe, alias: server, includeSchemas: params.includeSchemas === true };
  if (typeof search === "string") return { kind: "search", query: search, alias: server, includeSchemas: params.includeSchemas === true };
  if (server !== undefined) return { kind: "list", alias: server, includeSchemas: params.includeSchemas === true };
  if (params.includeSchemas !== undefined) denied("invalid_request", "includeSchemas requires a metadata mode");
  return { kind: "status" };
}

export function resolveRestrictedMcpGrant(config: RestrictedMcpConfig, context: RestrictedMcpLiveContext): RestrictedMcpGrant | null {
  if (!context.agentProfile.enabled || context.agentProfile.resourceMode !== "project_only" || context.agentProfile.memoryAccess !== "read") return null;
  if (context.project.privacyMode !== "protected" || context.isSubagent || context.scheduledJobId || context.scheduledRunId) return null;
  if (!context.project.allowedAgentProfileIds?.includes(context.agentProfile.id)) return null;
  let canonicalCwd: string;
  try { canonicalCwd = fs.realpathSync.native(context.project.cwd); } catch { return null; }
  if (canonicalCwd !== context.project.cwd) return null;
  return config.grants.find((grant) => grant.agentProfileId === context.agentProfile.id && grant.projectCwd === canonicalCwd) ?? null;
}

function sanitizeMetadata(tool: RestrictedMcpToolMetadata, includeSchema: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = { name: tool.name };
  if (typeof tool.description === "string") result.description = tool.description.slice(0, 2_000);
  if (includeSchema && tool.inputSchema !== undefined) {
    try {
      const encoded = JSON.stringify(tool.inputSchema);
      if (encoded.length <= 12_000) result.inputSchema = tool.inputSchema;
      else result.schemaOmitted = "schema exceeded metadata bound";
    } catch {
      result.schemaOmitted = "schema was not serializable";
    }
  }
  return result;
}

export class RestrictedMcpService {
  readonly #binding: RestrictedMcpSourceBinding;
  readonly #clients: RestrictedMcpClientPool;
  #closed = false;

  constructor(binding: RestrictedMcpSourceBinding, clients = new RestrictedMcpClientPool()) {
    this.#binding = binding;
    this.#clients = clients;
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.#closed) denied("unavailable", "restricted MCP runtime is closed");
    const operation = parseRestrictedMcpOperation(input);
    try {
      const grant = await this.#authorize();
      switch (operation.kind) {
        case "status":
          return {
            servers: [...grant.servers.keys()].sort(),
            connected: this.#clients.connectedAliases().filter((alias) => grant.servers.has(alias as RestrictedMcpServerAlias)),
            capabilities: ["status", "list", "search", "describe", "connect", "call"],
            searchMode: "literal",
          };
        case "connect": {
          const serverGrant = this.#server(grant, operation.alias);
          await this.#peer(operation.alias, serverGrant, signal);
          const tools = await this.#listFiltered(operation.alias, serverGrant, signal);
          return { server: operation.alias, connected: true, toolCount: tools.length };
        }
        case "list": {
          const serverGrant = this.#server(grant, operation.alias);
          const tools = await this.#listFiltered(operation.alias, serverGrant, signal);
          return { server: operation.alias, tools: tools.map((tool) => sanitizeMetadata(tool, operation.includeSchemas)) };
        }
        case "search": {
          const query = operation.query.toLowerCase();
          const matcher = (name: string): boolean => name.toLowerCase().includes(query);
          const aliases = operation.alias ? [operation.alias] : [...grant.servers.keys()].sort();
          const matches: Record<string, unknown>[] = [];
          for (const alias of aliases) {
            const currentGrant = await this.#authorize();
            const serverGrant = this.#server(currentGrant, alias);
            for (const tool of await this.#listFiltered(alias, serverGrant, signal)) {
              if (matcher(tool.name)) matches.push({ server: alias, ...sanitizeMetadata(tool, operation.includeSchemas) });
            }
          }
          return { matches };
        }
        case "describe": {
          const located = await this.#locate(grant, operation.tool, operation.alias, signal);
          return { server: located.alias, tool: sanitizeMetadata(located.tool, operation.includeSchemas) };
        }
        case "call": {
          const located = await this.#locate(grant, operation.tool, operation.alias, signal);
          // A second live resolution immediately before dispatch makes revocation
          // effective even after metadata discovery or connection.
          const currentGrant = await this.#authorize();
          const serverGrant = this.#server(currentGrant, located.alias);
          if (!serverGrant.allowedTools.has(operation.tool)) denied("tool_denied", "tool is not granted");
          let peer = await this.#peer(located.alias, serverGrant, signal);
          const dispatchGrant = await this.#authorize();
          const dispatchServer = this.#server(dispatchGrant, located.alias);
          if (!dispatchServer.allowedTools.has(operation.tool)) denied("tool_denied", "tool grant was revoked before dispatch");
          // Re-fetching also replaces a peer if the reviewed command/args binding
          // changed while metadata was being resolved.
          peer = await this.#clients.get(located.alias, dispatchServer, signal);
          const value = await peer.callTool(operation.tool, operation.args, { signal, timeoutMs: this.#clients.operationTimeoutMs() });
          // Re-resolve after the potentially long remote call and before any
          // personal/financial bytes enter the model or project artifact path.
          const postCallGrant = await this.#authorize();
          const postCallServer = this.#server(postCallGrant, located.alias);
          if (!postCallServer.allowedTools.has(operation.tool)) denied("tool_denied", "tool grant was revoked during execution");
          if (typeof value === "object" && value !== null && (value as Record<string, unknown>).isError === true) {
            // MCP error content can contain provider response bodies, auth details,
            // command paths, or stderr. Never surface it.
            denied("server_error", "restricted MCP server reported an error");
          }
          const output = renderRestrictedMcpOutput({
            alias: located.alias as RestrictedMcpServerAlias,
            projectCwd: postCallGrant.projectCwd,
            sourceSessionId: this.#binding.sourceSessionId,
            value,
          });
          return this.#renderCall(located.alias, operation.tool, output);
        }
      }
    } catch (error) {
      if (error instanceof RestrictedMcpDeniedError) throw error;
      // A crashed, aborted, timed-out, or malformed peer is never retained for a
      // later operation. Deliberately omit SDK errors, stderr, provider bodies,
      // and local paths from the replacement error.
      await this.#clients.disconnectAll();
      denied("operation_failed", "restricted MCP operation failed");
    }
  }

  /** Drop live children after an outer synchronous preflight revocation. */
  async disconnect(): Promise<void> {
    await this.#clients.disconnectAll();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#clients.close();
  }

  async #authorize(): Promise<RestrictedMcpGrant> {
    const context = this.#binding.getLiveContext();
    if (!context || context.sourceSessionId !== this.#binding.sourceSessionId || context.runtimeGeneration !== this.#binding.runtimeGeneration) {
      await this.#clients.disconnectAll();
      denied("runtime_revoked", "restricted MCP runtime authorization was revoked");
    }
    let config: RestrictedMcpConfig | null;
    try { config = this.#binding.loadConfig(); } catch {
      await this.#clients.disconnectAll();
      denied("policy_unavailable", "restricted MCP policy is unavailable");
    }
    const grant = config && resolveRestrictedMcpGrant(config, context);
    if (!grant) {
      await this.#clients.disconnectAll();
      denied("grant_revoked", "restricted MCP grant is unavailable");
    }
    await this.#clients.retainAliases(new Set(grant.servers.keys()));
    return grant;
  }

  #server(grant: RestrictedMcpGrant, rawAlias: string): RestrictedMcpServerGrant {
    if (!(rawAlias === "exasearch" || rawAlias === "mempalace" || rawAlias === "public-readonly")) denied("server_denied", "server is not granted");
    const server = grant.servers.get(rawAlias);
    if (!server) denied("server_denied", "server is not granted");
    return server;
  }

  async #peer(alias: string, _server: RestrictedMcpServerGrant, signal?: AbortSignal) {
    const currentGrant = await this.#authorize();
    const currentServer = this.#server(currentGrant, alias);
    return this.#clients.get(alias, currentServer, signal);
  }

  async #listFiltered(alias: string, server: RestrictedMcpServerGrant, signal?: AbortSignal): Promise<readonly RestrictedMcpToolMetadata[]> {
    const peer = await this.#peer(alias, server, signal);
    const advertised = await peer.listTools({ signal, timeoutMs: this.#clients.operationTimeoutMs() });
    const currentGrant = await this.#authorize();
    const currentServer = this.#server(currentGrant, alias);
    const byName = new Map(advertised.map((tool) => [tool.name, tool]));
    return [...currentServer.allowedTools].sort().flatMap((name) => {
      const tool = byName.get(name);
      return tool ? [tool] : [];
    });
  }

  async #locate(grant: RestrictedMcpGrant, toolName: string, requestedAlias: string | undefined, signal?: AbortSignal): Promise<{ alias: string; tool: RestrictedMcpToolMetadata }> {
    if (requestedAlias) {
      const server = this.#server(grant, requestedAlias);
      if (!server.allowedTools.has(toolName)) denied("tool_denied", "tool is not granted on this server");
      const metadata = (await this.#listFiltered(requestedAlias, server, signal)).find((tool) => tool.name === toolName);
      if (!metadata) denied("tool_unavailable", "granted tool is unavailable");
      return { alias: requestedAlias, tool: metadata };
    }
    const matches: Array<{ alias: string; tool: RestrictedMcpToolMetadata }> = [];
    for (const [alias, server] of grant.servers) {
      if (!server.allowedTools.has(toolName)) continue;
      const metadata = (await this.#listFiltered(alias, server, signal)).find((tool) => tool.name === toolName);
      if (metadata) matches.push({ alias, tool: metadata });
    }
    if (matches.length === 0) denied("tool_denied", "tool is not granted or unavailable");
    if (matches.length > 1) denied("ambiguous_tool", "tool name is ambiguous; specify server");
    return matches[0]!;
  }

  #renderCall(alias: string, tool: string, output: RestrictedMcpRenderedOutput): Record<string, unknown> {
    const result: Record<string, unknown> = { server: alias, tool, result: output.text, truncated: output.truncated };
    if (output.artifact) result.artifact = {
      path: output.artifact.relativePath,
      bytes: output.artifact.bytes,
      sha256: output.artifact.sha256,
    };
    return result;
  }
}
