import type { SessionRow } from "./sessions.js";
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

/**
 * Preserve pre-policy Wren behavior only for the immutable migration-seeded
 * profile in a Standard project. Scheduled runs are eligible. A durable agent
 * switch must finish before the target receives this compatibility authority.
 */
export function isLegacyWrenStandardRuntime(input: {
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
}): boolean {
  const { session, profile, project } = input;
  return isExactLegacyWrenProfile(profile)
    && session.agent_profile_id === profile.id
    && session.pending_agent_switch === null
    && session.legacy_private_session_quarantine === false
    && session.legacy_capability_ineligible === false
    && project.access_policy.privacy_mode === "standard";
}
