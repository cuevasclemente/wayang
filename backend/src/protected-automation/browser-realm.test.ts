import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { CdpConnection, ChromeTarget } from "../browser/cdp.js";
import { ManagedChromiumRuntime, type ManagedChromiumRuntimeOptions } from "../browser/manager.js";
import {
  ProtectedAutomationBrowserRealmRegistry,
  ensureProtectedAutomationBrowserRealmStorage,
  readProtectedAutomationBrowserProfileState,
  type ProtectedAutomationManagedRuntime,
} from "./browser-realm.js";
import {
  ProtectedAutomationBrowserPreparationCore,
  type ProtectedAutomationPreparationViewerContext,
} from "./browser-preparation.js";

const browserIntegrationTest = process.env.WAYANG_BROWSER_INTEGRATION === "1" ? test : test.skip;

class SyntheticRuntime implements ProtectedAutomationManagedRuntime {
  running = false;
  stops = 0;
  gateAttachmentCloses = 0;
  rejectDownloadCancellation = false;
  snapshotPageTargetId: string | null = null;
  discoveryPageTargetId: string | null = null;
  cancelled: string[] = [];
  private targetCloseStartedResolve: (() => void) | null = null;
  private targetCloseReleaseResolve: (() => void) | null = null;
  targetCloseStarted: Promise<void> = Promise.resolve();
  private targetCloseRelease: Promise<void> = Promise.resolve();
  private runtimeStopStartedResolve: (() => void) | null = null;
  private runtimeStopReleaseResolve: (() => void) | null = null;
  runtimeStopStarted: Promise<void> = Promise.resolve();
  private runtimeStopRelease: Promise<void> = Promise.resolve();
  private rejectRuntimeStop = false;
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      this.commands.push({ method, params: { ...params } });
      if (method === "Target.setDiscoverTargets" && this.discoveryPageTargetId) {
        this.emit("Target.targetCreated", {
          targetInfo: { type: "page", targetId: this.discoveryPageTargetId, url: "about:blank" },
        });
      }
      if (method === "Target.getTargets") {
        return { targetInfos: [
          { type: "page", targetId: "target-1", url: "about:blank" },
          ...(this.snapshotPageTargetId
            ? [{ type: "page", targetId: this.snapshotPageTargetId, url: "about:blank" }]
            : []),
        ] };
      }
      if (method === "Target.closeTarget") {
        if (this.targetCloseReleaseResolve) {
          this.targetCloseStartedResolve?.();
          await this.targetCloseRelease;
        }
        if (params.targetId === this.snapshotPageTargetId) this.snapshotPageTargetId = null;
        if (params.targetId === this.discoveryPageTargetId) this.discoveryPageTargetId = null;
        return { success: true };
      }
      return method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "frame-1", loaderId: "loader-1", url: "about:blank" } } }
        : {};
    },
    on: (method: string, listener: (event: any) => void) => {
      const listeners = this.listeners.get(method) ?? new Set<(event: any) => void>();
      listeners.add(listener);
      this.listeners.set(method, listeners);
      return () => listeners.delete(listener);
    },
  } as unknown as CdpConnection;
  private readonly target = {
    id: "target-1", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://synthetic.invalid",
  } as ChromeTarget;
  constructor(readonly options: ManagedChromiumRuntimeOptions) {}
  deferTargetClose(): void {
    this.targetCloseStarted = new Promise<void>((resolve) => { this.targetCloseStartedResolve = resolve; });
    this.targetCloseRelease = new Promise<void>((resolve) => { this.targetCloseReleaseResolve = resolve; });
  }
  releaseTargetClose(): void {
    this.targetCloseReleaseResolve?.();
    this.targetCloseReleaseResolve = null;
  }
  deferStop(reject = false): void {
    this.rejectRuntimeStop = reject;
    this.runtimeStopStarted = new Promise<void>((resolve) => { this.runtimeStopStartedResolve = resolve; });
    this.runtimeStopRelease = new Promise<void>((resolve) => { this.runtimeStopReleaseResolve = resolve; });
  }
  releaseStop(): void {
    this.runtimeStopReleaseResolve?.();
    this.runtimeStopReleaseResolve = null;
  }
  async start(check?: () => Promise<void>): Promise<void> { await check?.(); this.running = true; }
  async stop(): Promise<void> {
    this.runtimeStopStartedResolve?.();
    await this.runtimeStopRelease;
    this.running = false;
    this.stops += 1;
    if (this.rejectRuntimeStop) throw new Error("synthetic runtime stop failed");
  }
  emit(event: string, params: any): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(params);
  }
  async cancelDownload(guid: string, check?: () => Promise<void>): Promise<void> {
    await check?.();
    this.cancelled.push(guid);
    if (this.rejectDownloadCancellation) throw new Error("synthetic download cancellation failed");
  }
  async attachPageCdpViewer() {
    let closed = false;
    return { cdp: this.cdp, target: this.target, close: () => {
      if (closed) return;
      closed = true;
      this.gateAttachmentCloses += 1;
    } };
  }
  async withPageCdp<T>(): Promise<T> { throw new Error("synthetic runtime has no operation CDP"); }
}

