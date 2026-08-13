import { randomUUID } from "node:crypto";
import type { CdpConnection, ChromeTarget } from "./cdp.js";
import { InteractiveBrowserDownloadPublisher, type InteractiveBrowserDownloadState } from "./interactive-downloads.js";
import type { ManagedChromiumDownloadProgress, ManagedChromiumDownloadWillBegin } from "./manager.js";
import { isProtectedBrowserAllowedTopLevelUrl } from "./protected-browser.js";
import type { ProtectedBrowserBinding, ProtectedBrowserOperation } from "./types.js";
import type { BrowserProfileRow } from "./profile-catalog-store.js";
import type { BrowserProfileStorageDescriptor, BrowserStorageOpenerLease } from "./profile-storage-registry.js";

export const MAX_STANDARD_BROWSER_RUNNING_HOSTS = 3;
export const MAX_STANDARD_BROWSER_WORKSPACES_PER_HOST = 32;
export const MAX_STANDARD_BROWSER_TABS_PER_WORKSPACE = 16;
export const MAX_STANDARD_BROWSER_TARGETS_PER_HOST = 64;
export const MAX_STANDARD_BROWSER_UNASSIGNED_TARGETS = 8;
export const MAX_STANDARD_BROWSER_MUTATION_QUEUE = 32;
export const MAX_STANDARD_BROWSER_DOWNLOADS_PER_WORKSPACE = 4;
export const MAX_STANDARD_BROWSER_DOWNLOADS_PER_HOST = 16;
export const MAX_STANDARD_BROWSER_STAGED_BYTES_PER_HOST = 256 * 1024 * 1024;

function agentVisibleUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch { return ""; }
}

function redactUrlSecrets(value: string, rawUrl: string | undefined): string {
  if (!rawUrl) return value;
  let output = value.split(rawUrl).join(agentVisibleUrl(rawUrl) ?? "");
  try {
    const parsed = new URL(rawUrl);
    const secrets = [parsed.username, parsed.password, parsed.hash.slice(1), ...parsed.searchParams.values()]
      .filter((secret) => secret.length >= 3)
      .sort((left, right) => right.length - left.length);
    for (const secret of secrets) {
      output = output.split(secret).join("[REDACTED]");
      try { output = output.split(decodeURIComponent(secret)).join("[REDACTED]"); } catch { /* malformed encoding */ }
    }
  } catch { /* malformed URL already projects as empty */ }
  return output;
}

function agentVisibleTitle(value: string | undefined, rawUrl: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = redactUrlSecrets(value, rawUrl);
  return redacted.length > 512 ? `${redacted.slice(0, 512)}…` : redacted;
}

export interface StandardBrowserBackendTarget {
  id: string;
  openerId?: string;
  url?: string;
  title?: string;
}

export interface StandardBrowserHostBackendCallbacks {
  targetCreated(target: StandardBrowserBackendTarget): void;
  targetChanged(target: StandardBrowserBackendTarget): void;
  targetDestroyed(targetId: string): void;
  unexpectedExit(): void;
  downloadWillBegin(event: ManagedChromiumDownloadWillBegin, targetId: string | null): void;
  downloadProgress(event: ManagedChromiumDownloadProgress): void;
}

