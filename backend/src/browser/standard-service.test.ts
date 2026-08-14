import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ProtectedBrowserBinding, ProtectedBrowserOperation } from "./types.js";
import { browserProfileStorageIdentityDigest, type BrowserProfileRow, type ProjectBrowserDefaultRow, type SessionBrowserStateRow } from "./profile-catalog-store.js";
import { StandardBrowserProfileHostService, type StandardBrowserCatalogPort } from "./standard-service.js";
import type { StandardBrowserHostBackend, StandardBrowserHostBackendCallbacks } from "./standard-host.js";

class FakeBackend implements StandardBrowserHostBackend {
  running = false;
  targets = new Map<string, { id: string; url?: string; title?: string; openerId?: string }>();
  executions: Array<{ targetId: string; operation: ProtectedBrowserOperation }> = [];
  closeFailures = new Set<string>();
  serial = 0;
  constructor(private callbacks: StandardBrowserHostBackendCallbacks) {}
  async start(authorize: () => Promise<void>) { await authorize(); this.running = true; }
  async stop() { this.running = false; this.targets.clear(); }
  async listTargets() { return [...this.targets.values()]; }
  async createTarget(url: string) { const target = { id: `target-${++this.serial}`, url }; this.targets.set(target.id, target); this.callbacks.targetCreated(target); return target; }
  async closeTarget(id: string) {
    if (this.closeFailures.has(id)) throw new Error("synthetic target close failed");
    this.targets.delete(id); this.callbacks.targetDestroyed(id);
  }
  async execute(targetId: string, operation: ProtectedBrowserOperation, authorize: () => Promise<void>) { await authorize(); this.executions.push({ targetId, operation }); await authorize(); return { targetId, kind: operation.kind }; }
}

function binding(session: string, projectId = "project"): ProtectedBrowserBinding {
  return {
    capabilityId: "wayang.standard-browser.v1",
    sourceSessionId: session,
    projectId,
    projectCwd: `/synthetic/${projectId}`,
    agentProfileId: "agent",
    associationRevision: 1,
    runtimeGeneration: `runtime-${session}`,
    processBootNonce: "boot",
    controlGeneration: 1,
  };
}

function fixture(configured: Record<string, string | null>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-standard-service-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const sourceA = { kind: "managed" as const, storage_key: "alpha" };
  const sourceB = { kind: "managed" as const, storage_key: "beta" };
  const profiles: BrowserProfileRow[] = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alpha", storage_source: sourceA, storage_identity_digest: browserProfileStorageIdentityDigest(dataDir, sourceA), state: "active", revision: 1, created_at: 1, updated_at: 1 },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Beta", storage_source: sourceB, storage_identity_digest: browserProfileStorageIdentityDigest(dataDir, sourceB), state: "active", revision: 1, created_at: 1, updated_at: 1 },
  ];
  const states = new Map<string, SessionBrowserStateRow>();
  for (const [session, profileId] of Object.entries(configured)) states.set(session, { session_id: session, active_profile_id: profileId, revision: 1, updated_at: 1 });
  const defaults = new Map<string, ProjectBrowserDefaultRow>();
  let generation = 1;
  const catalog: StandardBrowserCatalogPort = {
    authorize: (exactBinding, profile) => exactBinding.capabilityId === "wayang.standard-browser.v1" && profile.state === "active",
    ownerAuthority: (sourceSessionId, profile) => profile.state === "active" ? {
      sourceSessionId,
      projectId: "project",
      projectCwd: "/synthetic/project",
      agentProfileId: "agent",
      associationRevision: 1,
    } : null,
    catalog: () => ({ generation, profiles }),
    materializeSessionState: (exactBinding) => structuredClone(states.get(exactBinding.sourceSessionId) ?? { session_id: exactBinding.sourceSessionId, active_profile_id: null, revision: 1, updated_at: 1 }),
    sessionState: (session) => states.has(session) ? structuredClone(states.get(session)!) : null,
    switchSessionProfile: ({ binding: exactBinding, profileId, expectedRevision }) => {
      const current = states.get(exactBinding.sourceSessionId)!;
      if (current.revision !== expectedRevision) throw new Error("stale session state");
      current.active_profile_id = profileId; current.revision += 1; current.updated_at += 1; generation += 1;
      return structuredClone(current);
    },
    projectDefault: (projectId) => defaults.has(projectId) ? structuredClone(defaults.get(projectId)!) : null,
    setProjectDefault: ({ binding: exactBinding, profileId, expectedRevision }) => {
      const current = defaults.get(exactBinding.projectId);
      if ((current?.revision ?? null) !== expectedRevision) throw new Error("stale default");
      const next = { project_id: exactBinding.projectId, profile_id: profileId, revision: (current?.revision ?? 0) + 1, updated_at: 1, updated_by: "agent" as const };
      defaults.set(exactBinding.projectId, next); generation += 1; return structuredClone(next);
    },
    sourceSessionsForAuthority: () => [...states.keys()],
  };
  const backends: FakeBackend[] = [];
  const service = new StandardBrowserProfileHostService({
    dataDir,
    catalog,
    backendFactory: ({ callbacks }) => { const backend = new FakeBackend(callbacks); backends.push(backend); return backend; },
  });
  return { root, service, profiles, states, backends, cleanup: async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function execute(runtime: any, name: string, args: Record<string, unknown> = {}) {
  const tool = runtime.toolForName(name);
  assert.ok(tool, `${name} missing`);
  return (tool.execute as any)(`call-${name}`, args);
}

test("two Standard runtimes share one profile host but own distinct tool objects and targets", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "session-b": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const a = f.service.createRuntime(binding("session-a"));
    const b = f.service.createRuntime(binding("session-b"));
    assert.notEqual(a.toolForName("browser_navigate"), b.toolForName("browser_navigate"));
    await Promise.all([
      execute(a, "browser_navigate", { url: "https://a.example" }),
      execute(b, "browser_navigate", { url: "https://b.example" }),
    ]);
    assert.equal(f.backends.length, 1, "same named profile created more than one Chromium host");
    assert.equal(f.backends[0]!.executions.length, 2);
    assert.notEqual(f.backends[0]!.executions[0]!.targetId, f.backends[0]!.executions[1]!.targetId);
    await a.detachAgentLease("pi_idle");
    assert.equal(a.preflight().allowed, false);
    assert.equal(b.preflight().allowed, true);
  } finally { await f.cleanup(); }
});

