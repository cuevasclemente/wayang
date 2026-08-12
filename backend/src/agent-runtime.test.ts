import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { createAgentProfile, getAgentProfile } from "./agent-profiles.js";
import {
  authorizeAgentToolCall,
  buildAgentResourceLoader,
  classifyMemoryTool,
  installAgentToolPolicyGuard,
  RESTRICTED_BUILTIN_TOOLS,
  WAYANG_INTERACTIVE_COMMUNICATION_APPENDIX,
} from "./agent-runtime.js";
import { commandGuardIdentityPinPath } from "./command-guard-pin.js";
import { close, commitStoreMutation, init } from "./db.js";
import { createProject } from "./projects.js";
import { commitWorkspaceCapabilityActivation, revokeWorkspaceCapabilityAssociation } from "./workspace-capabilities.js";
import { createSession, updatePiSessionFile } from "./sessions.js";
import {
  getProtectedArtifactReadRoots,
  getSessionAttachmentRoot,
  getWayangCheckoutSecretPaths,
  LEGACY_ATTACHMENT_ROOT,
} from "./protected-artifacts.js";
import { WREN_AGENT_PROFILE_ID, type AgentProfileRow } from "./workspace-types.js";
import { WAYANG_RUNTIME_CONTEXT_TOOL_NAME } from "./wayang-runtime-context.js";
import { RESTRICTED_MCP_TOOL_NAME, type RestrictedMcpRuntime } from "./restricted-mcp/index.js";
import { FILE_AUDIO_EXPERIMENT_TOOL_NAME, type FileAudioExperimentRuntime } from "./audio-experiment/types.js";
import type { InteractiveBrowserToolRuntime } from "./browser/interactive-runtime.js";

function fixture(name: string): {
  dir: string;
  cwd: string;
  agentDir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const cwd = path.join(dir, "workspace", "project");
  const agentDir = path.join(dir, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const previousData = process.env.WAYANG_DATA_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
  init();
  return {
    dir,
    cwd,
    agentDir,
    cleanup() {
      close();
      if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
      else process.env.WAYANG_DATA_DIR = previousData;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Wayang checkout secrets stay protected without project registration", () => {
  const f = fixture("wayang-runtime-checkout-secrets-");
  try {
    const protectedRoots = new Set(getProtectedArtifactReadRoots());
    for (const secretPath of getWayangCheckoutSecretPaths()) {
      assert.equal(protectedRoots.has(secretPath), true, secretPath);
    }
  } finally {
    f.cleanup();
  }
});

test("restricted resource loader trusts project Pi code while retaining instruction overlays and tool policy", async () => {
  const f = fixture("wayang-runtime-resources-");
  const marker = path.join(f.dir, "factory-executed");
  try {
    fs.writeFileSync(path.join(f.agentDir, "AGENTS.md"), "synthetic global identity");
    fs.writeFileSync(path.join(f.dir, "workspace", "AGENTS.md"), "synthetic ancestor instructions");
    fs.writeFileSync(path.join(f.cwd, "AGENTS.md"), "synthetic exact project instructions");
    fs.writeFileSync(path.join(f.agentDir, "SYSTEM.md"), "synthetic global system override");
    fs.writeFileSync(path.join(f.agentDir, "APPEND_SYSTEM.md"), "synthetic global append");
    fs.mkdirSync(path.join(f.cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(f.cwd, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "synthetic-project-provider" }));
    fs.writeFileSync(path.join(f.cwd, ".pi", "SYSTEM.md"), "synthetic project system override");
    fs.writeFileSync(path.join(f.cwd, ".pi", "APPEND_SYSTEM.md"), "synthetic project append");
    fs.mkdirSync(path.join(f.agentDir, "skills", "synthetic"), { recursive: true });
    fs.writeFileSync(path.join(f.agentDir, "skills", "synthetic", "SKILL.md"), "---\nname: synthetic\ndescription: synthetic\n---\nbody");
    fs.mkdirSync(path.join(f.cwd, ".pi", "extensions"), { recursive: true });
    fs.writeFileSync(path.join(f.cwd, ".pi", "extensions", "canary.ts"), [
      'import * as fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(marker)}, "executed");`,
      "export default function canary() {}",
    ].join("\n"));

    const profile = createAgentProfile({ name: "Restricted", instructions: "synthetic profile overlay" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const result = await buildAgentResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project });

    assert.equal(fs.existsSync(marker), true, "registered project extension should execute under explicit trust-all policy");
    assert.equal(result.resourceLoader.getExtensions().extensions.length, 1);
    assert.equal(result.resourceLoader.getSkills().skills.length, 1);
    assert.equal(result.settingsManager.getDefaultProvider(), "synthetic-project-provider");
    assert.equal(result.resourceLoader.getSystemPrompt(), undefined);
    assert.deepEqual(result.resourceLoader.getAppendSystemPrompt(), ["synthetic profile overlay"]);
    assert.deepEqual(result.resourceLoader.getAgentsFiles().agentsFiles, [{
      path: path.join(f.cwd, "AGENTS.md"),
      content: "synthetic exact project instructions",
    }]);
    assert.deepEqual(result.tools, [...RESTRICTED_BUILTIN_TOOLS]);
    assert.equal(result.tools?.map(String).includes("bash"), true);
  } finally {
    f.cleanup();
  }
});

test("interactive communication appendix reaches restricted and Standard sessions but not scheduled runs", async () => {
  const f = fixture("wayang-runtime-interactive-communication-");
  try {
    fs.writeFileSync(path.join(f.agentDir, "APPEND_SYSTEM.md"), "synthetic global append");
    const profile = createAgentProfile({ name: "Communication profile", instructions: "synthetic profile overlay" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const interactive = createSession(f.cwd, { agentProfileId: profile.id });

    const restricted = await buildAgentResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: interactive.id,
    });
    assert.equal(restricted.restricted, true);
    assert.deepEqual(restricted.resourceLoader.getAppendSystemPrompt(), [
      "synthetic profile overlay",
      WAYANG_INTERACTIVE_COMMUNICATION_APPENDIX,
    ]);

    commitWorkspaceCapabilityActivation({
      capability_id: "wayang.standard-resources.v1",
      project_id: project.id,
      agent_profile_id: profile.id,
      operation_digest: "f".repeat(64),
    });
    const standard = await buildAgentResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: interactive.id,
    });
    assert.equal(standard.restricted, false);
    assert.deepEqual(standard.resourceLoader.getAppendSystemPrompt(), [
      "synthetic global append",
      "synthetic profile overlay",
      WAYANG_INTERACTIVE_COMMUNICATION_APPENDIX,
    ]);

    const scheduled = createSession(f.cwd, { agentProfileId: profile.id });
    commitStoreMutation((draft) => {
      const row = draft.sessions.find((candidate) => candidate.id === scheduled.id)!;
      row.scheduled_job_id = "synthetic-job";
      row.scheduled_run_id = "synthetic-run";
    });
    const scheduledResources = await buildAgentResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: scheduled.id,
    });
    assert.deepEqual(scheduledResources.resourceLoader.getAppendSystemPrompt(), [
      "synthetic global append",
      "synthetic profile overlay",
    ]);
  } finally {
    f.cleanup();
  }
});

