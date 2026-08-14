import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ProtectedBrowserBinding, ProtectedBrowserOperation } from "./types.js";
import { StandardBrowserProfileHost, type StandardBrowserHostBackend, type StandardBrowserHostBackendCallbacks } from "./standard-host.js";
import type { BrowserProfileRow } from "./profile-catalog-store.js";
import { BrowserStorageOwnershipRegistry } from "./profile-storage-registry.js";

class FakeBackend implements StandardBrowserHostBackend {
  running = false;
  readonly targets = new Map<string, { id: string; openerId?: string; url?: string; title?: string }>();
  readonly closed: string[] = [];
  readonly executions: Array<{ targetId: string; operation: ProtectedBrowserOperation }> = [];
  readonly canceledDownloads: string[] = [];
  readonly closeFailures = new Set<string>();
  downloadStagingDir?: string;
  private serial = 0;
  constructor(private readonly callbacks: StandardBrowserHostBackendCallbacks) {
    this.targets.set("restored", { id: "restored", url: "https://restore.invalid" });
  }
  async start(authorize: () => Promise<void>) { await authorize(); this.running = true; }
  async stop() { this.running = false; this.targets.clear(); }
  async listTargets() { return [...this.targets.values()].map((target) => ({ ...target })); }
  async createTarget(url: string) {
    const target = { id: `target-${++this.serial}`, url, title: url };
    this.targets.set(target.id, target);
    this.callbacks.targetCreated({ ...target });
    return { ...target };
  }
  async closeTarget(targetId: string) {
    this.closed.push(targetId);
    if (this.closeFailures.has(targetId)) throw new Error("synthetic target close failed");
    this.targets.delete(targetId);
    this.callbacks.targetDestroyed(targetId);
  }
  async cancelDownload(guid: string) { this.canceledDownloads.push(guid); }
  async execute(targetId: string, operation: ProtectedBrowserOperation, authorize: () => Promise<void>) {
    await authorize();
    this.executions.push({ targetId, operation });
    if (operation.kind === "navigate") {
      const target = this.targets.get(targetId)!;
      target.url = operation.url;
      target.title = operation.url;
      this.callbacks.targetChanged({ ...target });
    }
    await authorize();
    return { targetId, kind: operation.kind };
  }
  popup(openerId: string, url: string) {
    const target = { id: `target-${++this.serial}`, openerId, url, title: url };
    this.targets.set(target.id, target);
    this.callbacks.targetCreated({ ...target });
    return target;
  }
  beginDownload(targetId: string | null, guid: string, url = "https://download.example/file") {
    this.callbacks.downloadWillBegin({ frameId: "frame", guid, url, suggestedFilename: `${guid}.bin` }, targetId);
  }
  progressDownload(guid: string, state: "inProgress" | "completed" | "canceled", bytes: number) {
    this.callbacks.downloadProgress({ guid, state, receivedBytes: bytes, totalBytes: bytes });
  }
  unassigned(url: string) {
    const target = { id: `target-${++this.serial}`, url, title: url };
    this.targets.set(target.id, target);
    this.callbacks.targetCreated({ ...target });
    return target;
  }
}

const profile: BrowserProfileRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Shared",
  storage_source: { kind: "managed", storage_key: "shared" },
  storage_identity_digest: "a".repeat(64),
  state: "active",
  revision: 1,
  created_at: 1,
  updated_at: 1,
};

function binding(sourceSessionId: string, runtimeGeneration = `runtime-${sourceSessionId}`): ProtectedBrowserBinding {
  return {
    capabilityId: "wayang.standard-browser.v1",
    sourceSessionId,
    projectId: "project",
    projectCwd: "/synthetic/project",
    agentProfileId: "agent",
    associationRevision: 1,
    runtimeGeneration,
    processBootNonce: "boot",
    controlGeneration: 1,
  };
}

