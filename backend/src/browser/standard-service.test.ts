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
  stopFailures = 0;
  credentialMode: "none" | "blocked" | "text-allowed" = "none";
  serial = 0;
  constructor(private callbacks: StandardBrowserHostBackendCallbacks) {}
  async start(authorize: () => Promise<void>) { await authorize(); this.running = true; }
  async stop() {
    if (this.stopFailures > 0) { this.stopFailures -= 1; throw new Error("synthetic host stop failed"); }
    this.running = false; this.targets.clear();
  }
  async listTargets() { return [...this.targets.values()]; }
  async createTarget(url: string) { const target = { id: `target-${++this.serial}`, url }; this.targets.set(target.id, target); this.callbacks.targetCreated(target); return target; }
  async closeTarget(id: string) {
    if (this.closeFailures.has(id)) throw new Error("synthetic target close failed");
    this.targets.delete(id); this.callbacks.targetDestroyed(id);
  }
  async execute(targetId: string, operation: ProtectedBrowserOperation, authorize: () => Promise<void>) { await authorize(); this.executions.push({ targetId, operation }); await authorize(); return { targetId, kind: operation.kind }; }
  async credentialContext(targetId: string, runtimeKey: string, authorize: () => Promise<void>) {
    await authorize();
    return { runtimeKey, targetId, documentIdentity: `${targetId}:document`, url: "https://login.example/", origin: "https://login.example" };
  }
  async fillCredential(targetId: string, expected: any, values: any, authorize: () => Promise<void>) {
    await authorize();
    assert.equal(expected.targetId, targetId);
    assert.equal(values.password, "synthetic-secret");
    this.credentialMode = "blocked";
    return ["username", "password"] as Array<"username" | "password">;
  }
  async allowCredentialInspection(_targetId: string, _expected: any, authorize: () => Promise<void>) { await authorize(); this.credentialMode = "text-allowed"; }
  async assertSafeCredentialResume() { if (this.credentialMode !== "none") throw new Error("fresh top-level document required"); }
  credentialInspection() { return this.credentialMode; }
  redactCredentialMetadata(value: unknown) { return value; }
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

function fixture(configured: Record<string, string | null>, credentialBroker?: any) {
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
    credentialBroker,
  });
  return { root, service, catalog, profiles, states, backends, cleanup: async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); } };
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