test("pair association loads standard resources independent of resource mode and model", async () => {
  const f = fixture("wayang-runtime-standard-capability-");
  try {
    fs.writeFileSync(path.join(f.agentDir, "AGENTS.md"), "synthetic global resources");
    const profile = createAgentProfile({ name: "Arbitrary standard label", resource_mode: "project_only" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id, provider: "provider-a", model: "model-a" });

    const denied = await buildAgentResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: row.id,
    });
    assert.equal(denied.restricted, true);
    assert.equal(denied.resourceLoader.getAgentsFiles().agentsFiles.some((entry) => entry.path === path.join(f.agentDir, "AGENTS.md")), false);

    const association = commitWorkspaceCapabilityActivation({
      capability_id: "wayang.standard-resources.v1",
      project_id: project.id,
      agent_profile_id: profile.id,
      operation_digest: "a".repeat(64),
    });
    const allowed = await buildAgentResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: row.id,
    });
    assert.equal(allowed.restricted, false);
    assert.equal(allowed.standardResourcesWitness?.associationRevision, association.revision);

    const otherModelRow = createSession(f.cwd, { agentProfileId: profile.id, provider: "provider-b", model: "model-b" });
    const otherModel = await buildAgentResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: otherModelRow.id,
    });
    assert.equal(otherModel.restricted, false, "provider/model variation does not partition pair authority");

    revokeWorkspaceCapabilityAssociation({
      capability_id: "wayang.standard-resources.v1",
      project_id: project.id,
      agent_profile_id: profile.id,
      expected_revision: association.revision,
    });
    const stale = await buildAgentResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: row.id,
    });
    assert.equal(stale.restricted, true);
  } finally { f.cleanup(); }
});

test("exact Wren loads standard resources for interactive and scheduled Standard sessions", async () => {
  const f = fixture("wayang-runtime-legacy-wren-standard-");
  try {
    fs.writeFileSync(path.join(f.agentDir, "AGENTS.md"), "synthetic Wren global resources");
    const now = Date.now();
    commitStoreMutation((draft) => {
      draft.agentProfiles.push({
        id: WREN_AGENT_PROFILE_ID,
        name: "Arbitrarily renamed Wren",
        description: null,
        builtin_kind: "wren",
        deletable: false,
        enabled: true,
        resource_mode: "standard",
        instructions: null,
        memory_access: "read_write",
        default_provider: null,
        default_model: null,
        allowed_tools: null,
        allowed_extensions: null,
        created_at: now,
        updated_at: now,
      });
    });
    const profile = getAgentProfile(WREN_AGENT_PROFILE_ID)!;
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const protectedRoot = path.join(f.dir, "protected-project");
    const ordinarySibling = path.join(f.dir, "ordinary-sibling.txt");
    fs.mkdirSync(protectedRoot);
    fs.writeFileSync(path.join(protectedRoot, "private.txt"), "protected");
    fs.writeFileSync(ordinarySibling, "ordinary");
    createProject({
      cwd: protectedRoot,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });
    assert.equal(authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile: profile,
      toolName: "read",
      params: { path: ordinarySibling },
      standardResourcesAuthorized: true,
    }).allowed, true);
    assert.equal(authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile: profile,
      toolName: "read",
      params: { path: path.join(protectedRoot, "private.txt") },
      standardResourcesAuthorized: true,
    }).allowed, false);
    const interactive = createSession(f.cwd, { agentProfileId: profile.id });
    const scheduled = createSession(f.cwd, { agentProfileId: profile.id });
    commitStoreMutation((draft) => {
      const row = draft.sessions.find((candidate) => candidate.id === scheduled.id)!;
      row.scheduled_job_id = "synthetic-job";
      row.scheduled_run_id = "synthetic-run";
    });

    for (const sourceSessionId of [interactive.id, scheduled.id]) {
      const loaded = await buildAgentResourceLoader({
        cwd: f.cwd,
        agentDir: f.agentDir,
        agentProfile: profile,
        project,
        sourceSessionId,
      });
      assert.equal(loaded.restricted, false);
      assert.equal(loaded.standardResourcesWitness?.authoritySource, "legacy-wren");
      assert.equal(loaded.resourceLoader.getAgentsFiles().agentsFiles.some(
        (entry) => entry.path === path.join(f.agentDir, "AGENTS.md")
      ), true);
    }
  } finally { f.cleanup(); }
});

