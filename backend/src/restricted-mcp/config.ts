import * as fs from "node:fs";
import * as path from "node:path";

export const RESTRICTED_MCP_SCHEMA_VERSION = 1;
export const MAX_RESTRICTED_MCP_CONFIG_BYTES = 128 * 1024;
export const MAX_RESTRICTED_MCP_GRANTS = 16;
export const MAX_RESTRICTED_MCP_SERVERS_PER_GRANT = 3;
export const MAX_RESTRICTED_MCP_TOOLS_PER_SERVER = 32;

export const REVIEWED_TOOL_CEILINGS = Object.freeze({
  exasearch: Object.freeze([
    "web_search_exa",
    "web_fetch_exa",
  ]),
  mempalace: Object.freeze([
    "mempalace_status",
    "mempalace_list_wings",
    "mempalace_list_rooms",
    "mempalace_get_taxonomy",
    "mempalace_get_aaak_spec",
    "mempalace_kg_query",
    "mempalace_kg_timeline",
    "mempalace_kg_stats",
    "mempalace_traverse",
    "mempalace_find_tunnels",
    "mempalace_graph_stats",
    "mempalace_search",
    "mempalace_check_duplicate",
    "mempalace_diary_read",
  ]),
  "public-readonly": Object.freeze([
    "get_accounts",
    "get_portfolio",
    "get_history",
    "get_quotes",
    "get_instrument",
  ]),
} as const);

export type RestrictedMcpServerAlias = keyof typeof REVIEWED_TOOL_CEILINGS;

export interface RestrictedMcpServerGrant {
  readonly command: string;
  readonly args: readonly string[];
  readonly allowedTools: ReadonlySet<string>;
}

export interface RestrictedMcpGrant {
  readonly agentProfileId: string;
  readonly projectCwd: string;
  readonly servers: ReadonlyMap<RestrictedMcpServerAlias, RestrictedMcpServerGrant>;
}

export interface RestrictedMcpConfig {
  readonly schemaVersion: 1;
  readonly grants: readonly RestrictedMcpGrant[];
  readonly fingerprint: string;
  readonly sourcePath: string;
}

export class RestrictedMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictedMcpConfigError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function fail(message: string): never {
  throw new RestrictedMcpConfigError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail(`${label} contains unsupported field ${key}`);
  for (const key of allowed) if (!(key in value)) fail(`${label} is missing ${key}`);
}

