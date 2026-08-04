import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ManagedChromiumRuntime,
  type ManagedChromiumRuntimeOptions,
} from "../browser/manager.js";
import type { CdpConnection, ChromeTarget } from "../browser/cdp.js";
import {
  ProtectedAutomationDownloadRegistry,
} from "./browser-downloads.js";

export type ProtectedAutomationBrowserLeaseKind = "run" | "prepare";

export interface ProtectedAutomationBrowserLeaseBinding {
  projectId: string;
  projectCwd: string;
  agentProfileId: string;
  jobId: string;
  capabilityRevision: number;
  jobRevision: number;
  sourceRevision: number;
  sourceManifestSha256: string;
  kind: ProtectedAutomationBrowserLeaseKind;
  ownerId: string;
  generation: string;
}

export interface ProtectedAutomationBrowserRealmStorage {
  rootDir: string;
  profileDir: string;
  downloadsDir: string;
  runtimeDir: string;
}

export interface ProtectedAutomationManagedRuntime {
  readonly running: boolean;
  start(assertAuthorizedBeforeBrowserCdp?: () => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  cancelDownload(guid: string, assertAuthorizedBeforeBrowserCdp?: () => Promise<void>): Promise<void>;
  withPageCdp<T>(operation: (cdp: CdpConnection, target: ChromeTarget) => Promise<T>): Promise<T>;
  /** Dedicated attachment retained by the realm for lease-lifetime request interception. */
  attachPageCdpViewer?(): Promise<{ cdp: CdpConnection; target: ChromeTarget; close(): void }>;
}

export interface ProtectedAutomationBrowserRealmAcquire {
  projectId: string;
  projectCwd: string;
  agentProfileId: string;
  jobId: string;
  capabilityRevision: number;
  jobRevision: number;
  sourceRevision: number;
  sourceManifestSha256: string;
  allowedHttpsOrigins: readonly string[];
  kind: ProtectedAutomationBrowserLeaseKind;
  ownerId: string;
  runRoot?: string;
  signal?: AbortSignal;
  /** Must resolve only while every durable exact revision remains current. */
  assertAuthorized(binding: Readonly<ProtectedAutomationBrowserLeaseBinding>): void | Promise<void>;
}

export interface ProtectedAutomationViewerRegistration {
  id: string;
  close(): void | Promise<void>;
}

export type ProtectedAutomationRuntimeFactory = (
  options: ManagedChromiumRuntimeOptions,
) => ProtectedAutomationManagedRuntime;

export interface ProtectedAutomationBrowserRealmRegistryOptions {
  dataDir: string;
  runtimeFactory?: ProtectedAutomationRuntimeFactory;
}

function realmError(message: string, statusCode = 403): Error {
  return Object.assign(new Error(message), { statusCode });
}

function privateDirectory(directory: string): void {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw realmError("Protected automation browser storage is unsafe");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw realmError("Protected automation browser storage has the wrong owner");
  }
  fs.chmodSync(directory, 0o700);
}

