import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { CdpConnection, ChromeTarget } from "../browser/cdp.js";
import type { ManagedChromiumRuntimeOptions } from "../browser/manager.js";
import { ProtectedAutomationNeedsUserError } from "./attention.js";
import {
  ProtectedAutomationBrowserRealmRegistry,
  type ProtectedAutomationManagedRuntime,
} from "./browser-realm.js";
import {
  PROTECTED_AUTOMATION_BROWSER_RPC_METHODS,
  ProtectedAutomationBrowserRpc,
} from "./browser-rpc.js";

class SyntheticCdp {
  readonly methods: string[] = [];
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  url = "about:blank";
  loader = "loader-1";
  popupPaused = false;
  popupClosed = false;
  popupResumed = false;
  autoAttachParams: Record<string, unknown> | null = null;
  private requestSequence = 0;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private readonly paused = new Map<string, (allowed: boolean) => void>();

  on(method: string, listener: (event: any) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set<(event: any) => void>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  private emit(method: string, event: any): void {
    for (const listener of this.listeners.get(method) ?? []) listener(event);
  }

  private pause(url: string, networkId: string, redirected = false, frameId = "frame-1"): Promise<boolean> {
    const requestId = `fetch-${++this.requestSequence}`;
    const result = new Promise<boolean>((resolve) => this.paused.set(requestId, resolve));
    this.emit("Fetch.requestPaused", {
      requestId, networkId, frameId, resourceType: "Document", request: { url },
      ...(redirected ? { responseStatusCode: 302 } : {}),
    });
    return result;
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.methods.push(method);
    this.commands.push({ method, params: { ...params } });
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "frame-1", loaderId: this.loader, url: this.url } } };
    }
    if (method === "Target.getTargets") {
      return { targetInfos: [{ type: "page", targetId: "target-1", url: "about:blank" }] };
    }
    if (method === "Target.setAutoAttach") {
      this.autoAttachParams = { ...params };
      return {};
    }
    if (method === "Target.closeTarget") {
      if (params.targetId === "popup-target") this.popupClosed = true;
      return { success: true };
    }
    if (method === "Runtime.runIfWaitingForDebugger") {
      this.popupResumed = true;
      return {};
    }
    if (method === "Fetch.continueRequest" || method === "Fetch.failRequest") {
      const requestId = String(params.requestId || "");
      const resolve = this.paused.get(requestId);
      this.paused.delete(requestId);
      resolve?.(method === "Fetch.continueRequest");
      return {};
    }
    if (method === "Page.navigate") {
      const requested = String(params.url || "");
      if (requested.includes("popup")) {
        assert.deepEqual(this.autoAttachParams, {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "page", exclude: false }],
        }, "popup creation requires the pre-navigation paused auto-attach gate");
        this.popupPaused = true;
        this.emit("Target.attachedToTarget", {
          sessionId: "popup-session",
          waitingForDebugger: true,
          targetInfo: { targetId: "popup-target", type: "page", url: "about:blank" },
        });
        await Promise.resolve();
        return { frameId: "frame-1", errorText: "popup denied" };
      }
      const networkId = `network-${this.requestSequence + 1}`;
      if (requested.includes("required-subresource")
        && !(await this.pause("http://foreign-subresource.example.test/frame", `${networkId}-child`, false, "frame-child"))) {
        return { frameId: "frame-1", errorText: "subresource blocked" };
      }
      if (!(await this.pause(requested, networkId))) return { frameId: "frame-1", errorText: "blocked" };
      let committed = requested;
      if (requested.includes("redirect-out")) {
        committed = "https://foreign.example.test/";
        if (!(await this.pause(committed, networkId, true))) return { frameId: "frame-1", errorText: "blocked" };
      } else if (requested.includes("redirect-http")) {
        committed = "http://allowed.example.test/downgrade";
        if (!(await this.pause(committed, networkId, true))) return { frameId: "frame-1", errorText: "blocked" };
      } else if (requested.includes("redirect-file")) {
        committed = "file:///etc/passwd";
        if (!(await this.pause(committed, networkId, true))) return { frameId: "frame-1", errorText: "blocked" };
      } else if (requested.includes("redirect-data")) {
        committed = "data:text/html,blocked";
        if (!(await this.pause(committed, networkId, true))) return { frameId: "frame-1", errorText: "blocked" };
      } else if (requested.includes("redirect-same")) {
        committed = "https://allowed.example.test/final";
        if (!(await this.pause(committed, networkId, true))) return { frameId: "frame-1", errorText: "blocked" };
      }
      if (requested.includes("noncommit")) return { frameId: "frame-1" };
      this.loader = `loader-${this.methods.length}`;
      this.url = committed;
      this.emit("Page.frameNavigated", { frame: { id: "frame-1", loaderId: this.loader, url: this.url } });
      this.emit("Network.loadingFinished", { requestId: networkId });
      return { frameId: "frame-1", loaderId: this.loader };
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params.expression || "");
      if (expression.includes("readyState: document.readyState")) {
        return { result: { value: { url: this.url, title: "Synthetic", readyState: "complete" } } };
      }
      if (expression.includes("nodes.map(__wayangInfo)")) {
        return { result: { value: { url: this.url, title: "Synthetic", elements: [{ index: 0, tag: "button", rect: { x: 1, y: 2, width: 3, height: 4 } }] } } };
      }
      if (expression.includes("document.body.innerText")) {
        return { result: { value: { url: this.url, title: "Synthetic", text: "synthetic page" } } };
      }
      if (expression.includes("querySelectorAll(selector)")) {
        return { result: { value: { url: this.url, title: "Synthetic", selector: "main", elements: [] } } };
      }
      return { result: { value: true } };
    }
    if (method.startsWith("Input.") || method === "Page.enable" || method === "Network.enable"
      || method === "Target.setDiscoverTargets" || method === "Fetch.enable") return {};
    throw new Error(`unexpected synthetic CDP method ${method}`);
  }
}

