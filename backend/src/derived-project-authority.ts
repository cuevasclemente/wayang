import { createHash } from "node:crypto";
import type {
  AgentProfileRow,
  ProjectRow,
  WorkspaceCapabilityAssociationRow,
  WorkspaceCapabilityId,
} from "./workspace-types.js";

export interface DerivedProjectAuthorityInput {
  capability_id: WorkspaceCapabilityId;
  project_id: string;
  agent_profile_id: string;
}

/** Stable equality witness for privacy/RBAC-derived authority; not an ordering counter. */
export function deriveWorkspaceCapabilityAssociation(
  input: DerivedProjectAuthorityInput,
  project: ProjectRow,
  profile: AgentProfileRow,
): WorkspaceCapabilityAssociationRow {
  const authorityState = JSON.stringify({
    capability_id: input.capability_id,
    project_id: project.id,
    privacy_mode: project.access_policy.privacy_mode,
    allowed_agent_profile_ids: project.access_policy.allowed_agent_profile_ids
      ? [...project.access_policy.allowed_agent_profile_ids].sort()
      : null,
    agent_profile_id: profile.id,
    profile_enabled: profile.enabled,
  });
  const digest = createHash("sha256").update(authorityState).digest();
  const revision = digest.readUIntBE(0, 6) + 1;
  return {
    project_id: project.id,
    agent_profile_id: profile.id,
    capability_id: input.capability_id,
    revision,
    active: true,
    approved_at: 0,
    revoked_at: null,
    updated_at: 0,
  };
}