test("revoked standard-resources witness permanently latches stale tools denied", async () => {
  const f = fixture("wayang-runtime-standard-latch-");
  try {
    const profile = createAgentProfile({ name: "Standard latch", resource_mode: "standard" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id, provider: "provider-a", model: "model-a" });
    const pair = {
      capability_id: "wayang.standard-resources.v1" as const,
      project_id: project.id,
      agent_profile_id: profile.id,
    };
    const association = commitWorkspaceCapabilityActivation({ ...pair, operation_digest: "b".repeat(64) });
    const loaded = await buildAgentResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: row.id });
    assert.ok(loaded.standardResourcesWitness);
    let executions = 0;
    const tool: any = { name: "bash", async execute() { executions += 1; return { content: [] }; } };
    let active = ["bash"];
    const session: any = {
      model: { provider: "provider-a", id: "model-a" },
      _toolRegistry: new Map([["bash", tool]]),
      getActiveToolNames: () => active,
      setActiveToolsByName(names: string[]) { active = [...names]; },
      agent: { state: { tools: [tool] }, async beforeToolCall() {} },
    };
    installAgentToolPolicyGuard(session, row.id, {
      standardResourcesWitness: loaded.standardResourcesWitness,
      standardResourcesRuntimeFence: {
        runtimeGeneration: "standard-latch-generation",
        processBootNonce: "standard-latch-boot",
        isCurrent: () => true,
      },
    });
    assert.deepEqual(active, ["bash"]);
    revokeWorkspaceCapabilityAssociation({ ...pair, expected_revision: association.revision });
    session.setActiveToolsByName(["bash"]);
    assert.deepEqual(active, []);
    commitWorkspaceCapabilityActivation({ ...pair, operation_digest: "c".repeat(64) });
    session.setActiveToolsByName(["bash"]);
    assert.deepEqual(active, [], "a replacement activation cannot revive a stale runtime");
    await assert.rejects(() => tool.execute("stale", {}), /Standard resource authority was revoked/);
    assert.equal(executions, 0);
  } finally { f.cleanup(); }
});

test("standard-resource runtime fence prevents A → B → A stale wrapper revival", async () => {
  const f = fixture("wayang-runtime-standard-generation-");
  try {
    const profile = createAgentProfile({ name: "Standard generation", resource_mode: "project_only" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id, provider: "provider-a", model: "model-a" });
    commitWorkspaceCapabilityActivation({
      capability_id: "wayang.standard-resources.v1",
      project_id: project.id,
      agent_profile_id: profile.id,
      operation_digest: "d".repeat(64),
    });
    const loaded = await buildAgentResourceLoader({
      cwd: f.cwd, agentDir: f.agentDir, agentProfile: profile, project, sourceSessionId: row.id,
    });
    assert.ok(loaded.standardResourcesWitness);

    let oldGenerationCurrent = true;
    let executions = 0;
    const tool: any = { name: "bash", async execute() { executions++; return { content: [] }; } };
    const session: any = {
      _toolRegistry: new Map([["bash", tool]]),
      getActiveToolNames: () => ["bash"],
      setActiveToolsByName() {},
      agent: { state: { tools: [tool] }, async beforeToolCall() {} },
    };
    installAgentToolPolicyGuard(session, row.id, {
      standardResourcesWitness: loaded.standardResourcesWitness,
      standardResourcesRuntimeFence: {
        runtimeGeneration: "model-a-generation",
        processBootNonce: "boot",
        isCurrent: () => oldGenerationCurrent,
      },
    });
    await tool.execute("current", {});
    assert.equal(executions, 1);

    oldGenerationCurrent = false;
    await assert.rejects(() => tool.execute("stale-after-b", {}), /runtime generation is stale/);
    oldGenerationCurrent = true;
    await assert.rejects(() => tool.execute("stale-after-return-to-a", {}), /permanently revoked/);
    assert.equal(executions, 1);
  } finally { f.cleanup(); }
});

test("interactive-browser guard preserves exact backend tool-object authorization through the neutral seam", async () => {
  const f = fixture("wayang-runtime-browser-tool-drift-");
  try {
    const profile = createAgentProfile({ name: "Browser tool drift" });
    createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id });
    let detachments = 0;
    let replacements = 0;
    const definition: any = { name: "browser_status", async execute() { return { content: [] }; } };
    const original: any = { name: "browser_status", async execute(...args: unknown[]) { return definition.execute(...args); } };
    const replacement: any = { name: "browser_status", async execute() { replacements++; return { content: [] }; } };
    const runtime: InteractiveBrowserToolRuntime = {
      kind: "standard",
      tools: [definition],
      toolForName(name) { return name === definition.name ? definition : undefined; },
      preflight: () => ({ allowed: true }),
      async detachAgentLease() { detachments++; },
      async closeSessionWorkspaces() {},
      async revokeAuthority() {},
    };
    let active = [definition.name];
    const session: any = {
      _toolDefinitions: new Map([[definition.name, { definition }]]),
      _toolRegistry: new Map([[definition.name, original]]),
      getActiveToolNames: () => active,
      setActiveToolsByName(names: string[]) { active = [...names]; },
      agent: { state: { tools: [original] }, async beforeToolCall() {} },
    };
    installAgentToolPolicyGuard(session, row.id, { protectedBrowserRuntime: runtime });
    assert.deepEqual(active, [definition.name]);

    session._toolRegistry.set(definition.name, replacement);
    session.agent.state.tools = [replacement];
    session.setActiveToolsByName([definition.name]);
    assert.deepEqual(active, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(detachments, 1);
    await assert.rejects(() => replacement.execute("counterfeit", {}), /tool object is not authorized/);
    assert.equal(replacements, 0);
  } finally { f.cleanup(); }
});

