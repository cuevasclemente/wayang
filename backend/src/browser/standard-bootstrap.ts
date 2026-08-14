import { createHash } from "node:crypto";
import { getStore } from "../db.js";
import { resolveWorkspaceCapability } from "../workspace-capabilities.js";
import {
  installInteractiveBrowserSessionLifecyclePort,
  installProductionProtectedBrowserFactory,
  resolveInteractiveBrowserAuthority,
  type InteractiveBrowserFactory,
} from "../pi-bridge.js";
import type { InteractiveBrowserSessionLifecyclePort } from "./interactive-runtime.js";
import {
  getProjectBrowserDefault,
  getSessionBrowserState,
  materializeSessionBrowserState,
  setProjectBrowserDefault,
  setSessionBrowserProfile,
} from "./profile-catalog.js";
import type { BrowserProfileRow } from "./profile-catalog-store.js";
import { createStandardBrowserHostBackendFactory } from "./standard-production.js";
import {
  StandardBrowserProfileHostService,
  type StandardBrowserCatalogPort,
  type StandardBrowserProfileHostServiceOptions,
} from "./standard-service.js";
import { STANDARD_BROWSER_CAPABILITY_ID, type ProtectedBrowserBinding } from "./types.js";

function profileCatalogGeneration(profiles: readonly BrowserProfileRow[]): number {
  const bytes = createHash("sha256")
    .update(JSON.stringify(profiles.map((profile) => [profile.id, profile.name, profile.state, profile.revision, profile.updated_at])))
    .digest();
  return bytes.readUIntBE(0, 6);
}

function exactStandardAuthority(binding: Readonly<ProtectedBrowserBinding>): boolean {
  if (binding.capabilityId !== STANDARD_BROWSER_CAPABILITY_ID) return false;
  const authority = resolveInteractiveBrowserAuthority(binding);
  return Boolean(authority && authority.privacyMode === "standard");
}

export function createProductionStandardBrowserCatalog(): StandardBrowserCatalogPort {
  return {
    authorize(binding, profile) {
      const current = getStore().browserProfiles.find((candidate) => candidate.id === profile.id);
      return Boolean(current && current.state === "active"
        && current.storage_identity_digest === profile.storage_identity_digest
        && exactStandardAuthority(binding));
    },
    ownerAuthority(sourceSessionId, profile) {
      const current = getStore().browserProfiles.find((candidate) => candidate.id === profile.id);
      if (!current || current.state !== "active" || current.storage_identity_digest !== profile.storage_identity_digest) return null;
      const session = getStore().sessions.find((candidate) => candidate.id === sourceSessionId);
      if (!session || session.archived || !session.project_id || !session.agent_profile_id || session.pending_agent_switch !== null
        || session.legacy_capability_ineligible || session.legacy_private_session_quarantine) return null;
      const resolution = resolveWorkspaceCapability({
        capability_id: STANDARD_BROWSER_CAPABILITY_ID,
        project_id: session.project_id,
        agent_profile_id: session.agent_profile_id,
      });
      if (!resolution.authorized || resolution.project.cwd !== session.cwd) return null;
      return {
        sourceSessionId,
        projectId: resolution.project.id,
        projectCwd: resolution.project.cwd,
        agentProfileId: resolution.profile.id,
        associationRevision: resolution.association.revision,
      };
    },
    catalog() {
      const profiles = getStore().browserProfiles.map((profile) => structuredClone(profile));
      return { generation: profileCatalogGeneration(profiles), profiles };
    },
    materializeSessionState(binding) {
      if (!exactStandardAuthority(binding)) throw new Error("Standard Browser Profile authority is unavailable");
      const session = getStore().sessions.find((candidate) => candidate.id === binding.sourceSessionId);
      if (!session || session.archived || session.project_id !== binding.projectId || session.agent_profile_id !== binding.agentProfileId) {
        throw new Error("Standard Browser Profile session binding is unavailable");
      }
      return materializeSessionBrowserState(binding.sourceSessionId);
    },
    sessionState(sourceSessionId) {
      return getSessionBrowserState(sourceSessionId);
    },
    switchSessionProfile({ binding, profileId, expectedRevision }) {
      if (!exactStandardAuthority(binding)) throw new Error("Standard Browser Profile authority is unavailable");
      return setSessionBrowserProfile({ sessionId: binding.sourceSessionId, profileId, expectedRevision });
    },
    projectDefault(projectId) {
      return getProjectBrowserDefault(projectId);
    },
    setProjectDefault({ binding, profileId, expectedRevision }) {
      if (!exactStandardAuthority(binding)) throw new Error("Standard Browser Profile authority is unavailable");
      return setProjectBrowserDefault({
        projectId: binding.projectId,
        profileId,
        expectedRevision,
        updatedBy: "agent",
      });
    },
    sourceSessionsForAuthority(scope) {
      if (scope.capabilityId !== STANDARD_BROWSER_CAPABILITY_ID) return [];
      return getStore().sessions
        .filter((session) => session.project_id === scope.projectId && session.agent_profile_id === scope.agentProfileId)
        .map((session) => session.id);
    },
  };
}

