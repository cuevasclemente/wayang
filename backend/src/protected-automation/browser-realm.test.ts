import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { CdpConnection, ChromeTarget } from "../browser/cdp.js";
import type { ManagedChromiumRuntimeOptions } from "../browser/manager.js";
import {
  ProtectedAutomationBrowserRealmRegistry,
  ensureProtectedAutomationBrowserRealmStorage,
  type ProtectedAutomationManagedRuntime,
} from "./browser-realm.js";
import {
  ProtectedAutomationBrowserPreparationCore,
  type ProtectedAutomationPreparationViewerContext,
} from "./browser-preparation.js";

class SyntheticRuntime implements ProtectedAutomationManagedRuntime {
  running = false;
  stops = 0;
  gateAttachmentCloses = 0;
  rejectDownloadCancellation = false;
  cancelled: string[] = [];
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      this.commands.push({ method, params: { ...params } });
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
  async start(check?: () => Promise<void>): Promise<void> { await check?.(); this.running = true; }
  async stop(): Promise<void> { this.running = false; this.stops += 1; }
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