test("file-audio tool-object replacement closes the runtime and never invokes the replacement", async () => {
  const f = fixture("wayang-runtime-audio-tool-drift-");
  try {
    const now = Date.now();
    commitStoreMutation((draft) => {
      draft.agentProfiles.push({
        id: WREN_AGENT_PROFILE_ID,
        name: "Audio tool drift Wren",
        description: null,
        builtin_kind: "wren",
        deletable: false,
        enabled: true,
        resource_mode: "standard",
        instructions: null,
        memory_access: "read_write",
        default_provider: null,
        default_model: null,
        allowed_tools: null,
        allowed_extensions: null,
        created_at: now,
        updated_at: now,
      });
    });
    const profile = getAgentProfile(WREN_AGENT_PROFILE_ID)!;
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id });
    let closes = 0;
    let replacements = 0;
    const original: any = { name: FILE_AUDIO_EXPERIMENT_TOOL_NAME, async execute() { return { content: [] }; } };
    const replacement: any = { name: FILE_AUDIO_EXPERIMENT_TOOL_NAME, async execute() { replacements++; return { content: [] }; } };
    const runtime = {
      tool: original,
      binding: {
        sourceSessionId: row.id,
        runtimeGeneration: "synthetic",
        processBootNonce: "synthetic",
        projectId: project.id,
        projectCwd: project.cwd,
        agentProfileId: profile.id,
        provider: "synthetic",
        model: "synthetic",
      },
      preflight: () => ({ allowed: true as const }),
      async close() { closes++; },
    } satisfies FileAudioExperimentRuntime;
    let active: string[] = [FILE_AUDIO_EXPERIMENT_TOOL_NAME];
    const session: any = {
      _toolDefinitions: new Map([[FILE_AUDIO_EXPERIMENT_TOOL_NAME, { definition: original }]]),
      _toolRegistry: new Map([[FILE_AUDIO_EXPERIMENT_TOOL_NAME, original]]),
      getActiveToolNames: () => active,
      setActiveToolsByName(names: string[]) { active = [...names]; },
      agent: { state: { tools: [original] }, async beforeToolCall() {} },
    };
    installAgentToolPolicyGuard(session, row.id, { fileAudioExperimentRuntime: runtime });
    assert.deepEqual(active, [FILE_AUDIO_EXPERIMENT_TOOL_NAME]);

    session._toolRegistry.set(FILE_AUDIO_EXPERIMENT_TOOL_NAME, replacement);
    session.agent.state.tools = [replacement];
    const decision = await session.agent.beforeToolCall({
      toolCall: { name: FILE_AUDIO_EXPERIMENT_TOOL_NAME },
      args: { operation: "execute", permit_id: "forged" },
    });
    assert.equal(decision.block, true);
    assert.match(decision.reason, /tool object is not authorized/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes, 1);
    await assert.rejects(() => replacement.execute("forged", {}), /tool object is not authorized/);
    assert.equal(replacements, 0);
  } finally { f.cleanup(); }
});

test("memory capability registry and filesystem policy implement none/read/read_write", () => {
  const f = fixture("wayang-runtime-memory-");
  const memoryRoot = path.join(f.dir, "memory");
  const ordinaryRoot = path.join(f.dir, "ordinary");
  fs.mkdirSync(memoryRoot);
  fs.mkdirSync(ordinaryRoot);
  fs.writeFileSync(path.join(memoryRoot, "note.md"), "synthetic");
  fs.writeFileSync(path.join(ordinaryRoot, "note.md"), "synthetic");
  try {
    const base = createAgentProfile({ name: "Memory policy", memory_access: "none" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: base.id });
    const decide = (profile: AgentProfileRow, toolName: string, target: string) => authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile: profile,
      toolName,
      params: { path: target },
      memoryRoots: [memoryRoot],
    });

    assert.equal(classifyMemoryTool("mcp-mempalace-semantic-search"), "read");
    assert.equal(classifyMemoryTool("mempalace_diary_write"), "mutation");
    assert.equal(decide(base, "read", path.join(memoryRoot, "note.md")).allowed, false);
    assert.equal(decide(base, "write", path.join(memoryRoot, "new.md")).allowed, false);
    assert.equal(decide(base, "write", path.join(ordinaryRoot, "new.md")).allowed, false);
    assert.equal(decide(base, "write", path.join(f.cwd, "new.md")).allowed, true);

    const readProfile = { ...base, memory_access: "read" as const };
    assert.equal(decide(readProfile, "read", path.join(memoryRoot, "note.md")).allowed, true);
    assert.equal(decide(readProfile, "edit", path.join(memoryRoot, "note.md")).allowed, false);
    assert.equal(authorizeAgentToolCall({ cwd: f.cwd, project, agentProfile: readProfile, toolName: "mempalace_kg_query", params: {} }).allowed, true);
    assert.equal(authorizeAgentToolCall({ cwd: f.cwd, project, agentProfile: readProfile, toolName: "mempalace_drawer_delete", params: {} }).allowed, false);

    const writeProfile = { ...base, memory_access: "read_write" as const };
    assert.equal(decide(writeProfile, "edit", path.join(memoryRoot, "note.md")).allowed, true);
    assert.equal(authorizeAgentToolCall({ cwd: f.cwd, project, agentProfile: writeProfile, toolName: "unknown_custom_tool", params: {} }).allowed, false);
    assert.equal(authorizeAgentToolCall({ cwd: f.cwd, project, agentProfile: writeProfile, toolName: WAYANG_RUNTIME_CONTEXT_TOOL_NAME, params: {} }).allowed, true);
    assert.equal(authorizeAgentToolCall({ cwd: f.cwd, project, agentProfile: writeProfile, toolName: "bash", params: {} }).allowed, true);
    assert.equal(authorizeAgentToolCall({
      cwd: f.cwd,
      project: { ...project, access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [writeProfile.id] } },
      agentProfile: writeProfile,
      toolName: "agent_team_spawn_parallel",
      params: {},
    }).allowed, false);
  } finally {
    f.cleanup();
  }
});

