import { randomUUID } from "node:crypto";
import { commitStoreMutation, getStore, type SessionRow, type StoreData, type StoredScheduledJobRow } from "./db.js";
import { notifyPolicyChanged } from "./policy-generation.js";
import { deriveWorkspaceCapabilityAssociation } from "./derived-project-authority.js";
export { deriveWorkspaceCapabilityAssociation } from "./derived-project-authority.js";
import {
  WORKSPACE_CAPABILITY_IDS,
  WorkspaceStoreError,
  type AgentProfileRow,
  type ProjectRow,
  type WorkspaceCapabilityApprovalEventRow,
  type WorkspaceCapabilityAssociationRow,
  type WorkspaceCapabilityId,
  type WorkspacePrivacyMode,
} from "./workspace-types.js";

export const MAX_WORKSPACE_CAPABILITY_APPROVAL_EVENTS = 4_096;

export interface WorkspaceCapabilityDefinition {
  id: WorkspaceCapabilityId;
  privacy_mode: WorkspacePrivacyMode;
  risk: "global-resources" | "host-execution" | "authenticated-browser" | "protected-automation";
}

export const WORKSPACE_CAPABILITY_REGISTRY: Readonly<Record<WorkspaceCapabilityId, WorkspaceCapabilityDefinition>> = Object.freeze({
  "wayang.standard-resources.v1": Object.freeze({
    id: "wayang.standard-resources.v1",
    privacy_mode: "standard",
    risk: "global-resources",
  }),
  "wayang.standard-browser.v1": Object.freeze({
    id: "wayang.standard-browser.v1",
    privacy_mode: "standard",
    risk: "authenticated-browser",
  }),
  "wayang.host-execution.v1": Object.freeze({
    id: "wayang.host-execution.v1",
    privacy_mode: "standard",
    risk: "host-execution",
  }),
  "wayang.protected-browser.v1": Object.freeze({
    id: "wayang.protected-browser.v1",
    privacy_mode: "protected",
    risk: "authenticated-browser",
  }),
  "wayang.protected-automation.v1": Object.freeze({
    id: "wayang.protected-automation.v1",
    privacy_mode: "protected",
    risk: "protected-automation",
  }),
});

export interface WorkspaceCapabilityResolutionInput {
  capability_id: WorkspaceCapabilityId;
  project_id: string;
  agent_profile_id: string;
}

export interface WorkspaceCapabilityPairWitness {
  readonly capability: WorkspaceCapabilityDefinition;
  readonly project: ProjectRow;
  readonly profile: AgentProfileRow;
  readonly association: WorkspaceCapabilityAssociationRow;
}

export type WorkspaceCapabilityDenialReason =
  | "unknown_capability"
  | "project_not_found"
  | "profile_not_found"
  | "incompatible_privacy_mode"
  | "profile_disabled"
  | "profile_not_allowed"
  | "stale_association_revision";

export type WorkspaceCapabilityResolution =
  | ({ authorized: true } & WorkspaceCapabilityPairWitness)
  | { authorized: false; reason: WorkspaceCapabilityDenialReason };

export type WorkspaceCapabilityRevocationResult =
  | { status: "revoked"; association: WorkspaceCapabilityAssociationRow }
  | { status: "already_revoked"; association: WorkspaceCapabilityAssociationRow };

export function isWorkspaceCapabilityId(value: unknown): value is WorkspaceCapabilityId {
  return typeof value === "string" && (WORKSPACE_CAPABILITY_IDS as readonly string[]).includes(value);
}

/** Missing legacy attribution markers deny rather than inheriting a default. */
export function isSessionCapabilityEligible(session: SessionRow): boolean {
  return session.legacy_private_session_quarantine === false
    && session.legacy_capability_ineligible === false
    && typeof session.agent_profile_id === "string";
}

export function isScheduledJobCapabilityEligible(job: StoredScheduledJobRow): boolean {
  return job.legacy_capability_ineligible === false
    && typeof job.agent_profile_id === "string";
}