function hostFixture() {
  const registry = new BrowserStorageOwnershipRegistry();
  const descriptor = { profileId: profile.id, root: "/synthetic/data/profile", identityDigest: profile.storage_identity_digest };
  const lease = registry.claim(descriptor, "host");
  let backend!: FakeBackend;
  const host = new StandardBrowserProfileHost(profile, descriptor, lease, ({ callbacks }) => {
    backend = new FakeBackend(callbacks);
    return backend;
  }, { authorize: () => true });
  return { host, backend: () => backend, registry };
}

test("same-profile sessions own exact independent targets and opener popups", async () => {
  const f = hostFixture();
  const a = binding("session-a");
  const b = binding("session-b");
  const wa = f.host.bindWorkspace(a);
  const wb = f.host.bindWorkspace(b);
  await Promise.all([
    f.host.execute(a, wa.generation, { kind: "navigate", url: "https://a.example" }),
    f.host.execute(b, wb.generation, { kind: "navigate", url: "https://b.example" }),
  ]);
  assert.ok(f.backend().closed.includes("restored"), "startup-restored target was not quarantined/closed");
  const stateA = f.host.publicState(a, wa.generation);
  const stateB = f.host.publicState(b, wb.generation);
  assert.equal(stateA.tabs[0]?.url, "https://a.example/");
  assert.equal(stateB.tabs[0]?.url, "https://b.example/");
  assert.notEqual(stateA.activeTab, stateB.activeTab);
  assert.notEqual(f.backend().executions[0]?.targetId, f.backend().executions[1]?.targetId);

  const rawA = f.backend().executions.find((entry) => entry.operation.kind === "navigate"
    && entry.operation.url === "https://a.example")!.targetId;
  f.backend().popup(rawA, "https://popup.example");
  assert.equal(f.host.publicState(a, wa.generation).tabs.length, 2);
  assert.equal(f.host.publicState(b, wb.generation).tabs.length, 1);

  f.backend().unassigned("https://human.example");
  assert.equal(f.host.publicState(a, wa.generation).tabs.length, 2, "unattributed target leaked into A");
  assert.equal(f.host.publicState(b, wb.generation).tabs.length, 1, "unattributed target leaked into B");
  await f.host.close();
});

test("failed target closure retains exact cleanup identity and blocks workspace replacement until retry", async () => {
  const f = hostFixture();
  const exact = binding("session-a");
  const workspace = f.host.bindWorkspace(exact);
  await f.host.execute(exact, workspace.generation, { kind: "navigate", url: "https://cleanup.example" });
  const targetId = f.backend().executions.at(-1)!.targetId;
  f.backend().closeFailures.add(targetId);
  await assert.rejects(() => f.host.closeWorkspace(exact.sourceSessionId, "archive"), /cleanup is pending/);
  assert.ok(f.backend().targets.has(targetId));
  assert.throws(() => f.host.bindWorkspace(binding("session-a", "replacement-runtime")), /cleanup is pending/);
  f.backend().closeFailures.delete(targetId);
  await f.host.closeWorkspace(exact.sourceSessionId, "cleanup_retry");
  assert.equal(f.backend().targets.has(targetId), false);
  assert.doesNotThrow(() => f.host.bindWorkspace(binding("session-a", "replacement-runtime")));
  await f.host.close();
});

test("agent tab projections strip URL credentials, query, fragments, and URL-bearing titles", async () => {
  const f = hostFixture();
  const exact = binding("session-a");
  const workspace = f.host.bindWorkspace(exact);
  await f.host.execute(exact, workspace.generation, { kind: "navigate", url: "https://example.test/path?code=SECRET#fragment" });
  const rawTarget = f.backend().executions.at(-1)!.targetId;
  const updated = f.backend().targets.get(rawTarget)!;
  updated.title = "Login code SECRET";
  (f.backend() as any).callbacks.targetChanged({ ...updated });
  const state = f.host.publicState(exact, workspace.generation);
  assert.equal(state.tabs[0]?.url, "https://example.test/path");
  assert.equal(state.tabs[0]?.title, "Login code [REDACTED]");
  assert.doesNotMatch(JSON.stringify(state), /SECRET|fragment/);
  await f.host.close();
});

