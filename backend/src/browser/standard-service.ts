import { randomUUID } from "node:crypto";
import type { ProtectedBrowserBinding } from "./types.js";
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

export interface StandardBrowserCatalogPort {
  authorize(binding: Readonly<ProtectedBrowserBinding>, profile: Readonly<BrowserProfileRow>): boolean;
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

export interface StandardBrowserProfileHostServiceOptions {
  dataDir: string;
  catalog: StandardBrowserCatalogPort;
  backendFactory: StandardBrowserHostBackendFactory;
  storageRegistry?: BrowserStorageOwnershipRegistry;
}

export class StandardBrowserProfileHostService implements InteractiveBrowserSessionLifecyclePort {
  private readonly hosts = new Map<string, StandardBrowserProfileHost>();
  private readonly runtimes = new Map<string, Set<StandardBrowserSessionRuntime>>();
  private readonly storageRegistry: BrowserStorageOwnershipRegistry;
  private closed = false;

  constructor(private readonly options: StandardBrowserProfileHostServiceOptions) {
    this.storageRegistry = options.storageRegistry ?? new BrowserStorageOwnershipRegistry();
  }

  private profile(profileId: string): BrowserProfileRow {
    const profile = this.options.catalog.catalog().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new Error("Browser Profile not found");
    if (profile.state !== "active") throw new Error("Browser Profile is not active");
    return profile;
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
    const profile = this.profile(state.active_profile_id);
    if (!this.options.catalog.authorize(binding, profile)) throw new Error("Standard Browser Profile authority is unavailable");
    const host = this.host(profile);
    const workspace = host.bindWorkspace(binding);
    return {
      profile,
      host,
      workspaceGeneration: workspace.generation,
      sessionStateRevision: state.revision,
    };
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
    return expected;
  }

  listProfiles(binding: Readonly<ProtectedBrowserBinding>): StandardBrowserCatalogSnapshot {
    const snapshot = this.options.catalog.catalog();
    return {
      generation: snapshot.generation,
      profiles: snapshot.profiles.filter((profile) => profile.state === "active"
        && this.options.catalog.authorize(binding, profile)),
    };
  }

  switchProfile(
    binding: Readonly<ProtectedBrowserBinding>,
    current: StandardBrowserRuntimeWorkspace | null,
    profileId: string,
    expectedSessionRevision: number,
  ): { state: SessionBrowserStateRow; workspace: StandardBrowserRuntimeWorkspace } {
    for (const host of this.hosts.values()) {
      if (host.hasBlockingControl(binding.sourceSessionId)) throw new Error("Cannot switch Browser Profile during human or credential control");
    }
    const profile = this.profile(profileId);
    if (!this.options.catalog.authorize(binding, profile)) throw new Error("Browser Profile choice is unavailable");
    const state = this.options.catalog.switchSessionProfile({ binding, profileId, expectedRevision: expectedSessionRevision });
    const workspace = this.attachWorkspace(binding, state);
    if (!workspace) throw new Error("Browser Profile assignment failed");
    void current;
    return { state, workspace };
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
    await Promise.allSettled([...this.hosts.values()].map((host) => host.closeWorkspace(sourceSessionId, reason)));
  }

  async revokeAuthority(scope: Readonly<InteractiveBrowserAuthorityScope>, reason: BrowserAuthorityRevokeReason): Promise<void> {
    const sessions = this.options.catalog.sourceSessionsForAuthority(scope);
    await Promise.allSettled(sessions.map((sourceSessionId) => this.closeSessionWorkspaces(sourceSessionId, "owner_close_all")));
    void reason;
  }

  blocksPiIdleDetach(): boolean {
    // Pi detach is always permitted. Workspaces are process-owned and survive;
    // later download lifecycle adds its explicit old-generation blocker here.
    return false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const runtimes of this.runtimes.values()) for (const runtime of runtimes) runtime.latchRevoked();
    this.runtimes.clear();
    await Promise.allSettled([...this.hosts.values()].map((host) => host.close()));
    this.hosts.clear();
    this.storageRegistry.close();
  }
}
