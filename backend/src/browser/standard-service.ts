import { randomUUID } from "node:crypto";
import type { ProtectedBrowserBinding } from "./types.js";
import type { CredentialBroker } from "./credentials.js";
import type {
  BrowserAuthorityRevokeReason,
  InteractiveBrowserAuthorityScope,
  InteractiveBrowserSessionLifecyclePort,
  SessionWorkspaceCloseReason,
} from "./interactive-runtime.js";
import type { BrowserProfileRow, ProjectBrowserDefaultRow, SessionBrowserStateRow } from "./profile-catalog-store.js";
import {
  BrowserStorageOwnershipRegistry,
  assertBrowserStorageAncestorsSafe,
  resolveBrowserProfileStorageDescriptor,
} from "./profile-storage-registry.js";
import {
  MAX_STANDARD_BROWSER_RUNNING_HOSTS,
  StandardBrowserProfileHost,
  type StandardBrowserHostBackendFactory,
  type StandardBrowserWorkspacePublicState,
} from "./standard-host.js";
import { createStandardBrowserSessionRuntime, type StandardBrowserSessionRuntime } from "./standard-runtime.js";

export interface StandardBrowserCatalogSnapshot {
  generation: number;
  profiles: readonly BrowserProfileRow[];
}

export interface StandardBrowserOwnerAuthority {
  sourceSessionId: string;
  projectId: string;
  projectCwd: string;
  agentProfileId: string;
  associationRevision: number;
}

export interface StandardBrowserCatalogPort {
  authorize(binding: Readonly<ProtectedBrowserBinding>, profile: Readonly<BrowserProfileRow>): boolean;
  ownerAuthority(sourceSessionId: string, profile: Readonly<BrowserProfileRow>): StandardBrowserOwnerAuthority | null;
  catalog(): StandardBrowserCatalogSnapshot;
  materializeSessionState(binding: Readonly<ProtectedBrowserBinding>): SessionBrowserStateRow;
  sessionState(sourceSessionId: string): SessionBrowserStateRow | null;
  switchSessionProfile(input: {
    binding: Readonly<ProtectedBrowserBinding>;
    profileId: string;
    expectedRevision: number;
  }): SessionBrowserStateRow;
  projectDefault(projectId: string): ProjectBrowserDefaultRow | null;
  setProjectDefault(input: {
    binding: Readonly<ProtectedBrowserBinding>;
    profileId: string;
    expectedRevision: number | null;
  }): ProjectBrowserDefaultRow;
  sourceSessionsForAuthority(scope: Readonly<InteractiveBrowserAuthorityScope>): readonly string[];
}

export interface StandardBrowserRuntimeWorkspace {
  profile: Readonly<BrowserProfileRow>;
  host: StandardBrowserProfileHost;
  workspaceGeneration: string;
  sessionStateRevision: number;
}

export const STANDARD_BROWSER_WORKSPACE_IDLE_MS = 60 * 60 * 1000;
export const STANDARD_BROWSER_EMPTY_HOST_IDLE_MS = 15 * 60 * 1000;

export interface StandardBrowserProfileHostServiceOptions {
  dataDir: string;
  catalog: StandardBrowserCatalogPort;
  backendFactory: StandardBrowserHostBackendFactory;
  storageRegistry?: BrowserStorageOwnershipRegistry;
  credentialBroker?: CredentialBroker;
}

export class StandardBrowserProfileHostService implements InteractiveBrowserSessionLifecyclePort {
  private readonly hosts = new Map<string, StandardBrowserProfileHost>();
  private readonly runtimes = new Map<string, Set<StandardBrowserSessionRuntime>>();
  private readonly workspaceLeases = new Map<string, Map<string, StandardBrowserRuntimeWorkspace>>();
  private readonly storageRegistry: BrowserStorageOwnershipRegistry;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private shutdownComplete = false;

  constructor(private readonly options: StandardBrowserProfileHostServiceOptions) {
    this.storageRegistry = options.storageRegistry ?? new BrowserStorageOwnershipRegistry();
  }

  get credentialBrokerSupported(): boolean { return Boolean(this.options.credentialBroker); }

  private profile(profileId: string): BrowserProfileRow {
    const profile = this.options.catalog.catalog().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error("Browser Profile not found");
    if (profile.state !== "active") throw new Error("Browser Profile is not active");
    return profile;
  }