test("human handoff hides agent tab metadata and denies every agent tab mutation", async () => {
  const f = hostFixture();
  const exact = binding("session-a");
  const workspace = f.host.bindWorkspace(exact);
  await f.host.execute(exact, workspace.generation, { kind: "navigate", url: "https://sensitive.example/path?token=SECRET" });
  await f.host.ownerSetControlMode(exact.sourceSessionId, workspace.generation, "paused");
  const status = f.host.publicState(exact, workspace.generation);
  assert.deepEqual(status.tabs, []);
  assert.equal(status.activeTab, null);
  await assert.rejects(() => f.host.listTabs(exact, workspace.generation), /human control|control changed/);
  await assert.rejects(() => f.host.openTab(exact, workspace.generation), /human control|control changed/);
  assert.throws(() => f.host.selectTab(exact, workspace.generation, "stale"), /human control/);
  await assert.rejects(() => f.host.closeTab(exact, workspace.generation, "stale"), /human control|control changed/);
  await f.host.close();
});

test("human resume retains exact tabs and workspace activity is not host-wide", async () => {
  const f = hostFixture();
  const exact = binding("session-a");
  const workspace = f.host.bindWorkspace(exact);
  await f.host.execute(exact, workspace.generation, { kind: "navigate", url: "https://resume.example/path" });
  const before = f.host.publicState(exact, workspace.generation);
  await f.host.ownerSetControlMode(exact.sourceSessionId, workspace.generation, "paused");
  await f.host.ownerResumeAgent(exact.sourceSessionId, workspace.generation);
  const after = f.host.publicState(exact, workspace.generation);
  assert.deepEqual(after.tabs, before.tabs);
  assert.equal(after.activeTab, before.activeTab);
  assert.equal(after.running, true);
  await f.host.closeWorkspace(exact.sourceSessionId, "owner_close_all");
  const rebound = f.host.bindWorkspace({ ...exact, runtimeGeneration: "runtime-rebound" });
  assert.equal(f.host.publicState({ ...exact, runtimeGeneration: "runtime-rebound" }, rebound.generation).running, false);
  await f.host.close();
});

test("downloads freeze exact target/workspace ownership and detach cancels before publication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-standard-download-owner-"));
  const projectDir = path.join(root, "project");
  const stagingDir = path.join(root, "staging");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  const f = hostFixture();
  f.backend().downloadStagingDir = stagingDir;
  const exact = { ...binding("session-a"), projectCwd: projectDir };
  const workspace = f.host.bindWorkspace(exact);
  await f.host.execute(exact, workspace.generation, { kind: "start" });
  const rawTarget = f.backend().targets.keys().next().value as string;
  f.backend().beginDownload(null, "unknown");
  assert.deepEqual(f.backend().canceledDownloads, ["unknown"]);

  f.backend().beginDownload(rawTarget, "owned");
  fs.writeFileSync(path.join(stagingDir, "owned"), Buffer.from("data"));
  await f.host.detachAgentLease(exact.sourceSessionId, exact.runtimeGeneration);
  assert.ok(f.backend().canceledDownloads.includes("owned"));
  f.backend().progressDownload("owned", "completed", 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(projectDir, ".wayang", "browser-downloads", "owned.bin")), false);
  await f.host.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("agent detach preserves UI workspace while runtime rebind fences the old generation", async () => {
  const f = hostFixture();
  const first = binding("session-a", "runtime-1");
  const workspace = f.host.bindWorkspace(first);
  await f.host.execute(first, workspace.generation, { kind: "start" });
  f.host.detachAgentLease(first.sourceSessionId, first.runtimeGeneration);
  assert.throws(() => f.host.publicState(first, workspace.generation), /stale/);

  const second = binding("session-a", "runtime-2");
  const rebound = f.host.bindWorkspace(second);
  assert.equal(rebound.reused, true);
  assert.equal(rebound.generation, workspace.generation);
  assert.equal(f.host.publicState(second, rebound.generation).tabs.length, 1);
  await f.host.closeWorkspace(second.sourceSessionId, "archive");
  assert.throws(() => f.host.publicState(second, rebound.generation), /stale/);
  await f.host.close();
  assert.equal(f.registry.activeCount(), 0);
});