test("restricted direct paths allow only the project, permitted memory, and own attachments while universal secrets stay denied", () => {
  const f = fixture("wayang-runtime-direct-boundary-");
  const memoryRoot = path.join(f.dir, "memoriki");
  try {
    fs.mkdirSync(memoryRoot);
    const memoryFile = path.join(memoryRoot, "note.md");
    fs.writeFileSync(memoryFile, "SYNTHETIC_MEMORY_CANARY\n");
    const projectFile = path.join(f.cwd, "allowed.txt");
    fs.writeFileSync(projectFile, "SYNTHETIC_PROJECT_CANARY\n");

    const projectEnv = path.join(f.cwd, ".env");
    fs.writeFileSync(projectEnv, "SYNTHETIC_PROVIDER_KEY=not-a-real-secret\n", { mode: 0o600 });
    const authFile = path.join(f.agentDir, "auth.json");
    const globalAgents = path.join(f.agentDir, "AGENTS.md");
    const globalSystem = path.join(f.agentDir, "SYSTEM.md");
    fs.writeFileSync(authFile, "SYNTHETIC_AUTH_CANARY\n", { mode: 0o600 });
    fs.writeFileSync(globalAgents, "SYNTHETIC_GLOBAL_AGENTS_CANARY\n");
    fs.writeFileSync(globalSystem, "SYNTHETIC_GLOBAL_SYSTEM_CANARY\n");

    const browserRoot = path.join(f.cwd, ".pi", "browser-workbench", "profiles", "synthetic");
    fs.mkdirSync(browserRoot, { recursive: true });
    const browserProfile = path.join(browserRoot, "Cookies");
    fs.writeFileSync(browserProfile, "SYNTHETIC_BROWSER_PROFILE_CANARY\n", { mode: 0o600 });

    const profile = createAgentProfile({ name: "Restricted path boundary", memory_access: "read" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const source = createSession(f.cwd, { agentProfileId: profile.id });
    const other = createSession(f.cwd, { agentProfileId: profile.id });
    const ownRoot = getSessionAttachmentRoot(source.id);
    const otherRoot = getSessionAttachmentRoot(other.id);
    fs.mkdirSync(ownRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(otherRoot, { recursive: true, mode: 0o700 });
    const ownAttachment = path.join(ownRoot, "own.txt");
    const crossAttachment = path.join(otherRoot, "cross.txt");
    fs.writeFileSync(ownAttachment, "SYNTHETIC_OWN_ATTACHMENT_CANARY\n", { mode: 0o600 });
    fs.writeFileSync(crossAttachment, "SYNTHETIC_CROSS_ATTACHMENT_CANARY\n", { mode: 0o600 });

    const decide = (agentProfile: AgentProfileRow, toolName: string, target: string) => authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile,
      toolName,
      params: { path: target },
      memoryRoots: [memoryRoot],
      sourceSessionId: source.id,
    });

    assert.equal(decide(profile, "read", projectFile).allowed, true);
    assert.equal(decide(profile, "read", memoryFile).allowed, true);
    assert.equal(decide(profile, "edit", memoryFile).allowed, false, "Memoriki is read-only for this profile");
    assert.equal(decide(profile, "read", ownAttachment).allowed, true);
    assert.equal(decide(profile, "read", crossAttachment).allowed, false);
    for (const denied of [projectEnv, authFile, globalAgents, globalSystem, "/proc/self/environ", browserProfile]) {
      assert.equal(decide(profile, "read", denied).allowed, false, denied);
    }

    const standardProfile = { ...profile, resource_mode: "standard" as const, memory_access: "read_write" as const };
    for (const denied of [projectEnv, authFile, "/proc/self/environ", browserProfile]) {
      assert.equal(decide(standardProfile, "read", denied).allowed, false, `universal deny: ${denied}`);
    }
  } finally {
    f.cleanup();
  }
});

test("Protected restricted agents read ordinary and Standard paths but write only their project", () => {
  const f = fixture("wayang-runtime-protected-read-lattice-");
  const ordinaryRoot = path.join(f.dir, "ordinary");
  const standardRoot = path.join(f.dir, "standard-project");
  const otherProtectedRoot = path.join(f.dir, "other-protected");
  try {
    fs.mkdirSync(ordinaryRoot);
    fs.mkdirSync(standardRoot);
    fs.mkdirSync(otherProtectedRoot);
    const ordinaryFile = path.join(ordinaryRoot, "ordinary.txt");
    const standardFile = path.join(standardRoot, "standard.txt");
    const otherProtectedFile = path.join(otherProtectedRoot, "protected.txt");
    const projectPiRoot = path.join(f.cwd, ".pi");
    const projectPiSettings = path.join(projectPiRoot, "settings.json");
    const projectPiAlias = path.join(f.cwd, "pi-control-alias");
    fs.writeFileSync(ordinaryFile, "ordinary");
    fs.writeFileSync(standardFile, "standard");
    fs.writeFileSync(otherProtectedFile, "protected");
    fs.mkdirSync(projectPiRoot);
    fs.writeFileSync(projectPiSettings, "{}\n");
    fs.symlinkSync(projectPiRoot, projectPiAlias, "dir");

    const sourceProfile = createAgentProfile({ name: "Protected reader" });
    const standardProfile = createAgentProfile({ name: "Standard owner" });
    const otherProtectedProfile = createAgentProfile({ name: "Other Protected owner" });
    const sourceProject = createProject({
      cwd: f.cwd,
      default_agent_profile_id: sourceProfile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [sourceProfile.id] },
    });
    createProject({
      cwd: standardRoot,
      default_agent_profile_id: standardProfile.id,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [standardProfile.id] },
    });
    createProject({
      cwd: otherProtectedRoot,
      default_agent_profile_id: otherProtectedProfile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [otherProtectedProfile.id] },
    });
    const source = createSession(f.cwd, { agentProfileId: sourceProfile.id });
    const decide = (toolName: string, target: string) => authorizeAgentToolCall({
      cwd: f.cwd,
      project: sourceProject,
      agentProfile: sourceProfile,
      toolName,
      params: { path: target },
      sourceSessionId: source.id,
    });

    assert.equal(decide("read", ordinaryFile).allowed, true);
    assert.equal(decide("read", standardFile).allowed, true, "Standard project run allowlists do not block Protected reads");
    assert.equal(decide("edit", ordinaryFile).allowed, false);
    assert.equal(decide("write", standardFile).allowed, false);
    assert.equal(decide("read", projectPiSettings).allowed, true);
    assert.equal(decide("edit", projectPiSettings).allowed, false);
    assert.equal(decide("write", path.join(projectPiAlias, "extension.ts")).allowed, false);
    assert.equal(decide("read", otherProtectedFile).allowed, false);
    assert.equal(decide("find", f.dir).allowed, false, "broad scans intersecting another Protected project fail closed");
  } finally {
    f.cleanup();
  }
});

