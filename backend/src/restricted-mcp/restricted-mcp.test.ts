import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRestrictedMcpChildEnvironment,
  createRestrictedMcpRuntime,
  includeRestrictedMcpActiveTool,
  loadRestrictedMcpConfig,
  MAX_RESTRICTED_MCP_SERIALIZED_RESULT_BYTES,
  renderRestrictedMcpOutput,
  RESTRICTED_MCP_TOOL_NAME,
  REVIEWED_TOOL_CEILINGS,
  RestrictedMcpClientPool,
  RestrictedMcpConfigError,
  type RestrictedMcpPeer,
  type RestrictedMcpPeerFactory,
} from "./index.js";
import {
  parseRestrictedMcpOperation,
  resolveRestrictedMcpGrant,
  RestrictedMcpDeniedError,
  RestrictedMcpService,
  type RestrictedMcpLiveContext,
} from "./service.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function fixture(): {
  root: string;
  project: string;
  configPath: string;
  commands: Record<keyof typeof REVIEWED_TOOL_CEILINGS, string>;
  writeConfig(transform?: (value: Record<string, unknown>) => void): void;
  cleanup(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-restricted-mcp-"));
  const project = path.join(root, "project");
  const launchers = path.join(root, "launchers");
  fs.mkdirSync(project, { mode: 0o700 });
  fs.mkdirSync(launchers, { mode: 0o700 });
  const commands = Object.fromEntries(Object.keys(REVIEWED_TOOL_CEILINGS).map((alias) => {
    const command = path.join(launchers, alias);
    fs.writeFileSync(command, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    return [alias, command];
  })) as Record<keyof typeof REVIEWED_TOOL_CEILINGS, string>;
  const configPath = path.join(root, "policy.json");
  const writeConfig = (transform?: (value: Record<string, unknown>) => void) => {
    const value: Record<string, unknown> = {
      schema_version: 1,
      grants: [{
        agent_profile_id: PROFILE_ID,
        project_cwd: project,
        servers: Object.fromEntries(Object.entries(REVIEWED_TOOL_CEILINGS).map(([alias, tools]) => [alias, {
          command: commands[alias as keyof typeof commands],
          args: [],
          allowed_tools: [...tools],
        }])),
      }],
    };
    transform?.(value);
    fs.writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
  };
  writeConfig();
  return { root, project, configPath, commands, writeConfig, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function liveContext(project: string): RestrictedMcpLiveContext {
  return {
    sourceSessionId: SESSION_ID,
    runtimeGeneration: "generation-1",
    scheduledJobId: null,
    scheduledRunId: null,
    isSubagent: false,
    agentProfile: { id: PROFILE_ID, enabled: true, resourceMode: "project_only", memoryAccess: "read" },
    project: { cwd: project, privacyMode: "protected", allowedAgentProfileIds: [PROFILE_ID] },
  };
}

class FakePeer implements RestrictedMcpPeer {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;
  throwCanary = false;
  returnErrorCanary = false;
  constructor(readonly tools: readonly string[]) {}
  async listTools() {
    return [...this.tools, "place_order", "cancel_order", "mempalace_kg_add", "mempalace_diary_write", "report_publish", "future_mutation"]
      .map((name) => ({ name, description: `Synthetic metadata for ${name}`, inputSchema: { type: "object" } }));
  }
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (this.throwCanary) throw new Error("SYNTHETIC_CREDENTIAL_AND_PROVIDER_BODY_CANARY");
    if (this.returnErrorCanary) return { isError: true, content: [{ type: "text", text: "SYNTHETIC_PROVIDER_RESPONSE_BODY_CANARY" }] };
    if (name === "get_portfolio") return { content: [{ type: "text", text: "x".repeat(20_000) }] };
    return { content: [{ type: "text", text: `synthetic result for ${name}` }] };
  }
  async close() { this.closed = true; }
}

function fakeFactory(f: ReturnType<typeof fixture>): { factory: RestrictedMcpPeerFactory; peers: Map<string, FakePeer>; environments: Readonly<Record<string, string>>[] } {
  const peers = new Map<string, FakePeer>();
  const environments: Readonly<Record<string, string>>[] = [];
  return {
    peers,
    environments,
    factory: {
      async connect(options) {
        environments.push(options.env);
        const alias = (Object.entries(f.commands).find(([, command]) => command === options.command)?.[0]) as keyof typeof REVIEWED_TOOL_CEILINGS | undefined;
        assert.ok(alias, "only a synthetic reviewed fixture command may connect");
        const peer = new FakePeer(REVIEWED_TOOL_CEILINGS[alias]);
        peers.set(alias, peer);
        return peer;
      },
    },
  };
}

test("strict private parser accepts reviewed subsets and rejects extension fields, mutations, unsafe mode, and symlinks", () => {
  const f = fixture();
  try {
    const parsed = loadRestrictedMcpConfig(f.configPath);
    assert.equal(parsed.grants.length, 1);
    assert.deepEqual([...parsed.grants[0]!.servers.keys()].sort(), ["exasearch", "mempalace", "public-readonly"]);

    f.writeConfig((value) => {
      const grant = (value.grants as Array<Record<string, unknown>>)[0]!;
      const publicServer = (grant.servers as Record<string, Record<string, unknown>>)["public-readonly"]!;
      publicServer.env = { SYNTHETIC_SECRET: "not-real" };
    });
    assert.throws(() => loadRestrictedMcpConfig(f.configPath), RestrictedMcpConfigError);

    f.writeConfig((value) => {
      const grant = (value.grants as Array<Record<string, unknown>>)[0]!;
      const publicServer = (grant.servers as Record<string, Record<string, unknown>>)["public-readonly"]!;
      publicServer.allowed_tools = ["get_accounts", "place_order"];
    });
    assert.throws(() => loadRestrictedMcpConfig(f.configPath), /unreviewed tool/);

    const commandSymlink = path.join(f.root, "launcher-symlink");
    fs.symlinkSync(f.commands.exasearch, commandSymlink);
    f.writeConfig((value) => {
      const grant = (value.grants as Array<Record<string, unknown>>)[0]!;
      const exa = (grant.servers as Record<string, Record<string, unknown>>).exasearch!;
      exa.command = commandSymlink;
    });
    assert.throws(() => loadRestrictedMcpConfig(f.configPath), /symlink/);

    f.writeConfig();
    fs.chmodSync(f.configPath, 0o666);
    assert.throws(() => loadRestrictedMcpConfig(f.configPath), /mode 0600/);
    fs.unlinkSync(f.configPath);
    fs.symlinkSync(f.commands.exasearch, f.configPath);
    assert.throws(() => loadRestrictedMcpConfig(f.configPath), RestrictedMcpConfigError);
  } finally { f.cleanup(); }
});

test("eligibility requires the exact live protected project-only read profile and complete scheduling identity", () => {
  const f = fixture();
  try {
    const config = loadRestrictedMcpConfig(f.configPath);
    const eligible = liveContext(f.project);
    assert.ok(resolveRestrictedMcpGrant(config, eligible));
    assert.equal(resolveRestrictedMcpGrant(config, { ...eligible, isSubagent: true }), null);
    assert.ok(resolveRestrictedMcpGrant(config, {
      ...eligible,
      scheduledJobId: "job-1",
      scheduledRunId: "run-1",
    }));
    assert.equal(resolveRestrictedMcpGrant(config, { ...eligible, scheduledRunId: "run-1" }), null);
    assert.equal(resolveRestrictedMcpGrant(config, { ...eligible, scheduledJobId: "job-1" }), null);
    assert.equal(resolveRestrictedMcpGrant(config, { ...eligible, project: { ...eligible.project, privacyMode: "standard" } }), null);
    assert.equal(resolveRestrictedMcpGrant(config, { ...eligible, project: { ...eligible.project, allowedAgentProfileIds: [] } }), null);
    assert.equal(resolveRestrictedMcpGrant(config, { ...eligible, agentProfile: { ...eligible.agentProfile, id: "33333333-3333-4333-8333-333333333333" } }), null);
    assert.equal(resolveRestrictedMcpGrant(config, { ...eligible, agentProfile: { ...eligible.agentProfile, resourceMode: "standard" } }), null);
    assert.equal(resolveRestrictedMcpGrant(config, { ...eligible, agentProfile: { ...eligible.agentProfile, memoryAccess: "read_write" } }), null);
  } finally { f.cleanup(); }
});

test("eligible restricted MCP runtime is appended to Pi's explicit active-tool allowlist exactly once", () => {
  const base = ["read", "edit", "write", "grep", "find", "ls", "bash"];
  const runtime = {
    tool: { name: RESTRICTED_MCP_TOOL_NAME },
    preflight: () => ({ allowed: true }),
    async close() {},
  } as any;
  assert.equal(includeRestrictedMcpActiveTool(undefined, undefined), undefined);
  assert.deepEqual(includeRestrictedMcpActiveTool(base, undefined), base);
  assert.deepEqual(includeRestrictedMcpActiveTool(base, runtime), [...base, RESTRICTED_MCP_TOOL_NAME]);
  assert.deepEqual(includeRestrictedMcpActiveTool([...base, RESTRICTED_MCP_TOOL_NAME], runtime), [...base, RESTRICTED_MCP_TOOL_NAME]);
  assert.deepEqual(base, ["read", "edit", "write", "grep", "find", "ls", "bash"], "caller list remains immutable");
});

test("runtime factory returns null without connecting and exposes identity-stable tool plus synchronous live preflight", async () => {
  const f = fixture();
  const fake = fakeFactory(f);
  let live = liveContext(f.project);
  try {
    const deniedRuntime = createRestrictedMcpRuntime({
      sourceSessionId: SESSION_ID,
      cwd: f.project,
      agentProfileId: PROFILE_ID,
      runtimeGeneration: "generation-1",
      getCurrentRuntime: () => ({ ...live, isSubagent: true }),
      loadConfig: () => loadRestrictedMcpConfig(f.configPath),
      clientPoolOptions: { factory: fake.factory },
    });
    assert.equal(deniedRuntime, null);
    assert.equal(fake.environments.length, 0, "ineligible factory must not invoke the peer factory");

    const runtime = createRestrictedMcpRuntime({
      sourceSessionId: SESSION_ID,
      cwd: f.project,
      agentProfileId: PROFILE_ID,
      runtimeGeneration: "generation-1",
      getCurrentRuntime: () => live,
      loadConfig: () => loadRestrictedMcpConfig(f.configPath),
      clientPoolOptions: { factory: fake.factory, idleTimeoutMs: 60_000 },
    });
    assert.ok(runtime);
    assert.equal(runtime.tool.name, RESTRICTED_MCP_TOOL_NAME);
    assert.deepEqual(runtime.preflight({}), { allowed: true });
    assert.deepEqual(runtime.preflight({ tool: "get_accounts", server: "public-readonly", args: "{}" }), { allowed: true });
    assert.equal(runtime.preflight({ tool: "place_order", server: "public-readonly", args: "{}" }).allowed, false);
    assert.equal(runtime.preflight({ action: "auth-start" }).allowed, false);
    f.writeConfig((value) => {
      const grant = (value.grants as Array<Record<string, unknown>>)[0]!;
      const server = (grant.servers as Record<string, Record<string, unknown>>)["public-readonly"]!;
      server.allowed_tools = ["get_portfolio", "get_history", "get_quotes", "get_instrument"];
    });
    assert.equal(runtime.preflight({ tool: "get_accounts", server: "public-readonly", args: "{}" }).allowed, false, "live tool tightening must be synchronous");
    f.writeConfig();
    assert.equal(fake.environments.length, 0, "preflight must never connect or spawn");

    await runtime.tool.execute("synthetic-call", { connect: "public-readonly" }, undefined, undefined, {} as never);
    assert.equal(fake.environments.length, 1);
    live = { ...live, runtimeGeneration: "generation-2" };
    const revoked = runtime.preflight({});
    assert.equal(revoked.allowed, false);
    assert.match(revoked.reason ?? "", /revoked/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.peers.get("public-readonly")?.closed, true);
    await runtime.close();
  } finally { f.cleanup(); }
});

test("operation parser rejects unknown fields, contradictory modes, non-object args, and adapter-only action", () => {
  assert.deepEqual(parseRestrictedMcpOperation({}), { kind: "status" });
  assert.deepEqual(parseRestrictedMcpOperation({ server: "mempalace" }), { kind: "list", alias: "mempalace", includeSchemas: false });
  assert.throws(() => parseRestrictedMcpOperation({ action: "auth-start" }), /unsupported mcp field/);
  assert.throws(() => parseRestrictedMcpOperation({ tool: "get_accounts", search: "account" }), /mutually exclusive/);
  assert.throws(() => parseRestrictedMcpOperation({ tool: "get_accounts", args: "[]" }), /must be an object/);
  assert.throws(() => parseRestrictedMcpOperation({ regex: true }), /only with search/);
  assert.throws(() => parseRestrictedMcpOperation({ search: "(a+)+$", regex: true }), /regex search is unavailable/);
  assert.deepEqual(parseRestrictedMcpOperation({ search: "account", regex: false }), { kind: "search", query: "account", alias: undefined, includeSchemas: false });
});

test("child environment is an exact harmless-name allowlist and strips synthetic secret/capability names", () => {
  const env = buildRestrictedMcpChildEnvironment({
    HOME: "/synthetic/home",
    USER: "synthetic",
    LANG: "C.UTF-8",
    PATH: "/synthetic/untrusted",
    OPENAI_API_KEY: "SYNTHETIC",
    EXA_API_KEY: "SYNTHETIC",
    PUBLIC_API_SECRET: "SYNTHETIC",
    BW_SESSION: "SYNTHETIC",
    WAYANG_APPS_CAPABILITY: "SYNTHETIC",
    COMMAND_GUARD_PIN: "SYNTHETIC",
  });
  assert.deepEqual(env, { PATH: "/usr/local/bin:/usr/bin:/bin", USER: "synthetic", LANG: "C.UTF-8" });
  assert.equal("HOME" in env, false, "reviewed wrappers must use fixed paths or set an isolated HOME themselves");
});

test("synthetic end-to-end metadata exposes exactly 21 reviewed tools and blocks mutations before dispatch", async () => {
  const f = fixture();
  const fake = fakeFactory(f);
  let live: RestrictedMcpLiveContext | null = liveContext(f.project);
  const clients = new RestrictedMcpClientPool({ factory: fake.factory, environment: buildRestrictedMcpChildEnvironment({ HOME: f.root }), idleTimeoutMs: 60_000 });
  const service = new RestrictedMcpService({
    sourceSessionId: SESSION_ID,
    runtimeGeneration: "generation-1",
    getLiveContext: () => live,
    loadConfig: () => loadRestrictedMcpConfig(f.configPath),
  }, clients);
  try {
    // Canary files are deliberately ignored: the subsystem accepts no global or
    // project MCP config inputs at all.
    fs.writeFileSync(path.join(f.root, "synthetic-global-mcp.json"), JSON.stringify({ reportPublisher: true }));
    fs.writeFileSync(path.join(f.project, ".mcp.json"), JSON.stringify({ futureServer: true }));
    assert.deepEqual(await service.execute({}), {
      servers: ["exasearch", "mempalace", "public-readonly"],
      connected: [],
      capabilities: ["status", "list", "search", "describe", "connect", "call"],
      searchMode: "literal",
    });
    const searched = await service.execute({ search: "_" }) as { matches: Array<{ name: string }> };
    assert.equal(searched.matches.length, 21);
    assert.equal(searched.matches.some((entry) => entry.name === "place_order" || entry.name === "report_publish"), false);

    const publicList = await service.execute({ server: "public-readonly", includeSchemas: true }) as { tools: Array<{ name: string }> };
    assert.deepEqual(publicList.tools.map((tool) => tool.name), [...REVIEWED_TOOL_CEILINGS["public-readonly"]].sort());
    await assert.rejects(() => service.execute({ tool: "place_order", args: "{}", server: "public-readonly" }), (error: unknown) => {
      assert.ok(error instanceof RestrictedMcpDeniedError);
      assert.equal(error.code, "tool_denied");
      return true;
    });
    assert.equal(fake.peers.get("public-readonly")!.calls.length, 0);

    const call = await service.execute({ tool: "get_accounts", args: "{}", server: "public-readonly" });
    assert.match(String(call.result), /synthetic result/);
    assert.deepEqual(fake.peers.get("public-readonly")!.calls.map((entry) => entry.name), ["get_accounts"]);

    live = { ...live!, runtimeGeneration: "generation-2" };
    await assert.rejects(() => service.execute({}), (error: unknown) => {
      assert.ok(error instanceof RestrictedMcpDeniedError);
      assert.equal(error.code, "runtime_revoked");
      return true;
    });
    assert.equal([...fake.peers.values()].every((peer) => peer.closed), true, "source-generation revocation closes connected peers");

    live = { ...live!, runtimeGeneration: "generation-1", agentProfile: { ...live!.agentProfile, enabled: false } };
    await assert.rejects(() => service.execute({}), /grant is unavailable/);
  } finally {
    await service.close();
    f.cleanup();
  }
});

test("serialized MCP results have a conservative hard ceiling before preview or spill", () => {
  const f = fixture();
  try {
    assert.throws(() => renderRestrictedMcpOutput({
      alias: "public-readonly",
      projectCwd: f.project,
      sourceSessionId: SESSION_ID,
      value: { content: "x".repeat(MAX_RESTRICTED_MCP_SERIALIZED_RESULT_BYTES + 1) },
    }), /exceeds protected output limit/);
    assert.equal(fs.existsSync(path.join(f.project, ".wayang")), false, "over-limit output must not create an artifact tree");
  } finally { f.cleanup(); }
});

test("protected output rejects a symlinked project-local spill parent", () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.project, ".wayang"));
    assert.throws(() => renderRestrictedMcpOutput({
      alias: "public-readonly",
      projectCwd: f.project,
      sourceSessionId: SESSION_ID,
      value: { content: "x".repeat(20_000) },
    }), /unsafe/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { f.cleanup(); }
});