  private activeProfile(profileId: string): BrowserProfileRow | null {
    const profile = this.options.catalog.catalog().profiles.find((candidate) => candidate.id === profileId);
    return profile?.state === "active" ? profile : null;
  }

  private host(profile: BrowserProfileRow): StandardBrowserProfileHost {
    const current = this.hosts.get(profile.id);
    if (current && !current.isClosed) return current;
    if (this.hosts.size >= MAX_STANDARD_BROWSER_RUNNING_HOSTS) throw new Error("Running Browser Profile host limit reached");
    const storage = resolveBrowserProfileStorageDescriptor(this.options.dataDir, profile);
    assertBrowserStorageAncestorsSafe(this.options.dataDir, storage);
    const ownerId = `standard-host:${profile.id}:${randomUUID()}`;
    const openerLease = this.storageRegistry.claim(storage, ownerId);
    let host: StandardBrowserProfileHost;
    try {
      host = new StandardBrowserProfileHost(
        profile,
        storage,
        openerLease,
        this.options.backendFactory,
        { authorize: (binding, exactProfile) => this.options.catalog.authorize(binding, exactProfile) },
      );
    } catch (error) {
      openerLease.release();
      throw error;
    }
    this.hosts.set(profile.id, host);
    return host;
  }

  createRuntime(binding: Readonly<ProtectedBrowserBinding>): StandardBrowserSessionRuntime {
    if (this.closed || binding.capabilityId !== "wayang.standard-browser.v1") {
      throw new Error("Standard Browser Profile runtime is unavailable");
    }
    const state = this.options.catalog.materializeSessionState(binding);
    const runtime = createStandardBrowserSessionRuntime({ service: this, binding: { ...binding }, initialState: state });
    let sourceRuntimes = this.runtimes.get(binding.sourceSessionId);
    if (!sourceRuntimes) { sourceRuntimes = new Set(); this.runtimes.set(binding.sourceSessionId, sourceRuntimes); }
    sourceRuntimes.add(runtime);
    return runtime;
  }

  attachWorkspace(binding: Readonly<ProtectedBrowserBinding>, state: Readonly<SessionBrowserStateRow>): StandardBrowserRuntimeWorkspace | null {
    if (state.active_profile_id === null) return null;
    const profile = this.activeProfile(state.active_profile_id);
    if (!profile) return null;
    if (!this.options.catalog.authorize(binding, profile)) throw new Error("Standard Browser Profile authority is unavailable");
    const host = this.host(profile);
    const workspace = host.bindWorkspace(binding);
    const exact = {
      profile,
      host,
      workspaceGeneration: workspace.generation,
      sessionStateRevision: state.revision,
    };
    let leases = this.workspaceLeases.get(binding.sourceSessionId);
    if (!leases) { leases = new Map(); this.workspaceLeases.set(binding.sourceSessionId, leases); }
    leases.set(profile.id, exact);
    return exact;
  }

  resolveWorkspace(
    binding: Readonly<ProtectedBrowserBinding>,
    expected: Readonly<StandardBrowserRuntimeWorkspace>,
  ): StandardBrowserRuntimeWorkspace {
    const state = this.options.catalog.sessionState(binding.sourceSessionId);
    if (!state || state.revision !== expected.sessionStateRevision || state.active_profile_id !== expected.profile.id
      || !this.options.catalog.authorize(binding, expected.profile)) {
      throw new Error("Standard Browser Profile assignment changed");
    }
    if (!expected.host.hasWorkspace(binding.sourceSessionId, expected.workspaceGeneration)) {
      const rebound = this.attachWorkspace(binding, state);
      if (!rebound) throw new Error("Standard browser workspace is unavailable");
      return rebound;
    }
    return expected;
  }

