import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  bootstrapProtectedBrowserProduction,
  ProtectedCredentialProtection,
  type ProtectedManagedChromiumPort,
} from "./protected-production.js";
import type { BrowserCredentialsConfig } from "../config.js";
import { CredentialBroker, type BitwardenAdapter } from "./credentials.js";
import type { ManagedChromiumRuntimeOptions } from "./manager.js";
import type { ProtectedBrowserToolRuntime } from "./protected-tools.js";
import type { ProtectedBrowserAuthoritySnapshot, ProtectedBrowserBinding } from "./types.js";

function exactBinding(projectCwd: string): ProtectedBrowserBinding {
  return {
    capabilityId: "wayang.protected-browser.v1",
    sourceSessionId: "synthetic-source-session",
    projectId: "synthetic-project-id",
    projectCwd,
    agentProfileId: "synthetic-profile-id",
    associationRevision: 1,
    runtimeGeneration: "synthetic-runtime-generation",
    processBootNonce: "synthetic-process-boot",
    controlGeneration: 5,
  };
}

function allowed(binding: Readonly<ProtectedBrowserBinding>): ProtectedBrowserAuthoritySnapshot {
  return {
    ...binding,
    authorized: true,
    privacyMode: "protected",
    sourceSessionDurable: true,
    sourceQuarantined: false,
    profileEnabled: true,
    projectAllowsProfile: true,
  };
}

class FakeCdp {
  readonly calls: string[] = [];
  readonly listeners = new Map<string, Set<(value: any) => void>>();
  url = "https://synthetic.invalid/start";
  loader = "loader-1";
  bodyText = "synthetic body";

  async send<T = any>(method: string, parameters: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(method);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1", loaderId: this.loader } } } as T;
    if (method === "Runtime.evaluate") {
      const expression = String(parameters.expression ?? "");
      if (expression.includes("__wayangOwnerPasteTarget")) return { result: { value: true } } as T;
      if (expression === "document") return { result: { objectId: "synthetic-document-object" } } as T;
      if (expression.includes("__wayangSecrets();")) return { result: { value: [] } } as T;
      if (expression.includes("document.body")) return { result: { value: { url: this.url, title: "Synthetic", text: this.bodyText } } } as T;
      return { result: { value: { url: this.url, title: "Synthetic", readyState: "complete" } } } as T;
    }
    if (method === "Runtime.callFunctionOn") {
      const values = (parameters.arguments as Array<{ value?: Record<string, string> }> | undefined)?.[0]?.value ?? {};
      return { result: { value: { filled: [values.username && "username", values.password && "password", values.totp && "totp"].filter(Boolean) } } } as T;
    }
    if (method === "Page.navigate") {
      this.url = String(parameters.url);
      this.loader = `loader-${this.calls.length}`;
      return { loaderId: this.loader } as T;
    }
    if (method === "Page.captureScreenshot") return { data: "c3ludGhldGlj" } as T;
    if (method === "Accessibility.getFullAXTree") return { nodes: [] } as T;
    return {} as T;
  }

  on(method: string, listener: (value: any) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close(): void {}
}

class FakeManagedChromium implements ProtectedManagedChromiumPort {
  running = false;
  starts = 0;
  stops = 0;
  attachments = 0;
  attachmentCloses = 0;
  canceled: string[] = [];
  readonly cdp = new FakeCdp();

  constructor(readonly options: ManagedChromiumRuntimeOptions) {}

  async start(guard?: () => Promise<void>): Promise<void> {
    if (this.running) return;
    await guard?.();
    this.starts += 1;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }

  async cancelDownload(guid: string, guard?: () => Promise<void>): Promise<void> {
    await guard?.();
    this.canceled.push(guid);
  }

  emitTopLevelNavigation(url: string): void {
    if (!this.running) return;
    this.cdp.url = url;
    this.options.onTopLevelNavigation?.(url);
  }