export function workspaceCapabilityAssociationKey(
  row: Pick<WorkspaceCapabilityAssociationRow, "project_id" | "agent_profile_id" | "capability_id">,
): string {
  return `${row.project_id}\u0000${row.agent_profile_id}\u0000${row.capability_id}`;
}

function cloneProject(project: ProjectRow): ProjectRow {
  return {
    ...project,
    access_policy: {
      ...project.access_policy,
      allowed_agent_profile_ids: project.access_policy.allowed_agent_profile_ids
        ? [...project.access_policy.allowed_agent_profile_ids]
        : null,
    },
  };
}

function cloneProfile(profile: AgentProfileRow): AgentProfileRow {
  return {
    ...profile,
    allowed_tools: profile.allowed_tools ? [...profile.allowed_tools] : null,
    allowed_extensions: profile.allowed_extensions ? [...profile.allowed_extensions] : null,
  };
}

function immutableWitness(
  capability: WorkspaceCapabilityDefinition,
  project: ProjectRow,
  profile: AgentProfileRow,
  association: WorkspaceCapabilityAssociationRow,
): WorkspaceCapabilityPairWitness {
  const projectCopy = cloneProject(project);
  if (projectCopy.access_policy.allowed_agent_profile_ids) Object.freeze(projectCopy.access_policy.allowed_agent_profile_ids);
  Object.freeze(projectCopy.access_policy);
  Object.freeze(projectCopy);
  const profileCopy = cloneProfile(profile);
  if (profileCopy.allowed_tools) Object.freeze(profileCopy.allowed_tools);
  if (profileCopy.allowed_extensions) Object.freeze(profileCopy.allowed_extensions);
  Object.freeze(profileCopy);
  return Object.freeze({
    capability,
    project: projectCopy,
    profile: profileCopy,
    association: Object.freeze({ ...association }),
  });
}

export function isWorkspaceCapabilityCompatible(capabilityId: WorkspaceCapabilityId, project: ProjectRow): boolean {
  return WORKSPACE_CAPABILITY_REGISTRY[capabilityId].privacy_mode === project.access_policy.privacy_mode;
}

export function projectAllowsAgentProfile(project: ProjectRow, agentProfileId: string): boolean {
  const allowed = project.access_policy.allowed_agent_profile_ids;
  return allowed === null || allowed.includes(agentProfileId);
}

export function findWorkspaceCapabilityAssociation(
  store: StoreData,
  input: WorkspaceCapabilityResolutionInput,
): WorkspaceCapabilityAssociationRow | undefined {
  return store.workspaceCapabilityAssociations.find((row) =>
    row.project_id === input.project_id
    && row.agent_profile_id === input.agent_profile_id
    && row.capability_id === input.capability_id);
}

/** Generic durable resolver. Provider/model and source runtime identity are deliberately absent. */
export function resolveWorkspaceCapability(input: WorkspaceCapabilityResolutionInput): WorkspaceCapabilityResolution {
  if (!isWorkspaceCapabilityId(input.capability_id)) return { authorized: false, reason: "unknown_capability" };
  const store = getStore();
  const project = store.projects.find((candidate) => candidate.id === input.project_id);
  if (!project) return { authorized: false, reason: "project_not_found" };
  const profile = store.agentProfiles.find((candidate) => candidate.id === input.agent_profile_id);
  if (!profile) return { authorized: false, reason: "profile_not_found" };
  if (!isWorkspaceCapabilityCompatible(input.capability_id, project)) {
    return { authorized: false, reason: "incompatible_privacy_mode" };
  }
  if (!profile.enabled) return { authorized: false, reason: "profile_disabled" };
  if (!projectAllowsAgentProfile(project, profile.id)) return { authorized: false, reason: "profile_not_allowed" };
  // Project privacy + exact enabled/allowed profile are the complete live
  // authority model. Legacy per-pair association rows and PIN approval history
  // are intentionally ignored and retained only as inert migration data.
  const association = deriveWorkspaceCapabilityAssociation(input, project, profile);
  return Object.freeze({
    authorized: true as const,
    ...immutableWitness(WORKSPACE_CAPABILITY_REGISTRY[input.capability_id], project, profile, association),
  });
}

