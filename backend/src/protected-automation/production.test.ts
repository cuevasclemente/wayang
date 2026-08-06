import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { CredentialBroker, type BitwardenAdapter } from "../browser/credentials.js";
import type { CdpConnection, ChromeTarget } from "../browser/cdp.js";
import type { ManagedChromiumRuntimeOptions } from "../browser/manager.js";
import { close, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { commitWorkspaceCapabilityActivation } from "../workspace-capabilities.js";
import type { SettingsPinAttemptPort } from "../workspace-capability-approval/types.js";
import type { ProtectedAutomationBinding } from "./authority.js";
import { getProtectedAutomationPreparationPort } from "./browser-preparation.js";
import {
  ProtectedAutomationBrowserRealmRegistry,
  type ProtectedAutomationManagedRuntime,
} from "./browser-realm.js";
import { bootstrapProtectedAutomationProduction, protectedAutomationDiagnosticCode } from "./production.js";
import { captureProtectedAutomationSnapshot, finalizeProtectedAutomationSnapshotCapture } from "./snapshots.js";
import {
  createProtectedAutomationJob,
  createProtectedAutomationRun,
  getProtectedAutomationJob,
  tombstoneProtectedAutomationJob,
  transitionProtectedAutomationJobLifecycle,
} from "./store.js";

let root = "";
let projectRoot = "";

class UnavailableVault implements BitwardenAdapter {
  readonly available = false;
  async listItems() { return []; }
  async getItem(): Promise<never> { throw new Error("unavailable"); }
  async getTotp(): Promise<never> { throw new Error("unavailable"); }
  async lock() {}
}

class SyntheticViewerCdp {
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  readonly methods: string[] = [];
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  failMethod: string | null = null;
  frameDuringStart = false;
  url = "about:blank";

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.methods.push(method);
    this.commands.push({ method, params: { ...params } });
    if (method === this.failMethod) throw new Error("synthetic private failure detail must not escape");
    if (method === "Page.startScreencast" && this.frameDuringStart) {
      this.emit("Page.screencastFrame", {
        data: Buffer.from("synchronous-start-frame").toString("base64"),
        metadata: { timestamp: 1 },
        sessionId: 51,
      });
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "synthetic-main-frame", loaderId: "synthetic-loader", url: this.url } } };
    }
    if (method === "Runtime.evaluate") {
      return { result: { value: { url: this.url, title: "Synthetic", readyState: "complete" } } };
    }
    if (method === "Target.getTargets") {
      return { targetInfos: [{ type: "page", targetId: "synthetic-target", url: "about:blank" }] };
    }
    if ([
      "Page.enable", "Network.enable", "Fetch.enable",
      "Target.setDiscoverTargets", "Target.setAutoAttach", "Target.closeTarget",
      "Fetch.continueRequest", "Fetch.failRequest",
      "Runtime.enable", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck",
      "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
    ].includes(method)) return {};
    throw new Error(`unexpected synthetic viewer CDP method ${method}`);
  }
  on(event: string, listener: (params: any) => void): () => void {
    let group = this.listeners.get(event);
    if (!group) { group = new Set(); this.listeners.set(event, group); }
    group.add(listener);
    return () => group!.delete(listener);
  }
  emit(event: string, params: any): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(params);
  }
}

class SyntheticViewerRuntime implements ProtectedAutomationManagedRuntime {
  running = false;
  readonly cdp = new SyntheticViewerCdp();
  attachmentCloses = 0;
  stops = 0;
  constructor(readonly options: ManagedChromiumRuntimeOptions) {}
  async start(check?: () => Promise<void>): Promise<void> { await check?.(); this.running = true; }
  async stop(): Promise<void> { this.running = false; this.stops += 1; }
  async cancelDownload(): Promise<void> {}
  async withPageCdp<T>(operation: (cdp: CdpConnection, target: ChromeTarget) => Promise<T>): Promise<T> {
    return operation(this.cdp as unknown as CdpConnection, {
      id: "synthetic-target", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://synthetic.invalid",
    });
  }
  async attachPageCdpViewer(): Promise<{ cdp: CdpConnection; target: ChromeTarget; close(): void }> {
    return {
      cdp: this.cdp as unknown as CdpConnection,
      target: { id: "synthetic-target", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://synthetic.invalid" },
      close: () => { this.attachmentCloses += 1; },
    };
  }
}

class SyntheticPinAttempts implements SettingsPinAttemptPort {
  reservation: Parameters<SettingsPinAttemptPort["reserve"]>[0] | null = null;
  async reserve(input: Parameters<SettingsPinAttemptPort["reserve"]>[0]) {
    if (this.reservation) return { status: "busy" as const };
    this.reservation = { ...input };
    return { status: "reserved" as const };
  }
  async verifyAndConsume(input: Parameters<SettingsPinAttemptPort["verifyAndConsume"]>[0]) {
    const current = this.reservation;
    this.reservation = null;
    if (!current || current.requestId !== input.requestId || current.reservationId !== input.reservationId) return { status: "unavailable" as const };
    return input.pin === "12345678" ? { status: "verified" as const } : { status: "wrong_pin" as const };
  }
  async cancelAndConsume() { this.reservation = null; }
}

beforeEach(() => {
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-production-"));
  projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(projectRoot, "source"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "source", "main.mjs"), "export default 'synthetic';\n");
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  init();
});