function idSegment(label: string, value: string): string {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value)) throw realmError(`Browser realm ${label} is invalid`, 400);
  return `${label}-${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

function positiveRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw realmError(`Browser realm ${label} is invalid`, 400);
}

export function normalizeProtectedAutomationOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 32) {
    throw realmError("Browser realm HTTPS origins are invalid", 400);
  }
  const normalized = new Set<string>();
  for (const value of origins) {
    if (typeof value !== "string" || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw realmError("Browser realm HTTPS origin is invalid", 400);
    }
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw realmError("Browser realm HTTPS origin is invalid", 400); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw realmError("Browser realm requires exact HTTPS origins", 400);
    }
    normalized.add(parsed.origin);
  }
  if (normalized.size !== origins.length) throw realmError("Browser realm HTTPS origins must be unique", 400);
  return normalized;
}

export function protectedAutomationBrowserRealmRoot(
  dataDir: string,
  projectId: string,
  agentProfileId: string,
  jobId: string,
): string {
  return path.join(path.resolve(dataDir), "protected-automation", "browser-realms", "v1",
    idSegment("project", projectId), idSegment("profile", agentProfileId), idSegment("job", jobId));
}

export function ensureProtectedAutomationBrowserRealmStorage(
  dataDir: string,
  projectCwd: string,
  projectId: string,
  agentProfileId: string,
  jobId: string,
): ProtectedAutomationBrowserRealmStorage {
  const requestedBase = path.resolve(dataDir);
  fs.mkdirSync(requestedBase, { recursive: true, mode: 0o700 });
  const base = fs.realpathSync(requestedBase);
  const projectRoot = path.resolve(projectCwd);
  const relative = path.relative(projectRoot, base);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw realmError("Browser realm profile must remain outside the project root");
  }
  let rootDir = base;
  for (const segment of [
    "protected-automation", "browser-realms", "v1",
    idSegment("project", projectId), idSegment("profile", agentProfileId), idSegment("job", jobId),
  ]) {
    rootDir = path.join(rootDir, segment);
    privateDirectory(rootDir);
  }
  const profileDir = path.join(rootDir, "profile");
  const downloadsDir = path.join(rootDir, "downloads");
  const runtimeDir = path.join(rootDir, "runtime");
  for (const directory of [profileDir, downloadsDir, runtimeDir]) privateDirectory(directory);
  return { rootDir, profileDir, downloadsDir, runtimeDir };
}

function exactBindingEqual(
  left: Readonly<ProtectedAutomationBrowserLeaseBinding>,
  right: Readonly<ProtectedAutomationBrowserLeaseBinding>,
): boolean {
  return left.projectId === right.projectId
    && left.projectCwd === right.projectCwd
    && left.agentProfileId === right.agentProfileId
    && left.jobId === right.jobId
    && left.capabilityRevision === right.capabilityRevision
    && left.jobRevision === right.jobRevision
    && left.sourceRevision === right.sourceRevision
    && left.sourceManifestSha256 === right.sourceManifestSha256
    && left.kind === right.kind && left.ownerId === right.ownerId && left.generation === right.generation;
}

export class ProtectedAutomationBrowserRealmLease {
  readonly binding: Readonly<ProtectedAutomationBrowserLeaseBinding>;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly downloads: ProtectedAutomationDownloadRegistry;
  readonly runtime: ProtectedAutomationManagedRuntime;
  readonly storage: ProtectedAutomationBrowserRealmStorage;
  readonly runRoot?: string;
  private readonly abortController = new AbortController();
  private readonly viewers = new Map<string, ProtectedAutomationViewerRegistration>();
  private queueTail: Promise<void> = Promise.resolve();
  private revoked = false;
  private denialGeneration = 0;
  private cleanupPromise: Promise<void> | null = null;
  private pendingDownloadsAtDenial: string[] = [];
  private removeAbortListener: (() => void) | undefined;
  private navigationGatePromise: Promise<void> | null = null;
  private navigationGateAttachment: { cdp: CdpConnection; target: ChromeTarget; close(): void } | null = null;
  private navigationGateListeners: Array<() => void> = [];
  private readonly navigationChains = new Map<string, string>();
  private navigationRequestBlock: Promise<void> = Promise.resolve();
  private mainFrameId: string | null = null;

  constructor(
    request: ProtectedAutomationBrowserRealmAcquire,
    storage: ProtectedAutomationBrowserRealmStorage,
    runtimeFactory: ProtectedAutomationRuntimeFactory,
    private readonly releaseActive: (lease: ProtectedAutomationBrowserRealmLease) => void,
  ) {
    if ((request.kind !== "run" && request.kind !== "prepare") || !path.isAbsolute(request.projectCwd)
      || path.resolve(request.projectCwd) !== request.projectCwd
      || (request.runRoot !== undefined && !path.isAbsolute(request.runRoot))
      || (request.kind === "prepare" && request.runRoot !== undefined)) {
      throw realmError("Browser realm scope is invalid", 400);
    }
    for (const id of [request.projectId, request.agentProfileId, request.jobId, request.ownerId]) idSegment("binding", id);
    for (const [label, revision] of [
      ["capability revision", request.capabilityRevision],
      ["job revision", request.jobRevision],
      ["source revision", request.sourceRevision],
    ] as const) positiveRevision(revision, label);
    if (!/^[a-f0-9]{64}$/u.test(request.sourceManifestSha256)) throw realmError("Browser realm source manifest is invalid", 400);
    if (!request.ownerId || (request.kind === "run" && !request.runRoot)) throw realmError("Browser realm lease owner is invalid", 400);
    this.binding = Object.freeze({
      projectId: request.projectId,
      projectCwd: request.projectCwd,
      agentProfileId: request.agentProfileId,
      jobId: request.jobId,
      capabilityRevision: request.capabilityRevision,
      jobRevision: request.jobRevision,
      sourceRevision: request.sourceRevision,
      sourceManifestSha256: request.sourceManifestSha256,
      kind: request.kind,
      ownerId: request.ownerId,
      generation: randomBytes(24).toString("base64url"),
    });
    this.allowedOrigins = normalizeProtectedAutomationOrigins(request.allowedHttpsOrigins);
    this.storage = storage;
    this.runRoot = request.runRoot;
    this.downloads = new ProtectedAutomationDownloadRegistry(
      storage.downloadsDir,
      this.allowedOrigins,
      request.kind === "run" ? request.ownerId : null,
      this.binding.generation,
    );
    let runtime!: ProtectedAutomationManagedRuntime;
    runtime = runtimeFactory({
      profileDir: storage.profileDir,
      downloadsDir: storage.downloadsDir,
      downloadBehavior: "allowAndName",
      workingDirectory: storage.runtimeDir,
      onDownloadWillBegin: (event) => {
        if (!this.downloads.begin(event)) {
          void runtime.cancelDownload(event.guid, () => this.assertAuthorized())
            .catch(() => this.deny("download-cancel-failed"));
        }
      },
      onDownloadProgress: (event) => {
        if (this.downloads.progress(event)) {
          void runtime.cancelDownload(event.guid, () => this.assertAuthorized()).catch(() => this.deny("download-cancel-failed"));
        }
      },
      onTopLevelNavigation: (url) => {
        if (url === "about:blank") return;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" || !this.allowedOrigins.has(parsed.origin)) this.deny("top-level-origin-drift");
        } catch { this.deny("top-level-origin-drift"); }
      },
      onUnexpectedExit: () => this.deny("chromium-exited"),
    });
    this.runtime = runtime;
    const abort = () => this.deny("owner-cancelled");
    request.signal?.addEventListener("abort", abort, { once: true });
    this.removeAbortListener = () => request.signal?.removeEventListener("abort", abort);
    if (request.signal?.aborted) this.deny("owner-cancelled");
    this.authority = request.assertAuthorized;
  }

  private readonly authority: ProtectedAutomationBrowserRealmAcquire["assertAuthorized"];

  get signal(): AbortSignal { return this.abortController.signal; }
  get isRevoked(): boolean { return this.revoked; }

  async assertAuthorized(): Promise<void> {
    const observed = this.binding;
    const denialGeneration = this.denialGeneration;
    if (this.revoked || this.signal.aborted) throw realmError("Browser realm lease has been revoked");
    try { await this.authority(observed); } catch {
      this.deny("authority-drift");
      throw realmError("Browser realm exact authority changed");
    }
    if (this.revoked || this.denialGeneration !== denialGeneration || !exactBindingEqual(observed, this.binding)) {
      throw realmError("Browser realm lease has been revoked");
    }
  }

  async start(): Promise<void> {
    await this.assertAuthorized();
    await this.runtime.start(() => this.assertAuthorized());
    await this.installNavigationGate();
    await this.assertAuthorized();
  }

  private installNavigationGate(): Promise<void> {
    this.navigationGatePromise ??= (async () => {
      if (!this.runtime.attachPageCdpViewer) {
        this.deny("navigation-interception-unavailable");
        throw realmError("Browser realm navigation interception is unavailable");
      }
      const attachment = await this.runtime.attachPageCdpViewer();
      this.navigationGateAttachment = attachment;
      const { cdp, target } = attachment;
      try {
        await this.assertAuthorized();
        await cdp.send("Page.enable");
        await cdp.send("Network.enable");
        const tree = await cdp.send<any>("Page.getFrameTree");
        const frameId = typeof tree?.frameTree?.frame?.id === "string" ? tree.frameTree.frame.id : "";
        if (!frameId) throw realmError("Browser realm top-level frame is unattested");
        this.mainFrameId = frameId;

        this.navigationGateListeners.push(cdp.on("Fetch.requestPaused", (event: any) => {
          void this.handlePausedRequest(cdp, event);
        }));
        const finishChain = (event: any) => {
          if (typeof event?.requestId === "string") this.navigationChains.delete(event.requestId);
        };
        this.navigationGateListeners.push(cdp.on("Network.loadingFinished", finishChain));
        this.navigationGateListeners.push(cdp.on("Network.loadingFailed", finishChain));
        const denyUnexpectedPage = (event: any) => {
          const info = event?.targetInfo;
          if (info?.type === "page" && info.targetId !== target.id) this.deny("unexpected-page-target");
        };
        this.navigationGateListeners.push(cdp.on("Target.targetCreated", denyUnexpectedPage));
        this.navigationGateListeners.push(cdp.on("Target.targetInfoChanged", denyUnexpectedPage));
        // Pause newly-created related targets before their first request. The
        // existing page remains the only permitted top-level target; popup and
        // new-tab sessions are never resumed.
        this.navigationGateListeners.push(cdp.on("Target.attachedToTarget", (event: any) => {
          const info = event?.targetInfo;
          if (info?.type === "page" && info.targetId !== target.id) {
            this.deny("unexpected-page-target");
            if (typeof info.targetId === "string") {
              void cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
            }
          }
        }));
        this.navigationGateListeners.push(cdp.on("Page.frameNavigated", (event: any) => {
          const frame = event?.frame;
          if (frame?.id !== this.mainFrameId || frame?.parentId) return;
          if (!this.isAllowedTopLevelUrl(frame.url)) this.deny("unattested-document");
        }));

        await this.assertAuthorized();
        await cdp.send("Fetch.enable", {
          patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
        });
        await this.assertAuthorized();
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        await this.assertAuthorized();
        await cdp.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "page", exclude: false }],
        });
        await this.assertAuthorized();
      } catch (error) {
        this.deny("navigation-interception-failed");
        throw error;
      }
    })();
    return this.navigationGatePromise;
  }

  private isAllowedTopLevelUrl(value: unknown): boolean {
    if (typeof value !== "string") return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && this.allowedOrigins.has(parsed.origin);
    } catch {
      return false;
    }
  }

  private async handlePausedRequest(cdp: CdpConnection, event: any): Promise<void> {
    const requestId = typeof event?.requestId === "string" ? event.requestId : "";
    const isTopLevelDocument = event?.resourceType === "Document" && event?.frameId === this.mainFrameId;
    if (!requestId) {
      this.deny("malformed-navigation-request");
      return;
    }
    if (!isTopLevelDocument) {
      // The contract gates top-level documents, not required iframe/subresource traffic.
      try {
        await this.assertAuthorized();
        await cdp.send("Fetch.continueRequest", { requestId });
      } catch { this.deny("subresource-release-failed"); }
      return;
    }

    const url = event?.request?.url;
    const networkId = typeof event?.networkId === "string" && event.networkId ? event.networkId : "";
    let origin = "";
    if (this.isAllowedTopLevelUrl(url)) origin = new URL(url).origin;
    const chainOrigin = networkId ? this.navigationChains.get(networkId) : undefined;
    const redirectChangedOrigin = Boolean(chainOrigin && chainOrigin !== origin);
    if (!origin || !networkId || redirectChangedOrigin) {
      if (!this.latchDenial(redirectChangedOrigin ? "cross-origin-redirect" : "disallowed-navigation-request")) return;
      // Keep the Fetch attachment alive until Chromium has acknowledged the
      // block. Disconnecting a Fetch client can otherwise resume a paused request.
      this.navigationRequestBlock = cdp.send("Fetch.failRequest", {
        requestId, errorReason: "BlockedByClient",
      }).then(() => undefined, () => undefined);
      await this.navigationRequestBlock;
      void this.cleanup();
      return;
    }
    if (!chainOrigin) this.navigationChains.set(networkId, origin);
    try {
      await this.assertAuthorized();
      await cdp.send("Fetch.continueRequest", { requestId });
    } catch {
      this.deny("navigation-request-release-failed");
    }
  }

  async assertNavigationGateReady(): Promise<void> {
    await this.start();
    if (!this.navigationGateAttachment || this.revoked) throw realmError("Browser realm navigation interception is unavailable");
    await this.assertAuthorized();
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => { release = resolve; });
    return prior.catch(() => undefined).then(async () => {
      await this.assertAuthorized();
      const result = await operation();
      await this.assertAuthorized();
      return result;
    }).finally(release);
  }

  async registerViewer(registration: ProtectedAutomationViewerRegistration): Promise<void> {
    if (this.binding.kind !== "prepare") throw realmError("Browser viewers require a preparation lease", 409);
    await this.assertAuthorized();
    if (!registration || typeof registration.id !== "string" || !registration.id || typeof registration.close !== "function"
      || this.viewers.has(registration.id) || this.viewers.size >= 4) {
      throw realmError("Browser preparation viewer is invalid", 400);
    }
    this.viewers.set(registration.id, registration);
    try { await this.assertAuthorized(); } catch (error) {
      this.viewers.delete(registration.id);
      await Promise.resolve(registration.close()).catch(() => undefined);
      throw error;
    }
  }

  unregisterViewer(id: string): void { this.viewers.delete(id); }

  handleViewerMessage<T>(id: string, dispatch: () => Promise<T>): Promise<T> {
    if (!this.viewers.has(id)) return Promise.reject(realmError("Browser preparation viewer is unavailable"));
    return this.runExclusive(dispatch);
  }

  private latchDenial(_reason: string): boolean {
    if (this.revoked) return false;
    this.revoked = true;
    this.denialGeneration += 1;
    this.abortController.abort(realmError("Browser realm lease has been revoked"));
    this.pendingDownloadsAtDenial = this.downloads.pendingGuids();
    this.downloads.revoke();
    return true;
  }

  deny(reason: string): void {
    if (!this.latchDenial(reason)) return;
    void this.cleanup();
  }

  private cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      const viewers = [...this.viewers.values()];
      this.viewers.clear();
      const pendingDownloads = this.pendingDownloadsAtDenial;
      this.pendingDownloadsAtDenial = [];
      await this.navigationRequestBlock;
      for (const remove of this.navigationGateListeners.splice(0)) remove();
      this.navigationChains.clear();
      this.mainFrameId = null;
      const navigationGateAttachment = this.navigationGateAttachment;
      this.navigationGateAttachment = null;
      navigationGateAttachment?.close();
      await Promise.allSettled([
        ...viewers.map((viewer) => Promise.resolve().then(() => viewer.close())),
        ...pendingDownloads.map((guid) => this.runtime.cancelDownload(guid)),
        // Stop concurrently so a denied in-flight CDP command cannot prevent
        // teardown while the serialized queue drains.
        this.runtime.stop(),
        this.queueTail.catch(() => undefined),
      ]);
      this.releaseActive(this);
    })();
    return this.cleanupPromise;
  }

  async close(): Promise<void> {
    this.deny("lease-closed");
    await this.cleanup();
  }
}

interface RealmSlot {
  projectId: string;
  agentProfileId: string;
  jobId: string;
  storage: ProtectedAutomationBrowserRealmStorage;
  active: ProtectedAutomationBrowserRealmLease | null;
}

export class ProtectedAutomationBrowserRealmRegistry {
  private readonly realms = new Map<string, RealmSlot>();
  private readonly runtimeFactory: ProtectedAutomationRuntimeFactory;

  constructor(private readonly options: ProtectedAutomationBrowserRealmRegistryOptions) {
    this.runtimeFactory = options.runtimeFactory ?? ((runtimeOptions) => new ManagedChromiumRuntime(runtimeOptions));
  }

  acquire(request: ProtectedAutomationBrowserRealmAcquire): ProtectedAutomationBrowserRealmLease {
    const key = [request.projectId, request.agentProfileId, request.jobId].map((value) => idSegment("id", value)).join(":");
    let slot = this.realms.get(key);
    if (!slot) {
      slot = {
        projectId: request.projectId,
        agentProfileId: request.agentProfileId,
        jobId: request.jobId,
        storage: ensureProtectedAutomationBrowserRealmStorage(
          this.options.dataDir,
          request.projectCwd,
          request.projectId,
          request.agentProfileId,
          request.jobId,
        ),
        active: null,
      };
      this.realms.set(key, slot);
    }
    if (slot.active) throw realmError("Browser realm already has an exclusive run or preparation lease", 409);
    const lease = new ProtectedAutomationBrowserRealmLease(request, slot.storage, this.runtimeFactory, (released) => {
      if (slot!.active === released) slot!.active = null;
    });
    slot.active = lease;
    return lease;
  }

  /** Synchronous denial latch used immediately after durable policy publication. */
  denyWhere(predicate: (binding: Readonly<ProtectedAutomationBrowserLeaseBinding>) => boolean): number {
    let denied = 0;
    for (const slot of this.realms.values()) {
      if (slot.active && predicate(slot.active.binding)) {
        slot.active.deny("policy-changed");
        denied += 1;
      }
    }
    return denied;
  }

  hasActiveLease(projectId: string, agentProfileId: string, jobId: string): boolean {
    return [...this.realms.values()].some((slot) => slot.projectId === projectId
      && slot.agentProfileId === agentProfileId && slot.jobId === jobId && slot.active !== null);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.realms.values()].map((slot) => slot.active?.close()));
    this.realms.clear();
  }
}
