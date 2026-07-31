export const STORE_SCHEMA_VERSION = 2;

/**
 * Legacy stable IDs retained so schema-1 stores keep their references. Names
 * never confer authority. The exact Wren ID plus its non-user-settable
 * historical kind is also the narrow interactive Standard-project Unix-IPC
 * compatibility identity; it never grants host execution or capabilities.
 */
export const WREN_AGENT_PROFILE_ID = "00000000-0000-4000-8000-000000000001";
export const NEUTRAL_AGENT_PROFILE_ID = "00000000-0000-4000-8000-000000000002";

export const WORKSPACE_CAPABILITY_IDS = [
  "wayang.standard-resources.v1",
  "wayang.host-execution.v1",
  "wayang.protected-browser.v1",
] as const;

export type WorkspaceCapabilityId = typeof WORKSPACE_CAPABILITY_IDS[number];
export type WorkspacePrivacyMode = "standard" | "protected";
export type MemoryAccess = "none" | "read" | "read_write";
export type ResourceMode = "standard" | "project_only" | "custom";

/** Historical migration metadata. Only the exact seeded Wren ID+kind pair may
 * participate in the narrow Unix-IPC compatibility check. */
export type BuiltinAgentKind = "wren" | "neutral" | null;

export interface WorkspaceSettingsRow {
  default_agent_profile_id: string;
}

export interface AgentProfileRow {
  id: string;
  name: string;
  description: string | null;
  /** Historical migration metadata; ordinary CRUD cannot set or copy it. */
  builtin_kind: BuiltinAgentKind;
  /** @deprecated Deletion is governed by generic workspace references. */
  deletable: boolean;
  enabled: boolean;
  resource_mode: ResourceMode;
  instructions: string | null;
  memory_access: MemoryAccess;
  default_provider: string | null;
  default_model: string | null;
  allowed_tools: string[] | null;
  allowed_extensions: string[] | null;
  created_at: number;
  updated_at: number;
}

export interface PendingAgentSwitch {
  switch_id: string;
  from_agent_profile_id: string | null;
  from_provider: string | null;
  from_model: string | null;
  to_agent_profile_id: string;
  target_provider: string;
  target_model: string;
  changed_at: number;
}

export interface ProjectAccessPolicy {
  privacy_mode: WorkspacePrivacyMode;
  allowed_agent_profile_ids: string[] | null;
}

export interface ProjectRow {
  id: string;
  cwd: string;
  name: string;
  description: string | null;
  color: string | null;
  default_agent_profile_id: string;
  default_provider: string | null;
  default_model: string | null;
  access_policy: ProjectAccessPolicy;
  created_at: number;
  updated_at: number;
}

/**
 * Sole live durable workspace-capability authority and monotonic ABA clock.
 * Inactive rows are retained tombstones during ordinary operation.
 */
export interface WorkspaceCapabilityAssociationRow {
  project_id: string;
  agent_profile_id: string;
  capability_id: WorkspaceCapabilityId;
  revision: number;
  active: boolean;
  approved_at: number;
  revoked_at: number | null;
  updated_at: number;
}

/** Append-only PIN approval history. The resolver never consults this row. */
export interface WorkspaceCapabilityApprovalEventRow {
  id: string;
  project_id: string;
  agent_profile_id: string;
  capability_id: WorkspaceCapabilityId;
  association_revision: number;
  operation_digest: string;
  approved_at: number;
  /** Mutable audit annotation; never live authority. */
  revoked_at: number | null;
}

export class WorkspaceStoreError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "WorkspaceStoreError";
  }
}
