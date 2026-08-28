import * as path from "node:path";
import type { Config } from "./config.js";
import type { AuthService } from "./auth/service.js";
import {
  cleanupPiSessionCapabilityDenial,
  latchPiSessionCapabilityActivation,
  latchPiSessionCapabilityDenial,
} from "./pi-bridge.js";
import type {
  CapabilityActivationIntent,
  CapabilityAssociationRecord,
} from "./workspace-capability-approval/types.js";
import {
  HardenedSettingsPinAttemptAdapter,
  provisionPinAttemptStateForService,
  WorkspaceCapabilityIntegration,
  type WorkspaceCapabilityRuntimeLifecyclePort,
} from "./workspace-capability-integration.js";
import { workspaceSettingsService } from "./workspace-settings-service.js";

export interface ProductionWorkspaceCapabilityBootstrap {
  /** Shared durable PIN-attempt authority for owner/Origin-bound confirmations. */
  pinAttempts: HardenedSettingsPinAttemptAdapter;
  /** Best-effort completion of runtime/browser cleanup begun by denial latches. */
  close(): Promise<void>;
}

class ProductionCapabilityRuntimeLifecycle implements WorkspaceCapabilityRuntimeLifecyclePort {
  private readonly affectedRuntimeIds = new Set<string>();
  private readonly cleanupTasks = new Set<Promise<void>>();

  latchActivation(input: { intent: CapabilityActivationIntent; runtimeIds: readonly string[] }): void {
    latchPiSessionCapabilityActivation(input.runtimeIds);
  }

  latchDenied(input: { association: CapabilityAssociationRecord; runtimeIds: readonly string[] }): void {
    for (const id of input.runtimeIds) this.affectedRuntimeIds.add(id);
    // This call is deliberately synchronous: durable denial already happened,
    // and no await may precede live host/standard/protected authority latching.
    const browserCapability = input.association.capabilityId === "wayang.standard-browser.v1"
      || input.association.capabilityId === "wayang.protected-browser.v1";
    latchPiSessionCapabilityDenial(
      input.runtimeIds,
      undefined,
      browserCapability
        ? { kind: "revoke", reason: "capability_revoked" }
        : { kind: "detach", reason: "runtime_replaced" },
      browserCapability
        ? {
            capabilityId: input.association.capabilityId as "wayang.standard-browser.v1" | "wayang.protected-browser.v1",
            projectId: input.association.projectId,
            agentProfileId: input.association.agentProfileId,
          }
        : undefined,
    );
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
 * Compose shared owner-PIN attempts plus legacy-row denial cleanup. Per-pair
 * capability activation/revocation is retired; Project privacy and RBAC derive
 * live authority. Missing non-secret cooldown state is initialized privately
 * for the remaining operation-specific confirmation flows.
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
    console.warn(`[owner-pin] confirmation attempts remain unavailable (${provisioned.reason}); run make doctor and optionally make setup-owner-pin-confirmations`);
  }
  const lifecycle = new ProductionCapabilityRuntimeLifecycle();
  const integration = new WorkspaceCapabilityIntegration(lifecycle);
  const pinAttempts = new HardenedSettingsPinAttemptAdapter(
    pinAttemptStatePath,
    // A failed initialization stays unavailable for this process even if a
    // partial publication happens to look valid afterward. Restart performs a
    // fresh full validation; no request may bypass the startup decision.
    provisioned.status === "ready",
  );

  // Ordinary Settings mutations use the denial-first runtime port retained by
  // the compatibility integration. Installation is intentionally one-way for
  // the process lifetime: production has one workspace settings service.
  workspaceSettingsService.installCapabilityInvalidationPort(integration);

  void auth; // retained parameter keeps production bootstrap call sites stable.
  return {
    pinAttempts,
    close: () => lifecycle.close(),
  };
}
