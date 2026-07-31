import type { HostExecutionMode } from "./host-execution.js";

export interface AgentSwitchAuthoritySnapshot {
  pending: boolean;
  /** `wren_host` is accepted only from an incremental stale caller and is
   * never treated as host authority. New runtime protocol state is `host`. */
  bashMode: HostExecutionMode | "wren_host";
}

function assertCurrentBashMode(mode: AgentSwitchAuthoritySnapshot["bashMode"]): asserts mode is HostExecutionMode {
  if (mode === "wren_host") throw new Error("Legacy wren_host protocol state is invalid; a fresh runtime is required");
}

export type AgentSwitchAuthorityPhase =
  | "initial"
  | "old_runtime_revoked"
  | "provisional_target_active"
  | "durable_switch_completed"
  | "provisional_target_destroyed"
  | "fresh_target_active"
  | "failure_cleaned";

/**
 * Pure fail-closed ordering assertions for the authority-sensitive portion of
 * an agent switch. Persistence and runtime callbacks remain owned by PiBridge.
 */
export class AgentSwitchAuthorityLifecycle {
  private currentPhase: AgentSwitchAuthorityPhase = "initial";

  get phase(): AgentSwitchAuthorityPhase {
    return this.currentPhase;
  }

  oldRuntimeRevoked(): void {
    if (this.currentPhase !== "initial") throw new Error("Old runtime authority was revoked out of order");
    this.currentPhase = "old_runtime_revoked";
  }

  authorizeProvisionalTargetConstruction(): void {
    if (this.currentPhase !== "old_runtime_revoked") {
      throw new Error("Target runtime construction requires prior old-runtime revocation");
    }
  }

  provisionalTargetConstructed(snapshot: AgentSwitchAuthoritySnapshot): void {
    this.authorizeProvisionalTargetConstruction();
    assertCurrentBashMode(snapshot.bashMode);
    if (!snapshot.pending) throw new Error("Provisional target runtime requires a pending durable switch");
    if (snapshot.bashMode === "host") throw new Error("A pending agent switch can never select host execution");
    this.currentPhase = "provisional_target_active";
  }

  durableSwitchCompleted(snapshot: AgentSwitchAuthoritySnapshot): void {
    assertCurrentBashMode(snapshot.bashMode);
    if (this.currentPhase !== "provisional_target_active") {
      throw new Error("Durable switch completion requires the provisional target runtime");
    }
    if (snapshot.pending) throw new Error("Durable switch completion did not clear the pending marker");
    this.currentPhase = "durable_switch_completed";
  }

  provisionalTargetDestroyed(): void {
    if (this.currentPhase !== "durable_switch_completed") {
      throw new Error("Provisional target destruction requires durable switch completion");
    }
    this.currentPhase = "provisional_target_destroyed";
  }

  authorizeFreshTargetConstruction(): void {
    if (this.currentPhase !== "provisional_target_destroyed") {
      throw new Error("Fresh target runtime requires completed switch and destroyed provisional runtime");
    }
  }

  freshTargetConstructed(snapshot: AgentSwitchAuthoritySnapshot): void {
    this.authorizeFreshTargetConstruction();
    assertCurrentBashMode(snapshot.bashMode);
    if (snapshot.pending) throw new Error("Fresh target runtime cannot retain a pending switch");
    this.currentPhase = "fresh_target_active";
  }

  failureCleaned(snapshot: AgentSwitchAuthoritySnapshot): void {
    assertCurrentBashMode(snapshot.bashMode);
    if (snapshot.pending && snapshot.bashMode === "host") {
      throw new Error("Switch failure recovery cannot leave pending host authority");
    }
    this.currentPhase = "failure_cleaned";
  }
}
