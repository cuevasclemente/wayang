import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createAgentProfile } from "./agent-profiles.js";
import { CapabilityBoundProtectedBrowser } from "./browser/protected-browser.js";
import { createProtectedBrowserToolRuntime, INTERACTIVE_BROWSER_TOOL_NAMES } from "./browser/protected-tools.js";
import type { ProtectedBrowserBinding } from "./browser/types.js";
import { close, init } from "./db.js";
import {
  createPiSession,
  destroyPiSession,
  getLiveInteractiveBrowserRuntime,
  getLiveProtectedBrowserRuntime,
  getPiSessionBrowserAgentDiagnostic,
} from "./pi-bridge.js";
import { createProject } from "./projects.js";
import { getBashSandboxAvailability } from "./sandbox-bash.js";
import { createSession } from "./sessions.js";

function runtimeFactory(dataDir: string, captured: ProtectedBrowserBinding[]) {
  return async (binding: ProtectedBrowserBinding) => {
    captured.push({ ...binding });
    const browser = new CapabilityBoundProtectedBrowser({
      dataDir,
      binding,
      authority: {
        resolve: async (current) => ({
          ...current,
          authorized: true,
          privacyMode: current.capabilityId === "wayang.standard-browser.v1" ? "standard" : "protected",
          sourceSessionDurable: true,
          sourceQuarantined: false,
          profileEnabled: true,
          projectAllowsProfile: true,
        }),
      },
      backend: {
        async execute(operation) { return { value: { operation: operation.kind } }; },
        stop() {},
      },
    });
    return createProtectedBrowserToolRuntime({ browser });
  };
}

test("Standard interactive sessions derive exact browser tools while scheduled sessions do not", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-standard-browser-injection-"));
  const dataDir = path.join(root, "data");
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.WAYANG_DATA_DIR = dataDir;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
  close();
  init();
  t.after(async () => {
    await Promise.allSettled([]);
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const profile = createAgentProfile({ name: "Standard browser profile", resource_mode: "project_only" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  const captured: ProtectedBrowserBinding[] = [];
  const factory = runtimeFactory(dataDir, captured);

  const neutralCaptured: ProtectedBrowserBinding[] = [];
  const neutralProbe = defineTool({
    name: "browser_workspace_probe",
    label: "Synthetic browser workspace probe",
    description: "Synthetic exact-object runtime contract probe.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() { return { content: [{ type: "text" as const, text: "neutral-standard-runtime" }], details: {} }; },
  });
  let invalidFactoryRevocations = 0;
  const invalidLease = createSession(projectRoot, {
    agentProfileId: profile.id,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  await assert.rejects(
    createPiSession(invalidLease.id, projectRoot, invalidLease.provider, invalidLease.model, undefined, {
      protectedBrowserFactory: async (binding) => ({
        kind: "standard" as const,
        binding: { ...binding, controlGeneration: binding.controlGeneration + 1 },
        tools: Object.freeze([neutralProbe]),
        toolForName(name: string) { return name === neutralProbe.name ? neutralProbe : undefined; },
        preflight() { return { allowed: true as const }; },
        async detachAgentLease() {},
        async closeSessionWorkspaces() {},
        async revokeAuthority() { invalidFactoryRevocations++; },
      }),
    }),
    /non-exact runtime lease/,
  );
  assert.equal(invalidFactoryRevocations, 1, "invalid factory lease is revoked rather than merely detached");

  const neutralFactory = async (binding: ProtectedBrowserBinding) => {
    neutralCaptured.push({ ...binding });
    let detached = false;
    return {
      kind: "standard" as const,
      binding: { ...binding },
      tools: [neutralProbe],
      toolForName(name: string) { return name === neutralProbe.name ? neutralProbe : undefined; },
      preflight: () => detached
        ? { allowed: false as const, reason: "synthetic detached" }
        : { allowed: true as const },
      async detachAgentLease() { detached = true; },
      async closeSessionWorkspaces() { detached = true; },
      async revokeAuthority() { detached = true; },
    };
  };
  const neutral = createSession(projectRoot, {
    agentProfileId: profile.id,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  const neutralHandle = await createPiSession(neutral.id, projectRoot, neutral.provider, neutral.model, undefined, {
    protectedBrowserFactory: neutralFactory,
  });
  assert.equal(neutralCaptured.length, 1);
  assert.equal(neutralCaptured[0].sourceSessionId, neutral.id);
  assert.equal(getLiveProtectedBrowserRuntime(neutral.id), undefined, "neutral Standard runtime never masquerades as Protected route integration");
  assert.notEqual(getPiSessionBrowserAgentDiagnostic(neutral.id).reason_code, "fresh_runtime_required");
  assert.ok(neutralHandle.session.getActiveToolNames().includes(neutralProbe.name));
  const neutralRegistry = (neutralHandle.session as any)._toolRegistry as Map<string, any>;
  const neutralResult = await neutralRegistry.get(neutralProbe.name).execute("synthetic-probe", {});
  assert.equal(neutralResult.content[0].text, "neutral-standard-runtime");
  await destroyPiSession(neutral.id);

  const approved = createSession(projectRoot, {
    agentProfileId: profile.id,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  const approvedHandle = await createPiSession(approved.id, projectRoot, approved.provider, approved.model, undefined, { protectedBrowserFactory: factory });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].capabilityId, "wayang.standard-browser.v1");
  assert.deepEqual(
    INTERACTIVE_BROWSER_TOOL_NAMES.filter((name) => approvedHandle.session.getActiveToolNames().includes(name)),
    [...INTERACTIVE_BROWSER_TOOL_NAMES],
  );
  const expectedRestrictedTools = [
    "read", "edit", "write",
    "wayang_runtime_context", "session_list", "session_read", "session_attachments",
    "wayang_workspace_read", "wayang_workspace_change",
    ...INTERACTIVE_BROWSER_TOOL_NAMES,
  ];
  if (getBashSandboxAvailability().available) expectedRestrictedTools.push("bash");
  assert.deepEqual(
    new Set(approvedHandle.session.getActiveToolNames()),
    new Set(expectedRestrictedTools),
    "derived Standard runtime receives reviewed resources, available host bash, and exact browser tools",
  );
  const live = getLiveInteractiveBrowserRuntime(approved.id);
  assert.ok(live);
  const registry = (approvedHandle.session as any)._toolRegistry as Map<string, unknown>;
  const definitions = (approvedHandle.session as any)._toolDefinitions as Map<string, { definition: unknown }>;
  for (const tool of live!.tools) {
    assert.equal(definitions.get(tool.name)?.definition, tool, `${tool.name} definition`);
    assert.equal(registry.has(tool.name), true, `${tool.name} registry entry`);
  }
  assert.equal(getPiSessionBrowserAgentDiagnostic(approved.id).available, true);

  const scheduled = createSession(projectRoot, {
    agentProfileId: profile.id,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    scheduledJobId: "synthetic-scheduled-job",
    scheduledRunId: "synthetic-scheduled-run",
  });
  const scheduledHandle = await createPiSession(scheduled.id, projectRoot, scheduled.provider, scheduled.model, undefined, { protectedBrowserFactory: factory });
  assert.equal(captured.length, 1, "scheduled runtime never invokes the browser factory");
  assert.equal(getPiSessionBrowserAgentDiagnostic(scheduled.id).reason_code, "interactive_session_required");
  assert.ok(INTERACTIVE_BROWSER_TOOL_NAMES.every((name) => !scheduledHandle.session.getActiveToolNames().includes(name)));

});
