import type { SessionRow } from "./sessions.js";
import { getLegacyAgentActivationStatus, type LegacyAgentActivationStatus } from "./legacy-agent-activation.js";
import { WREN_AGENT_PROFILE_ID, type AgentProfileRow, type ProjectRow } from "./workspace-types.js";

export function isExactLegacyWrenProfile(
  profile: Pick<AgentProfileRow, "id" | "builtin_kind" | "enabled"> | null | undefined,
): boolean {
  return Boolean(
    profile
    && profile.id === WREN_AGENT_PROFILE_ID
    && profile.builtin_kind === "wren"
    && profile.enabled === true
  );
}

export interface LegacyWrenStandardRuntimeInput {
  session: Pick<
    SessionRow,
    | "agent_profile_id"
    | "pending_agent_switch"
    | "legacy_private_session_quarantine"
    | "legacy_capability_ineligible"
    | "scheduled_job_id"
    | "scheduled_run_id"
  >;
  profile: Pick<AgentProfileRow, "id" | "builtin_kind" | "enabled">;
  project: Pick<ProjectRow, "access_policy">;
}

/** Historical row/session classifier only. It never authorizes a runtime. */
export function isLegacyWrenStandardRuntimeIdentity(input: LegacyWrenStandardRuntimeInput): boolean {
  const { session, profile, project } = input;
  return isExactLegacyWrenProfile(profile)
    && session.agent_profile_id === profile.id
    && session.pending_agent_switch === null
    && session.legacy_private_session_quarantine === false
    && session.legacy_capability_ineligible === false
    && project.access_policy.privacy_mode === "standard";
}

/**
 * Preserve pre-policy compatibility only on an explicitly activated deployment.
 * Scheduled runs remain eligible so provisioning cannot silently narrow the
 * active home's historical behavior. Store/profile rows alone are insufficient.
 */
export function isLegacyWrenStandardRuntime(
  input: LegacyWrenStandardRuntimeInput,
  activation: Pick<LegacyAgentActivationStatus, "active"> = getLegacyAgentActivationStatus(),
): boolean {
  return activation.active && isLegacyWrenStandardRuntimeIdentity(input);
}