export interface StandardBrowserHostBackend {
  readonly running: boolean;
  readonly downloadStagingDir?: string;
  start(authorize: () => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  listTargets(): Promise<StandardBrowserBackendTarget[]>;
  createTarget(url: string): Promise<StandardBrowserBackendTarget>;
  closeTarget(targetId: string): Promise<void>;
  cancelDownload?(guid: string): Promise<void>;
  execute(targetId: string, operation: ProtectedBrowserOperation, authorize: () => Promise<void>): Promise<unknown>;
  attachViewer?(targetId: string): Promise<{ cdp: Pick<CdpConnection, "send" | "on" | "close">; target: ChromeTarget; close(): void }>;
}

export type StandardBrowserHostBackendFactory = (input: {
  profile: Readonly<BrowserProfileRow>;
  storage: Readonly<BrowserProfileStorageDescriptor>;
  callbacks: StandardBrowserHostBackendCallbacks;
}) => StandardBrowserHostBackend;

export interface StandardBrowserWorkspacePublicState {
  profileId: string;
  sourceSessionId: string;
  workspaceGeneration: string;
  controlGeneration: number;
  controlMode: "agent" | "user" | "paused";
  activeTab: string | null;
  tabs: Array<{ tab: string; title?: string; url?: string }>;
  running: boolean;
  updatedAt: number;
  download?: InteractiveBrowserDownloadState;
}

interface TargetRecord {
  rawId: string;
  handle: string;
  generation: string;
  title?: string;
  url?: string;
}

interface WorkspaceRecord {
  sourceSessionId: string;
  generation: string;
  controlGeneration: number;
  controlMode: "agent" | "user" | "paused";
  runtimeGeneration: string | null;
  targets: Map<string, TargetRecord>;
  activeTargetId: string | null;
  lastActivityAt: number;
  queueDepth: number;
  queueTail: Promise<void>;
  binding: ProtectedBrowserBinding;
  latestDownload?: InteractiveBrowserDownloadState;
  closed: boolean;
}

interface StandardDownloadOwner {
  sourceSessionId: string;
  workspaceGeneration: string;
  targetId: string;
  targetGeneration: string;
  binding: ProtectedBrowserBinding;
  publisher: InteractiveBrowserDownloadPublisher;
  reservedBytes: number;
}

export interface StandardBrowserHostAuthority {
  authorize(binding: Readonly<ProtectedBrowserBinding>, profile: Readonly<BrowserProfileRow>): boolean;
}

export class StandardBrowserProfileHost {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly targetOwners = new Map<string, string>();
  private readonly unassignedTargets = new Map<string, StandardBrowserBackendTarget>();
  private readonly downloads = new Map<string, StandardDownloadOwner>();
  private observedDownloadCount = 0;
  private backend: StandardBrowserHostBackend;
  private openerLease: BrowserStorageOpenerLease;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private startupReconciled = false;
  private closed = false;
  private emptySince: number | null = Date.now();

  constructor(
    readonly profile: Readonly<BrowserProfileRow>,
    readonly storage: Readonly<BrowserProfileStorageDescriptor>,
    openerLease: BrowserStorageOpenerLease,
    backendFactory: StandardBrowserHostBackendFactory,
    private readonly authority: StandardBrowserHostAuthority,
  ) {
    this.openerLease = openerLease;
    this.backend = backendFactory({
      profile,
      storage,
      callbacks: {
        targetCreated: (target) => this.onTargetCreated(target),
        targetChanged: (target) => this.onTargetChanged(target),
        targetDestroyed: (targetId) => this.onTargetDestroyed(targetId),
        unexpectedExit: () => this.onUnexpectedExit(),
        downloadWillBegin: (event, targetId) => this.onDownloadWillBegin(event, targetId),
        downloadProgress: (event) => this.onDownloadProgress(event),
      },
    });
  }

  get running(): boolean { return this.backend.running; }
  get workspaceCount(): number { return this.workspaces.size; }
  get isClosed(): boolean { return this.closed; }

  private assertAuthority(binding: Readonly<ProtectedBrowserBinding>): void {
    if (this.closed || !this.authority.authorize(binding, this.profile)) {
      throw new Error("Standard Browser Profile authority is unavailable");
    }
  }

  private async ensureStartedAuthorized(authorize: () => void | Promise<void>): Promise<void> {
    if (this.closed) throw new Error("Standard Browser Profile host is closed");
    await authorize();
    if (this.backend.running && this.startupReconciled) return;
    if (!this.startPromise) {
      this.startPromise = (async () => {
        await this.backend.start(async () => { await authorize(); });
        await authorize();
        if (!this.startupReconciled) {
          // Unknown/restored targets never acquire an owner by URL, visibility,
          // tab order, title, or profile state. Close before workspace attach.
          const restored = await this.backend.listTargets();
          for (const target of restored) await this.backend.closeTarget(target.id);
          this.unassignedTargets.clear();
          this.startupReconciled = true;
        }
      })().finally(() => { this.startPromise = null; });
    }
    await this.startPromise;
    await authorize();
  }

  private ensureStarted(binding: Readonly<ProtectedBrowserBinding>): Promise<void> {
    return this.ensureStartedAuthorized(() => this.assertAuthority(binding));
  }