test("direct read, grep, and find deny backend artifacts while the source session reads only its own attachment", async () => {
  const f = fixture("wayang-runtime-artifacts-");
  try {
    const profile = createAgentProfile({ name: "Artifact guard", memory_access: "read_write" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id });
    const other = createSession(f.cwd, { agentProfileId: profile.id });

    const transcriptDir = path.join(f.agentDir, "sessions", "synthetic-project");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcript = path.join(transcriptDir, "protected.jsonl");
    fs.writeFileSync(transcript, "PROTECTED_TRANSCRIPT_CANARY\n");
    updatePiSessionFile(row.id, transcript);

    const dataDir = process.env.WAYANG_DATA_DIR!;
    const store = path.join(dataDir, "store.json");
    const search = path.join(dataDir, "search.db");
    const projection = path.join(dataDir, "project-access-policy.json");
    fs.writeFileSync(search, "SEARCH_CANARY\n");
    fs.writeFileSync(projection, "PROJECTION_CANARY\n", { mode: 0o600 });

    const ownRoot = getSessionAttachmentRoot(row.id);
    const otherRoot = getSessionAttachmentRoot(other.id);
    fs.mkdirSync(ownRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(otherRoot, { recursive: true, mode: 0o700 });
    const ownAttachment = path.join(ownRoot, "own.txt");
    const otherAttachment = path.join(otherRoot, "other.txt");
    fs.writeFileSync(ownAttachment, "OWN_ATTACHMENT_CANARY\n", { mode: 0o600 });
    fs.writeFileSync(otherAttachment, "OTHER_ATTACHMENT_CANARY\n", { mode: 0o600 });

    const read = createReadTool(f.cwd);
    const grep = createGrepTool(f.cwd);
    const find = createFindTool(f.cwd);
    const tools = [read, grep, find];
    const fakeSession: any = {
      _toolRegistry: new Map(tools.map((tool) => [tool.name, tool])),
      setActiveToolsByName() {},
      agent: { state: { tools }, async beforeToolCall() { return undefined; } },
    };
    installAgentToolPolicyGuard(fakeSession, row.id);

    for (const denied of [transcript, store, search, projection, otherAttachment]) {
      await assert.rejects(() => (read.execute as any)("read", { path: denied }), /Wayang policy blocked read/);
      await assert.rejects(
        () => (grep.execute as any)("grep", { pattern: "CANARY", path: denied }),
        /Wayang policy blocked grep/,
      );
      await assert.rejects(
        () => (find.execute as any)("find", { pattern: "*", path: denied }),
        /Wayang policy blocked find/,
      );
    }
    await assert.rejects(
      () => (grep.execute as any)("grep", { pattern: "CANARY", path: transcriptDir }),
      /Wayang policy blocked grep/,
    );
    await assert.rejects(
      () => (find.execute as any)("find", { pattern: "*", path: dataDir }),
      /Wayang policy blocked find/,
    );

    const own = await (read.execute as any)("read", { path: ownAttachment });
    assert.match(own.content[0].text, /OWN_ATTACHMENT_CANARY/);
    const ownGrep = await (grep.execute as any)("grep", { pattern: "OWN_ATTACHMENT_CANARY", path: ownRoot });
    assert.match(ownGrep.content[0].text, /own\.txt/);

    assert.equal(authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile: profile,
      toolName: "write",
      params: { path: path.join(ownRoot, "new.txt") },
      sourceSessionId: row.id,
    }).allowed, false, "the attachment exception is read-only");
    assert.equal(authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile: profile,
      toolName: "write",
      params: { path: path.join(LEGACY_ATTACHMENT_ROOT, "legacy.txt") },
      sourceSessionId: row.id,
    }).allowed, false, "legacy flat uploads fail closed even when absent");
  } finally {
    f.cleanup();
  }
});

test("command-guard identity PIN denies every direct path tool through canonical aliases and ancestors", async () => {
  const f = fixture("wayang-runtime-pin-artifact-");
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    const realConfig = path.join(f.dir, "real-config");
    const configAlias = path.join(f.dir, "config-alias");
    fs.mkdirSync(path.join(realConfig, "pi"), { recursive: true });
    fs.symlinkSync(realConfig, configAlias, "dir");
    process.env.XDG_CONFIG_HOME = configAlias;
    const pinAlias = commandGuardIdentityPinPath();
    const pinCanonical = path.join(realConfig, "pi", "command-guard-identity-pin");
    fs.writeFileSync(pinCanonical, "12345678\n", { mode: 0o600 });

    const profile = createAgentProfile({ name: "PIN boundary fixture", resource_mode: "project_only" });
    createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id });
    const tools = [
      createReadTool(f.cwd),
      createEditTool(f.cwd),
      createWriteTool(f.cwd),
      createGrepTool(f.cwd),
      createFindTool(f.cwd),
      createLsTool(f.cwd),
    ];
    const runtime: any = {
      _toolRegistry: new Map(tools.map((tool) => [tool.name, tool])),
      setActiveToolsByName() {},
      agent: { state: { tools }, async beforeToolCall() { return undefined; } },
    };
    installAgentToolPolicyGuard(runtime, row.id);
    const [read, edit, write, grep, find, ls] = tools;

    await assert.rejects(() => (read!.execute as any)("read", { path: pinAlias }), /Wayang policy blocked read/);
    await assert.rejects(() => (edit!.execute as any)("edit", {
      path: pinAlias,
      edits: [{ oldText: "12345678", newText: "00000000" }],
    }), /Wayang policy blocked edit/);
    await assert.rejects(() => (write!.execute as any)("write", { path: pinAlias, content: "00000000\n" }), /Wayang policy blocked write/);
    for (const [tool, name, params] of [
      [grep, "grep", { path: configAlias, pattern: "12345678" }],
      [find, "find", { path: configAlias, pattern: "*" }],
      [ls, "ls", { path: configAlias }],
    ] as const) {
      await assert.rejects(() => (tool!.execute as any)(name, params), new RegExp(`Wayang policy blocked ${name}`));
    }
    assert.equal(fs.readFileSync(pinCanonical, "utf8"), "12345678\n");
    assert.equal(row.agent_profile_id, profile.id);
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    f.cleanup();
  }
});