/** Reauthorizes an older backend witness and rejects every stale association revision. */
export function resolveCurrentWorkspaceCapabilityWitness(witness: WorkspaceCapabilityPairWitness): WorkspaceCapabilityResolution {
  const resolved = resolveWorkspaceCapability({
    capability_id: witness.association.capability_id,
    project_id: witness.association.project_id,
    agent_profile_id: witness.association.agent_profile_id,
  });
  if (!resolved.authorized || resolved.association.revision !== witness.association.revision) {
    return { authorized: false, reason: resolved.authorized ? "stale_association_revision" : resolved.reason };
  }
  return resolved;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new WorkspaceStoreError(`Invalid ${label}`);
  return value;
}

function nextRevision(current: number): number {
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER - 1) {
    throw new WorkspaceStoreError("Workspace capability association revision is exhausted", 409);
  }
  return current + 1;
}

function annotateApprovalRevoked(
  store: StoreData,
  association: WorkspaceCapabilityAssociationRow,
  approvedRevision: number,
  revokedAt: number,
): void {
  for (const event of store.workspaceCapabilityApprovalEvents) {
    if (event.revoked_at === null
      && event.project_id === association.project_id
      && event.agent_profile_id === association.agent_profile_id
      && event.capability_id === association.capability_id
      && event.association_revision === approvedRevision) {
      event.revoked_at = Math.max(revokedAt, event.approved_at);
    }
  }
}

/**
 * Denial primitive for explicit revoke, policy invalidation, and subject deletion.
 * It never consults or requires approval history and must run in the caller's
 * durable transaction before runtime cleanup.
 */
export function tombstoneWorkspaceCapabilityAssociationsDraft(
  store: StoreData,
  predicate: (association: WorkspaceCapabilityAssociationRow) => boolean,
  revokedAt = Date.now(),
): WorkspaceCapabilityAssociationRow[] {
  requireTimestamp(revokedAt, "revocation time");
  const changed: WorkspaceCapabilityAssociationRow[] = [];
  for (const association of store.workspaceCapabilityAssociations) {
    if (!association.active || !predicate(association)) continue;
    const approvedRevision = association.revision;
    association.revision = nextRevision(association.revision);
    association.active = false;
    association.revoked_at = Math.max(revokedAt, association.approved_at);
    association.updated_at = association.revoked_at;
    annotateApprovalRevoked(store, association, approvedRevision, association.revoked_at);
    changed.push({ ...association });
  }
  return changed;
}

