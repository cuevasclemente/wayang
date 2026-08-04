import * as path from "node:path";
import type { Config } from "./config.js";
import type { AuthService } from "./auth/service.js";
import {
  cleanupPiSessionCapabilityDenial,
  latchPiSessionCapabilityDenial,
} from "./pi-bridge.js";
import type { WorkspaceCapabilitiesRouterOptions } from "./routes/workspace-capabilities.js";
import type { CapabilityAssociationRecord } from "./workspace-capability-approval/types.js";
import {
  createWorkspaceCapabilityApprovalIntegration,
  provisionPinAttemptStateForService,
  type HardenedSettingsPinAttemptAdapter,
  type WorkspaceCapabilityRuntimeDenialPort,
} from "./workspace-capability-integration.js";
import { workspaceSettingsService } from "./workspace-settings-service.js";

export interface ProductionWorkspaceCapabilityBootstrap {
  /** Pass directly as createApp({ workspaceCapabilities: routerOptions }). */
  routerOptions: WorkspaceCapabilitiesRouterOptions;
  /** Shared durable PIN-attempt authority for other owner/Origin-bound Settings confirmations. */
  pinAttempts: HardenedSettingsPinAttemptAdapter;
  /** Best-effort completion of runtime/browser cleanup begun by denial latches. */
  close(): Promise<void>;
}

class ProductionCapabilityRuntimeDenial implements WorkspaceCapabilityRuntimeDenialPort {
  private readonly affectedRuntimeIds = new Set<string>();
  private readonly cleanupTasks = new Set<Promise<void>>();

  latchDenied(input: { association: CapabilityAssociationRecord; runtimeIds: readonly string[] }): void {
    for (const id of input.runtimeIds) this.affectedRuntimeIds.add(id);
    // This call is deliberately synchronous: durable denial already happened,
    // and no await may precede live host/standard/protected authority latching.
    latchPiSessionCapabilityDenial(input.runtimeIds);
  }

  async cleanupDeniedRuntimeIds(runtimeIds: readonly string[]): Promise<void> {
    for (const id of runtimeIds) this.affectedRuntimeIds.add(id);
    const task = cleanupPiSessionCapabilityDenial(runtimeIds);
    this.cleanupTasks.add(task);
    try { await task; }
    finally { this.cleanupTasks.delete(task); }
  }

  async close(): Promise<void> {
    await this.cleanupDeniedRuntimeIds([...this.affectedRuntimeIds]).catch(() => undefined);
    await Promise.allSettled([...this.cleanupTasks]);
  }
}

/**
 * Compose the production Settings capability ports without activating anything.
 * The existing command-guard PIN remains external and is checked by metadata
 * only. Missing non-secret cooldown state is initialized owner-privately and
 * then persists across restarts; unsafe existing authority is never repaired.
 */
export function createProductionWorkspaceCapabilityBootstrap(
  auth: AuthService,
  configOrDataDir: Pick<Config, "dataDir"> | string,
): ProductionWorkspaceCapabilityBootstrap {
  const configuredDataDir = typeof configOrDataDir === "string" ? configOrDataDir : configOrDataDir.dataDir;
  if (typeof configuredDataDir !== "string" || configuredDataDir.length === 0 || !path.isAbsolute(configuredDataDir)) {
    throw new Error("Workspace capability bootstrap requires an absolute data directory");
  }
  const dataDir = path.resolve(configuredDataDir);
  const pinAttemptStatePath = path.join(dataDir, "workspace-capability-approval", "pin-attempt-state.json");
  const provisioned = provisionPinAttemptStateForService(pinAttemptStatePath);
  if (provisioned.status === "unavailable") {
    console.warn(`[workspace-capabilities] PIN approval remains unavailable (${provisioned.reason})`);
  }
  const denial = new ProductionCapabilityRuntimeDenial();
  const { integration, service, pinAttempts } = createWorkspaceCapabilityApprovalIntegration({
    denial,
    pinAttemptStatePath,
    // A failed initialization stays unavailable for this process even if a
    // partial publication happens to look valid afterward. Restart performs a
    // fresh full validation; no request may bypass the startup decision.
    pinAttemptReady: provisioned.status === "ready",
  });

  // Ordinary Settings mutations and dedicated revocation now share the exact
  // same denial-first runtime port. Installation is intentionally one-way for
  // the process lifetime: production has one workspace settings service.
  workspaceSettingsService.installCapabilityInvalidationPort(integration);

  return {
    routerOptions: {
      service,
      owners: { resolve: (request) => auth.resolveSettingsOwner(request) },
    },
    pinAttempts,
    close: () => denial.close(),
  };
}