test("plain authorization reserves mcp only for restricted profiles", () => {
  const f = fixture("wayang-runtime-mcp-name-reserved-");
  try {
    const restricted = createAgentProfile({ name: "Restricted MCP name policy" });
    const project = createProject({ cwd: f.cwd, default_agent_profile_id: restricted.id });
    const standard = { ...restricted, resource_mode: "standard" as const };

    const restrictedDecision = authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile: restricted,
      toolName: RESTRICTED_MCP_TOOL_NAME,
      params: {},
    });
    assert.equal(restrictedDecision.allowed, false);
    assert.match(restrictedDecision.reason ?? "", /source-bound runtime object/);
    assert.equal(authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile: standard,
      toolName: RESTRICTED_MCP_TOOL_NAME,
      params: {},
      standardResourcesAuthorized: true,
    }).allowed, true, "an exactly authorized Standard runtime may retain Pi's MCP adapter");
    assert.equal(authorizeAgentToolCall({
      cwd: f.cwd,
      project,
      agentProfile: restricted,
      toolName: "unreviewed_restricted_tool",
      params: {},
    }).allowed, false);
    assert.deepEqual(RESTRICTED_BUILTIN_TOOLS, ["read", "edit", "write", "grep", "find", "ls", "bash"]);
    assert.equal(RESTRICTED_BUILTIN_TOOLS.includes(RESTRICTED_MCP_TOOL_NAME as any), false);
    assert.equal(classifyMemoryTool(RESTRICTED_MCP_TOOL_NAME), null);
  } finally {
    f.cleanup();
  }
});

test("restricted MCP guard requires the exact registered runtime tool for activation, before-call, and execute", async () => {
  const f = fixture("wayang-runtime-mcp-identity-");
  try {
    const profile = createAgentProfile({ name: "Restricted MCP identity" });
    createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id });
    let executions = 0;
    let activeNames: string[] = [RESTRICTED_MCP_TOOL_NAME];
    const definition: any = {
      name: RESTRICTED_MCP_TOOL_NAME,
      async execute() {
        executions++;
        return { content: [{ type: "text", text: "synthetic restricted MCP result" }] };
      },
    };
    const wrappedTool: any = {
      name: RESTRICTED_MCP_TOOL_NAME,
      async execute(...args: unknown[]) {
        return definition.execute(...args);
      },
    };
    const runtime: RestrictedMcpRuntime = {
      tool: definition,
      preflight: () => ({ allowed: true }),
      async close() {},
    };
    const fakeSession: any = {
      _toolDefinitions: new Map([[RESTRICTED_MCP_TOOL_NAME, { definition }]]),
      _toolRegistry: new Map([[RESTRICTED_MCP_TOOL_NAME, wrappedTool]]),
      getActiveToolNames: () => activeNames,
      setActiveToolsByName(names: string[]) { activeNames = [...names]; },
      agent: { state: { tools: [wrappedTool] }, async beforeToolCall() { return undefined; } },
    };
    installAgentToolPolicyGuard(fakeSession, row.id, { restrictedMcpRuntime: runtime });

    assert.deepEqual(activeNames, [RESTRICTED_MCP_TOOL_NAME]);
    assert.equal(await fakeSession.agent.beforeToolCall({
      toolCall: { name: RESTRICTED_MCP_TOOL_NAME },
      args: {},
    }), undefined);
    await wrappedTool.execute("legitimate", {});
    assert.equal(executions, 1);

    let counterfeitExecutions = 0;
    const counterfeit: any = {
      name: RESTRICTED_MCP_TOOL_NAME,
      async execute() {
        counterfeitExecutions++;
        return { content: [] };
      },
    };
    fakeSession._toolRegistry = new Map([[RESTRICTED_MCP_TOOL_NAME, counterfeit]]);
    fakeSession.agent.state.tools = [counterfeit];
    fakeSession.setActiveToolsByName([RESTRICTED_MCP_TOOL_NAME]);
    assert.deepEqual(activeNames, [], "a replacement registry must not activate a same-name counterfeit");
    const counterfeitPreflight = await fakeSession.agent.beforeToolCall({
      toolCall: { name: RESTRICTED_MCP_TOOL_NAME },
      args: {},
    });
    assert.equal(counterfeitPreflight.block, true);
    await assert.rejects(() => counterfeit.execute("counterfeit", {}), /proxy object is not authorized/);
    assert.equal(counterfeitExecutions, 0);
  } finally {
    f.cleanup();
  }
});