test("owner workspace stop invalidates its lease and the same runtime safely reacquires", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const runtime = f.service.createRuntime(binding("session-a"));
    await execute(runtime, "browser_open");
    const first = f.service.resolveOwnerWorkspace("session-a", "/synthetic/project")!.workspace;
    await first.host.closeWorkspace("session-a", "owner_stop");
    const rebound = f.service.resolveOwnerWorkspace("session-a", "/synthetic/project")!.workspace;
    assert.notEqual(rebound.workspaceGeneration, first.workspaceGeneration);
    await execute(runtime, "browser_status");
    await execute(runtime, "browser_open");
    assert.equal(rebound.host.hasWorkspace("session-a", rebound.workspaceGeneration), true);
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

for (const arrival of ["while-viewer-close-pending", "during-viewer-close", "during-runtime-revocation"] as const) {
  test(`session cleanup freezes absent second-host workspace before ${arrival}`, async () => {
    const f = fixture({
      "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "session-b": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let closing: Promise<void> | undefined;
    try {
      const old = f.service.createRuntime(binding("session-a"));
      await execute(old, "browser_open");
      const first = f.service.resolveLiveWorkspace(binding("session-a"))!;
      const other = f.service.createRuntime(binding("session-b"));
      await execute(other, "browser_open");
      const otherWorkspace = f.service.resolveLiveWorkspace(binding("session-b"))!;
      const otherTarget = [...f.backends[1]!.targets.keys()][0]!;
      assert.notEqual(first.host, otherWorkspace.host);

      const replacementBinding = { ...binding("session-a"), runtimeGeneration: "replacement-runtime" };
      const arrived: {
        runtime?: ReturnType<typeof f.service.createRuntime>;
        workspace?: ReturnType<typeof f.service.resolveLiveWorkspace>;
      } = {};
      const attachReplacement = () => {
        const state = f.states.get("session-a")!;
        state.active_profile_id = f.profiles[1]!.id;
        state.revision += 1;
        arrived.runtime = f.service.createRuntime(replacementBinding);
        arrived.workspace = f.service.resolveLiveWorkspace(replacementBinding);
      };
      if (arrival === "during-runtime-revocation") {
        const latch = old.latchRevoked;
        old.latchRevoked = () => { old.latchRevoked = latch; latch(); attachReplacement(); };
      }
      await first.host.ownerSetControlMode("session-a", first.workspaceGeneration, "user");
      let closeEntered!: () => void;
      const entered = new Promise<void>((resolve) => { closeEntered = resolve; });
      first.host.registerViewer("session-a", first.workspaceGeneration, async () => {
        if (arrival === "during-viewer-close") attachReplacement();
        closeEntered();
        await closeGate;
      });
      closing = f.service.closeSessionWorkspaces("session-a", "archive");
      await entered;
      if (arrival === "while-viewer-close-pending") attachReplacement();
      const { runtime: replacement, workspace: replacementWorkspace } = arrived;
      assert.ok(replacement);
      assert.ok(replacementWorkspace);
      await execute(replacement, "browser_open");
      const target = [...f.backends[1]!.targets.keys()].find((id) => id !== otherTarget)!;
      assert.ok(target);
      releaseClose();
      await closing;

      assert.equal(replacementWorkspace!.host.hasWorkspace("session-a", replacementWorkspace!.workspaceGeneration), true,
        "old cleanup closed a workspace absent from its original second-host targets");
      assert.equal(f.service.resolveLiveWorkspace(replacementBinding), replacementWorkspace!,
        "old cleanup deleted the newly attached lease");
      assert.ok(f.backends[1]!.targets.has(target));
      assert.ok(f.backends[1]!.targets.has(otherTarget));
      assert.equal(replacement.preflight().allowed, true);
      assert.equal(old.preflight().allowed, false);
    } finally {
      releaseClose();
      await closing?.catch(() => undefined);
      await f.cleanup();
    }
  });
}

test("session cleanup preserves a replacement second-host generation and exact lease", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  let releaseClose!: () => void;
  const gate = new Promise<void>((resolve) => { releaseClose = resolve; });
  let closing: Promise<void> | undefined;
  try {
    const exact = binding("session-a");
    const old = f.service.createRuntime(exact);
    await execute(old, "browser_open");
    const first = f.service.resolveLiveWorkspace(exact)!;
    const switched = await f.service.switchProfile(exact, first, f.profiles[1]!.id, 1);
    const second = switched.workspace;
    await second.host.execute(exact, second.workspaceGeneration, { kind: "start" });
    const oldTarget = [...f.backends[1]!.targets.keys()][0]!;
    await first.host.ownerSetControlMode("session-a", first.workspaceGeneration, "user");
    let closeEntered!: () => void;
    const entered = new Promise<void>((resolve) => { closeEntered = resolve; });
    first.host.registerViewer("session-a", first.workspaceGeneration, async () => { closeEntered(); await gate; });
    closing = f.service.closeSessionWorkspaces("session-a", "archive");
    await entered;
    await second.host.closeWorkspace("session-a", "owner_stop");
    const replacementBinding = { ...exact, runtimeGeneration: "replacement-runtime" };
    const replacement = f.service.createRuntime(replacementBinding);
    const current = f.service.resolveLiveWorkspace(replacementBinding)!;
    assert.notEqual(current.workspaceGeneration, second.workspaceGeneration);
    await execute(replacement, "browser_open");
    const newTarget = [...f.backends[1]!.targets.keys()][0]!;
    releaseClose();
    await closing;
    assert.equal(current.host.hasWorkspace("session-a", current.workspaceGeneration), true,
      "old cleanup followed the second host into a replacement generation");
    assert.equal(f.service.resolveLiveWorkspace(replacementBinding), current, "old cleanup deleted the replacement lease entry");
    assert.equal(f.backends[1]!.targets.has(oldTarget), false);
    assert.ok(f.backends[1]!.targets.has(newTarget));
    assert.equal(replacement.preflight().allowed, true);
  } finally {
    releaseClose();
    await closing?.catch(() => undefined);
    await f.cleanup();
  }
});

test("session cleanup attempts both captured hosts after failure and retains only pending cleanup", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const exact = binding("session-a");
    const runtime = f.service.createRuntime(exact);
    await execute(runtime, "browser_open");
    const first = f.service.resolveLiveWorkspace(exact)!;
    const second = (await f.service.switchProfile(exact, first, f.profiles[1]!.id, 1)).workspace;
    await second.host.execute(exact, second.workspaceGeneration, { kind: "start" });
    const target = [...f.backends[0]!.targets.keys()][0]!;
    f.backends[0]!.closeFailures.add(target);
    await assert.rejects(f.service.closeSessionWorkspaces("session-a", "archive"), /cleanup is pending/);
    assert.deepEqual(first.host.cleanupPendingSessionIds(), ["session-a"]);
    assert.ok(f.backends[0]!.targets.has(target));
    assert.equal(second.host.workspaceCount, 0, "first-host failure skipped the captured second host");
    assert.equal(f.backends[1]!.targets.size, 0);
    assert.equal(f.service.resolveLiveWorkspace(exact), null, "successful target retained its service lease");
    f.backends[0]!.closeFailures.clear();
    await f.service.closeSessionWorkspaces("session-a", "archive");
    assert.equal(first.host.workspaceCount, 0);
    assert.equal(f.backends[0]!.targets.size, 0);
  } finally {
    f.backends[0]?.closeFailures.clear();
    await f.cleanup();
  }
});