test("session cleanup propagates target-close failure and retries with retained host identity", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const runtime = f.service.createRuntime(binding("session-a"));
    await execute(runtime, "browser_open");
    const backend = f.backends[0]!;
    const targetId = backend.executions.at(-1)?.targetId ?? [...backend.targets.keys()][0]!;
    backend.closeFailures.add(targetId);
    await assert.rejects(() => f.service.closeSessionWorkspaces("session-a", "archive"), /cleanup is pending/);
    assert.equal(runtime.preflight().allowed, false);
    assert.ok(backend.targets.has(targetId));
    backend.closeFailures.delete(targetId);
    await f.service.sweepIdle();
    assert.equal(backend.targets.has(targetId), false, "bounded cleanup retry did not retire the retained target");
  } finally { await f.cleanup(); }
});

test("catalog-only runtime lists profiles, switches by opaque choice, and changes only current project default", async () => {
  const f = fixture({ "session-a": null });
  try {
    const runtime = f.service.createRuntime(binding("session-a", "project-a"));
    const status = await execute(runtime, "browser_status") as any;
    assert.match(status.content[0].text, /"configured":false/);
    const listed = await execute(runtime, "browser_list_profiles") as any;
    const parsed = JSON.parse(listed.content[0].text);
    const alphaChoice = parsed.profiles.find((row: any) => row.name === "Alpha").profile;
    await execute(runtime, "browser_set_project_default_profile", { profile: alphaChoice });
    assert.equal(f.states.get("session-a")!.active_profile_id, null, "project default assigned current session");
    // A catalog mutation invalidates old choices; list again before switching.
    const refreshed = JSON.parse((await execute(runtime, "browser_list_profiles") as any).content[0].text);
    const refreshedAlpha = refreshed.profiles.find((row: any) => row.name === "Alpha").profile;
    await execute(runtime, "browser_switch_profile", { profile: refreshedAlpha });
    assert.equal(f.states.get("session-a")!.active_profile_id, f.profiles[0]!.id);
    await assert.rejects(() => (runtime.toolForName("browser_switch_profile")!.execute as any)("stale", { profile: alphaChoice }), /stale/);
  } finally { await f.cleanup(); }
});

test("workspace and empty-host idle thresholds are independent", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const runtime = f.service.createRuntime(binding("session-a"));
    await execute(runtime, "browser_open");
    const future = Date.now() + 61 * 60 * 1000;
    assert.deepEqual(await f.service.sweepIdle(future), { workspacesClosed: 1, hostsStopped: 0 });
    assert.deepEqual(await f.service.sweepIdle(future + 14 * 60 * 1000), { workspacesClosed: 0, hostsStopped: 0 });
    assert.deepEqual(await f.service.sweepIdle(future + 15 * 60 * 1000), { workspacesClosed: 0, hostsStopped: 1 });
  } finally { await f.cleanup(); }
});

test("profile switching is denied while any retained source workspace is paused", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const runtime = f.service.createRuntime(binding("session-a"));
    await execute(runtime, "browser_open");
    await execute(runtime, "browser_wait_for_user", { reason: "synthetic login" });
    const listed = JSON.parse((await execute(runtime, "browser_list_profiles") as any).content[0].text);
    const beta = listed.profiles.find((row: any) => row.name === "Beta").profile;
    await assert.rejects(() => execute(runtime, "browser_switch_profile", { profile: beta }), /during human/);
  } finally { await f.cleanup(); }
});
