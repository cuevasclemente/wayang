import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Backend-owned interactive-browser runtime contract.
 *
 * Lifecycle methods are intentionally separate: detaching an agent lease,
 * closing session-owned workspaces, and revoking authority are different
 * operations even when an incremental adapter currently shares teardown work.
 * The reason is backend diagnostic context only and must never participate in
 * authorization.
 */
export interface InteractiveBrowserRuntime {
  readonly tools: readonly ToolDefinition[];
  toolForName(name: string): ToolDefinition | undefined;
  preflight(): { allowed: true } | { allowed: false; reason: string };
  detachAgentLease(reason: string): Promise<void>;
  closeSessionWorkspaces(reason: string): Promise<void>;
  revokeAuthority(reason: string): Promise<void>;
}