test("captured cleanup retries only failed exact targets after a replacement attaches", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const exact = binding("session-a");
    const old = f.service.createRuntime(exact);
    await execute(old, "browser_open");
    const first = f.service.resolveLiveWorkspace(exact)!;
    const second = (await f.service.switchProfile(exact, first, f.profiles[1]!.id, 1)).workspace;
    await second.host.execute(exact, second.workspaceGeneration, { kind: "start" });
    let revocations = 0;
    const latch = old.latchRevoked;
    old.latchRevoked = () => { revocations += 1; latch(); };
    const cleanup = f.service.captureSessionWorkspaceCleanup("session-a", "archive");
    assert.equal(revocations, 0, "capture emitted a revocation notification");
    assert.equal(first.host.hasWorkspace("session-a", first.workspaceGeneration), true);
    const target = [...f.backends[0]!.targets.keys()][0]!;
    f.backends[0]!.closeFailures.add(target);
    const attempt = cleanup();
    assert.equal(cleanup(), attempt, "concurrent captured cleanup did not join");
    await assert.rejects(attempt, /cleanup is pending/);
    assert.equal(second.host.workspaceCount, 0);
    assert.deepEqual(first.host.cleanupPendingSessionIds(), ["session-a"]);

    const replacementBinding = { ...exact, runtimeGeneration: "replacement-runtime" };
    const replacement = f.service.createRuntime(replacementBinding);
    await execute(replacement, "browser_open");
    const current = f.service.resolveLiveWorkspace(replacementBinding)!;
    const replacementTarget = [...f.backends[1]!.targets.keys()][0]!;
    f.backends[0]!.closeFailures.clear();
    await cleanup();
    await cleanup();
    assert.equal(revocations, 1, "retry notified an already revoked runtime again");
    assert.equal(first.host.workspaceCount, 0);
    assert.equal(f.backends[0]!.targets.size, 0);
    assert.equal(f.service.resolveLiveWorkspace(replacementBinding), current);
    assert.ok(f.backends[1]!.targets.has(replacementTarget));
    assert.equal(replacement.preflight().allowed, true);
  } finally {
    f.backends[0]?.closeFailures.clear();
    await f.cleanup();
  }
});