class SyntheticRuntime implements ProtectedAutomationManagedRuntime {
  running = false;
  readonly cdp = new SyntheticCdp();
  readonly target = {
    id: "target-1", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://synthetic.invalid",
  } as ChromeTarget;
  constructor(readonly options: ManagedChromiumRuntimeOptions) {}
  async start(check?: () => Promise<void>): Promise<void> { await check?.(); this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  async cancelDownload(): Promise<void> {}
  async attachPageCdpViewer() { return { cdp: this.cdp as unknown as CdpConnection, target: this.target, close() {} }; }
  async withPageCdp<T>(operation: (cdp: CdpConnection, target: ChromeTarget) => Promise<T>): Promise<T> {
    return operation(this.cdp as unknown as CdpConnection, { ...this.target, url: this.cdp.url });
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-rpc-"));
  fs.mkdirSync(path.join(root, "project"));
  let runtime!: SyntheticRuntime;
  let authorized = true;
  const realms = new ProtectedAutomationBrowserRealmRegistry({
    dataDir: path.join(root, "data"),
    runtimeFactory: (options) => { runtime = new SyntheticRuntime(options); return runtime; },
  });
  const lease = realms.acquire({
    projectId: "project", projectCwd: path.join(root, "project"), agentProfileId: "profile", jobId: "job",
    capabilityRevision: 2, jobRevision: 4, sourceRevision: 3, sourceManifestSha256: "b".repeat(64),
    allowedHttpsOrigins: ["https://allowed.example.test"], kind: "run", ownerId: "run", runRoot: path.join(root, "run"),
    assertAuthorized() { if (!authorized) throw new Error("drift"); },
  });
  const rpc = new ProtectedAutomationBrowserRpc(lease);
  const request = (method: string, params: unknown) => rpc.request({
    method, params, allowedHttpsOrigins: ["https://allowed.example.test"], signal: new AbortController().signal,
  });
  return {
    root, realms, lease, rpc, request,
    get runtime() { return runtime; },
    set authorized(value: boolean) { authorized = value; },
    async cleanup() { await rpc.close(); await realms.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("the FD3 vocabulary is a bounded selector-only allowlist with exact parameter objects", async () => {
  const f = fixture();
  try {
    assert.ok(PROTECTED_AUTOMATION_BROWSER_RPC_METHODS.length <= 16);
    assert.equal(PROTECTED_AUTOMATION_BROWSER_RPC_METHODS.some((method) => /cdp|cookie|storage|javascript|coordinate/iu.test(method)), false);
    await assert.rejects(() => f.request("cdp.send", { method: "Runtime.evaluate" }), /not allowed/i);
    await assert.rejects(() => f.request("browser.click", { x: 1, y: 2 }), /not allowed/i);
    await assert.rejects(() => f.request("browser.snapshot", { javascript: "document.cookie" }), /not exact/i);
    await assert.rejects(() => f.request("browser.navigate", { url: "https://allowed.example.test", extra: true }), /not exact/i);
    const status = await f.request("browser.status", {}) as { running: boolean; generation: string };
    assert.equal(status.running, false);
    assert.match(status.generation, /^[A-Za-z0-9_-]+$/u);
    assert.deepEqual(f.runtime.cdp.methods, []);
  } finally {
    await f.cleanup();
  }
});

test("navigation and inspection require exact allowed HTTPS origins and settled document attestation", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.request("browser.navigate", { url: "http://allowed.example.test/" }),
      /origin is not allowed/i,
    );
    await assert.rejects(
      () => f.request("browser.navigate", { url: "https://foreign.example.test/" }),
      /origin is not allowed/i,
    );
    const navigation = await f.request("browser.navigate", { url: "https://allowed.example.test/export" }) as any;
    assert.equal(navigation.url, "https://allowed.example.test/export");
    assert.match(navigation.document, /^target-1:frame-1:loader-/u);
    assert.ok(f.runtime.cdp.methods.indexOf("Fetch.enable") < f.runtime.cdp.methods.indexOf("Page.navigate"),
      "document interception is installed before navigation delivery");
    assert.ok(f.runtime.cdp.methods.indexOf("Target.setAutoAttach") < f.runtime.cdp.methods.indexOf("Page.navigate"),
      "paused popup auto-attachment is installed before navigation delivery");
    assert.deepEqual(f.runtime.cdp.autoAttachParams, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page", exclude: false }],
    });
    const redirected = await f.request("browser.navigate", { url: "https://allowed.example.test/redirect-same" }) as any;
    assert.equal(redirected.url, "https://allowed.example.test/final", "required same-origin redirects remain available");
    const withSubresource = await f.request("browser.navigate", {
      url: "https://allowed.example.test/required-subresource",
    }) as any;
    assert.equal(withSubresource.url, "https://allowed.example.test/required-subresource",
      "foreign iframe/subresource documents remain outside the top-level gate");
    const snapshot = await f.request("browser.snapshot", {}) as any;
    assert.equal(snapshot.text, "synthetic page");
    const dom = await f.request("browser.dom_snapshot", { includeText: false, limit: 10 }) as any;
    assert.equal(dom.elements[0].tag, "button");
    assert.equal("rect" in dom.elements[0], false, "agent-visible coordinates are stripped");
    assert.ok(f.runtime.cdp.methods.filter((method) => method === "Page.getFrameTree").length >= 12,
      "each operation observes two consecutive settled identities before releasing a result");
    assert.equal(f.lease.isRevoked, false);
  } finally {
    await f.cleanup();
  }
});

test("a foreign redirect is blocked at the request stage and denial-latches the lease", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.request("browser.navigate", { url: "https://allowed.example.test/redirect-out" }),
      /cancelled|revoked|navigation/i,
    );
    assert.equal(f.runtime.cdp.methods.includes("Fetch.failRequest"), true);
    assert.equal(f.runtime.cdp.url, "about:blank", "the foreign document never commits");
    assert.equal(f.lease.isRevoked, true);
    await assert.rejects(() => f.request("browser.status", {}), /cancelled|revoked/i);
    await f.rpc.close();
    assert.equal(f.runtime.running, false);
  } finally {
    await f.cleanup();
  }
});