export function commitWorkspaceCapabilityActivation(input: WorkspaceCapabilityResolutionInput & {
  operation_digest: string;
  approved_at?: number;
}): WorkspaceCapabilityAssociationRow {
  if (!isWorkspaceCapabilityId(input.capability_id)) throw new WorkspaceStoreError("Unknown workspace capability");
  if (typeof input.operation_digest !== "string" || !/^[a-f0-9]{64}$/u.test(input.operation_digest)) {
    throw new WorkspaceStoreError("operation_digest must be a SHA-256 digest");
  }
  const now = requireTimestamp(input.approved_at ?? Date.now(), "approval time");
  const association = commitStoreMutation((draft) => {
    // Saturation must deny before association state changes. It can never block denial paths.
    if (draft.workspaceCapabilityApprovalEvents.length >= MAX_WORKSPACE_CAPABILITY_APPROVAL_EVENTS) {
      throw new WorkspaceStoreError("Workspace capability approval history is full", 409);
    }
    const project = draft.projects.find((candidate) => candidate.id === input.project_id);
    const profile = draft.agentProfiles.find((candidate) => candidate.id === input.agent_profile_id);
    if (!project) throw new WorkspaceStoreError("Project not found", 404);
    if (!profile) throw new WorkspaceStoreError("Agent profile not found", 404);
    if (!isWorkspaceCapabilityCompatible(input.capability_id, project)) {
      throw new WorkspaceStoreError("Capability is incompatible with project privacy mode", 409);
    }
    if (!profile.enabled) throw new WorkspaceStoreError("Agent profile must be enabled", 409);
    if (!projectAllowsAgentProfile(project, profile.id)) {
      throw new WorkspaceStoreError("Agent profile is not allowed for this project", 403);
    }
    let row = findWorkspaceCapabilityAssociation(draft, input);
    if (row?.active) throw new WorkspaceStoreError("Workspace capability association is already active", 409);
    if (row) {
      row.revision = nextRevision(row.revision);
      row.active = true;
      row.approved_at = now;
      row.revoked_at = null;
      row.updated_at = now;
    } else {
      row = {
        project_id: project.id,
        agent_profile_id: profile.id,
        capability_id: input.capability_id,
        revision: 1,
        active: true,
        approved_at: now,
        revoked_at: null,
        updated_at: now,
      };
      draft.workspaceCapabilityAssociations.push(row);
      draft.workspaceCapabilityAssociations.sort((left, right) => {
        const leftKey = workspaceCapabilityAssociationKey(left);
        const rightKey = workspaceCapabilityAssociationKey(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    }
    const event: WorkspaceCapabilityApprovalEventRow = {
      id: randomUUID(),
      project_id: project.id,
      agent_profile_id: profile.id,
      capability_id: input.capability_id,
      association_revision: row.revision,
      operation_digest: input.operation_digest,
      approved_at: now,
      revoked_at: null,
    };
    draft.workspaceCapabilityApprovalEvents.push(event);
    return { ...row };
  });
  notifyPolicyChanged();
  return association;
}

export function revokeWorkspaceCapabilityAssociation(
  input: WorkspaceCapabilityResolutionInput & { expected_revision: number; revoked_at?: number },
): WorkspaceCapabilityRevocationResult {
  if (!isWorkspaceCapabilityId(input.capability_id)) throw new WorkspaceStoreError("Unknown workspace capability");
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) {
    throw new WorkspaceStoreError("expected_revision must be a positive integer");
  }
  const now = requireTimestamp(input.revoked_at ?? Date.now(), "revocation time");
  const result = commitStoreMutation((draft) => {
    const row = findWorkspaceCapabilityAssociation(draft, input);
    if (!row) throw new WorkspaceStoreError("Workspace capability association not found", 404);
    if (!row.active && row.revision === input.expected_revision + 1) {
      return { status: "already_revoked", association: { ...row } } as const;
    }
    if (!row.active || row.revision !== input.expected_revision) {
      throw new WorkspaceStoreError("Workspace capability association revision conflict", 409);
    }
    tombstoneWorkspaceCapabilityAssociationsDraft(draft, (candidate) => candidate === row, now);
    return { status: "revoked", association: { ...row } } as const;
  });
  if (result.status === "revoked") notifyPolicyChanged();
  return result;
}

export function listWorkspaceCapabilityAssociations(): WorkspaceCapabilityAssociationRow[] {
  return getStore().workspaceCapabilityAssociations.map((row) => ({ ...row }));
}

export function listWorkspaceCapabilityApprovalEvents(limit = MAX_WORKSPACE_CAPABILITY_APPROVAL_EVENTS): WorkspaceCapabilityApprovalEventRow[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_WORKSPACE_CAPABILITY_APPROVAL_EVENTS) {
    throw new WorkspaceStoreError("Invalid workspace capability approval history limit");
  }
  if (limit === 0) return [];
  return getStore().workspaceCapabilityApprovalEvents.slice(-limit).map((row) => ({ ...row }));
}