for (const method of ["closeSessionWorkspaces", "revokeAuthority"] as const) {
  test(`Standard runtime ${method} honors cleanup captured before a replacement attaches`, async () => {
    const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    try {
      const exact = binding("session-a");
      const old = f.service.createRuntime(exact);
      await execute(old, "browser_open");
      const first = f.service.resolveLiveWorkspace(exact)!;
      const captured = f.service.captureSessionWorkspaceCleanup("session-a", "archive");
      const state = f.states.get("session-a")!;
      state.active_profile_id = f.profiles[1]!.id;
      state.revision += 1;
      const replacementBinding = { ...exact, runtimeGeneration: "replacement-runtime" };
      const replacement = f.service.createRuntime(replacementBinding);
      await execute(replacement, "browser_open");
      const current = f.service.resolveLiveWorkspace(replacementBinding)!;
      if (method === "closeSessionWorkspaces") await old.closeSessionWorkspaces("archive", captured);
      else await old.revokeAuthority("project_or_profile_denied", captured);
      assert.equal(current.host.hasWorkspace("session-a", current.workspaceGeneration), true,
        "runtime adapter ignored its supplied snapshot and closed the later workspace");
      assert.equal(f.service.resolveLiveWorkspace(replacementBinding), current);
      assert.equal(replacement.preflight().allowed, true);
      assert.equal(old.preflight().allowed, false);
      assert.equal(first.host.workspaceCount, 0);
      assert.equal(f.backends[0]!.targets.size, 0);
      assert.equal(f.backends[1]!.targets.size, 1);
    } finally { await f.cleanup(); }
  });

  test(`Standard runtime ${method} retries its original failed cleanup without recapturing`, async () => {
    const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    try {
      const exact = binding("session-a");
      const old = f.service.createRuntime(exact);
      await execute(old, "browser_open");
      const first = f.service.resolveLiveWorkspace(exact)!;
      const target = [...f.backends[0]!.targets.keys()][0]!;
      const closeRuntime = () => method === "closeSessionWorkspaces"
        ? old.closeSessionWorkspaces("archive")
        : old.revokeAuthority("project_or_profile_denied");
      f.backends[0]!.closeFailures.add(target);
      await assert.rejects(closeRuntime(), /cleanup is pending/);
      assert.deepEqual(first.host.cleanupPendingSessionIds(), ["session-a"]);
      const state = f.states.get("session-a")!;
      state.active_profile_id = f.profiles[1]!.id;
      state.revision += 1;
      const replacementBinding = { ...exact, runtimeGeneration: "replacement-runtime" };
      const replacement = f.service.createRuntime(replacementBinding);
      await execute(replacement, "browser_open");
      const current = f.service.resolveLiveWorkspace(replacementBinding)!;
      f.backends[0]!.closeFailures.clear();
      await closeRuntime();
      assert.equal(first.host.workspaceCount, 0);
      assert.equal(f.backends[0]!.targets.has(target), false);
      assert.equal(f.service.resolveLiveWorkspace(replacementBinding), current);
      assert.equal(f.backends[1]!.targets.size, 1);
      assert.equal(replacement.preflight().allowed, true);
      await closeRuntime();
      assert.equal(f.service.resolveLiveWorkspace(replacementBinding), current);
    } finally {
      f.backends[0]?.closeFailures.clear();
      await f.cleanup();
    }
  });

  test(`Standard runtime ${method} reserves its in-flight cleanup before synchronous reentry`, async () => {
    const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    let releaseViewer!: () => void;
    const viewerGate = new Promise<void>((resolve) => { releaseViewer = resolve; });
    let closing: Promise<void> | undefined;
    let reentered: Promise<void> | undefined;
    try {
      const exact = binding("session-a");
      const runtime = f.service.createRuntime(exact);
      await execute(runtime, "browser_open");
      const workspace = f.service.resolveLiveWorkspace(exact)!;
      await workspace.host.ownerSetControlMode("session-a", workspace.workspaceGeneration, "user");
      let viewerEntered!: () => void;
      const entered = new Promise<void>((resolve) => { viewerEntered = resolve; });
      workspace.host.registerViewer("session-a", workspace.workspaceGeneration, async () => {
        viewerEntered();
        await viewerGate;
      });
      const captured = f.service.captureSessionWorkspaceCleanup("session-a", "archive");
      let cleanupInvocations = 0;
      const supplied = () => { cleanupInvocations += 1; return captured(); };
      const closeRuntime = () => method === "closeSessionWorkspaces"
        ? runtime.closeSessionWorkspaces("archive", supplied)
        : runtime.revokeAuthority("project_or_profile_denied", supplied);
      const latch = runtime.latchRevoked;
      runtime.latchRevoked = () => {
        runtime.latchRevoked = latch;
        latch();
        reentered = closeRuntime();
      };
      closing = closeRuntime();
      await entered;
      assert.ok(reentered, "synthetic revocation observer did not reenter runtime cleanup");
      assert.equal(reentered, closing, "reentrant runtime cleanup started a second attempt instead of joining");
      assert.equal(cleanupInvocations, 1, "runtime reentry invoked its captured operation twice");
      let settled = false;
      void reentered.then(() => { settled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "runtime cleanup confirmed before the viewer drained");
      releaseViewer();
      await Promise.all([closing, reentered]);
      assert.equal(workspace.host.workspaceCount, 0);
      assert.equal(f.backends[0]!.targets.size, 0);
    } finally {
      releaseViewer();
      await Promise.allSettled([closing, reentered]);
      await f.cleanup();
    }
  });
}

test("captured authority cleanup freezes selector sessions before invocation and retry", async () => {
  const f = fixture({
    "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "session-b": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  try {
    const a = f.service.createRuntime(binding("session-a"));
    const b = f.service.createRuntime(binding("session-b"));
    await execute(a, "browser_open");
    await execute(b, "browser_open");
    const bWorkspace = f.service.resolveLiveWorkspace(binding("session-b"))!;
    const selected = ["session-a"];
    let selections = 0;
    f.catalog.sourceSessionsForAuthority = () => { selections += 1; return selected; };
    const cleanup = f.service.captureAuthorityCleanup({
      capabilityId: "wayang.standard-browser.v1", projectId: "project", agentProfileId: "agent",
    }, "project_or_profile_denied");
    assert.equal(a.preflight().allowed, true, "capture revoked a runtime before invocation");
    selected.splice(0, 1, "session-b");
    const target = [...f.backends[0]!.targets.keys()][0]!;
    f.backends[0]!.closeFailures.add(target);
    await assert.rejects(cleanup(), /authority cleanup is pending/);
    assert.equal(a.preflight().allowed, false);
    assert.equal(b.preflight().allowed, true);
    f.backends[0]!.closeFailures.clear();
    await cleanup();
    assert.equal(selections, 1, "captured cleanup re-resolved mutable authority sessions");
    assert.equal(f.backends[0]!.targets.size, 0);
    assert.equal(f.service.resolveLiveWorkspace(binding("session-b")), bWorkspace);
    assert.equal(f.backends[1]!.targets.size, 1);
    assert.equal(b.preflight().allowed, true);
  } finally {
    f.backends[0]?.closeFailures.clear();
    await f.cleanup();
  }
});

test("authority cleanup captures all selected workspaces before the first runtime notification", async () => {
  const f = fixture({
    "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "session-b": null,
  });
  try {
    const a = f.service.createRuntime(binding("session-a"));
    await execute(a, "browser_open");
    const replacementBinding = { ...binding("session-b"), runtimeGeneration: "late-runtime" };
    let replacement: ReturnType<typeof f.service.createRuntime> | undefined;
    const latch = a.latchRevoked;
    a.latchRevoked = () => {
      a.latchRevoked = latch;
      latch();
      f.states.get("session-b")!.active_profile_id = f.profiles[1]!.id;
      replacement = f.service.createRuntime(replacementBinding);
    };
    await f.service.revokeAuthority({
      capabilityId: "wayang.standard-browser.v1", projectId: "project", agentProfileId: "agent",
    }, "project_or_profile_denied");
    assert.ok(replacement);
    assert.equal(replacement.preflight().allowed, true);
    assert.ok(f.service.resolveLiveWorkspace(replacementBinding));
    await execute(replacement, "browser_open");
  } finally { await f.cleanup(); }
});

test("completed captured cleanup cannot delete a replacement session lease map", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const old = f.service.createRuntime(binding("session-a"));
    await execute(old, "browser_open");
    const cleanup = f.service.captureSessionWorkspaceCleanup("session-a", "archive");
    await cleanup();
    const exact = { ...binding("session-a"), runtimeGeneration: "replacement-runtime" };
    const replacement = f.service.createRuntime(exact);
    const current = f.service.resolveLiveWorkspace(exact)!;
    await execute(replacement, "browser_open");
    await cleanup();
    assert.equal(f.service.resolveLiveWorkspace(exact), current);
    assert.equal(replacement.preflight().allowed, true);
    assert.equal(f.backends[0]!.targets.size, 1);
  } finally { await f.cleanup(); }
});