test("oversized Public output spills only under a private source-session project path", async () => {
  const f = fixture();
  const fake = fakeFactory(f);
  const service = new RestrictedMcpService({
    sourceSessionId: SESSION_ID,
    runtimeGeneration: "generation-1",
    getLiveContext: () => liveContext(f.project),
    loadConfig: () => loadRestrictedMcpConfig(f.configPath),
  }, new RestrictedMcpClientPool({ factory: fake.factory, idleTimeoutMs: 60_000 }));
  try {
    const result = await service.execute({ tool: "get_portfolio", args: "{}", server: "public-readonly" }) as {
      artifact: { path: string; bytes: number; sha256: string };
      result: string;
      truncated: boolean;
    };
    assert.equal(result.truncated, true);
    assert.match(result.artifact.path, /^\.wayang\/mcp-results\/22222222-2222-4222-8222-222222222222\//);
    const artifact = path.join(f.project, result.artifact.path);
    assert.equal(fs.realpathSync.native(artifact).startsWith(`${f.project}${path.sep}`), true);
    assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(artifact)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(artifact).size, result.artifact.bytes);
  } finally {
    await service.close();
    f.cleanup();
  }
});

test("SDK/provider failures are sanitized and never return stderr/body canaries", async () => {
  const f = fixture();
  const fake = fakeFactory(f);
  const service = new RestrictedMcpService({
    sourceSessionId: SESSION_ID,
    runtimeGeneration: "generation-1",
    getLiveContext: () => liveContext(f.project),
    loadConfig: () => loadRestrictedMcpConfig(f.configPath),
  }, new RestrictedMcpClientPool({ factory: fake.factory, idleTimeoutMs: 60_000 }));
  try {
    await service.execute({ connect: "public-readonly" });
    fake.peers.get("public-readonly")!.returnErrorCanary = true;
    await assert.rejects(() => service.execute({ tool: "get_accounts", args: "{}", server: "public-readonly" }), (error: unknown) => {
      assert.ok(error instanceof RestrictedMcpDeniedError);
      assert.equal(error.code, "server_error");
      assert.doesNotMatch(error.message, /CANARY|credential|provider/i);
      return true;
    });
    fake.peers.get("public-readonly")!.returnErrorCanary = false;
    fake.peers.get("public-readonly")!.throwCanary = true;
    await assert.rejects(() => service.execute({ tool: "get_accounts", args: "{}", server: "public-readonly" }), (error: unknown) => {
      assert.ok(error instanceof RestrictedMcpDeniedError);
      assert.equal(error.code, "operation_failed");
      assert.doesNotMatch(error.message, /CANARY|credential|provider/i);
      return true;
    });
  } finally {
    await service.close();
    f.cleanup();
  }
});
