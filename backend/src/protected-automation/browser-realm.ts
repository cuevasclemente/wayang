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

export interface ProtectedAutomationBrowserProfileState {
  saved: boolean;
  lastSavedAt: number | null;
}

const PREPARATION_STATE_FILE = "preparation-state.json";
const PROJECT_SEGMENT_PATTERN = /^project-[A-Za-z0-9_-]{43}$/u;
const PROFILE_SEGMENT_PATTERN = /^profile-[A-Za-z0-9_-]{43}$/u;
const JOB_SEGMENT_PATTERN = /^job-[A-Za-z0-9_-]{43}$/u;
const STAGED_PURGE_PATTERN = /^(job-[A-Za-z0-9_-]{43})\.purge-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  /** Receives bounded reason codes only; never bindings, URLs, paths, or identities. */
  onDiagnostic?: (event: { component: "browser-realm"; code: string }) => void;
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

function validateBrowserRealmTree(root: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const visit = (target: string): void => {
    const metadata = fs.lstatSync(target);
    if (uid !== undefined && metadata.uid !== uid) throw realmError("Protected automation browser purge artifact has the wrong owner");
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      if ((metadata.mode & 0o077) !== 0) throw realmError("Protected automation browser purge artifact is not private");
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) throw realmError("Protected automation browser purge artifact is unsafe");
  };
  visit(root);
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch { /* directory fsync is not available on every supported host */ }
}

export function reconcileProtectedAutomationBrowserRealmPurges(
  dataDir: string,
  durableJobs: readonly { id: string; project_id: string; agent_profile_id: string }[],
): void {
  const realmsRoot = path.join(path.resolve(dataDir), "protected-automation", "browser-realms", "v1");
  let rootMetadata: fs.Stats;
  try { rootMetadata = fs.lstatSync(realmsRoot); }
  catch (failure: any) { if (failure?.code === "ENOENT") return; throw failure; }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && rootMetadata.uid !== process.getuid())) {
    throw realmError("Protected automation browser realm root is unsafe");
  }
  const durableRoots = new Set(durableJobs.map((job) => protectedAutomationBrowserRealmRoot(
    dataDir, job.project_id, job.agent_profile_id, job.id,
  )));
  for (const projectName of fs.readdirSync(realmsRoot).sort()) {
    if (!PROJECT_SEGMENT_PATTERN.test(projectName)) throw realmError("Protected automation browser project storage is invalid");
    const projectRoot = path.join(realmsRoot, projectName);
    privateDirectory(projectRoot);
    for (const profileName of fs.readdirSync(projectRoot).sort()) {
      if (!PROFILE_SEGMENT_PATTERN.test(profileName)) throw realmError("Protected automation browser profile storage is invalid");
      const profileRoot = path.join(projectRoot, profileName);
      privateDirectory(profileRoot);
      for (const entry of fs.readdirSync(profileRoot).sort()) {
        const staged = STAGED_PURGE_PATTERN.exec(entry);
        if (!staged) {
          if (!JOB_SEGMENT_PATTERN.test(entry)) throw realmError("Protected automation browser job storage is invalid");
          privateDirectory(path.join(profileRoot, entry));
          continue;
        }
        const stagedRoot = path.join(profileRoot, entry);
        const canonicalRoot = path.join(profileRoot, staged[1]!);
        validateBrowserRealmTree(stagedRoot);
        if (durableRoots.has(canonicalRoot)) {
          if (fs.existsSync(canonicalRoot)) throw realmError("Staged browser purge conflicts with durable storage");
          fs.renameSync(stagedRoot, canonicalRoot);
        } else {
          fs.rmSync(stagedRoot, { recursive: true, force: false });
          if (fs.existsSync(stagedRoot)) throw realmError("Committed browser purge could not be removed");
        }
        syncDirectory(profileRoot);
      }
    }
  }
}