  bindWorkspace(binding: Readonly<ProtectedBrowserBinding>): { generation: string; reused: boolean } {
    this.assertAuthority(binding);
    let workspace = this.workspaces.get(binding.sourceSessionId);
    if (workspace && !workspace.closed) {
      workspace.runtimeGeneration = binding.runtimeGeneration;
      workspace.binding = { ...binding };
      workspace.controlGeneration += 1;
      workspace.lastActivityAt = Date.now();
      return { generation: workspace.generation, reused: true };
    }
    if (this.workspaces.size >= MAX_STANDARD_BROWSER_WORKSPACES_PER_HOST) {
      throw new Error("Standard Browser Profile workspace limit reached");
    }
    workspace = {
      sourceSessionId: binding.sourceSessionId,
      generation: randomUUID(),
      controlGeneration: 1,
      controlMode: "agent",
      runtimeGeneration: binding.runtimeGeneration,
      targets: new Map(),
      activeTargetId: null,
      lastActivityAt: Date.now(),
      queueDepth: 0,
      queueTail: Promise.resolve(),
      binding: { ...binding },
      closed: false,
    };
    this.workspaces.set(binding.sourceSessionId, workspace);
    this.emptySince = null;
    return { generation: workspace.generation, reused: false };
  }

  private exactWorkspace(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string): WorkspaceRecord {
    this.assertAuthority(binding);
    const workspace = this.workspaces.get(binding.sourceSessionId);
    if (!workspace || workspace.closed || workspace.generation !== workspaceGeneration
      || workspace.runtimeGeneration !== binding.runtimeGeneration) {
      throw new Error("Standard browser workspace lease is stale");
    }
    return workspace;
  }

  private async queueWorkspace<T>(workspace: WorkspaceRecord, operation: () => Promise<T>): Promise<T> {
    if (workspace.queueDepth >= MAX_STANDARD_BROWSER_MUTATION_QUEUE) throw new Error("Standard browser workspace is busy");
    workspace.queueDepth += 1;
    const prior = workspace.queueTail;
    let release!: () => void;
    workspace.queueTail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await prior.catch(() => undefined);
      if (workspace.closed) throw new Error("Standard browser workspace is closed");
      return await operation();
    } finally {
      workspace.queueDepth -= 1;
      release();
    }
  }

  private adoptTarget(workspace: WorkspaceRecord, target: StandardBrowserBackendTarget): TargetRecord {
    if (workspace.targets.size >= MAX_STANDARD_BROWSER_TABS_PER_WORKSPACE
      || this.targetOwners.size >= MAX_STANDARD_BROWSER_TARGETS_PER_HOST) {
      throw new Error("Standard browser target limit reached");
    }
    const existingOwner = this.targetOwners.get(target.id);
    if (existingOwner && existingOwner !== workspace.sourceSessionId) throw new Error("Standard browser target already has another owner");
    const record: TargetRecord = {
      rawId: target.id,
      handle: randomUUID(),
      generation: randomUUID(),
      ...(target.title ? { title: target.title } : {}),
      ...(target.url ? { url: target.url } : {}),
    };
    workspace.targets.set(target.id, record);
    this.targetOwners.set(target.id, workspace.sourceSessionId);
    this.unassignedTargets.delete(target.id);
    workspace.activeTargetId ??= target.id;
    workspace.lastActivityAt = Date.now();
    return record;
  }

  private async ensureActiveTargetAuthorized(workspace: WorkspaceRecord, authorize: () => void | Promise<void>): Promise<TargetRecord> {
    await this.ensureStartedAuthorized(authorize);
    if (workspace.closed) throw new Error("Standard browser workspace is closed");
    if (workspace.activeTargetId) {
      const active = workspace.targets.get(workspace.activeTargetId);
      if (active) return active;
    }
    const target = await this.backend.createTarget("about:blank");
    await authorize();
    return this.adoptTarget(workspace, target);
  }

  private async ensureActiveTarget(binding: Readonly<ProtectedBrowserBinding>, workspace: WorkspaceRecord): Promise<TargetRecord> {
    await this.ensureStarted(binding);
    if (workspace.activeTargetId) {
      const active = workspace.targets.get(workspace.activeTargetId);
      if (active) return active;
    }
    const target = await this.backend.createTarget("about:blank");
    return this.adoptTarget(workspace, target);
  }