  resolveOwnerWorkspace(sourceSessionId: string, expectedProjectCwd?: string): {
    authority: StandardBrowserOwnerAuthority;
    workspace: StandardBrowserRuntimeWorkspace;
  } | null {
    const state = this.options.catalog.sessionState(sourceSessionId);
    if (!state?.active_profile_id) return null;
    let workspace = this.workspaceLeases.get(sourceSessionId)?.get(state.active_profile_id);
    if (!workspace || workspace.sessionStateRevision !== state.revision || workspace.host.isClosed
      || !workspace.host.hasWorkspace(sourceSessionId, workspace.workspaceGeneration)) {
      const profile = this.profile(state.active_profile_id);
      const authority = this.options.catalog.ownerAuthority(sourceSessionId, profile);
      if (!authority || (expectedProjectCwd !== undefined && authority.projectCwd !== expectedProjectCwd)) return null;
      const ownerBinding: ProtectedBrowserBinding = {
        capabilityId: "wayang.standard-browser.v1",
        sourceSessionId,
        projectId: authority.projectId,
        projectCwd: authority.projectCwd,
        agentProfileId: authority.agentProfileId,
        associationRevision: authority.associationRevision,
        runtimeGeneration: `owner:${randomUUID()}`,
        processBootNonce: "owner-without-pi",
        controlGeneration: 1,
      };
      workspace = this.attachWorkspace(ownerBinding, state) ?? undefined;
      if (!workspace) return null;
      // Owner-without-Pi workspaces retain no agent lease. The durable owner
      // path can start/view them, but cannot mint or execute agent tools.
      void workspace.host.detachAgentLease(sourceSessionId, ownerBinding.runtimeGeneration);
      return { authority, workspace };
    }
    const authority = this.options.catalog.ownerAuthority(sourceSessionId, workspace.profile);
    if (!authority || (expectedProjectCwd !== undefined && authority.projectCwd !== expectedProjectCwd)) return null;
    return { authority, workspace };
  }

  private ownerCredentialSelection(sourceSessionId: string, expectedProjectCwd?: string) {
    const resolved = this.resolveOwnerWorkspace(sourceSessionId, expectedProjectCwd);
    if (!resolved) throw new Error("Standard browser credential workspace is unavailable");
    const authorize = async () => {
      const current = this.resolveOwnerWorkspace(sourceSessionId, expectedProjectCwd);
      if (!current || current.workspace.host !== resolved.workspace.host
        || current.workspace.profile.id !== resolved.workspace.profile.id
        || current.workspace.workspaceGeneration !== resolved.workspace.workspaceGeneration
        || current.workspace.sessionStateRevision !== resolved.workspace.sessionStateRevision
        || current.authority.associationRevision !== resolved.authority.associationRevision) {
        throw new Error("Standard browser credential authority changed");
      }
    };
    return { ...resolved, authorize };
  }

  async credentialStatus(sourceSessionId: string, expectedProjectCwd?: string): Promise<unknown> {
    const broker = this.options.credentialBroker;
    if (!broker) throw new Error("Standard browser credential broker is unavailable");
    const selected = this.ownerCredentialSelection(sourceSessionId, expectedProjectCwd);
    const status = broker.status();
    let origin: string | null = null;
    try {
      origin = (await selected.workspace.host.ownerCredentialContext(
        sourceSessionId, selected.workspace.workspaceGeneration, selected.authorize,
      )).origin;
    } catch { origin = null; }
    return { ...status, origin };
  }

  async credentialMatches(sourceSessionId: string, expectedProjectCwd?: string): Promise<unknown> {
    const broker = this.options.credentialBroker;
    if (!broker) throw new Error("Standard browser credential broker is unavailable");
    const selected = this.ownerCredentialSelection(sourceSessionId, expectedProjectCwd);
    const context = await selected.workspace.host.ownerCredentialContext(
      sourceSessionId, selected.workspace.workspaceGeneration, selected.authorize,
    );
    return broker.matches(context);
  }

  async credentialFill(sourceSessionId: string, expectedProjectCwd: string | undefined, choiceToken: string, operation: "login" | "totp"): Promise<unknown> {
    const broker = this.options.credentialBroker;
    if (!broker) throw new Error("Standard browser credential broker is unavailable");
    const selected = this.ownerCredentialSelection(sourceSessionId, expectedProjectCwd);
    const context = await selected.workspace.host.ownerCredentialContext(
      sourceSessionId, selected.workspace.workspaceGeneration, selected.authorize,
    );
    return broker.fill(choiceToken, operation, context, (values) => selected.workspace.host.ownerFillCredential(
      sourceSessionId, selected.workspace.workspaceGeneration, context, values, selected.authorize,
    ));
  }

  async allowCredentialInspection(sourceSessionId: string, expectedProjectCwd?: string): Promise<StandardBrowserWorkspacePublicState> {
    const selected = this.ownerCredentialSelection(sourceSessionId, expectedProjectCwd);
    await selected.workspace.host.ownerAllowCredentialInspection(
      sourceSessionId, selected.workspace.workspaceGeneration, selected.authorize,
    );
    return selected.workspace.host.ownerPublicState(sourceSessionId, selected.workspace.workspaceGeneration);
  }