export interface StandardBrowserProductionBootstrapOptions {
  enabled: boolean;
  dataDir: string;
  protectedFactory: InteractiveBrowserFactory;
  backendFactory?: StandardBrowserProfileHostServiceOptions["backendFactory"];
  installFactory?: (factory: InteractiveBrowserFactory) => () => void;
  installLifecycle?: (port: InteractiveBrowserSessionLifecyclePort) => () => void;
}

export interface StandardBrowserProductionBootstrap {
  readonly service: StandardBrowserProfileHostService | null;
  readonly factory: InteractiveBrowserFactory;
  close(): Promise<void>;
}

/**
 * Installs one process-wide interactive-browser factory. With the startup gate
 * disabled it delegates byte-for-byte to the existing Protected production
 * factory. Enabling the gate routes only Standard bindings into the named
 * profile host service; construction itself never opens profile storage.
 */
export function bootstrapStandardBrowserProduction(
  options: StandardBrowserProductionBootstrapOptions,
): StandardBrowserProductionBootstrap {
  if (!options || typeof options.enabled !== "boolean" || !options.dataDir || typeof options.protectedFactory !== "function") {
    throw new Error("Standard Browser Profile production bootstrap options are incomplete");
  }
  const service = options.enabled
    ? new StandardBrowserProfileHostService({
        dataDir: options.dataDir,
        catalog: createProductionStandardBrowserCatalog(),
        backendFactory: options.backendFactory ?? createStandardBrowserHostBackendFactory({ dataDir: options.dataDir }),
      })
    : null;
  let closed = false;
  let shutdownComplete = false;
  let closePromise: Promise<void> | null = null;
  let integrationsUninstalled = false;
  const factory: InteractiveBrowserFactory = (binding) => {
    if (closed) throw new Error("Interactive browser production bootstrap is closed");
    if (binding.capabilityId === STANDARD_BROWSER_CAPABILITY_ID) {
      if (!service) return options.protectedFactory(binding);
      return service.createRuntime(binding);
    }
    return options.protectedFactory(binding);
  };
  const uninstallFactory = (options.installFactory ?? installProductionProtectedBrowserFactory)(factory);
  const uninstallLifecycle = service
    ? (options.installLifecycle ?? installInteractiveBrowserSessionLifecyclePort)(service)
    : () => undefined;
  const idleTimer = service ? setInterval(() => {
    void service.sweepIdle().catch(() => {
      console.warn("[browser] Standard Browser Profile idle cleanup failed");
    });
  }, 60_000) : null;
  idleTimer?.unref();
  return {
    service,
    factory,
    async close() {
      if (shutdownComplete) return;
      if (closePromise) return closePromise;
      closed = true;
      if (!integrationsUninstalled) {
        integrationsUninstalled = true;
        if (idleTimer) clearInterval(idleTimer);
        uninstallFactory();
        uninstallLifecycle();
      }
      let closing!: Promise<void>;
      closing = (async () => {
        await service?.close();
        shutdownComplete = true;
      })().finally(() => {
        if (closePromise === closing) closePromise = null;
      });
      closePromise = closing;
      return closing;
    },
  };
}