  private exactOwnerWorkspace(sourceSessionId: string, workspaceGeneration: string): WorkspaceRecord {
    if (this.closed) throw new Error("Standard Browser Profile host is closed");
    const workspace = this.workspaces.get(sourceSessionId);
    if (!workspace || workspace.closed || workspace.generation !== workspaceGeneration) {
      throw new Error("Standard browser owner workspace is stale");
    }
    return workspace;
  }

  ownerPublicState(sourceSessionId: string, workspaceGeneration: string): StandardBrowserWorkspacePublicState {
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    const tabs = [...workspace.targets.values()].map((target) => ({
      tab: target.handle,
      ...(agentVisibleTitle(target.title, target.url) ? { title: agentVisibleTitle(target.title, target.url) } : {}),
      ...(agentVisibleUrl(target.url) ? { url: agentVisibleUrl(target.url) } : {}),
    }));
    return {
      profileId: this.profile.id,
      sourceSessionId,
      workspaceGeneration,
      controlGeneration: workspace.controlGeneration,
      controlMode: workspace.controlMode,
      activeTab: workspace.activeTargetId ? workspace.targets.get(workspace.activeTargetId)?.handle ?? null : null,
      tabs,
      running: this.backend.running,
      updatedAt: workspace.lastActivityAt,
      ...(workspace.latestDownload ? { download: { ...workspace.latestDownload } } : {}),
    };
  }

  ownerSetControlMode(sourceSessionId: string, workspaceGeneration: string, mode: "user" | "paused"): void {
    this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    this.setControlMode(sourceSessionId, mode);
  }

  async ownerResumeAgent(sourceSessionId: string, workspaceGeneration: string): Promise<void> {
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    await this.cancelWorkspaceDownloads(sourceSessionId, workspaceGeneration);
    const targets = [...workspace.targets.keys()];
    workspace.targets.clear();
    workspace.activeTargetId = null;
    for (const targetId of targets) {
      this.targetOwners.delete(targetId);
      await this.backend.closeTarget(targetId).catch(() => undefined);
    }
    workspace.controlMode = "agent";
    workspace.controlGeneration += 1;
    workspace.lastActivityAt = Date.now();
  }