  async lockCredentials(sourceSessionId: string, expectedProjectCwd?: string): Promise<void> {
    const broker = this.options.credentialBroker;
    if (!broker) throw new Error("Standard browser credential broker is unavailable");
    const selected = this.ownerCredentialSelection(sourceSessionId, expectedProjectCwd);
    await selected.authorize();
    await broker.lock();
  }

  resolveLiveWorkspace(binding: Readonly<ProtectedBrowserBinding>): StandardBrowserRuntimeWorkspace | null {
    const state = this.options.catalog.sessionState(binding.sourceSessionId);
    if (!state?.active_profile_id) return null;
    const workspace = this.workspaceLeases.get(binding.sourceSessionId)?.get(state.active_profile_id);
    if (!workspace) return null;
    return this.resolveWorkspace(binding, workspace);
  }

  listProfiles(binding: Readonly<ProtectedBrowserBinding>): StandardBrowserCatalogSnapshot {
    const snapshot = this.options.catalog.catalog();
    return {
      generation: snapshot.generation,
      profiles: snapshot.profiles.filter((profile) => profile.state === "active"
        && this.options.catalog.authorize(binding, profile)),
    };
  }

  async switchProfile(
    binding: Readonly<ProtectedBrowserBinding>,
    current: StandardBrowserRuntimeWorkspace | null,
    profileId: string,
    expectedSessionRevision: number,
  ): Promise<{ state: SessionBrowserStateRow; workspace: StandardBrowserRuntimeWorkspace }> {
    for (const host of this.hosts.values()) {
      if (host.hasBlockingControl(binding.sourceSessionId)) throw new Error("Cannot switch Browser Profile during human or credential control");
    }
    const profile = this.profile(profileId);
    if (!this.options.catalog.authorize(binding, profile)) throw new Error("Browser Profile choice is unavailable");
    const targetHost = this.host(profile);
    if (!targetHost.canBindWorkspace(binding.sourceSessionId)) {
      throw new Error("Standard Browser Profile workspace limit reached");
    }
    if (current) await current.host.detachAgentLease(binding.sourceSessionId, binding.runtimeGeneration);
    let state: SessionBrowserStateRow;
    try {
      state = this.options.catalog.switchSessionProfile({ binding, profileId, expectedRevision: expectedSessionRevision });
    } catch (error) {
      if (current) current.host.bindWorkspace(binding);
      throw error;
    }
    try {
      const workspace = this.attachWorkspace(binding, state);
      if (!workspace) throw new Error("Browser Profile assignment failed");
      return { state, workspace };
    } catch (error) {
      if (current) {
        try {
          this.options.catalog.switchSessionProfile({
            binding,
            profileId: current.profile.id,
            expectedRevision: state.revision,
          });
          current.host.bindWorkspace(binding);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Browser Profile switch rollback failed");
        }
      }
      throw error;
    }
  }

  assertOwnerSwitchAllowed(sourceSessionId: string): void {
    for (const host of this.hosts.values()) {
      if (host.hasBlockingControl(sourceSessionId)) throw new Error("Cannot switch Browser Profile during human or credential control");
    }
  }

  setProjectDefault(
    binding: Readonly<ProtectedBrowserBinding>,
    profileId: string,
    expectedRevision: number | null,
  ): ProjectBrowserDefaultRow {
    const profile = this.profile(profileId);
    if (!this.options.catalog.authorize(binding, profile)) throw new Error("Browser Profile choice is unavailable");
    return this.options.catalog.setProjectDefault({ binding, profileId, expectedRevision });
  }

  projectDefault(projectId: string): ProjectBrowserDefaultRow | null {
    return this.options.catalog.projectDefault(projectId);
  }

  runtimeDetached(runtime: StandardBrowserSessionRuntime): void {
    this.runtimes.get(runtime.binding.sourceSessionId)?.delete(runtime);
    if (this.runtimes.get(runtime.binding.sourceSessionId)?.size === 0) this.runtimes.delete(runtime.binding.sourceSessionId);
  }

