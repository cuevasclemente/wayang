import { randomUUID } from "node:crypto";
import type { ProtectedBrowserBinding, ProtectedBrowserOperation } from "./types.js";
import type { BrowserProfileRow } from "./profile-catalog-store.js";
import type { BrowserProfileStorageDescriptor, BrowserStorageOpenerLease } from "./profile-storage-registry.js";

export const MAX_STANDARD_BROWSER_RUNNING_HOSTS = 3;
export const MAX_STANDARD_BROWSER_WORKSPACES_PER_HOST = 32;
export const MAX_STANDARD_BROWSER_TABS_PER_WORKSPACE = 16;
export const MAX_STANDARD_BROWSER_TARGETS_PER_HOST = 64;
export const MAX_STANDARD_BROWSER_UNASSIGNED_TARGETS = 8;
export const MAX_STANDARD_BROWSER_MUTATION_QUEUE = 32;

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
}

export interface StandardBrowserHostBackend {
  readonly running: boolean;
  start(authorize: () => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  listTargets(): Promise<StandardBrowserBackendTarget[]>;
  createTarget(url: string): Promise<StandardBrowserBackendTarget>;
  closeTarget(targetId: string): Promise<void>;
  execute(targetId: string, operation: ProtectedBrowserOperation, authorize: () => Promise<void>): Promise<unknown>;
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
  closed: boolean;
}

export interface StandardBrowserHostAuthority {
  authorize(binding: Readonly<ProtectedBrowserBinding>, profile: Readonly<BrowserProfileRow>): boolean;
}

export class StandardBrowserProfileHost {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly targetOwners = new Map<string, string>();
  private readonly unassignedTargets = new Map<string, StandardBrowserBackendTarget>();
  private backend: StandardBrowserHostBackend;
  private openerLease: BrowserStorageOpenerLease;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private startupReconciled = false;
  private closed = false;

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

  private async ensureStarted(binding: Readonly<ProtectedBrowserBinding>): Promise<void> {
    this.assertAuthority(binding);
    if (this.backend.running && this.startupReconciled) return;
    if (!this.startPromise) {
      this.startPromise = (async () => {
        await this.backend.start(async () => this.assertAuthority(binding));
        this.assertAuthority(binding);
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
    this.assertAuthority(binding);
  }

  bindWorkspace(binding: Readonly<ProtectedBrowserBinding>): { generation: string; reused: boolean } {
    this.assertAuthority(binding);
    let workspace = this.workspaces.get(binding.sourceSessionId);
    if (workspace && !workspace.closed) {
      workspace.runtimeGeneration = binding.runtimeGeneration;
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
      closed: false,
    };
    this.workspaces.set(binding.sourceSessionId, workspace);
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

  private async ensureActiveTarget(binding: Readonly<ProtectedBrowserBinding>, workspace: WorkspaceRecord): Promise<TargetRecord> {
    await this.ensureStarted(binding);
    if (workspace.activeTargetId) {
      const active = workspace.targets.get(workspace.activeTargetId);
      if (active) return active;
    }
    const target = await this.backend.createTarget("about:blank");
    return this.adoptTarget(workspace, target);
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

  private onUnexpectedExit(): void {
    this.startupReconciled = false;
    for (const workspace of this.workspaces.values()) {
      workspace.targets.clear();
      workspace.activeTargetId = null;
      workspace.controlGeneration += 1;
    }
    this.targetOwners.clear();
    this.unassignedTargets.clear();
  }

  publicState(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string): StandardBrowserWorkspacePublicState {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    const tabs = [...workspace.targets.values()].map((target) => ({
      tab: target.handle,
      ...(target.title ? { title: target.title } : {}),
      ...(target.url ? { url: target.url } : {}),
    }));
    return {
      profileId: this.profile.id,
      sourceSessionId: workspace.sourceSessionId,
      workspaceGeneration: workspace.generation,
      controlGeneration: workspace.controlGeneration,
      controlMode: workspace.controlMode,
      activeTab: workspace.activeTargetId ? workspace.targets.get(workspace.activeTargetId)?.handle ?? null : null,
      tabs,
      running: this.backend.running,
      updatedAt: workspace.lastActivityAt,
    };
  }

  async execute(
    binding: Readonly<ProtectedBrowserBinding>,
    workspaceGeneration: string,
    operation: ProtectedBrowserOperation,
  ): Promise<unknown> {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    return this.queueWorkspace(workspace, async () => {
      this.assertAuthority(binding);
      if (workspace.controlMode !== "agent" && operation.kind !== "status") throw new Error("Standard browser workspace is under human control");
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
        this.exactWorkspace(binding, workspaceGeneration);
      });
      this.exactWorkspace(binding, workspaceGeneration);
      workspace.lastActivityAt = Date.now();
      return value;
    });
  }

  async listTabs(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string): Promise<StandardBrowserWorkspacePublicState> {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    await this.ensureActiveTarget(binding, workspace);
    return this.publicState(binding, workspaceGeneration);
  }

  async openTab(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string, url = "about:blank"): Promise<StandardBrowserWorkspacePublicState> {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    return this.queueWorkspace(workspace, async () => {
      await this.ensureStarted(binding);
      const target = await this.backend.createTarget(url);
      const record = this.adoptTarget(workspace, target);
      workspace.activeTargetId = record.rawId;
      return this.publicState(binding, workspaceGeneration);
    });
  }

  selectTab(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string, handle: string): StandardBrowserWorkspacePublicState {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    const target = [...workspace.targets.values()].find((candidate) => candidate.handle === handle);
    if (!target) throw new Error("Standard browser tab choice is stale");
    workspace.activeTargetId = target.rawId;
    workspace.lastActivityAt = Date.now();
    return this.publicState(binding, workspaceGeneration);
  }

  async closeTab(binding: Readonly<ProtectedBrowserBinding>, workspaceGeneration: string, handle: string): Promise<StandardBrowserWorkspacePublicState | null> {
    const workspace = this.exactWorkspace(binding, workspaceGeneration);
    const target = [...workspace.targets.values()].find((candidate) => candidate.handle === handle);
    if (!target) throw new Error("Standard browser tab choice is stale");
    await this.backend.closeTarget(target.rawId);
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

  detachAgentLease(sourceSessionId: string, runtimeGeneration: string): void {
    const workspace = this.workspaces.get(sourceSessionId);
    if (!workspace || workspace.runtimeGeneration !== runtimeGeneration) return;
    workspace.runtimeGeneration = null;
    workspace.controlGeneration += 1;
    workspace.lastActivityAt = Date.now();
  }

  async closeWorkspace(sourceSessionId: string, _reason: string): Promise<void> {
    const workspace = this.workspaces.get(sourceSessionId);
    if (!workspace || workspace.closed) return;
    workspace.closed = true;
    workspace.runtimeGeneration = null;
    workspace.controlGeneration += 1;
    const targets = [...workspace.targets.keys()];
    workspace.targets.clear();
    workspace.activeTargetId = null;
    this.workspaces.delete(sourceSessionId);
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