  async ownerStart(sourceSessionId: string, workspaceGeneration: string, authorize: () => void | Promise<void>): Promise<void> {
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    await this.ensureActiveTargetAuthorized(workspace, authorize);
    this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration).lastActivityAt = Date.now();
  }

  async ownerExecute(
    sourceSessionId: string,
    workspaceGeneration: string,
    operation: ProtectedBrowserOperation,
    authorize: () => void | Promise<void>,
  ): Promise<unknown> {
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    return this.queueWorkspace(workspace, async () => {
      await authorize();
      if (operation.kind === "status") return this.ownerPublicState(sourceSessionId, workspaceGeneration);
      if (operation.kind === "start") {
        await this.ensureActiveTargetAuthorized(workspace, authorize);
        return this.ownerPublicState(sourceSessionId, workspaceGeneration);
      }
      if (operation.kind === "stop") {
        await this.closeWorkspace(sourceSessionId, "owner_stop");
        return { closed: true, profileId: this.profile.id };
      }
      if (workspace.controlMode === "agent") throw new Error("Standard browser owner operation requires human control");
      const target = await this.ensureActiveTargetAuthorized(workspace, authorize);
      const value = await this.backend.execute(target.rawId, operation, async () => { await authorize(); });
      await authorize();
      this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration).lastActivityAt = Date.now();
      return value;
    });
  }

  async ownerListTabs(sourceSessionId: string, workspaceGeneration: string, authorize: () => void | Promise<void>): Promise<StandardBrowserWorkspacePublicState> {
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    await this.ensureActiveTargetAuthorized(workspace, authorize);
    return this.ownerPublicState(sourceSessionId, workspaceGeneration);
  }

  async ownerOpenTab(sourceSessionId: string, workspaceGeneration: string, url: string, authorize: () => void | Promise<void>): Promise<StandardBrowserWorkspacePublicState> {
    if (url !== "about:blank" && !isProtectedBrowserAllowedTopLevelUrl(url)) throw new Error("Standard browser tab requires an absolute HTTPS URL");
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    return this.queueWorkspace(workspace, async () => {
      if (workspace.controlMode === "agent") throw new Error("Standard browser tab changes require human control");
      await this.ensureStartedAuthorized(authorize);
      const target = await this.backend.createTarget(url);
      await authorize();
      const record = this.adoptTarget(workspace, target);
      workspace.activeTargetId = record.rawId;
      return this.ownerPublicState(sourceSessionId, workspaceGeneration);
    });
  }

  async ownerSelectTab(sourceSessionId: string, workspaceGeneration: string, handle: string): Promise<StandardBrowserWorkspacePublicState> {
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    return this.queueWorkspace(workspace, async () => {
      if (workspace.controlMode === "agent") throw new Error("Standard browser tab changes require human control");
      const target = [...workspace.targets.values()].find((candidate) => candidate.handle === handle);
      if (!target) throw new Error("Standard browser tab choice is stale");
      workspace.activeTargetId = target.rawId;
      workspace.lastActivityAt = Date.now();
      return this.ownerPublicState(sourceSessionId, workspaceGeneration);
    });
  }

  async ownerCloseTab(sourceSessionId: string, workspaceGeneration: string, handle: string): Promise<StandardBrowserWorkspacePublicState> {
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    return this.queueWorkspace(workspace, async () => {
      if (workspace.controlMode === "agent") throw new Error("Standard browser tab changes require human control");
      const target = [...workspace.targets.values()].find((candidate) => candidate.handle === handle);
      if (!target) throw new Error("Standard browser tab choice is stale");
      this.targetOwners.delete(target.rawId);
      workspace.targets.delete(target.rawId);
      await this.backend.closeTarget(target.rawId);
      if (workspace.activeTargetId === target.rawId) workspace.activeTargetId = workspace.targets.keys().next().value ?? null;
      return this.ownerPublicState(sourceSessionId, workspaceGeneration);
    });
  }

  async ownerAttachActiveViewer(
    sourceSessionId: string,
    workspaceGeneration: string,
    authorize: () => void | Promise<void>,
  ): Promise<{ cdp: Pick<CdpConnection, "send" | "on" | "close">; target: ChromeTarget; close(): void }> {
    const workspace = this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    if (workspace.controlMode === "agent") throw new Error("Standard browser viewer requires human control");
    const target = await this.ensureActiveTargetAuthorized(workspace, authorize);
    if (!this.backend.attachViewer) throw new Error("Standard browser viewer transport is unavailable");
    const attachment = await this.backend.attachViewer(target.rawId);
    await authorize();
    this.exactOwnerWorkspace(sourceSessionId, workspaceGeneration);
    return attachment;
  }

  private onTargetCreated(target: StandardBrowserBackendTarget): void {
    if (target.openerId) {
      const sourceSessionId = this.targetOwners.get(target.openerId);
      const workspace = sourceSessionId ? this.workspaces.get(sourceSessionId) : undefined;
      if (workspace && !workspace.closed) {
        try { this.adoptTarget(workspace, target); return; }
        catch { void this.backend.closeTarget(target.id).catch(() => undefined); return; }
      }
    }
    if (this.unassignedTargets.size >= MAX_STANDARD_BROWSER_UNASSIGNED_TARGETS) {
      void this.backend.closeTarget(target.id).catch(() => undefined);
      return;
    }
    this.unassignedTargets.set(target.id, { ...target });
  }

  private onTargetChanged(target: StandardBrowserBackendTarget): void {
    const owner = this.targetOwners.get(target.id);
    const workspace = owner ? this.workspaces.get(owner) : undefined;
    const record = workspace?.targets.get(target.id);
    if (record) {
      record.title = target.title;
      record.url = target.url;
      workspace!.lastActivityAt = Date.now();
    } else if (this.unassignedTargets.has(target.id)) {
      this.unassignedTargets.set(target.id, { ...target });
    }
  }

  private onTargetDestroyed(targetId: string): void {
    const owner = this.targetOwners.get(targetId);
    this.targetOwners.delete(targetId);
    this.unassignedTargets.delete(targetId);
    if (!owner) return;
    const workspace = this.workspaces.get(owner);
    if (!workspace) return;
    workspace.targets.delete(targetId);
    if (workspace.activeTargetId === targetId) workspace.activeTargetId = workspace.targets.keys().next().value ?? null;
    workspace.lastActivityAt = Date.now();
  }

  private cancelDownload(guid: string): void {
    void this.backend.cancelDownload?.(guid).catch(() => undefined);
  }

  private onDownloadWillBegin(event: ManagedChromiumDownloadWillBegin, targetId: string | null): void {
    const sourceSessionId = targetId ? this.targetOwners.get(targetId) : undefined;
    const workspace = sourceSessionId ? this.workspaces.get(sourceSessionId) : undefined;
    const workspaceDownloadCount = sourceSessionId
      ? [...this.downloads.values()].filter((owner) => owner.sourceSessionId === sourceSessionId).length
      : 0;
    const target = targetId && workspace ? workspace.targets.get(targetId) : undefined;
    if (!sourceSessionId || !targetId || !workspace || workspace.closed || !target || !this.backend.downloadStagingDir
      || workspace.runtimeGeneration !== workspace.binding.runtimeGeneration
      || workspaceDownloadCount >= MAX_STANDARD_BROWSER_DOWNLOADS_PER_WORKSPACE
      || this.downloads.size >= MAX_STANDARD_BROWSER_DOWNLOADS_PER_HOST
      || this.observedDownloadCount >= 32) {
      this.cancelDownload(event.guid);
      return;
    }
    this.observedDownloadCount += 1;
    let publisher: InteractiveBrowserDownloadPublisher;
    try {
      publisher = new InteractiveBrowserDownloadPublisher(this.backend.downloadStagingDir, workspace.binding.projectCwd, { cleanStaging: false });
    } catch {
      this.cancelDownload(event.guid);
      return;
    }
    const decision = publisher.begin(event);
    workspace.latestDownload = publisher.latest;
    workspace.lastActivityAt = Date.now();
    if (!decision.accepted) {
      this.cancelDownload(event.guid);
      return;
    }
    this.downloads.set(event.guid, {
      sourceSessionId,
      workspaceGeneration: workspace.generation,
      targetId,
      targetGeneration: target.generation,
      binding: { ...workspace.binding },
      publisher,
      reservedBytes: 0,
    });
  }

  private onDownloadProgress(event: ManagedChromiumDownloadProgress): void {
    const owner = this.downloads.get(event.guid);
    if (!owner) { if (event.state === "inProgress") this.cancelDownload(event.guid); return; }
    const reservedBytes = Number.isSafeInteger(event.receivedBytes) && event.receivedBytes >= 0 ? event.receivedBytes : 0;
    const otherReserved = [...this.downloads.values()].reduce((total, candidate) => candidate === owner ? total : total + candidate.reservedBytes, 0);
    if (otherReserved + reservedBytes > MAX_STANDARD_BROWSER_STAGED_BYTES_PER_HOST) {
      this.cancelDownload(event.guid);
      owner.publisher.revoke();
      this.downloads.delete(event.guid);
      return;
    }
    owner.reservedBytes = reservedBytes;
    const authorize = async () => {
      const workspace = this.exactWorkspace(owner.binding, owner.workspaceGeneration);
      const target = workspace.targets.get(owner.targetId);
      if (!target || target.generation !== owner.targetGeneration || this.targetOwners.get(owner.targetId) !== owner.sourceSessionId) {
        throw new Error("Standard browser download owner changed");
      }
    };
    void owner.publisher.progress(event, authorize).then((result) => {
      const workspace = this.workspaces.get(owner.sourceSessionId);
      if (workspace?.generation === owner.workspaceGeneration) {
        workspace.latestDownload = result.state;
        workspace.lastActivityAt = Date.now();
      }
      if (result.cancel) this.cancelDownload(event.guid);
      if (event.state !== "inProgress") this.downloads.delete(event.guid);
    }).catch(() => {
      this.cancelDownload(event.guid);
      this.downloads.delete(event.guid);
    });
  }

  private onUnexpectedExit(): void {
    this.startupReconciled = false;
    for (const workspace of this.workspaces.values()) {
      workspace.targets.clear();
      workspace.activeTargetId = null;
      workspace.controlGeneration += 1;
    }
    this.targetOwners.clear();
    this.unassignedTargets.clear();
    for (const owner of this.downloads.values()) owner.publisher.revoke();
    this.downloads.clear();
  }

  publicState(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string): StandardBrowserWorkspacePublicState {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    const tabs = workspace.controlMode === "agent" ? [...workspace.targets.values()].map((target) => ({
      tab: target.handle,
      ...(agentVisibleTitle(target.title, target.url) ? { title: agentVisibleTitle(target.title, target.url) } : {}),
      ...(agentVisibleUrl(target.url) ? { url: agentVisibleUrl(target.url) } : {}),
    })) : [];
    return {
      profileId: this.profile.id,
      sourceSessionId: workspace.sourceSessionId,
      workspaceGeneration: workspace.generation,
      controlGeneration: workspace.controlGeneration,
      controlMode: workspace.controlMode,
      activeTab: workspace.controlMode === "agent" && workspace.activeTargetId ? workspace.targets.get(workspace.activeTargetId)?.handle ?? null : null,
      tabs,
      running: this.backend.running,
      updatedAt: workspace.lastActivityAt,
      ...(workspace.latestDownload ? { download: { ...workspace.latestDownload } } : {}),
    };
  }

  async execute(
    binding: Readonly<ProtectedBrowserBinding>,
    workspaceGeneration: string,
    operation: ProtectedBrowserOperation,
  ): Promise<unknown> {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    const capturedControlGeneration = workspace.controlGeneration;
    return this.queueWorkspace(workspace, async () => {
      this.assertAuthority(binding);
      const assertAgentControl = () => {
        const current = this.exactWorkspace(binding, workspaceGeneration);
        if (current.controlMode !== "agent" || current.controlGeneration !== capturedControlGeneration) {
          throw new Error("Standard browser workspace control changed");
        }
      };
      if (operation.kind !== "status") assertAgentControl();
      if (operation.kind === "status") return this.publicState(binding, workspaceGeneration);
      if (operation.kind === "start") {
        await this.ensureActiveTarget(binding, workspace);
        return this.publicState(binding, workspaceGeneration);
      }
      if (operation.kind === "stop") {
        await this.closeWorkspace(binding.sourceSessionId, "tool");
        return { closed: true, profileId: this.profile.id };
      }
      const target = await this.ensureActiveTarget(binding, workspace);
      const value = await this.backend.execute(target.rawId, operation, async () => {
        assertAgentControl();
      });
      assertAgentControl();
      workspace.lastActivityAt = Date.now();
      return value;
    });
  }

  async attachActiveViewer(
    binding: Readonly<ProtectedBrowserBinding>,
    workspaceGeneration: string,
  ): Promise<{ cdp: Pick<CdpConnection, "send" | "on" | "close">; target: ChromeTarget; close(): void }> {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    if (workspace.controlMode === "agent") throw new Error("Standard browser viewer requires human control");
    const target = await this.ensureActiveTarget(binding, workspace);
    if (!this.backend.attachViewer) throw new Error("Standard browser viewer transport is unavailable");
    const attachment = await this.backend.attachViewer(target.rawId);
    this.exactWorkspace(binding, workspaceGeneration);
    return attachment;
  }

  async listTabs(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string): Promise<StandardBrowserWorkspacePublicState> {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    const controlGeneration = workspace.controlGeneration;
    const assertControl = () => {
      const current = this.exactWorkspace(binding, workspaceGeneration);
      if (current.controlMode !== "agent" || current.controlGeneration !== controlGeneration) throw new Error("Standard browser workspace control changed");
    };
    assertControl();
    await this.ensureActiveTarget(binding, workspace);
    assertControl();
    return this.publicState(binding, workspaceGeneration);
  }

  async openTab(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string, url = "about:blank"): Promise<StandardBrowserWorkspacePublicState> {
    if (url !== "about:blank" && !isProtectedBrowserAllowedTopLevelUrl(url)) throw new Error("Standard browser tab requires an absolute HTTPS URL");
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    const controlGeneration = workspace.controlGeneration;
    const assertControl = () => {
      const current = this.exactWorkspace(binding, workspaceGeneration);
      if (current.controlMode !== "agent" || current.controlGeneration !== controlGeneration) throw new Error("Standard browser workspace control changed");
    };
    assertControl();
    return this.queueWorkspace(workspace, async () => {
      assertControl();
      await this.ensureStarted(binding);
      assertControl();
      const target = await this.backend.createTarget(url);
      try { assertControl(); }
      catch (error) { await this.backend.closeTarget(target.id).catch(() => undefined); throw error; }
      const record = this.adoptTarget(workspace, target);
      workspace.activeTargetId = record.rawId;
      return this.publicState(binding, workspaceGeneration);
    });
  }

  selectTab(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string, handle: string): StandardBrowserWorkspacePublicState {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    if (workspace.controlMode !== "agent") throw new Error("Standard browser workspace is under human control");
    const target = [...workspace.targets.values()].find((candidate) => candidate.handle === handle);
    if (!target) throw new Error("Standard browser tab choice is stale");
    workspace.activeTargetId = target.rawId;
    workspace.lastActivityAt = Date.now();
    return this.publicState(binding, workspaceGeneration);
  }

  async closeTab(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string, handle: string): Promise<StandardBrowserWorkspacePublicState | null> {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    const controlGeneration = workspace.controlGeneration;
    const assertControl = () => {
      const current = this.exactWorkspace(binding, workspaceGeneration);
      if (current.controlMode !== "agent" || current.controlGeneration !== controlGeneration) throw new Error("Standard browser workspace control changed");
    };
    assertControl();
    const target = [...workspace.targets.values()].find((candidate) => candidate.handle === handle);
    if (!target) throw new Error("Standard browser tab choice is stale");
    await this.backend.closeTarget(target.rawId);
    assertControl();
    this.onTargetDestroyed(target.rawId);
    if (workspace.targets.size === 0) {
      await this.closeWorkspace(binding.sourceSessionId, "final_tab");
      return null;
    }
    return this.publicState(binding, workspaceGeneration);
  }

  setControlMode(sourceSessionId: string, mode: "agent" | "user" | "paused"): void {
    const workspace = this.workspaces.get(sourceSessionId);
    if (!workspace || workspace.closed) throw new Error("Standard browser workspace is unavailable");
    workspace.controlMode = mode;
    workspace.controlGeneration += 1;
    workspace.lastActivityAt = Date.now();
  }

  hasBlockingControl(sourceSessionId: string): boolean {
    const workspace = this.workspaces.get(sourceSessionId);
    return Boolean(workspace && !workspace.closed && workspace.controlMode !== "agent");
  }

  async detachAgentLease(sourceSessionId: string, runtimeGeneration: string): Promise<void> {
    const workspace = this.workspaces.get(sourceSessionId);
    if (!workspace || workspace.runtimeGeneration !== runtimeGeneration) return;
    workspace.runtimeGeneration = null;
    workspace.controlGeneration += 1;
    workspace.lastActivityAt = Date.now();
    await this.cancelWorkspaceDownloads(sourceSessionId, workspace.generation);
  }

  idleWorkspaceSessionIds(now: number, idleMs: number): string[] {
    return [...this.workspaces.values()]
      .filter((workspace) => !workspace.closed && workspace.controlMode === "agent"
        && workspace.queueDepth === 0 && now - workspace.lastActivityAt >= idleMs)
      .map((workspace) => workspace.sourceSessionId);
  }

  emptySinceTimestamp(): number | null {
    return this.workspaces.size === 0 ? this.emptySince : null;
  }

  private async cancelWorkspaceDownloads(sourceSessionId: string, workspaceGeneration: string): Promise<void> {
    const owned = [...this.downloads.entries()].filter(([, owner]) => owner.sourceSessionId === sourceSessionId
      && owner.workspaceGeneration === workspaceGeneration);
    for (const [guid, owner] of owned) {
      owner.publisher.revoke();
      this.downloads.delete(guid);
      await this.backend.cancelDownload?.(guid).catch(() => undefined);
    }
  }

  async closeWorkspace(sourceSessionId: string, _reason: string, closedAt = Date.now()): Promise<void> {
    const workspace = this.workspaces.get(sourceSessionId);
    if (!workspace || workspace.closed) return;
    workspace.closed = true;
    workspace.runtimeGeneration = null;
    workspace.controlGeneration += 1;
    await this.cancelWorkspaceDownloads(sourceSessionId, workspace.generation);
    const targets = [...workspace.targets.keys()];
    workspace.targets.clear();
    workspace.activeTargetId = null;
    this.workspaces.delete(sourceSessionId);
    if (this.workspaces.size === 0) this.emptySince = closedAt;
    for (const targetId of targets) {
      this.targetOwners.delete(targetId);
      await this.backend.closeTarget(targetId).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sourceSessionId of [...this.workspaces.keys()]) await this.closeWorkspace(sourceSessionId, "host_close");
    if (!this.stopPromise) this.stopPromise = this.backend.stop().finally(() => { this.stopPromise = null; });
    await this.stopPromise;
    this.openerLease.release();
  }
}