test("profile invalidation retains a failed host shutdown for exact retry", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const runtime = f.service.createRuntime(binding("session-a"));
    await execute(runtime, "browser_open");
    f.backends[0]!.stopFailures = 1;
    await assert.rejects(() => f.service.invalidateProfile(f.profiles[0]!.id), /shutdown is incomplete/);
    await f.service.invalidateProfile(f.profiles[0]!.id);
    assert.equal(f.backends[0]!.running, false);
  } finally { await f.cleanup(); }
});

test("service shutdown propagates failure and remains retryable", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const runtime = f.service.createRuntime(binding("session-a"));
    await execute(runtime, "browser_open");
    f.backends[0]!.stopFailures = 1;
    await assert.rejects(() => f.service.close(), /service shutdown is incomplete/);
    await f.service.close();
    assert.equal(f.backends[0]!.running, false);
  } finally { await f.cleanup(); }
});

test("Standard credentials bind the exact live workspace target and require explicit redacted inspection", async () => {
  let choiceContext: any;
  const broker = {
    status: () => ({ availability: "unlocked", unlockExpiresAt: Date.now() + 60_000 }),
    async matches(context: any) {
      choiceContext = context;
      return { availability: "unlocked", exactOrigin: context.origin, choices: [{ choiceToken: "opaque-choice", label: "Synthetic", maskedIdentifier: "s…@example", hasTotp: false }] };
    },
    async fill(token: string, operation: string, context: any, filler: (values: any) => Promise<any>) {
      assert.equal(token, "opaque-choice");
      assert.equal(operation, "login");
      assert.equal(context.runtimeKey, choiceContext.runtimeKey);
      return { filled: await filler({ username: "synthetic-user", password: "synthetic-secret" }) };
    },
    async lock() {},
  };
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, broker);
  try {
    const runtime = f.service.createRuntime(binding("session-a"));
    await execute(runtime, "browser_open");
    await execute(runtime, "browser_wait_for_user", { reason: "credential test" });
    const status = await f.service.credentialStatus("session-a", "/synthetic/project") as any;
    assert.equal(status.origin, "https://login.example");
    await f.service.credentialMatches("session-a", "/synthetic/project");
    const fill = await f.service.credentialFill("session-a", "/synthetic/project", "opaque-choice", "login") as any;
    assert.deepEqual(fill.filled, ["username", "password"]);
    const owner = f.service.resolveOwnerWorkspace("session-a", "/synthetic/project")!;
    assert.equal(owner.workspace.host.ownerPublicState("session-a", owner.workspace.workspaceGeneration).credentialInspection, "blocked");
    await assert.rejects(
      () => owner.workspace.host.ownerResumeAgent("session-a", owner.workspace.workspaceGeneration),
      /fresh top-level document/,
    );
    const allowed = await f.service.allowCredentialInspection("session-a", "/synthetic/project");
    assert.equal(allowed.controlMode, "agent");
    assert.equal(allowed.credentialInspection, "text-allowed");
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

test("failed profile CAS restores the old runtime lease", async () => {
  const f = fixture({ "session-a": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  try {
    const exactBinding = binding("session-a");
    const runtime = f.service.createRuntime(exactBinding);
    await execute(runtime, "browser_open");
    const current = f.service.resolveLiveWorkspace(exactBinding);
    assert.ok(current);
    await assert.rejects(
      () => f.service.switchProfile(exactBinding, current, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 99),
      /stale session state/,
    );
    await execute(runtime, "browser_status");
    await execute(runtime, "browser_open");
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
