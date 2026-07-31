import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRestrictedMcpChildEnvironment,
  loadRestrictedMcpConfig,
  MAX_RESTRICTED_MCP_SERIALIZED_RESULT_BYTES,
  MAX_RESTRICTED_MCP_STDOUT_FRAME_BYTES,
  RestrictedMcpClientPool,
  RestrictedMcpDeniedError,
  RestrictedMcpService,
  type RestrictedMcpLiveContext,
} from "./index.js";

const PROFILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALLOWED_TOOL = "web_search_exa";
const BLOCKED_TOOL = "synthetic_future_mutation";
const STDERR_CANARY = "SYNTHETIC_STDERR_SECRET_CANARY_DO_NOT_SURFACE";

function shellFreeWrapperSource(): string {
  if (process.execPath.includes("\n") || process.execPath.includes("\r")) throw new Error("invalid synthetic node path");
  return `#!${process.execPath}\nimport "./synthetic-server.mjs";\n`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("real SDK stdio filters tools and environment, discards stderr, and terminates its synthetic child", { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-restricted-mcp-stdio-"));
  const project = path.join(root, "project");
  const serverPath = path.join(root, "synthetic-server.mjs");
  const wrapperPath = path.join(root, "synthetic-mcp-wrapper.mjs");
  const mutationMarker = path.join(root, "blocked-tool-dispatched");
  const configPath = path.join(root, "policy.json");
  fs.mkdirSync(project, { mode: 0o700 });

  const serverIndexUrl = new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href;
  const serverStdioUrl = new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href;
  const sdkTypesUrl = new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href;
  fs.writeFileSync(serverPath, [
    `import fs from ${JSON.stringify("node:fs")};`,
    `import { Server } from ${JSON.stringify(serverIndexUrl)};`,
    `import { StdioServerTransport } from ${JSON.stringify(serverStdioUrl)};`,
    `import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(sdkTypesUrl)};`,
    `const allowed = ${JSON.stringify(ALLOWED_TOOL)};`,
    `const blocked = ${JSON.stringify(BLOCKED_TOOL)};`,
    `const mutationMarker = ${JSON.stringify(mutationMarker)};`,
    `process.stderr.write(${JSON.stringify(`${STDERR_CANARY}\n`)});`,
    `const server = new Server({ name: "wayang-synthetic-stdio", version: "1" }, { capabilities: { tools: {} } });`,
    `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [`,
    `  { name: allowed, description: "synthetic allowed environment inspection", inputSchema: { type: "object", properties: { echo: { type: "string" } }, additionalProperties: false } },`,
    `  { name: blocked, description: "synthetic mutation canary", inputSchema: { type: "object", properties: {}, additionalProperties: false } },`,
    `] }));`,
    `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
    `  if (request.params.name === blocked) {`,
    `    fs.writeFileSync(mutationMarker, "DISPATCHED");`,
    `    return { content: [{ type: "text", text: "blocked tool was dispatched" }] };`,
    `  }`,
    `  if (request.params.name !== allowed) return { isError: true, content: [{ type: "text", text: "unknown tool" }] };`,
    `  const envEntries = Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right));`,
    `  return { content: [{ type: "text", text: JSON.stringify({`,
    `    pid: process.pid,`,
    `    echo: request.params.arguments?.echo ?? null,`,
    `    envKeys: envEntries.map(([key]) => key),`,
    `    envValues: envEntries.map(([, value]) => value),`,
    `  }) }] };`,
    `});`,
    `await server.connect(new StdioServerTransport());`,
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(wrapperPath, shellFreeWrapperSource(), { mode: 0o700 });

  fs.writeFileSync(configPath, JSON.stringify({
    schema_version: 1,
    grants: [{
      agent_profile_id: PROFILE_ID,
      project_cwd: project,
      servers: {
        exasearch: {
          command: wrapperPath,
          args: [],
          allowed_tools: [ALLOWED_TOOL],
        },
      },
    }],
  }), { mode: 0o600 });

  const context: RestrictedMcpLiveContext = {
    sourceSessionId: SESSION_ID,
    runtimeGeneration: "stdio-generation",
    scheduledJobId: null,
    scheduledRunId: null,
    isSubagent: false,
    agentProfile: { id: PROFILE_ID, enabled: true, resourceMode: "project_only", memoryAccess: "read" },
    project: { cwd: project, privacyMode: "protected", allowedAgentProfileIds: [PROFILE_ID] },
  };
  const childEnvironment = buildRestrictedMcpChildEnvironment({
    HOME: "/synthetic/HOME_VALUE_CANARY",
    USER: "synthetic-user",
    LANG: "C",
    PATH: "/synthetic/PATH_VALUE_CANARY",
    OPENAI_API_KEY: "SYNTHETIC_PROVIDER_VALUE_CANARY",
    EXA_API_KEY: "SYNTHETIC_EXA_VALUE_CANARY",
    WAYANG_APPS_CAPABILITY: "SYNTHETIC_CAPABILITY_VALUE_CANARY",
    COMMAND_GUARD_PIN: "SYNTHETIC_PIN_VALUE_CANARY",
    BW_SESSION: "SYNTHETIC_BW_SESSION_VALUE_CANARY",
  });
  const service = new RestrictedMcpService({
    sourceSessionId: SESSION_ID,
    runtimeGeneration: "stdio-generation",
    getLiveContext: () => context,
    loadConfig: () => loadRestrictedMcpConfig(configPath),
  }, new RestrictedMcpClientPool({
    environment: childEnvironment,
    idleTimeoutMs: 60_000,
    operationTimeoutMs: 5_000,
  }));

  const originalStderrWrite = process.stderr.write;
  let observedParentStderr = "";
  let childPid: number | undefined;
  let operationError: unknown;
  try {
    process.stderr.write = function captureStderr(chunk: string | Uint8Array): boolean {
      observedParentStderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    } as typeof process.stderr.write;

    const listed = await service.execute({ server: "exasearch" }) as { tools: Array<{ name: string }> };
    assert.deepEqual(listed.tools.map((tool) => tool.name), [ALLOWED_TOOL]);
    await assert.rejects(
      () => service.execute({ server: "exasearch", tool: BLOCKED_TOOL, args: "{}" }),
      (error: unknown) => error instanceof RestrictedMcpDeniedError && error.code === "tool_denied",
    );
    assert.equal(fs.existsSync(mutationMarker), false, "blocked advertised tool must fail before SDK dispatch");

    const called = await service.execute({
      server: "exasearch",
      tool: ALLOWED_TOOL,
      args: JSON.stringify({ echo: "synthetic-echo" }),
    }) as { result: string };
    assert.doesNotMatch(JSON.stringify(called), new RegExp(STDERR_CANARY));
    const sdkResult = JSON.parse(called.result) as { content: Array<{ type: string; text: string }> };
    const childResult = JSON.parse(sdkResult.content[0]!.text) as {
      pid: number;
      echo: string;
      envKeys: string[];
      envValues: string[];
    };
    childPid = childResult.pid;
    assert.equal(childResult.echo, "synthetic-echo");
    assert.deepEqual(childResult.envKeys, ["LANG", "PATH", "USER"]);
    assert.deepEqual(childResult.envValues.sort(), ["/usr/local/bin:/usr/bin:/bin", "C", "synthetic-user"].sort());
    const serializedEnvironment = JSON.stringify({ keys: childResult.envKeys, values: childResult.envValues });
    assert.doesNotMatch(serializedEnvironment, /HOME|OPENAI|EXA_API|WAYANG_APPS|COMMAND_GUARD|BW_SESSION|PROVIDER_VALUE|CAPABILITY_VALUE|PIN_VALUE|PATH_VALUE_CANARY/);
    for (const forbiddenValue of [
      "/synthetic/HOME_VALUE_CANARY",
      "/synthetic/PATH_VALUE_CANARY",
      "SYNTHETIC_PROVIDER_VALUE_CANARY",
      "SYNTHETIC_EXA_VALUE_CANARY",
      "SYNTHETIC_CAPABILITY_VALUE_CANARY",
      "SYNTHETIC_PIN_VALUE_CANARY",
      "SYNTHETIC_BW_SESSION_VALUE_CANARY",
    ]) assert.equal(childResult.envValues.includes(forbiddenValue), false);
    assert.doesNotMatch(observedParentStderr, new RegExp(STDERR_CANARY));
    assert.equal(processIsAlive(childPid), true);
  } catch (error) {
    operationError = error;
  } finally {
    process.stderr.write = originalStderrWrite;
    try { await service.close(); } catch (error) { operationError ??= error; }
  }

  try {
    if (operationError) throw operationError;
    assert.ok(childPid, "allowed call must return the synthetic child pid");
    await waitForExit(childPid);
    assert.equal(processIsAlive(childPid), false, "service close must terminate the stdio child");
  } finally {
    if (childPid && processIsAlive(childPid)) {
      try { process.kill(childPid, "SIGKILL"); } catch { /* synthetic child already exited */ }
      await waitForExit(childPid);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounded stdio framing rejects oversized and unterminated synthetic stdout and closes each child", { timeout: 20_000 }, async (t) => {
  assert.ok(MAX_RESTRICTED_MCP_STDOUT_FRAME_BYTES > MAX_RESTRICTED_MCP_SERIALIZED_RESULT_BYTES);
  assert.ok(MAX_RESTRICTED_MCP_STDOUT_FRAME_BYTES <= MAX_RESTRICTED_MCP_SERIALIZED_RESULT_BYTES + 1024 * 1024);

  const runCase = async (kind: "oversized" | "unterminated"): Promise<void> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wayang-restricted-mcp-frame-${kind}-`));
    const project = path.join(root, "project");
    const wrapperPath = path.join(root, `synthetic-${kind}-wrapper.mjs`);
    const pidPath = path.join(root, "child.pid");
    const configPath = path.join(root, "policy.json");
    fs.mkdirSync(project, { mode: 0o700 });
    const stdoutProgram = kind === "oversized"
      ? `process.stdout.write("OVERSIZED_FRAME_PRIVATE_CANARY" + "x".repeat(${MAX_RESTRICTED_MCP_STDOUT_FRAME_BYTES})); setInterval(() => {}, 1000);`
      : `process.stdout.write(${JSON.stringify('{"private":"UNTERMINATED_FRAME_PRIVATE_CANARY"}')}); setTimeout(() => process.exit(0), 20);`;
    fs.writeFileSync(wrapperPath, [
      `#!${process.execPath}`,
      `import fs from "node:fs";`,
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      stdoutProgram,
    ].join("\n"), { mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify({
      schema_version: 1,
      grants: [{
        agent_profile_id: PROFILE_ID,
        project_cwd: project,
        servers: {
          exasearch: { command: wrapperPath, args: [], allowed_tools: [ALLOWED_TOOL] },
        },
      }],
    }), { mode: 0o600 });
    const context: RestrictedMcpLiveContext = {
      sourceSessionId: SESSION_ID,
      runtimeGeneration: `frame-${kind}`,
      scheduledJobId: null,
      scheduledRunId: null,
      isSubagent: false,
      agentProfile: { id: PROFILE_ID, enabled: true, resourceMode: "project_only", memoryAccess: "read" },
      project: { cwd: project, privacyMode: "protected", allowedAgentProfileIds: [PROFILE_ID] },
    };
    const service = new RestrictedMcpService({
      sourceSessionId: SESSION_ID,
      runtimeGeneration: `frame-${kind}`,
      getLiveContext: () => context,
      loadConfig: () => loadRestrictedMcpConfig(configPath),
    }, new RestrictedMcpClientPool({ operationTimeoutMs: 5_000, idleTimeoutMs: 60_000 }));
    let childPid: number | undefined;
    try {
      await assert.rejects(() => service.execute({ server: "exasearch" }), (error: unknown) => {
        assert.ok(error instanceof RestrictedMcpDeniedError);
        assert.equal(error.code, "operation_failed");
        assert.equal(error.message, "restricted MCP operation failed");
        assert.doesNotMatch(error.message, /PRIVATE_CANARY|OVERSIZED|UNTERMINATED/);
        return true;
      });
      await waitForFile(pidPath);
      assert.equal(fs.existsSync(pidPath), true);
      childPid = Number(fs.readFileSync(pidPath, "utf8"));
      assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true);
      await service.close();
      await waitForExit(childPid);
      assert.equal(processIsAlive(childPid), false, `${kind} framing failure must terminate its child`);
    } finally {
      await service.close().catch(() => undefined);
      if (childPid && processIsAlive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* synthetic child already exited */ }
        await waitForExit(childPid);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  await t.test("oversized frame", () => runCase("oversized"));
  await t.test("unterminated frame", () => runCase("unterminated"));
});