  workspaceState(binding: Readonly<ProtectedBrowserBinding>, workspace: StandardBrowserRuntimeWorkspace): StandardBrowserWorkspacePublicState {
    this.resolveWorkspace(binding, workspace);
    return workspace.host.publicState(binding, workspace.workspaceGeneration);
  }

  async closeSessionWorkspaces(sourceSessionId: string, reason: SessionWorkspaceCloseReason): Promise<void> {
    const runtimes = this.runtimes.get(sourceSessionId);
    if (runtimes) for (const runtime of [...runtimes]) runtime.latchRevoked();
    const leases = this.workspaceLeases.get(sourceSessionId);
    const failures: unknown[] = [];
    for (const [profileId, host] of this.hosts) {
      try {
        await host.closeWorkspace(sourceSessionId, reason);
        leases?.delete(profileId);
      } catch (error) { failures.push(error); }
    }
    if (leases?.size === 0) this.workspaceLeases.delete(sourceSessionId);
    if (failures.length > 0) throw new AggregateError(failures, "Standard browser session cleanup is pending");
  }

  async revokeAuthority(scope: Readonly<InteractiveBrowserAuthorityScope>, reason: BrowserAuthorityRevokeReason): Promise<void> {
    const sessions = this.options.catalog.sourceSessionsForAuthority(scope);
    const results = await Promise.allSettled(
      sessions.map((sourceSessionId) => this.closeSessionWorkspaces(sourceSessionId, "owner_close_all")),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Standard browser authority cleanup is pending");
    void reason;
  }

  async invalidateProfile(profileId: string): Promise<void> {
    const host = this.hosts.get(profileId);
    if (!host) return;
    await host.close();
    if (this.hosts.get(profileId) === host) this.hosts.delete(profileId);
    for (const [sourceSessionId, leases] of this.workspaceLeases) {
      leases.delete(profileId);
      if (leases.size === 0) this.workspaceLeases.delete(sourceSessionId);
    }
  }

  async sweepIdle(
    now = Date.now(),
    workspaceIdleMs = STANDARD_BROWSER_WORKSPACE_IDLE_MS,
    hostIdleMs = STANDARD_BROWSER_EMPTY_HOST_IDLE_MS,
  ): Promise<{ workspacesClosed: number; hostsStopped: number }> {
    let workspacesClosed = 0;
    let hostsStopped = 0;
    for (const [profileId, host] of [...this.hosts]) {
      for (const sourceSessionId of host.cleanupPendingSessionIds()) {
        try {
          await host.closeWorkspace(sourceSessionId, "cleanup_retry", now);
          const leases = this.workspaceLeases.get(sourceSessionId);
          leases?.delete(profileId);
          if (leases?.size === 0) this.workspaceLeases.delete(sourceSessionId);
        } catch { /* keep exact cleanup identity for the next bounded retry */ }
      }
      for (const sourceSessionId of host.idleWorkspaceSessionIds(now, workspaceIdleMs)) {
        await host.closeWorkspace(sourceSessionId, "workspace_idle", now);
        const leases = this.workspaceLeases.get(sourceSessionId);
        leases?.delete(profileId);
        if (leases?.size === 0) this.workspaceLeases.delete(sourceSessionId);
        workspacesClosed += 1;
      }
      const emptySince = host.emptySinceTimestamp();
      if (emptySince !== null && now - emptySince >= hostIdleMs) {
        await host.close();
        if (this.hosts.get(profileId) === host) this.hosts.delete(profileId);
        hostsStopped += 1;
      }
    }
    return { workspacesClosed, hostsStopped };
  }

  blocksPiIdleDetach(): boolean {
    // Pi detach is always permitted. Workspaces are process-owned and survive;
    // later download lifecycle adds its explicit old-generation blocker here.
    return false;
  }

  async close(): Promise<void> {
    if (this.shutdownComplete) return;
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const runtimes of this.runtimes.values()) for (const runtime of runtimes) runtime.latchRevoked();
    let closing!: Promise<void>;
    closing = (async () => {
      const results = await Promise.allSettled([...this.hosts.values()].map((host) => host.close()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Standard Browser Profile service shutdown is incomplete");
      this.runtimes.clear();
      this.workspaceLeases.clear();
      this.hosts.clear();
      this.storageRegistry.close();
      this.shutdownComplete = true;
    })().finally(() => {
      if (this.closePromise === closing) this.closePromise = null;
    });
    this.closePromise = closing;
    return closing;
  }
}