export function readProtectedAutomationBrowserProfileState(
  dataDir: string,
  projectId: string,
  agentProfileId: string,
  jobId: string,
): ProtectedAutomationBrowserProfileState {
  const rootDir = protectedAutomationBrowserRealmRoot(dataDir, projectId, agentProfileId, jobId);
  let rootMetadata: fs.Stats;
  try { rootMetadata = fs.lstatSync(rootDir); }
  catch (error: any) {
    if (error?.code === "ENOENT") return { saved: false, lastSavedAt: null };
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || (typeof process.getuid === "function" && rootMetadata.uid !== process.getuid())) {
    throw realmError("Protected automation browser preparation storage is unsafe");
  }
  const statePath = path.join(rootDir, PREPARATION_STATE_FILE);
  let metadata: fs.Stats;
  try { metadata = fs.lstatSync(statePath); }
  catch (error: any) {
    if (error?.code === "ENOENT") return { saved: false, lastSavedAt: null };
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 2 || metadata.size > 1_024 || (metadata.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw realmError("Protected automation browser preparation state is unsafe");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { throw realmError("Protected automation browser preparation state is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).sort().join("\0") !== "last_saved_at\0version"
    || (parsed as any).version !== 1
    || !Number.isSafeInteger((parsed as any).last_saved_at) || (parsed as any).last_saved_at < 0) {
    throw realmError("Protected automation browser preparation state is invalid");
  }
  return { saved: true, lastSavedAt: (parsed as any).last_saved_at };
}

function writeProtectedAutomationBrowserProfileState(
  storage: ProtectedAutomationBrowserRealmStorage,
  lastSavedAt: number,
): void {
  if (!Number.isSafeInteger(lastSavedAt) || lastSavedAt < 0) throw realmError("Preparation save timestamp is invalid", 400);
  const statePath = path.join(storage.rootDir, PREPARATION_STATE_FILE);
  const temporary = path.join(storage.rootDir, `.preparation-state-${randomBytes(12).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, last_saved_at: lastSavedAt })}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, statePath);
    try {
      const directory = fs.openSync(storage.rootDir, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch { /* directory fsync is not portable; the file rename remains atomic */ }
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
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
  private cleanupFailure: Error | null = null;
  private releaseAfterCleanup = true;
  private released = false;
  private pendingDownloadsAtDenial: string[] = [];
  private removeAbortListener: (() => void) | undefined;
  private navigationGatePromise: Promise<void> | null = null;
  private navigationGateAttachment: { cdp: CdpConnection; target: ChromeTarget; close(): void } | null = null;
  private navigationGateListeners: Array<() => void> = [];
  private readonly targetClosurePromises = new Set<Promise<void>>();
  private readonly navigationChains = new Map<string, string>();
  private navigationRequestBlock: Promise<void> = Promise.resolve();
  private mainFrameId: string | null = null;

  constructor(
    request: ProtectedAutomationBrowserRealmAcquire,
    storage: ProtectedAutomationBrowserRealmStorage,
    runtimeFactory: ProtectedAutomationRuntimeFactory,
    private readonly releaseActive: (lease: ProtectedAutomationBrowserRealmLease) => void,
    private readonly diagnostic: (code: string) => void,
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
        await this.assertAuthorized();
        const snapshot = await cdp.send<any>("Target.getTargets");
        if (!Array.isArray(snapshot?.targetInfos)) throw realmError("Browser target snapshot is unavailable");
        const initialBlankTargetIds = new Set<string>();
        for (const info of snapshot.targetInfos) {
          if (info?.type !== "page" || info.targetId === target.id) continue;
          if (typeof info.targetId !== "string" || !info.targetId || info.targetId.length > 256
            || /[\u0000-\u001f\u007f]/u.test(info.targetId)) {
            throw realmError("Browser target snapshot is malformed");
          }
          if (info.url !== "about:blank") throw realmError("Browser target snapshot contains an active extra page");
          initialBlankTargetIds.add(info.targetId);
        }
        const targetClosures = new Map<string, Promise<void>>();
        const closeUnexpectedPage = (info: any) => {
          if (info?.type !== "page" || info.targetId === target.id) return;
          const targetId = info?.targetId;
          if (typeof targetId !== "string" || !targetId || targetId.length > 256
            || /[\u0000-\u001f\u007f]/u.test(targetId)) {
            this.deny("malformed-page-target");
            return;
          }
          const isUnchangedInitialBlank = initialBlankTargetIds.has(targetId) && info.url === "about:blank";
          if (!targetClosures.has(targetId)) {
            const closure = (isUnchangedInitialBlank ? this.assertAuthorized() : Promise.resolve())
              .then(() => cdp.send<any>("Target.closeTarget", { targetId }))
              .then((result) => {
                if (result?.success === false) throw realmError("Browser page target did not close");
              })
              .catch(() => this.deny(isUnchangedInitialBlank
                ? "initial-page-target-close-failed"
                : "unexpected-page-target-close-failed"));
            targetClosures.set(targetId, closure);
            this.targetClosurePromises.add(closure);
            void closure.then(
              () => this.targetClosurePromises.delete(closure),
              () => this.targetClosurePromises.delete(closure),
            );
          }
          if (!isUnchangedInitialBlank) this.deny("unexpected-page-target");
        };
        this.navigationGateListeners.push(cdp.on("Target.targetCreated", (event: any) => closeUnexpectedPage(event?.targetInfo)));
        this.navigationGateListeners.push(cdp.on("Target.targetInfoChanged", (event: any) => closeUnexpectedPage(event?.targetInfo)));
        // Pause newly-created related targets before their first request. Only
        // immutable-snapshot about:blank extras may be normalized; every target
        // created or changed afterward denial-latches the realm before closure.
        this.navigationGateListeners.push(cdp.on("Target.attachedToTarget", (event: any) => {
          closeUnexpectedPage(event?.targetInfo);
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
        await cdp.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "page", exclude: false }],
        });
        for (const targetId of initialBlankTargetIds) {
          closeUnexpectedPage({ type: "page", targetId, url: "about:blank" });
        }
        await this.assertAuthorized();
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        await Promise.all([...initialBlankTargetIds].map((targetId) => targetClosures.get(targetId)).filter(Boolean));
        await this.assertAuthorized();
        // Target.closeTarget acknowledgement can precede target destruction,
        // especially on macOS CI. Re-attest the target set until Chromium
        // publishes the closure, but keep startup bounded and authority-checked.
        const normalizationDeadline = Date.now() + 5_000;
        while (true) {
          const verifiedTargets = await cdp.send<any>("Target.getTargets");
          if (Array.isArray(verifiedTargets?.targetInfos)
            && !verifiedTargets.targetInfos.some((info: any) => info?.type === "page" && info.targetId !== target.id)) break;
          if (Date.now() >= normalizationDeadline) throw realmError("Browser target normalization did not settle");
          await new Promise((resolve) => setTimeout(resolve, 25));
          await this.assertAuthorized();
        }
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

  private latchDenial(reason: string): boolean {
    if (this.revoked) return false;
    const code = /^[a-z0-9-]{1,64}$/u.test(reason) ? reason : "unclassified";
    this.diagnostic(code);
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
      const targetContainment = Promise.allSettled([...this.targetClosurePromises]);
      const downloadCancellations = pendingDownloads.map((guid) => this.runtime.cancelDownload(guid));
      // Chromium termination is the containment fallback if a target-close
      // acknowledgement stalls. Managed runtime stop is itself bounded.
      const runtimeStop = this.runtime.stop().then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const }),
      );
      await Promise.race([targetContainment, runtimeStop]);
      for (const remove of this.navigationGateListeners.splice(0)) remove();
      this.navigationChains.clear();
      this.mainFrameId = null;
      const navigationGateAttachment = this.navigationGateAttachment;
      this.navigationGateAttachment = null;
      navigationGateAttachment?.close();
      await Promise.allSettled([
        targetContainment,
        ...viewers.map((viewer) => Promise.resolve().then(() => viewer.close())),
        ...downloadCancellations,
        runtimeStop,
        this.queueTail.catch(() => undefined),
      ]);
      if (!(await runtimeStop).ok) this.cleanupFailure = realmError("Managed Chromium did not stop cleanly", 503);
      if (this.releaseAfterCleanup) this.releaseLease();
    })();
    return this.cleanupPromise;
  }

  private releaseLease(): void {
    if (this.released) return;
    this.released = true;
    this.releaseActive(this);
  }

  async close(): Promise<void> {
    this.deny("lease-closed");
    await this.cleanup();
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  async saveAndClosePreparation(lastSavedAt: number): Promise<void> {
    if (this.binding.kind !== "prepare") throw realmError("Only preparation leases may save browser profile state", 409);
    await this.assertAuthorized();
    if (!this.latchDenial("lease-closed")) throw realmError("Browser preparation is already closing", 409);
    this.releaseAfterCleanup = false;
    try {
      await this.cleanup();
      if (this.cleanupFailure) throw this.cleanupFailure;
      try { await this.authority(this.binding); }
      catch { throw realmError("Browser preparation authority changed before save", 409); }
      writeProtectedAutomationBrowserProfileState(this.storage, lastSavedAt);
    } finally {
      this.releaseLease();
    }
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
  private readonly diagnostic: (event: { component: "browser-realm"; code: string }) => void;

  constructor(private readonly options: ProtectedAutomationBrowserRealmRegistryOptions) {
    this.runtimeFactory = options.runtimeFactory ?? ((runtimeOptions) => new ManagedChromiumRuntime(runtimeOptions));
    this.diagnostic = options.onDiagnostic ?? ((event) => {
      if (event.code === "lease-closed") return;
      console.warn(`[protected-automation] component=${event.component} code=${event.code}`);
    });
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
    }, (code) => this.diagnostic({ component: "browser-realm", code }));
    slot.active = lease;
    return lease;
  }

  profileState(projectId: string, agentProfileId: string, jobId: string): ProtectedAutomationBrowserProfileState {
    return readProtectedAutomationBrowserProfileState(this.options.dataDir, projectId, agentProfileId, jobId);
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
