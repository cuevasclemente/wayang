import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ProtectedBrowserBinding } from "./types.js";

export type InteractiveBrowserAllowDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export type AgentLeaseDetachReason =
  | "pi_idle"
  | "runtime_replaced"
  | "model_or_agent_switch";

export type SessionWorkspaceCloseReason =
  | "archive"
  | "session_delete"
  | "owner_close_all";

export type BrowserAuthorityRevokeReason =
  | "capability_revoked"
  | "project_or_profile_denied"
  | "service_shutdown";

/**
 * Backend-owned interactive-browser tool runtime contract.
 *
 * Lifecycle methods are intentionally separate: detaching an agent lease,
 * closing session-owned workspaces, and revoking authority are different
 * operations even when an incremental adapter currently shares teardown work.
 * The reason is bounded diagnostic context only and never participates in
 * authorization.
 */
export interface InteractiveBrowserToolRuntime {
  readonly kind: "standard" | "protected";
  readonly tools: readonly ToolDefinition[];
  toolForName(name: string): ToolDefinition | undefined;
  preflight(): InteractiveBrowserAllowDecision;
  detachAgentLease(reason: AgentLeaseDetachReason): Promise<void>;
  closeSessionWorkspaces(reason: SessionWorkspaceCloseReason): Promise<void>;
  revokeAuthority(reason: BrowserAuthorityRevokeReason): Promise<void>;
}

/** Capability factory result validated before publication by pi-bridge. */
export interface CapabilityBoundInteractiveBrowserToolRuntime extends InteractiveBrowserToolRuntime {
  readonly binding: Readonly<ProtectedBrowserBinding>;
}

/**
 * Process-level lifecycle port for workspaces that may outlive a Pi runtime.
 * Archive/delete and authority denial must not depend on a live Pi handle.
 */
export interface InteractiveBrowserSessionLifecyclePort {
  closeSessionWorkspaces(
    sourceSessionId: string,
    reason: SessionWorkspaceCloseReason,
  ): Promise<void>;
  revokeAuthority(
    binding: Readonly<ProtectedBrowserBinding>,
    reason: BrowserAuthorityRevokeReason,
  ): Promise<void>;
  blocksPiIdleDetach(binding: Readonly<ProtectedBrowserBinding>): boolean;
  close(): Promise<void>;
}