afterEach(() => {
  close();
  delete process.env.WAYANG_DATA_DIR;
  const unlock = (target: string): void => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    try { fs.chmodSync(target, 0o700); } catch { return; }
    for (const name of fs.readdirSync(target)) unlock(path.join(target, name));
  };
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
});

function jobFixture(tombstone = true) {
  const profile = createAgentProfile({ name: "Synthetic production owner" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
  });
  const association = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "a".repeat(64),
  });
  const jobId = "synthetic-purge-job";
  const snapshot = captureProtectedAutomationSnapshot({
    projectRoot, projectId: project.id, agentProfileId: profile.id, jobId, revision: 1,
    sourceDirectory: "source", entrypoint: "main.mjs",
  });
  const job = createProtectedAutomationJob({
    id: jobId,
    project_id: project.id,
    agent_profile_id: profile.id,
    capability_revision: association.revision,
    name: "Synthetic purge job",
    source_manifest_sha256: snapshot.manifestSha256,
    entrypoint: "main.mjs",
    argv: [],
    uses_browser_profile: true,
    allowed_https_origins: ["https://example.test"],
    cron_expr: "0 8 * * *",
    timezone: "local",
    timeout_ms: 60_000,
    overlap_policy: "skip",
    missed_run_policy: "skip",
  });
  finalizeProtectedAutomationSnapshotCapture(snapshot);
  return { project, profile, job: tombstone ? tombstoneProtectedAutomationJob(job.id, job.revision) : job };
}

function tombstonedFixture() { return jobFixture(true); }

function bindingFor(fixture: ReturnType<typeof jobFixture>): ProtectedAutomationBinding {
  return {
    capabilityId: "wayang.protected-automation.v1",
    sourceSessionId: "synthetic-preparation-source",
    projectId: fixture.project.id,
    projectCwd: fixture.project.cwd,
    agentProfileId: fixture.profile.id,
    associationRevision: fixture.job.capability_revision,
    runtimeGeneration: "synthetic-preparation-runtime",
    processBootNonce: "synthetic-preparation-boot",
  };
}

async function prepareFixture(fixture: ReturnType<typeof jobFixture>) {
  const preparation = getProtectedAutomationPreparationPort();
  if (!preparation) throw new Error("production preparation port was not installed");
  return preparation.prepare({ binding: bindingFor(fixture), job: fixture.job, assertAuthorized() {} });
}

function broker() {
  return new CredentialBroker({
    bwPath: "", unlockSocketPath: path.join(root, "unlock.sock"), idleTimeoutMs: 60_000,
    choiceTtlMs: 30_000, maxCliOutputBytes: 1024, cliTimeoutMs: 1000,
  }, new UnavailableVault());
}

test("PIN purge is one-use owner/Origin/revision bound and never removes project outputs", async () => {
  const fixture = tombstonedFixture();
  const output = path.join(projectRoot, "retained-output.txt");
  fs.writeFileSync(output, "project output must survive\n");
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  const production = bootstrapProtectedAutomationProduction({
    dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts,
  });
  production.start();
  (production.services.manager as any).hasActiveJob = () => false;
  const owner = { sessionId: "owner-a", origin: "http://127.0.0.1:8787" };
  try {
    const challenge = await production.integration.requestPurge(owner, fixture.job.id, fixture.job.revision);
    assert.match(challenge.operation_digest, /^[a-f0-9]{64}$/u);
    await assert.rejects(
      production.integration.commitPurge({ ...owner, origin: "http://localhost:8787" }, fixture.job.id, challenge.request_id, "12345678"),
      /owner or Origin/i,
    );
    const result = await production.integration.commitPurge(owner, fixture.job.id, challenge.request_id, "12345678");
    assert.equal(result.purged_job_id, fixture.job.id);
    assert.deepEqual(result.purged_run_ids, []);
    assert.equal(getProtectedAutomationJob(fixture.job.id), undefined);
    assert.equal(getStore().protectedAutomationRuns.some((run) => run.job_id === fixture.job.id), false);
    assert.equal(fs.readFileSync(output, "utf8"), "project output must survive\n");
    assert.equal(fs.existsSync(path.join(process.env.WAYANG_DATA_DIR!, "protected-automation", "jobs")), false);
    await assert.rejects(
      production.integration.commitPurge(owner, fixture.job.id, challenge.request_id, "12345678"),
      /not found/i,
    );
  } finally {
    await production.close();
    await credentialBroker.shutdown();
  }
});