function request(root: string, assertAuthorized: () => void, kind: "run" | "prepare" = "run") {
  return {
    projectId: "synthetic-project",
    projectCwd: path.join(root, "project"),
    agentProfileId: "synthetic-profile",
    jobId: "synthetic-job",
    capabilityRevision: 3,
    jobRevision: 7,
    sourceRevision: 5,
    sourceManifestSha256: "a".repeat(64),
    allowedHttpsOrigins: ["https://allowed.example.test"],
    kind,
    ownerId: kind === "run" ? "synthetic-run" : "synthetic-preparation",
    runRoot: kind === "run" ? path.join(root, "run") : undefined,
    assertAuthorized,
  } as const;
}

test("Project/Profile/Job browser profiles are private, stable, and outside the project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-storage-"));
  try {
    const project = path.join(root, "project");
    const data = path.join(root, "data");
    fs.mkdirSync(project);
    const first = ensureProtectedAutomationBrowserRealmStorage(data, project, "project-a", "profile-a", "job-a");
    const same = ensureProtectedAutomationBrowserRealmStorage(data, project, "project-a", "profile-a", "job-a");
    const otherJob = ensureProtectedAutomationBrowserRealmStorage(data, project, "project-a", "profile-a", "job-b");
    assert.deepEqual(first, same);
    assert.notEqual(first.rootDir, otherJob.rootDir);
    assert.equal(path.relative(project, first.rootDir).startsWith(".."), true);
    assert.match(first.rootDir, /browser-realms\/v1\/project-/u);
    for (const directory of Object.values(first)) {
      const metadata = fs.lstatSync(directory);
      assert.equal(metadata.isDirectory(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.mode & 0o777, 0o700);
    }
    assert.throws(
      () => ensureProtectedAutomationBrowserRealmStorage(project, project, "project-a", "profile-a", "job-a"),
      /outside the project root/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a clean preparation close durably marks the private browser profile as saved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-prepared-state-"));
  fs.mkdirSync(path.join(root, "project"));
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => new SyntheticRuntime(options),
  });
  try {
    const lease = realms.acquire(request(root, () => undefined, "prepare"));
    assert.deepEqual(
      readProtectedAutomationBrowserProfileState(path.join(root, "data"), "synthetic-project", "synthetic-profile", "synthetic-job"),
      { saved: false, lastSavedAt: null },
    );
    await lease.saveAndClosePreparation(1_786_000_000_000);
    assert.deepEqual(realms.profileState("synthetic-project", "synthetic-profile", "synthetic-job"), {
      saved: true,
      lastSavedAt: 1_786_000_000_000,
    });
    const statePath = path.join(lease.storage.rootDir, "preparation-state.json");
    assert.equal(fs.lstatSync(statePath).isFile(), true);
    assert.equal(fs.lstatSync(statePath).mode & 0o777, 0o600);
    fs.writeFileSync(statePath, "{\"version\":1,\"last_saved_at\":\"invalid\"}\n", { mode: 0o600 });
    assert.throws(
      () => realms.profileState("synthetic-project", "synthetic-profile", "synthetic-job"),
      /preparation state is invalid/i,
    );
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed Chromium stop writes no saved marker and retains exclusivity until failure settles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-save-failure-"));
  fs.mkdirSync(path.join(root, "project"));
  let runtime!: SyntheticRuntime;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => {
      runtime = new SyntheticRuntime(options);
      runtime.deferStop(true);
      return runtime;
    },
  });
  try {
    const lease = realms.acquire(request(root, () => undefined, "prepare"));
    const saving = lease.saveAndClosePreparation(1_786_000_000_000);
    await runtime.runtimeStopStarted;
    assert.equal(realms.hasActiveLease("synthetic-project", "synthetic-profile", "synthetic-job"), true);
    assert.throws(() => realms.acquire(request(root, () => undefined, "prepare")), /exclusive/i);
    assert.deepEqual(realms.profileState("synthetic-project", "synthetic-profile", "synthetic-job"), {
      saved: false,
      lastSavedAt: null,
    });
    runtime.releaseStop();
    await assert.rejects(() => saving, /did not stop cleanly/i);
    assert.equal(realms.hasActiveLease("synthetic-project", "synthetic-profile", "synthetic-job"), false);
    assert.deepEqual(realms.profileState("synthetic-project", "synthetic-profile", "synthetic-job"), {
      saved: false,
      lastSavedAt: null,
    });
  } finally {
    runtime?.releaseStop();
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a realm grants exactly one run or prepare lease and teardown permits a fresh generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-exclusive-"));
  const runtimes: SyntheticRuntime[] = [];
  fs.mkdirSync(path.join(root, "project"));
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => { const runtime = new SyntheticRuntime(options); runtimes.push(runtime); return runtime; },
  });
  try {
    const first = realms.acquire(request(root, () => undefined));
    assert.throws(() => realms.acquire(request(root, () => undefined, "prepare")), /exclusive/i);
    await first.start();
    const autoAttach = runtimes[0].commands.find((command) => command.method === "Target.setAutoAttach");
    assert.deepEqual(autoAttach?.params, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page", exclude: false }],
    });
    const fetchEnableIndex = runtimes[0].commands.findIndex((command) => command.method === "Fetch.enable");
    const autoAttachIndex = runtimes[0].commands.findIndex((command) => command.method === "Target.setAutoAttach");
    assert.ok(fetchEnableIndex >= 0);
    assert.ok(autoAttachIndex > fetchEnableIndex);
    assert.equal(runtimes[0].gateAttachmentCloses, 0, "navigation interception remains installed for the lease lifetime");
    const firstGeneration = first.binding.generation;
    await first.close();
    assert.equal(runtimes[0].gateAttachmentCloses, 1);
    assert.equal(runtimes[0].stops, 1);
    const second = realms.acquire(request(root, () => undefined, "prepare"));
    assert.notEqual(second.binding.generation, firstGeneration);
    await second.close();
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gate installation closes pre-existing extra pages but still denies later page creation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-targets-"));
  fs.mkdirSync(path.join(root, "project"));
  let runtime!: SyntheticRuntime;
  const diagnostics: string[] = [];
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => {
      runtime = new SyntheticRuntime(options);
      runtime.snapshotPageTargetId = "pre-existing-target";
      runtime.discoveryPageTargetId = "pre-existing-target";
      return runtime;
    },
    onDiagnostic: (event) => diagnostics.push(event.code),
  });
  try {
    const lease = realms.acquire(request(root, () => undefined, "prepare"));
    await lease.start();
    assert.equal(lease.isRevoked, false);
    assert.deepEqual(
      runtime.commands.filter((command) => command.method === "Target.closeTarget").map((command) => command.params),
      [{ targetId: "pre-existing-target" }],
    );
    assert.deepEqual(diagnostics, []);

    runtime.emit("Target.targetCreated", {
      targetInfo: { type: "page", targetId: "later-target", url: "about:blank" },
    });
    assert.equal(lease.isRevoked, true);
    assert.deepEqual(diagnostics, ["unexpected-page-target"]);
    await lease.close();
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a page first observed during discovery is never accepted as a startup target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-discovery-race-"));
  fs.mkdirSync(path.join(root, "project"));
  let runtime!: SyntheticRuntime;
  const diagnostics: string[] = [];
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => {
      runtime = new SyntheticRuntime(options);
      runtime.discoveryPageTargetId = "raced-target";
      return runtime;
    },
    onDiagnostic: (event) => diagnostics.push(event.code),
  });
  try {
    const lease = realms.acquire(request(root, () => undefined, "prepare"));
    await assert.rejects(() => lease.start(), /revoked/i);
    assert.equal(lease.isRevoked, true);
    assert.deepEqual(diagnostics, ["unexpected-page-target"]);
    assert.deepEqual(
      runtime.commands.filter((command) => command.method === "Target.closeTarget").map((command) => command.params),
      [{ targetId: "raced-target" }],
    );
    await lease.close();
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a popup created while an initial blank target is closing denial-latches the realm", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-close-race-"));
  fs.mkdirSync(path.join(root, "project"));
  let runtime!: SyntheticRuntime;
  const diagnostics: string[] = [];
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => {
      runtime = new SyntheticRuntime(options);
      runtime.snapshotPageTargetId = "pre-existing-target";
      runtime.discoveryPageTargetId = "pre-existing-target";
      runtime.deferTargetClose();
      return runtime;
    },
    onDiagnostic: (event) => diagnostics.push(event.code),
  });
  try {
    const lease = realms.acquire(request(root, () => undefined, "prepare"));
    const starting = lease.start();
    await runtime.targetCloseStarted;
    runtime.emit("Target.targetCreated", {
      targetInfo: { type: "page", targetId: "raced-target", url: "about:blank" },
    });
    runtime.releaseTargetClose();
    await assert.rejects(() => starting, /revoked/i);
    assert.equal(lease.isRevoked, true);
    assert.deepEqual(diagnostics, ["unexpected-page-target"]);
    await lease.close();
  } finally {
    runtime?.releaseTargetClose();
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

browserIntegrationTest("real Chromium normalizes a pre-existing blank target and retains one authorized page", { timeout: 45_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-real-targets-"));
  fs.mkdirSync(path.join(root, "project"));
  let runtime!: ManagedChromiumRuntime;
  class ExtraBlankRuntime extends ManagedChromiumRuntime {
    override async start(check?: () => Promise<void>): Promise<void> {
      await super.start(check);
      await this.withPageCdp(async (cdp) => {
        await cdp.send("Target.createTarget", { url: "about:blank" });
      });
    }
  }
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => { runtime = new ExtraBlankRuntime(options); return runtime; },
  });
  try {
    const lease = realms.acquire(request(root, () => undefined, "prepare"));
    await lease.start();
    assert.equal(lease.isRevoked, false);
    const pageCount = await runtime.withPageCdp(async (cdp) => {
      const targets = await cdp.send<any>("Target.getTargets");
      return targets.targetInfos.filter((info: any) => info.type === "page").length;
    });
    assert.equal(pageCount, 1);
    await lease.close();
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a snapshotted blank target changing URL before close acknowledgement is denied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-target-mutation-"));
  fs.mkdirSync(path.join(root, "project"));
  let runtime!: SyntheticRuntime;
  const diagnostics: string[] = [];
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => {
      runtime = new SyntheticRuntime(options);
      runtime.snapshotPageTargetId = "pre-existing-target";
      runtime.discoveryPageTargetId = "pre-existing-target";
      runtime.deferTargetClose();
      return runtime;
    },
    onDiagnostic: (event) => diagnostics.push(event.code),
  });
  try {
    const lease = realms.acquire(request(root, () => undefined, "prepare"));
    const starting = lease.start();
    await runtime.targetCloseStarted;
    runtime.emit("Target.targetInfoChanged", {
      targetInfo: { type: "page", targetId: "pre-existing-target", url: "https://allowed.example.test/" },
    });
    runtime.releaseTargetClose();
    await assert.rejects(() => starting, /revoked/i);
    assert.equal(lease.isRevoked, true);
    assert.deepEqual(diagnostics, ["unexpected-page-target"]);
    await lease.close();
  } finally {
    runtime?.releaseTargetClose();
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("authority drift denial-latches the generation and closes viewers, downloads, and Chromium", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-denial-"));
  fs.mkdirSync(path.join(root, "project"));
  let authorized = true;
  let runtime!: SyntheticRuntime;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => { runtime = new SyntheticRuntime(options); return runtime; },
  });
  try {
    const lease = realms.acquire(request(root, () => { if (!authorized) throw new Error("revision drift"); }, "prepare"));
    await lease.start();
    let viewerCloses = 0;
    await lease.registerViewer({ id: "synthetic-viewer", close() { viewerCloses += 1; } });
    runtime.options.onDownloadWillBegin?.({
      frameId: "frame", guid: "download-guid", url: "https://allowed.example.test/export", suggestedFilename: "export.csv",
    });
    authorized = false;
    await assert.rejects(() => lease.assertAuthorized(), /exact authority changed/i);
    authorized = true;
    await assert.rejects(() => lease.assertAuthorized(), /revoked/i, "restoring old revisions cannot revive a denied generation");
    await lease.close();
    assert.equal(lease.isRevoked, true);
    assert.equal(viewerCloses, 1);
    assert.deepEqual(runtime.cancelled, ["download-guid"]);
    assert.equal(runtime.stops, 1);
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejected download begin plus cancellation failure denial-latches and rejects later progress", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-download-cancel-failure-"));
  fs.mkdirSync(path.join(root, "project"));
  let runtime!: SyntheticRuntime;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => {
      runtime = new SyntheticRuntime(options);
      runtime.rejectDownloadCancellation = true;
      return runtime;
    },
  });
  try {
    const lease = realms.acquire(request(root, () => undefined));
    await lease.start();
    const guid = "rejected-download";
    runtime.options.onDownloadWillBegin?.({
      frameId: "frame-1",
      guid,
      url: "https://foreign.example.test/export",
      suggestedFilename: "foreign.csv",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(runtime.cancelled, [guid]);
    assert.equal(lease.isRevoked, true);
    assert.equal(runtime.running, false);
    assert.equal(runtime.stops, 1, "Chromium cleanup runs after cancellation failure");
    assert.equal(runtime.gateAttachmentCloses, 1);
    await assert.rejects(() => lease.assertAuthorized(), /revoked/i);

    runtime.options.onDownloadProgress?.({
      guid, totalBytes: 9, receivedBytes: 9, state: "completed",
    });
    assert.deepEqual(lease.downloads.listCompleted(), [], "progress after denial cannot publish the rejected download");
    assert.deepEqual(runtime.cancelled, [guid], "late progress cannot schedule another browser cancellation");
    await lease.close();
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the route-free preparation core guards viewer messages and closes transport on drift", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-preparation-"));
  fs.mkdirSync(path.join(root, "project"));
  let authorized = true;
  let viewerContext!: ProtectedAutomationPreparationViewerContext;
  let closes = 0;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"), runtimeFactory: (options) => new SyntheticRuntime(options),
  });
  const preparation = new ProtectedAutomationBrowserPreparationCore(realms);
  try {
    const preparedRequest = request(root, () => { if (!authorized) throw new Error("drift"); }, "prepare");
    const { kind: _kind, runRoot: _runRoot, ...preparationRequest } = preparedRequest;
    const lease = await preparation.acquire(preparationRequest);
    const viewer = await lease.attachViewer({
      async open(context) {
        viewerContext = context;
        return { id: "viewer", close() { closes += 1; } };
      },
    });
    assert.equal(await viewerContext.handleMessage(async () => "guarded-message"), "guarded-message");
    authorized = false;
    await assert.rejects(() => viewerContext.handleMessage(async () => "must-not-release"), /exact authority changed/i);
    await lease.close();
    assert.equal(closes, 1);
    await viewer.close();
    assert.equal(closes, 1, "viewer close handles are one-shot");
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("owner cancellation synchronously denies the lease before asynchronous cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-cancel-"));
  fs.mkdirSync(path.join(root, "project"));
  const controller = new AbortController();
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"), runtimeFactory: (options) => new SyntheticRuntime(options),
  });
  try {
    const lease = realms.acquire({ ...request(root, () => undefined), signal: controller.signal });
    controller.abort();
    assert.equal(lease.isRevoked, true);
    await assert.rejects(() => lease.assertAuthorized(), /revoked/i);
    await lease.close();
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("realm denial diagnostics emit one bounded reason code without binding metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-realm-diagnostic-"));
  fs.mkdirSync(path.join(root, "project"));
  const diagnostics: unknown[] = [];
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => new SyntheticRuntime(options),
    onDiagnostic: (event) => diagnostics.push(event),
  });
  try {
    const lease = realms.acquire(request(root, () => undefined));
    lease.deny("unexpected-page-target");
    lease.deny("must-not-repeat");
    await lease.close();
    assert.deepEqual(diagnostics, [{ component: "browser-realm", code: "unexpected-page-target" }]);
    assert.equal(JSON.stringify(diagnostics).includes("synthetic-project"), false);
    assert.equal(JSON.stringify(diagnostics).includes(root), false);
  } finally {
    await realms.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