test("HTTP downgrade, file, and data document requests are blocked before commit", async () => {
  for (const suffix of ["redirect-http", "redirect-file", "redirect-data"]) {
    const f = fixture();
    try {
      await assert.rejects(
        () => f.request("browser.navigate", { url: `https://allowed.example.test/${suffix}` }),
        /cancelled|revoked|navigation/i,
      );
      assert.equal(f.runtime.cdp.methods.includes("Fetch.failRequest"), true, suffix);
      assert.equal(f.runtime.cdp.url, "about:blank", suffix);
      assert.equal(f.lease.isRevoked, true, suffix);
    } finally {
      await f.cleanup();
    }
  }
});

test("a popup is paused and closed without resume before denial-latching the realm", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.request("browser.navigate", { url: "https://allowed.example.test/popup" }),
      /cancelled|revoked|navigation/i,
    );
    const methods = f.runtime.cdp.methods;
    assert.ok(methods.indexOf("Target.setAutoAttach") < methods.indexOf("Page.navigate"));
    assert.equal(f.runtime.cdp.popupPaused, true);
    assert.equal(f.runtime.cdp.popupClosed, true);
    assert.equal(f.runtime.cdp.popupResumed, false);
    assert.equal(methods.includes("Runtime.runIfWaitingForDebugger"), false);
    assert.equal(methods.includes("Fetch.continueRequest"), false,
      "the paused popup is never continued through the document request gate");
    const navigateIndex = methods.indexOf("Page.navigate");
    const popupCommands = f.runtime.cdp.commands.slice(navigateIndex + 1);
    assert.deepEqual(popupCommands, [{ method: "Target.closeTarget", params: { targetId: "popup-target" } }],
      "the debugger-paused popup is closed before any continue or resume command");
    assert.equal(f.lease.isRevoked, true);
    assert.equal(f.runtime.cdp.url, "about:blank");
  } finally {
    await f.cleanup();
  }
});