test("authenticated owner pause and cancel use canonical exact job/run ownership", async () => {
  const fixture = jobFixture(false);
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  const production = bootstrapProtectedAutomationProduction({ dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts });
  production.start();
  const owner = { sessionId: "owner-control", origin: "http://127.0.0.1:8787" };
  try {
    const prepared = await prepareFixture(fixture);
    const selection = {
      sourceSessionId: prepared.source_session_id,
      jobId: prepared.job_id,
      preparationId: prepared.preparation_id,
    };
    assert.equal(production.integration.getPreparation(owner, selection).job_revision, fixture.job.revision);

    const queued = createProtectedAutomationRun({
      id: "synthetic-owner-cancel-run", job_id: fixture.job.id, project_id: fixture.project.id,
      agent_profile_id: fixture.profile.id, job_revision: fixture.job.revision,
      capability_revision: fixture.job.capability_revision, trigger: "manual", scheduled_for: null,
      occurrence_key: null, started_at: Date.now(), finished_at: null, status: "queued",
      outcome_code: null, exit_code: null,
    });
    const cancelled = production.integration.cancelRun(owner, fixture.job.id, queued.id);
    assert.equal(cancelled.job_id, fixture.job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.outcome_code, "cancelled_before_start");
    assert.throws(
      () => production.integration.cancelRun(owner, "foreign-job", queued.id),
      /job not found/i,
    );

    const paused = production.integration.pauseJob(owner, fixture.job.id, fixture.job.revision);
    assert.equal(paused.id, fixture.job.id);
    assert.equal(paused.enabled, false);
    assert.equal(paused.revision, fixture.job.revision + 1);
    assert.equal(getProtectedAutomationJob(fixture.job.id)?.revision, paused.revision);
    assert.throws(
      () => production.integration.getPreparation(owner, selection),
      /not found/i,
      "owner pause synchronously denial-latches and unpublishes the exact preparation",
    );
    assert.throws(
      () => production.integration.pauseJob(owner, fixture.job.id, fixture.job.revision),
      /revision conflict/i,
    );
  } finally {
    await production.close();
    await credentialBroker.shutdown();
  }
});

test("a frame emitted synchronously during screencast start is subscribed and acknowledged", async () => {
  const fixture = jobFixture(false);
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  let runtime!: SyntheticViewerRuntime;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: process.env.WAYANG_DATA_DIR!,
    runtimeFactory: (options) => { runtime = new SyntheticViewerRuntime(options); return runtime; },
  });
  const production = bootstrapProtectedAutomationProduction({
    dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts, realms,
  });
  production.start();
  const owner = { sessionId: "synchronous-frame-owner", origin: "http://127.0.0.1:8787" };
  let transport: Awaited<ReturnType<typeof production.integration.openPreparationViewer>> | undefined;
  try {
    const prepared = await prepareFixture(fixture);
    const selection = {
      sourceSessionId: prepared.source_session_id,
      jobId: prepared.job_id,
      preparationId: prepared.preparation_id,
    };
    transport = await production.integration.openPreparationViewer(owner, selection);
    const released: Array<{ type?: string; sessionId?: number }> = [];
    transport.onMessage((message) => released.push(JSON.parse(message.toString("utf8"))));
    runtime.cdp.frameDuringStart = true;
    await transport.start();
    assert.deepEqual(released.map((message) => ({ type: message.type, sessionId: message.sessionId })), [
      { type: "frame", sessionId: 51 },
    ]);
    await transport.dispatch(Buffer.from(JSON.stringify({ type: "frame-ack", sessionId: 51 }), "utf8"), false);
    assert.deepEqual(runtime.cdp.commands.filter((command) => command.method === "Page.screencastFrameAck").at(-1), {
      method: "Page.screencastFrameAck", params: { sessionId: 51 },
    });
  } finally {
    await transport?.close().catch(() => undefined);
    await production.close();
    await credentialBroker.shutdown();
  }
});