function fingerprint(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function assertOwnedPrivateFile(stat: fs.Stats, label: string, exact0600: boolean): void {
  if (!stat.isFile()) fail(`${label} must be a regular file`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) fail(`${label} must be owned by the Wayang user`);
  const mode = stat.mode & 0o777;
  if (exact0600 ? mode !== 0o600 : (mode & 0o022) !== 0) {
    fail(exact0600 ? `${label} must have mode 0600` : `${label} must not be group/other writable`);
  }
}

/** Revalidate a reviewed launcher without executing or reading it. */
export function validateRestrictedMcpCommand(command: string): string {
  if (!path.isAbsolute(command) || path.normalize(command) !== command) fail("server command must be a normalized absolute path");
  let link: fs.Stats;
  let stat: fs.Stats;
  let canonical: string;
  try {
    link = fs.lstatSync(command);
    if (link.isSymbolicLink()) fail("server command must not be a symlink");
    canonical = fs.realpathSync.native(command);
    stat = fs.statSync(command);
  } catch (error) {
    if (error instanceof RestrictedMcpConfigError) throw error;
    fail("server command is unavailable");
  }
  if (canonical !== command) fail("server command must be canonical");
  assertOwnedPrivateFile(stat, "server command", false);
  if ((stat.mode & 0o111) === 0) fail("server command must be executable");
  return canonical;
}

function parseServer(alias: RestrictedMcpServerAlias, value: unknown): RestrictedMcpServerGrant {
  if (!isRecord(value)) fail(`server ${alias} must be an object`);
  requireExactKeys(value, ["command", "args", "allowed_tools"], `server ${alias}`);
  if (typeof value.command !== "string") fail(`server ${alias} command must be a string`);
  const command = validateRestrictedMcpCommand(value.command);
  if (!Array.isArray(value.args) || value.args.length > 32 || !value.args.every((arg) => typeof arg === "string" && Buffer.byteLength(arg) <= 4096)) {
    fail(`server ${alias} args must be a bounded string array`);
  }
  if (!Array.isArray(value.allowed_tools) || value.allowed_tools.length === 0 || value.allowed_tools.length > MAX_RESTRICTED_MCP_TOOLS_PER_SERVER) {
    fail(`server ${alias} allowed_tools must be a nonempty bounded array`);
  }
  const ceiling = new Set<string>(REVIEWED_TOOL_CEILINGS[alias]);
  const tools = new Set<string>();
  for (const tool of value.allowed_tools) {
    if (typeof tool !== "string" || !NAME_RE.test(tool)) fail(`server ${alias} contains an invalid tool name`);
    if (!ceiling.has(tool)) fail(`server ${alias} requests an unreviewed tool`);
    if (tools.has(tool)) fail(`server ${alias} contains a duplicate tool`);
    tools.add(tool);
  }
  return Object.freeze({ command, args: Object.freeze([...value.args] as string[]), allowedTools: tools });
}

function parseGrant(value: unknown): RestrictedMcpGrant {
  if (!isRecord(value)) fail("grant must be an object");
  requireExactKeys(value, ["agent_profile_id", "project_cwd", "servers"], "grant");
  if (typeof value.agent_profile_id !== "string" || !UUID_RE.test(value.agent_profile_id)) fail("grant profile id must be a UUID");
  if (typeof value.project_cwd !== "string" || !path.isAbsolute(value.project_cwd) || path.normalize(value.project_cwd) !== value.project_cwd) {
    fail("grant project cwd must be a normalized absolute path");
  }
  let projectCwd: string;
  try {
    const stat = fs.statSync(value.project_cwd);
    if (!stat.isDirectory()) fail("grant project cwd must be a directory");
    projectCwd = fs.realpathSync.native(value.project_cwd);
  } catch (error) {
    if (error instanceof RestrictedMcpConfigError) throw error;
    fail("grant project cwd is unavailable");
  }
  if (projectCwd !== value.project_cwd) fail("grant project cwd must be canonical");
  if (!isRecord(value.servers)) fail("grant servers must be an object");
  const entries = Object.entries(value.servers);
  if (entries.length === 0 || entries.length > MAX_RESTRICTED_MCP_SERVERS_PER_GRANT) fail("grant must contain a bounded nonempty server set");
  const servers = new Map<RestrictedMcpServerAlias, RestrictedMcpServerGrant>();
  for (const [rawAlias, server] of entries) {
    if (!(rawAlias in REVIEWED_TOOL_CEILINGS)) fail(`grant contains unreviewed server alias ${rawAlias}`);
    const alias = rawAlias as RestrictedMcpServerAlias;
    servers.set(alias, parseServer(alias, server));
  }
  return Object.freeze({ agentProfileId: value.agent_profile_id, projectCwd, servers });
}

/**
 * Load the private grant through one no-follow descriptor and reject concurrent
 * metadata changes. No global/project MCP configuration is consulted.
 */
export function loadRestrictedMcpConfig(configPath: string): RestrictedMcpConfig {
  if (!path.isAbsolute(configPath) || path.normalize(configPath) !== configPath) fail("restricted MCP config path must be a normalized absolute path");
  let fd: number | undefined;
  try {
    fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    assertOwnedPrivateFile(before, "restricted MCP config", true);
    if (before.size <= 0 || before.size > MAX_RESTRICTED_MCP_CONFIG_BYTES) fail("restricted MCP config has an invalid size");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (fingerprint(before) !== fingerprint(after) || bytes.byteLength !== before.size) fail("restricted MCP config changed while loading");
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { fail("restricted MCP config is malformed JSON"); }
    if (!isRecord(parsed)) fail("restricted MCP config must be an object");
    requireExactKeys(parsed, ["schema_version", "grants"], "restricted MCP config");
    if (parsed.schema_version !== RESTRICTED_MCP_SCHEMA_VERSION) fail("unsupported restricted MCP schema version");
    if (!Array.isArray(parsed.grants) || parsed.grants.length === 0 || parsed.grants.length > MAX_RESTRICTED_MCP_GRANTS) fail("restricted MCP grants must be a bounded nonempty array");
    const grants = parsed.grants.map(parseGrant);
    const identities = new Set<string>();
    for (const grant of grants) {
      const identity = `${grant.agentProfileId}\0${grant.projectCwd}`;
      if (identities.has(identity)) fail("restricted MCP config contains a duplicate grant");
      identities.add(identity);
    }
    return Object.freeze({
      schemaVersion: 1,
      grants: Object.freeze(grants),
      fingerprint: fingerprint(after),
      sourcePath: configPath,
    });
  } catch (error) {
    if (error instanceof RestrictedMcpConfigError) throw error;
    fail("restricted MCP config is unavailable");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  // All reachable branches above return or throw. Keep an explicit terminal
  // fail for TypeScript's conservative try/catch/finally control-flow analysis.
  return fail("restricted MCP config load terminated unexpectedly");
}

export function loadRestrictedMcpConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): RestrictedMcpConfig | null {
  const configured = env.WAYANG_RESTRICTED_MCP_CONFIG_PATH;
  if (!configured) return null;
  return loadRestrictedMcpConfig(configured);
}