test("an unattested initial document denial-latches inspection", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.request("browser.snapshot", {}),
      /outside the exact HTTPS allowlist/i,
    );
    assert.equal(f.lease.isRevoked, true);
  } finally {
    await f.cleanup();
  }
});

test("a permitted request that does not commit a new loader fails closed", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.request("browser.navigate", { url: "https://allowed.example.test/noncommit" }),
      /did not commit/i,
    );
    assert.equal(f.lease.isRevoked, true);
    assert.equal(f.runtime.cdp.url, "about:blank");
  } finally {
    await f.cleanup();
  }
});

test("child-visible download results expose only opaque handles and materialized file facts", async () => {
  const f = fixture();
  try {
    const guid = "browser-profile-guid";
    f.runtime.options.onDownloadWillBegin?.({
      frameId: "frame-1", guid, url: "https://allowed.example.test/private/export?account=synthetic",
      suggestedFilename: "account-secret.csv",
    });
    fs.writeFileSync(path.join(f.runtime.options.downloadsDir, guid), "synthetic", { mode: 0o600 });
    f.runtime.options.onDownloadProgress?.({ guid, totalBytes: 9, receivedBytes: 9, state: "completed" });
    const listed = await f.request("browser.downloads.list", {}) as any;
    assert.equal(listed.downloads.length, 1);
    assert.deepEqual(Object.keys(listed.downloads[0]).sort(), ["handle", "sizeBytes"]);
    assert.equal(JSON.stringify(listed).includes("account-secret"), false);
    assert.equal(JSON.stringify(listed).includes("allowed.example.test"), false);
    assert.equal(JSON.stringify(listed).includes(guid), false);
    await assert.rejects(
      () => f.request("browser.downloads.materialize", { handle: listed.downloads[0].handle, name: null }),
      /download name is invalid/i,
    );
    const materialized = await f.request("browser.downloads.materialize", {
      handle: listed.downloads[0].handle, name: "export.bin",
    }) as any;
    assert.deepEqual(Object.keys(materialized).sort(), ["name", "sha256", "sizeBytes"]);
    assert.equal(materialized.name, "export.bin");
  } finally {
    await f.cleanup();
  }
});

test("origin/revision drift suppresses results and human attention uses metadata-only signaling", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.rpc.request({
        method: "browser.status", params: {}, allowedHttpsOrigins: ["https://other.example.test"], signal: new AbortController().signal,
      }),
      /origin binding changed/i,
    );
    assert.equal(f.lease.isRevoked, true);
  } finally {
    await f.cleanup();
  }

  const attention = fixture();
  try {
    await assert.rejects(
      () => attention.request("browser.needs_user", { reason: "mfa_required" }),
      (error: unknown) => error instanceof ProtectedAutomationNeedsUserError && error.reason === "mfa_required",
    );
  } finally {
    await attention.cleanup();
  }
});