test("a late screencast frame is reauthorized and suppressed after job revision drift", async () => {
  const fixture = jobFixture(false);
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  let runtime!: SyntheticViewerRuntime;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: process.env.WAYANG_DATA_DIR!,
    runtimeFactory: (options) => { runtime = new SyntheticViewerRuntime(options); return runtime; },
  });
  const production = bootstrapProtectedAutomationProduction({
    dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts, realms,
  });
  production.start();
  const owner = { sessionId: "viewer-owner", origin: "http://127.0.0.1:8787" };
  let transport: Awaited<ReturnType<typeof production.integration.openPreparationViewer>> | undefined;
  try {
    const prepared = await prepareFixture(fixture);
    const selection = {
      sourceSessionId: prepared.source_session_id,
      jobId: prepared.job_id,
      preparationId: prepared.preparation_id,
    };
    transport = await production.integration.openPreparationViewer(owner, selection);
    await transport.start();
    const released: Array<{ type?: string; sessionId?: number }> = [];
    transport.onMessage((message) => released.push(JSON.parse(message.toString("utf8"))));

    transitionProtectedAutomationJobLifecycle(fixture.job.id, fixture.job.revision, false);
    runtime.cdp.emit("Page.screencastFrame", {
      data: Buffer.from("late-frame").toString("base64"), metadata: { timestamp: 1 }, sessionId: 77,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(released, [], "the stale browser-originated frame never reaches the owner transport");
    assert.equal(runtime.attachmentCloses, 2,
      "revision drift closes both the navigation-gate and screencast attachments");
    assert.equal(runtime.running, false, "revision drift denial also stops the preparation Chromium lease");
  } finally {
    await transport?.close().catch(() => undefined);
    await production.close();
    await credentialBroker.shutdown();
  }
});

test("viewer initialization failures expose only a bounded diagnostic stage code", async () => {
  const fixture = jobFixture(false);
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  let runtime!: SyntheticViewerRuntime;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: process.env.WAYANG_DATA_DIR!,
    runtimeFactory: (options) => { runtime = new SyntheticViewerRuntime(options); return runtime; },
  });
  const production = bootstrapProtectedAutomationProduction({
    dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts, realms,
  });
  production.start();
  try {
    const prepared = await prepareFixture(fixture);
    const selection = {
      sourceSessionId: prepared.source_session_id,
      jobId: prepared.job_id,
      preparationId: prepared.preparation_id,
    };
    runtime.cdp.failMethod = "Page.startScreencast";
    const failedTransport = await production.integration.openPreparationViewer(
      { sessionId: "diagnostic-owner", origin: "http://127.0.0.1:8787" },
      selection,
    );
    const failure = await failedTransport.start().then(() => undefined, (error) => error);
    await failedTransport.close();
    assert.equal(protectedAutomationDiagnosticCode(failure), "viewer-screencast-start");
    assert.equal(String(failure).includes("synthetic private failure detail"), false);
    await assert.rejects(
      production.integration.navigatePreparation(
        { sessionId: "diagnostic-owner", origin: "http://127.0.0.1:8787" },
        selection,
        "https://example.test/",
      ),
      /viewer must be attached/i,
    );
  } finally {
    await production.close();
    await credentialBroker.shutdown();
  }
});

test("closing the last viewer removes preparation navigation and credential context", async () => {
  const fixture = jobFixture(false);
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  let runtime!: SyntheticViewerRuntime;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: process.env.WAYANG_DATA_DIR!,
    runtimeFactory: (options) => { runtime = new SyntheticViewerRuntime(options); return runtime; },
  });
  const production = bootstrapProtectedAutomationProduction({
    dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts, realms,
  });
  production.start();
  const owner = { sessionId: "viewer-context-owner", origin: "http://127.0.0.1:8787" };
  try {
    const prepared = await prepareFixture(fixture);
    const selection = {
      sourceSessionId: prepared.source_session_id,
      jobId: prepared.job_id,
      preparationId: prepared.preparation_id,
    };
    const transport = await production.integration.openPreparationViewer(owner, selection);
    await transport.start();
    await transport.dispatch(Buffer.from(JSON.stringify({ type: "paste", text: "synthetic-human-paste" }), "utf8"), false);
    assert.deepEqual(
      runtime.cdp.commands.filter((command) => command.method === "Input.insertText").at(-1),
      { method: "Input.insertText", params: { text: "synthetic-human-paste" } },
    );
    await assert.rejects(
      transport.dispatch(Buffer.from(JSON.stringify({ type: "paste", text: "synthetic", extra: true }), "utf8"), false),
      /paste message is invalid/i,
    );
    await assert.rejects(
      transport.dispatch(Buffer.from(JSON.stringify({ type: "paste", text: "x".repeat(4_097) }), "utf8"), false),
      /paste text is invalid/i,
    );
    await transport.close();
    await transport.close();
    await assert.rejects(
      production.integration.navigatePreparation(owner, selection, "https://example.test/"),
      /viewer must be attached/i,
    );
    await assert.rejects(
      production.integration.credentialMatches(owner, selection),
      /viewer must be attached/i,
    );
    assert.deepEqual(production.integration.getJob(fixture.job.id).browser_profile, {
      supported: true,
      saved: false,
      last_saved_at: null,
    });
    await production.integration.closePreparation(owner, selection);
    const savedProfile = production.integration.getJob(fixture.job.id).browser_profile;
    assert.equal(savedProfile.supported, true);
    assert.equal(savedProfile.saved, true);
    assert.equal(typeof savedProfile.last_saved_at, "number");
  } finally {
    await production.close();
    await credentialBroker.shutdown();
  }
});