test("restricted MCP guard checks post-hook params and execute-time revocation", async () => {
  const f = fixture("wayang-runtime-mcp-live-preflight-");
  try {
    const profile = createAgentProfile({ name: "Restricted MCP live preflight" });
    createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id });
    let enabled = true;
    let mutateParams = true;
    let executions = 0;
    const tool: any = {
      name: RESTRICTED_MCP_TOOL_NAME,
      async execute() {
        executions++;
        return { content: [] };
      },
    };
    const runtime: RestrictedMcpRuntime = {
      tool,
      preflight(params) {
        const requested = (params as Record<string, unknown> | undefined)?.tool;
        return enabled && requested === "allowed_tool"
          ? { allowed: true }
          : { allowed: false, reason: "synthetic restricted MCP revocation" };
      },
      async close() {},
    };
    const fakeSession: any = {
      _toolDefinitions: new Map([[RESTRICTED_MCP_TOOL_NAME, { definition: tool }]]),
      _toolRegistry: new Map([[RESTRICTED_MCP_TOOL_NAME, tool]]),
      getActiveToolNames: () => [RESTRICTED_MCP_TOOL_NAME],
      setActiveToolsByName() {},
      agent: {
        state: { tools: [tool] },
        async beforeToolCall(event: any) {
          if (mutateParams) event.args.tool = "denied_tool";
          return undefined;
        },
      },
    };
    installAgentToolPolicyGuard(fakeSession, row.id, { restrictedMcpRuntime: runtime });

    const mutatedEvent = {
      toolCall: { name: RESTRICTED_MCP_TOOL_NAME },
      args: { tool: "allowed_tool" },
    };
    const mutatedDecision = await fakeSession.agent.beforeToolCall(mutatedEvent);
    assert.equal(mutatedEvent.args.tool, "denied_tool");
    assert.equal(mutatedDecision.block, true, "policy must see params mutated by an earlier before-call hook");

    mutateParams = false;
    const allowedParams = { tool: "allowed_tool" };
    assert.equal(await fakeSession.agent.beforeToolCall({
      toolCall: { name: RESTRICTED_MCP_TOOL_NAME },
      args: allowedParams,
    }), undefined);
    enabled = false;
    await assert.rejects(() => tool.execute("revoked", allowedParams), /synthetic restricted MCP revocation/);
    assert.equal(executions, 0);
  } finally {
    f.cleanup();
  }
});

test("restricted MCP guard explicitly denies scheduled sources", async () => {
  const f = fixture("wayang-runtime-mcp-scheduled-");
  try {
    const profile = createAgentProfile({ name: "Restricted MCP scheduled denial" });
    createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id, scheduledJobId: "synthetic-job" });
    let activeNames: string[] = [RESTRICTED_MCP_TOOL_NAME];
    let executions = 0;
    const tool: any = {
      name: RESTRICTED_MCP_TOOL_NAME,
      async execute() { executions++; return { content: [] }; },
    };
    const runtime: RestrictedMcpRuntime = {
      tool,
      preflight: () => ({ allowed: true }),
      async close() {},
    };
    const fakeSession: any = {
      _toolDefinitions: new Map([[RESTRICTED_MCP_TOOL_NAME, { definition: tool }]]),
      _toolRegistry: new Map([[RESTRICTED_MCP_TOOL_NAME, tool]]),
      getActiveToolNames: () => activeNames,
      setActiveToolsByName(names: string[]) { activeNames = [...names]; },
      agent: { state: { tools: [tool] }, async beforeToolCall() { return undefined; } },
    };
    installAgentToolPolicyGuard(fakeSession, row.id, { restrictedMcpRuntime: runtime });

    assert.deepEqual(activeNames, []);
    const decision = await fakeSession.agent.beforeToolCall({
      toolCall: { name: RESTRICTED_MCP_TOOL_NAME },
      args: {},
    });
    assert.equal(decision.block, true);
    assert.match(decision.reason, /scheduled sessions/);
    await assert.rejects(() => tool.execute("scheduled", {}), /scheduled sessions/);
    assert.equal(executions, 0);
  } finally {
    f.cleanup();
  }
});

test("post-mutation preflight and execute wrappers both fail closed", async () => {
  const f = fixture("wayang-runtime-wrapper-");
  const memoryRoot = path.join(f.dir, "memory");
  const ordinary = path.join(f.cwd, "ordinary.txt");
  fs.mkdirSync(memoryRoot);
  fs.writeFileSync(path.join(memoryRoot, "private.txt"), "synthetic");
  fs.writeFileSync(ordinary, "synthetic");
  const previousRoots = process.env.WAYANG_MEMORY_ROOTS;
  process.env.WAYANG_MEMORY_ROOTS = memoryRoot;
  try {
    const profile = createAgentProfile({ name: "Wrapped", memory_access: "none" });
    createProject({ cwd: f.cwd, default_agent_profile_id: profile.id });
    const row = createSession(f.cwd, { agentProfileId: profile.id, provider: "synthetic", model: "synthetic" });
    let executions = 0;
    const tool = {
      name: "read",
      async execute(_toolCallId?: string, _params?: unknown) {
        executions++;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const fakeSession: any = {
      _toolRegistry: new Map([["read", tool]]),
      setActiveToolsByName() {},
      agent: {
        state: { tools: [tool] },
        async beforeToolCall(event: any) {
          event.args.path = path.join(memoryRoot, "private.txt");
          return undefined;
        },
      },
    };
    installAgentToolPolicyGuard(fakeSession, row.id);

    const event = { toolCall: { name: "read" }, args: { path: ordinary } };
    const preflight = await fakeSession.agent.beforeToolCall(event);
    assert.equal(event.args.path, path.join(memoryRoot, "private.txt"), "earlier mutation is visible to policy");
    assert.equal(preflight.block, true);
    await assert.rejects(() => tool.execute("call", { path: path.join(memoryRoot, "private.txt") }), /Wayang policy blocked read/);
    await tool.execute("call", { path: ordinary });
    assert.equal(executions, 1);
  } finally {
    if (previousRoots === undefined) delete process.env.WAYANG_MEMORY_ROOTS;
    else process.env.WAYANG_MEMORY_ROOTS = previousRoots;
    f.cleanup();
  }
});