  async attachPageCdpViewer() {
    if (!this.running) throw new Error("synthetic browser is stopped");
    this.attachments += 1;
    let closed = false;
    return {
      cdp: this.cdp,
      target: { id: "target-1", type: "page", url: this.cdp.url, webSocketDebuggerUrl: "ws://synthetic.invalid" },
      close: () => {
        if (closed) return;
        closed = true;
        this.attachmentCloses += 1;
      },
    };
  }
}

test("protected credential protection unions fills, redacts reversible forms, blocks screenshots/mutations, and clears only on a fresh document", () => {
  const protection = new ProtectedCredentialProtection();
  const first = "SYNTHETIC_PASSWORD_CANARY_7f3a";
  const second = "synthetic+totp/42";
  protection.recordFill("target:frame:loader-a", { password: first });
  protection.recordFill("target:frame:loader-a", { totp: second });
  assert.equal(protection.mode, "blocked");
  assert.throws(() => protection.assertOperation({ kind: "snapshot", mode: "text" }, "target:frame:loader-a"), /explicit UI authorization/i);

  protection.allowInspection("target:frame:loader-a");
  assert.throws(() => protection.allowInspection("target:frame:loader-a"), /already used|unavailable/i);
  assert.throws(() => protection.assertOperation({ kind: "snapshot", mode: "screenshot" }, "target:frame:loader-a"), /screenshots remain blocked/i);
  assert.throws(() => protection.assertOperation({ kind: "click", x: 1, y: 2 }, "target:frame:loader-a"), /mutations remain blocked/i);
  protection.assertOperation({ kind: "dom_snapshot", includeText: true }, "target:frame:loader-a");

  const result = protection.redact({
    raw: `${first}:${second}`,
    component: encodeURIComponent(second).replace(/%2f/i, "%2f"),
    form: new URLSearchParams({ value: second }).toString().slice("value=".length),
    base64: Buffer.from(first).toString("base64"),
    base64url: Buffer.from(second).toString("base64url"),
  });
  assert.equal(JSON.stringify(result).includes(first), false);
  assert.equal(JSON.stringify(result).includes(second), false);
  for (const value of Object.values(result)) assert.match(value, /\[REDACTED\]/);

  protection.assertOperation({ kind: "click", x: 1, y: 2 }, "target:frame:loader-b");
  assert.equal(protection.mode, "none", "only a changed target/frame/loader document clears protection");
  protection.recordFill("target:frame:loader-b", { password: first });
  protection.reset();
  assert.equal(protection.mode, "none", "explicit stop/reset/full-realm cleanup clears in-memory known values");
});

test("production guarded broker fills backend-to-CDP only and enforces blocked/read-only/fresh-document states", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-credential-production-"));
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { mode: 0o700 });
  const binding = exactBinding(fs.realpathSync.native(projectRoot));
  const username = "synthetic-user@example.invalid";
  const password = "SYNTHETIC_PROTECTED_PASSWORD_92af";
  const itemId = "123e4567-e89b-42d3-a456-426614174000";
  const adapter: BitwardenAdapter = {
    available: true,
    async listItems() { return [{ id: itemId, name: "Synthetic protected login", login: { username, password, uris: [{ uri: "https://synthetic.invalid/login" }] } }]; },
    async getItem() { return { id: itemId, name: "Synthetic protected login", login: { username, password, uris: [{ uri: "https://synthetic.invalid/login" }] } }; },
    async getTotp() { return "123456"; },
    async lock() {},
  };
  const brokerConfig: BrowserCredentialsConfig = {
    bwPath: "",
    unlockSocketPath: path.join(root, "unlock.sock"),
    idleTimeoutMs: 60_000,
    choiceTtlMs: 5_000,
    maxCliOutputBytes: 1024,
    cliTimeoutMs: 1_000,
  };
  const broker = new CredentialBroker(brokerConfig, adapter);
  broker.acceptUnlockKey("synthetic-session-key");
  let live: ProtectedBrowserToolRuntime | undefined;
  let managed: FakeManagedChromium | undefined;
  const production = bootstrapProtectedBrowserProduction({
    dataDir: path.join(root, "data"),
    owner: { resolve() { return "synthetic-owner"; } },
    credentialBroker: broker,
    authorityResolver(current) { return allowed(current); },
    pairAuthorityResolver() { return true; },
    managedChromiumFactory(options) { managed = new FakeManagedChromium(options); return managed; },
    installFactory() { return () => undefined; },
    liveRuntimeResolver(sourceSessionId, expected) {
      if (!live || sourceSessionId !== live.browser.currentBinding.sourceSessionId || live.browser.isRevoked) return undefined;
      if (expected && JSON.stringify(expected) !== JSON.stringify(live.browser.currentBinding)) return undefined;
      return live;
    },
    subscribePolicy() { return () => undefined; },
    settleTimeoutMs: 100,
    settleIntervalMs: 0,
  });
  try {
    live = await production.factory(binding);
    let selection = await production.integration.select({ targetSessionId: binding.sourceSessionId, transport: "http" });
    assert.ok(selection);
    let resolved = await production.integration.resolve(selection!);
    assert.ok(resolved?.credentialControls);
    assert.deepEqual(resolved!.ownerControls!.state().credentialBroker, { supported: true, guarded: true });
    await resolved!.ownerControls!.start();
    await live.browser.beginCredentialHandoff();
    selection = await production.integration.select({ targetSessionId: binding.sourceSessionId, transport: "http" });
    assert.ok(selection);
    resolved = await production.integration.resolve(selection!);
    assert.ok(resolved?.credentialControls);
    const matches = await resolved!.credentialControls!.matches();
    assert.equal(matches.choices.length, 1);
    assert.equal(JSON.stringify(matches).includes(password), false);
    const choice = matches.choices[0];
    const filled = await resolved!.credentialControls!.fill(choice.choiceToken, "login");
    assert.deepEqual(filled, { filled: ["username", "password"] });
    assert.equal(JSON.stringify(filled).includes(password), false);
    assert.equal(resolved!.ownerControls!.state().credentialInspection, "blocked");
    await assert.rejects(() => resolved!.credentialControls!.fill(choice.choiceToken, "login"), /already used|expired/i);

    const oldLeaseChoice = (await resolved!.credentialControls!.matches()).choices[0];
    const firstManaged = managed;
    const oldBrowser = live.browser;
    const modelSwitchBinding: ProtectedBrowserBinding = {
      ...binding,
      sourceSessionId: "synthetic-source-session-model-b",
      runtimeGeneration: "synthetic-runtime-generation-model-b",
      controlGeneration: 1,
    };
    const oldResolved = resolved!;
    live = await production.factory(modelSwitchBinding);
    assert.equal(oldBrowser.isRevoked, true, "model-A lease is denial-latched before model B publishes");
    await assert.rejects(() => oldResolved.credentialControls!.status(), /revoked/i);
    selection = await production.integration.select({ targetSessionId: modelSwitchBinding.sourceSessionId, transport: "http" });
    assert.ok(selection);
    resolved = await production.integration.resolve(selection!);
    assert.ok(resolved?.credentialControls);
    assert.equal(managed, firstManaged, "model switch reuses one pair-keyed Chromium realm");
    assert.equal(managed!.running, true, "model switch does not stop the persistent Chromium process");
    assert.equal(live.browser.mode, "user", "human-control state survives the runtime lease transfer");
    assert.equal(resolved!.ownerControls!.state().credentialInspection, "blocked", "credential taint survives model switch");
    await assert.rejects(
      () => resolved!.credentialControls!.fill(oldLeaseChoice.choiceToken, "login"),
      /already used|expired|no longer valid/i,
      "model-A credential choices cannot cross the lease boundary",
    );

    await resolved!.credentialControls!.allowAgentInspection();
    selection = await production.integration.select({ targetSessionId: modelSwitchBinding.sourceSessionId, transport: "http" });
    assert.ok(selection);
    resolved = await production.integration.resolve(selection!);
    assert.ok(resolved?.credentialControls);
    managed!.cdp.bodyText = `${password} ${Buffer.from(password).toString("base64url")}`;
    const text = await live.browser.execute<any>({ kind: "snapshot", mode: "text" });
    assert.equal(JSON.stringify(text).includes(password), false);
    assert.match(text.text, /\[REDACTED\]/);
    await assert.rejects(() => live!.browser.execute({ kind: "snapshot", mode: "screenshot" }), /screenshots remain blocked/i);
    await assert.rejects(() => live!.browser.execute({ kind: "click", x: 1, y: 1 }), /mutations remain blocked/i);

    managed!.cdp.loader = "loader-fresh-document";
    assert.deepEqual(await live.browser.execute({ kind: "click", x: 1, y: 1 }), { clicked: true });
    assert.equal(resolved!.ownerControls!.state().credentialInspection, undefined);

    await live.browser.beginCredentialHandoff();
    selection = await production.integration.select({ targetSessionId: modelSwitchBinding.sourceSessionId, transport: "http" });
    assert.ok(selection);
    resolved = await production.integration.resolve(selection!);
    assert.ok(resolved?.credentialControls);
    const stale = (await resolved!.credentialControls!.matches()).choices[0];
    const choiceLoader = "loader-fresh-document";
    managed!.cdp.loader = "loader-stale-choice";
    await assert.rejects(() => resolved!.credentialControls!.fill(stale.choiceToken, "login"), /no longer valid/i);
    managed!.cdp.loader = choiceLoader;
    await assert.rejects(() => resolved!.credentialControls!.fill(stale.choiceToken, "login"), /already used|expired/i);

    const stoppedChoice = (await resolved!.credentialControls!.matches()).choices[0];
    await resolved!.ownerControls!.stop();
    await resolved!.ownerControls!.start();
    await assert.rejects(() => resolved!.credentialControls!.fill(stoppedChoice.choiceToken, "login"), /already used|expired/i);
    await live.browser.revoke();
  } finally {
    await production.close();
    await broker.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production uses one pair realm with exclusive route/tool/viewer leases, ordinary downloads, and denial-first takeover", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-production-"));
  const projectRoot = path.join(root, "project");
  const dataDir = path.join(root, "private-data");
  fs.mkdirSync(projectRoot, { mode: 0o700 });
  const binding = exactBinding(fs.realpathSync.native(projectRoot));
  let authorityAvailable = true;
  let authorityChecks = 0;
  let policyListener: (() => void) | undefined;
  let installedFactory: ((binding: ProtectedBrowserBinding) => ProtectedBrowserToolRuntime | Promise<ProtectedBrowserToolRuntime>) | undefined;
  let uninstalled = 0;
  let managedCreations = 0;
  let managed: FakeManagedChromium | undefined;
  let live: ProtectedBrowserToolRuntime | undefined;

  const production = bootstrapProtectedBrowserProduction({
    dataDir,
    owner: { resolve() { return "synthetic-owner-session"; } },
    authorityResolver(current) { authorityChecks += 1; return authorityAvailable ? allowed(current) : null; },
    pairAuthorityResolver() { return authorityAvailable; },
    managedChromiumFactory(options) {
      managedCreations += 1;
      managed = new FakeManagedChromium(options);
      return managed;
    },
    installFactory(factory) {
      installedFactory = factory;
      return () => { uninstalled += 1; installedFactory = undefined; };
    },
    liveRuntimeResolver(sourceSessionId, expected) {
      if (!live || live.browser.isRevoked || sourceSessionId !== live.browser.currentBinding.sourceSessionId) return undefined;
      if (expected && JSON.stringify(live.browser.currentBinding) !== JSON.stringify(expected)) return undefined;
      return live;
    },
    subscribePolicy(listener) {
      policyListener = () => listener(2);
      return () => { policyListener = undefined; };
    },
    settleTimeoutMs: 100,
    settleIntervalMs: 0,
  });

  try {
    assert.equal(managedCreations, 0, "bootstrap must not construct a Chromium runtime");
    assert.equal(fs.existsSync(dataDir), false, "bootstrap must not inspect or create profile storage");
    assert.equal(typeof installedFactory, "function");

    live = await installedFactory!(binding);
    assert.equal(managedCreations, 1);
    assert.ok(managed);
    assert.equal(managed!.starts, 0, "factory construction remains process-inert");

    let selection = await production.integration.select({
      targetSessionId: binding.sourceSessionId,
      projectCwd: binding.projectCwd,
      transport: "http",
    });
    assert.ok(selection);
    const resolved = await production.integration.resolve(selection!);
    assert.equal(resolved?.browser, live.browser, "routes resolve the factory's exact coordinator");
    assert.equal(await production.integration.select({ targetSessionId: "other", transport: "http" }), null);
    for (const value of ["shared", "project", "session", "unknown", ""] as const) {
      assert.equal(await production.integration.select({
        targetSessionId: binding.sourceSessionId,
        requestedPersistence: value,
        transport: "http",
      }), null, `production accepted persistence=${value}`);
      assert.equal(await production.integration.select({
        targetSessionId: binding.sourceSessionId,
        requestedScope: value,
        transport: "cdp",
      }), null, `production accepted scope=${value}`);
    }

    const controls = resolved!.ownerControls;
    assert.ok(controls, "production exposes narrow authenticated-owner lifecycle controls");
    const stoppedState = controls!.state();
    assert.deepEqual(stoppedState, {
      sessionId: binding.sourceSessionId,
      projectCwd: binding.projectCwd,
      status: "stopped",
      controlMode: "agent",
      secretTainted: false,
      localOnlyRecommended: true,
      needsUser: false,
      cdpReady: false,
      viewerTransport: "cdp-screencast",
      cdpScreencastWsPath: `/ws/browser?${new URLSearchParams({ session_id: binding.sourceSessionId }).toString()}`,
      vncReady: false,
      profile: { persistence: "protected" },
      credentialBroker: { supported: false, guarded: true },
      updatedAt: stoppedState.updatedAt,
    });
    assert.equal(JSON.stringify(stoppedState).includes(managed!.options.profileDir), false, "public state excludes private profile paths");
    assert.deepEqual(await live.browser.execute({ kind: "status" }), stoppedState, "status returns the exact public UI contract");

    const startedState = await controls!.start();
    assert.equal(startedState.status, "running");
    assert.equal(startedState.cdpReady, true);
    assert.equal(typeof startedState.startedAt, "number");
    assert.equal(managed!.starts, 1);
    const stoppedAgain = await controls!.stop();
    assert.equal(stoppedAgain.status, "stopped");
    assert.equal(stoppedAgain.cdpReady, false);
    const agentStartedState = await live.browser.execute<any>({ kind: "start" });
    assert.equal(agentStartedState.status, "running");
    assert.equal(agentStartedState.viewerTransport, "cdp-screencast");
    assert.equal(agentStartedState.vncReady, false);
    assert.equal(managed!.starts, 2);
    await assert.rejects(controls!.pasteText("synthetic rejected text"), /requires human control/i);

    await live.browser.beginCredentialHandoff();
    const pastedState = await controls!.pasteText("synthetic owner-only text");
    assert.equal(pastedState.controlMode, "user");
    assert.ok(managed!.cdp.calls.includes("Input.insertText"));
    await assert.rejects(live.browser.resumeAgentAfterCredentialHandoff(), /fresh allowed top-level document/i);
    managed!.cdp.loader = "loader-after-human-handoff";
    await live.browser.resumeAgentAfterCredentialHandoff();
    assert.equal(controls!.state().controlMode, "agent");

    fs.writeFileSync(path.join(managed!.options.profileDir, "synthetic-marker"), "recoverable");
    const resetState = await controls!.resetProfile();
    assert.equal(resetState.status, "stopped");
    assert.equal(resetState.startedAt, undefined);
    assert.equal(fs.existsSync(path.join(managed!.options.profileDir, "synthetic-marker")), false);
    const recoveryRoot = path.join(path.dirname(managed!.options.profileDir), "profile-recovery");
    assert.ok(fs.readdirSync(recoveryRoot).some((entry) => fs.existsSync(path.join(recoveryRoot, entry, "synthetic-marker"))), "old profile is recoverably retained");
    await controls!.start();

    const snapshot = await live.browser.execute<any>({ kind: "snapshot" });
    assert.equal(snapshot.text, "synthetic body");
    assert.equal(managed!.starts, 3);
    assert.ok(managed!.cdp.calls.includes("Page.getFrameTree"));

    assert.equal(managed!.options.downloadBehavior, "allow");
    assert.equal(managed!.options.downloadsDir, path.join(binding.projectCwd, ".wayang", "browser-downloads"));
    const downloadGuid = "synthetic_observable_download";
    managed!.options.onDownloadWillBegin?.({
      frameId: "frame-1",
      guid: downloadGuid,
      url: managed!.cdp.url,
      suggestedFilename: "observable.txt",
    });
    assert.equal(controls!.state().download?.status, "downloading");
    const downloadBody = "synthetic observable download\n";
    fs.mkdirSync(managed!.options.downloadsDir, { recursive: true });
    fs.writeFileSync(path.join(managed!.options.downloadsDir, "observable.txt"), downloadBody, { mode: 0o600 });
    managed!.options.onDownloadProgress?.({
      guid: downloadGuid,
      state: "completed",
      totalBytes: Buffer.byteLength(downloadBody),
      receivedBytes: Buffer.byteLength(downloadBody),
    });
    const status = await (live.tool.execute as any)("synthetic-status", { operation: "status" });
    const agentDownloadState = JSON.parse(status.content[0].text);
    assert.equal(agentDownloadState.download?.status, "completed");
    assert.equal(agentDownloadState.download?.relativePath, ".wayang/browser-downloads/observable.txt");
    assert.equal(agentDownloadState.download?.bytes, Buffer.byteLength(downloadBody));
    assert.equal(fs.readFileSync(path.join(binding.projectCwd, ".wayang", "browser-downloads", "observable.txt"), "utf8"), downloadBody);

    let takeoverViewerClosed = 0;
    await live.browser.registerViewer("cdp", () => { takeoverViewerClosed += 1; });
    const oldBrowser = live.browser;
    const sameManaged = managed;
    const takeoverBinding: ProtectedBrowserBinding = {
      ...binding,
      sourceSessionId: "synthetic-source-session-takeover",
      runtimeGeneration: "synthetic-runtime-generation-takeover",
      controlGeneration: 1,
    };
    live = await production.factory(takeoverBinding);
    assert.equal(oldBrowser.isRevoked, true);
    assert.equal(managed, sameManaged, "session takeover retains the pair realm and Chromium process");
    assert.equal(managed!.running, true);
    assert.equal(takeoverViewerClosed, 1, "session takeover closes the old lease viewer");

    const takeoverSessionId = live.browser.currentBinding.sourceSessionId;
    selection = await production.integration.select({ targetSessionId: takeoverSessionId, projectCwd: binding.projectCwd, transport: "http" });
    assert.ok(selection);
    const takeoverResolved = await production.integration.resolve(selection!);
    const takeoverControls = takeoverResolved?.ownerControls;
    assert.ok(takeoverControls);
    assert.equal(await production.integration.openViewer!(selection!, "vnc"), null, "VNC is explicitly unavailable");
    const viewer = await production.integration.openViewer!(selection!, "cdp");
    assert.ok(viewer);
    const outgoing: string[] = [];
    viewer!.onMessage((message) => outgoing.push(message.toString("utf8")));
    const authorityBeforeViewerInput = authorityChecks;
    await viewer!.dispatch(Buffer.from(JSON.stringify({ type: "mouse", event: "move", x: 10, y: 20 })), false);
    assert.ok(authorityChecks > authorityBeforeViewerInput, "viewer CDP commands reauthorize at dispatch time");
    assert.ok(managed!.cdp.calls.includes("Input.dispatchMouseEvent"));
    assert.ok(outgoing.some((message) => message.includes('"type":"page"')));

    managed!.options.onDownloadWillBegin?.({
      frameId: "frame-1",
      guid: "synthetic_arbitrary_download",
      url: managed!.cdp.url,
      suggestedFilename: "synthetic.csv",
    });
    assert.equal(takeoverControls!.state().download?.status, "downloading", "ordinary downloads are not canceled by a permit policy");

    await live.browser.revoke();
    assert.equal(managed!.running, true, "an idle model-stop gap preserves the pair realm");
    authorityAvailable = false;
    policyListener?.();
    // The realm-level policy subscription remains live without an attached Pi
    // lease and synchronously denies replacement before asynchronous teardown.
    await live.browser.revokeRealm();
    assert.equal(live.browser.isRevoked, true);
    assert.equal(await production.integration.resolve(selection!), null, "revoked runtime is removed from exact live resolution");
    assert.equal(managed!.stops, 3, "UI stop/reset plus one final revocation stop are recorded");
    await viewer!.close();
  } finally {
    await production.close();
    assert.equal(managed?.stops, 3, "bootstrap close does not duplicate final ManagedChromium stop");
    assert.equal(uninstalled, 1);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function delayedNavigationFixture(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wayang-protected-delayed-${label}-`));
  const projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { mode: 0o700 });
  const binding = exactBinding(fs.realpathSync.native(projectRoot));
  let live: ProtectedBrowserToolRuntime | undefined;
  let managed: FakeManagedChromium | undefined;
  const production = bootstrapProtectedBrowserProduction({
    dataDir: path.join(root, "data"),
    owner: { resolve() { return "synthetic-owner"; } },
    authorityResolver(current) { return allowed(current); },
    pairAuthorityResolver() { return true; },
    managedChromiumFactory(options) {
      managed = new FakeManagedChromium(options);
      return managed;
    },
    installFactory() { return () => undefined; },
    liveRuntimeResolver(sourceSessionId, expected) {
      if (!live || sourceSessionId !== binding.sourceSessionId || live.browser.isRevoked) return undefined;
      if (expected && JSON.stringify(expected) !== JSON.stringify(live.browser.currentBinding)) return undefined;
      return live;
    },
    subscribePolicy() { return () => undefined; },
    settleTimeoutMs: 100,
    settleIntervalMs: 1,
  });
  live = await production.factory(binding);
  const selection = await production.integration.select({ targetSessionId: binding.sourceSessionId, transport: "cdp" });
  assert.ok(selection);
  assert.ok(managed);
  return { root, production, live, managed: managed!, selection: selection! };
}

test("agent result release remains observed and a delayed forbidden redirect revokes the runtime", async () => {
  const f = await delayedNavigationFixture("agent");
  try {
    assert.deepEqual(await f.live.browser.execute({ kind: "click", x: 4, y: 8 }), { clicked: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.managed.emitTopLevelNavigation("http://forbidden.invalid/delayed-agent");
    assert.equal(f.live.browser.isRevoked, true, "navigation callback synchronously latches coordinator denial");
    await f.live.browser.revokeRealm();
    assert.equal(f.managed.stops, 1);
  } finally {
    await f.production.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("viewer result release remains observed and a delayed forbidden redirect closes viewer and runtime", async () => {
  const f = await delayedNavigationFixture("viewer");
  try {
    const viewer = await f.production.integration.openViewer!(f.selection, "cdp");
    assert.ok(viewer);
    await f.live.browser.registerViewer("cdp", () => viewer!.close());
    await viewer!.dispatch(Buffer.from(JSON.stringify({ type: "key", event: "down", key: "a", code: "KeyA" })), false);
    const closesBeforeRedirect = f.managed.attachmentCloses;
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.managed.emitTopLevelNavigation("file:///synthetic/delayed-viewer");
    assert.equal(f.live.browser.isRevoked, true, "viewer redirect synchronously latches coordinator denial");
    await f.live.browser.revokeRealm();
    assert.ok(f.managed.attachmentCloses > closesBeforeRedirect, "revocation closes the registered CDP viewer");
    assert.equal(f.managed.stops, 1);
  } finally {
    await f.production.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("future Project-Agent pairs receive independent realms while same-pair sessions transfer one realm", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-independent-realms-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  fs.mkdirSync(projectA, { mode: 0o700 });
  fs.mkdirSync(projectB, { mode: 0o700 });
  const bindingA = exactBinding(fs.realpathSync.native(projectA));
  const bindingB: ProtectedBrowserBinding = {
    ...exactBinding(fs.realpathSync.native(projectB)),
    sourceSessionId: "synthetic-session-independent-b",
    projectId: "synthetic-project-independent-b",
    agentProfileId: "synthetic-profile-independent-b",
    runtimeGeneration: "synthetic-runtime-independent-b",
  };
  const managed: FakeManagedChromium[] = [];
  const production = bootstrapProtectedBrowserProduction({
    dataDir: path.join(root, "data"),
    owner: { resolve() { return "synthetic-owner"; } },
    authorityResolver(current) { return allowed(current); },
    pairAuthorityResolver() { return true; },
    managedChromiumFactory(options) {
      const instance = new FakeManagedChromium(options);
      managed.push(instance);
      return instance;
    },
    installFactory() { return () => undefined; },
    subscribePolicy() { return () => undefined; },
  });
  try {
    const leaseA = await production.factory(bindingA);
    const leaseB = await production.factory(bindingB);
    assert.equal(managed.length, 2);
    assert.equal(leaseA.browser.isRevoked, false, "an unrelated pair does not take over pair A");
    assert.notEqual(managed[0]!.options.profileDir, managed[1]!.options.profileDir);

    const takeoverA = await production.factory({
      ...bindingA,
      sourceSessionId: "synthetic-session-a2",
      runtimeGeneration: "synthetic-runtime-a2",
    });
    assert.equal(managed.length, 2, "same pair takeover does not construct a second Chromium realm");
    assert.equal(leaseA.browser.isRevoked, true);
    assert.equal(leaseB.browser.isRevoked, false, "pair B remains independently usable");
    assert.equal(takeoverA.browser.isRevoked, false);
  } finally {
    await production.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protected production preserves its strict runtime export surface", async () => {
  const runtime = await import("./protected-production.js");
  assert.deepEqual(Object.keys(runtime).sort(), [
    "ProtectedCredentialProtection",
    "bootstrapProtectedBrowserProduction",
  ]);
});

test("production selection never falls back from an exact runtime binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-production-selection-"));
  let installed = 0;
  const production = bootstrapProtectedBrowserProduction({
    dataDir: path.join(root, "data"),
    owner: { resolve() { return null; } },
    authorityResolver() { throw new Error("authority lookup must not run without an exact live runtime"); },
    liveRuntimeResolver() { return undefined; },
    installFactory() { installed += 1; return () => undefined; },
  });
  try {
    assert.equal(installed, 1);
    assert.equal(await production.integration.select({ projectCwd: "/synthetic/project", transport: "cdp" }), null);
    assert.equal(await production.integration.select({ targetSessionId: "missing", projectCwd: "/synthetic/project", transport: "cdp" }), null);
  } finally {
    await production.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