test("credential matches are suppressed and revoked when the last viewer closes in flight", async () => {
  const fixture = jobFixture(false);
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  let runtime!: SyntheticViewerRuntime;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: process.env.WAYANG_DATA_DIR!,
    runtimeFactory: (options) => { runtime = new SyntheticViewerRuntime(options); return runtime; },
  });
  const production = bootstrapProtectedAutomationProduction({
    dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts, realms,
  });
  production.start();
  const owner = { sessionId: "credential-race-owner", origin: "http://127.0.0.1:8787" };
  let releaseMatches!: () => void;
  let matchesStartedResolve!: () => void;
  const matchesRelease = new Promise<void>((resolve) => { releaseMatches = resolve; });
  const matchesStarted = new Promise<void>((resolve) => { matchesStartedResolve = resolve; });
  let revoked = 0;
  const originalRevoke = credentialBroker.revokeChoicesForAutomationPreparation.bind(credentialBroker);
  (credentialBroker as any).matches = async () => {
    matchesStartedResolve();
    await matchesRelease;
    return [{ choiceToken: "synthetic-choice-that-must-not-release" }];
  };
  (credentialBroker as any).revokeChoicesForAutomationPreparation = (binding: any) => {
    revoked += 1;
    return originalRevoke(binding);
  };
  let transport: Awaited<ReturnType<typeof production.integration.openPreparationViewer>> | undefined;
  try {
    const prepared = await prepareFixture(fixture);
    const selection = {
      sourceSessionId: prepared.source_session_id,
      jobId: prepared.job_id,
      preparationId: prepared.preparation_id,
    };
    transport = await production.integration.openPreparationViewer(owner, selection);
    await transport.start();
    runtime.cdp.url = "https://example.test/";
    const pending = production.integration.credentialMatches(owner, selection);
    await matchesStarted;
    await transport.close();
    transport = undefined;
    releaseMatches();
    await assert.rejects(() => pending, /viewer authority changed/i);
    assert.equal(revoked, 1);
  } finally {
    releaseMatches();
    await transport?.close().catch(() => undefined);
    await production.close();
    await credentialBroker.shutdown();
  }
});

test("purge refuses a manager-live controller even after durable rows are terminal", async () => {
  const fixture = tombstonedFixture();
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  const production = bootstrapProtectedAutomationProduction({ dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts });
  production.start();
  (production.services.manager as any).hasActiveJob = (jobId: string) => jobId === fixture.job.id;
  try {
    await assert.rejects(
      production.integration.requestPurge(
        { sessionId: "owner", origin: "http://127.0.0.1:8787" }, fixture.job.id, fixture.job.revision,
      ),
      /process|controller/i,
    );
    assert.equal(pinAttempts.reservation, null);
    assert.ok(getProtectedAutomationJob(fixture.job.id));
  } finally {
    await production.close();
    await credentialBroker.shutdown();
  }
});

test("purge refuses stale tombstone revisions before reserving a PIN attempt", async () => {
  const fixture = tombstonedFixture();
  const credentialBroker = broker();
  const pinAttempts = new SyntheticPinAttempts();
  const production = bootstrapProtectedAutomationProduction({ dataDir: process.env.WAYANG_DATA_DIR!, credentialBroker, pinAttempts });
  production.start();
  (production.services.manager as any).hasActiveJob = () => false;
  try {
    await assert.rejects(
      production.integration.requestPurge({ sessionId: "owner", origin: "http://127.0.0.1:8787" }, fixture.job.id, fixture.job.revision - 1),
      /revision conflict/i,
    );
    assert.equal(pinAttempts.reservation, null);
  } finally {
    await production.close();
    await credentialBroker.shutdown();
  }
});
