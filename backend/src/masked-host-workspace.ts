import { getStore } from "./db.js";
import type { SessionRow } from "./sessions.js";
import { isLegacyWrenStandardRuntime } from "./legacy-wren.js";
import {
  isSessionCapabilityEligible,
  resolveWorkspaceCapability,
} from "./workspace-capabilities.js";
import type { AgentProfileRow, ProjectRow } from "./workspace-types.js";

export const MASKED_HOST_WORKSPACE_CAPABILITY_ID = "wayang.masked-host-workspace.v1" as const;
export const STANDARD_RESOURCES_CAPABILITY_ID = "wayang.standard-resources.v1" as const;

export interface ExactMaskedHostWorkspaceWitness {
  readonly capabilityId: typeof MASKED_HOST_WORKSPACE_CAPABILITY_ID;
  readonly projectId: string;
  readonly agentProfileId: string;
  readonly standardResourcesAssociationRevision: number;
  readonly maskedWorkspaceAssociationRevision: number;
  readonly authoritySource: "associations" | "legacy-activated-home";
}

export function historicalAgentPairIsCutOver(projectId: string, agentProfileId: string): boolean {
  return getStore().historicalAgentCutovers.some((row) => (
    row.project_id === projectId && row.agent_profile_id === agentProfileId
  ));
}

export interface MaskedHostWorkspaceResolutionInput {
  session: SessionRow;
  project: ProjectRow;
  profile: AgentProfileRow;
}

/**
 * Resolve the broad-but-masked ordinary-host workspace. Generic authority
 * requires both exact associations. The activated historical home keeps its
 * pre-cutover fallback until a durable per-pair cutover marker is introduced.
 */
export function resolveMaskedHostWorkspaceWitness(
  input: MaskedHostWorkspaceResolutionInput,
): ExactMaskedHostWorkspaceWitness | null {
  const { session, project, profile } = input;
  if (!isSessionCapabilityEligible(session) || session.pending_agent_switch !== null
    || session.agent_profile_id !== profile.id || session.cwd !== project.cwd
    || project.access_policy.privacy_mode !== "standard") return null;

  const standard = resolveWorkspaceCapability({
    capability_id: STANDARD_RESOURCES_CAPABILITY_ID,
    project_id: project.id,
    agent_profile_id: profile.id,
  });
  const masked = resolveWorkspaceCapability({
    capability_id: MASKED_HOST_WORKSPACE_CAPABILITY_ID,
    project_id: project.id,
    agent_profile_id: profile.id,
  });
  if (standard.authorized && masked.authorized) {
    return Object.freeze({
      capabilityId: MASKED_HOST_WORKSPACE_CAPABILITY_ID,
      projectId: project.id,
      agentProfileId: profile.id,
      standardResourcesAssociationRevision: standard.association.revision,
      maskedWorkspaceAssociationRevision: masked.association.revision,
      authoritySource: "associations" as const,
    });
  }

  if (historicalAgentPairIsCutOver(project.id, profile.id)) return null;
  if (!isLegacyWrenStandardRuntime({ session, project, profile })) return null;
  return Object.freeze({
    capabilityId: MASKED_HOST_WORKSPACE_CAPABILITY_ID,
    projectId: project.id,
    agentProfileId: profile.id,
    standardResourcesAssociationRevision: 0,
    maskedWorkspaceAssociationRevision: 0,
    authoritySource: "legacy-activated-home" as const,
  });
}
