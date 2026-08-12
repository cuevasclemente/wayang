import { randomUUID } from "node:crypto";
import { commitStoreMutation, getStore, type SessionRow, type StoreData, type StoredScheduledJobRow } from "./db.js";
import { notifyPolicyChanged } from "./policy-generation.js";
import { blockProtectedAutomationJobsDraft } from "./protected-automation/draft-lifecycle.js";
import { tombstoneWorkspaceCapabilityAssociationsDraft } from "./workspace-capabilities.js";
import {
  WorkspaceStoreError,
  type AgentProfileRow,
  type MemoryAccess,
  type ResourceMode,
} from "./workspace-types.js";

export interface AgentProfileCreateInput {
  name: string;
  description?: string | null;
  resource_mode?: ResourceMode;
  instructions?: string | null;
  memory_access?: MemoryAccess;
  default_provider?: string | null;
  default_model?: string | null;
}

export interface AgentProfileUpdateInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  resource_mode?: ResourceMode;
  instructions?: string | null;
  memory_access?: MemoryAccess;
  default_provider?: string | null;
  default_model?: string | null;
}

function cloneProfile(profile: AgentProfileRow): AgentProfileRow {
  return {
    ...profile,
    allowed_tools: profile.allowed_tools ? [...profile.allowed_tools] : null,
    allowed_extensions: profile.allowed_extensions ? [...profile.allowed_extensions] : null,
  };
}

function text(value: unknown, field: string, max: number, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw new WorkspaceStoreError(`${field} must be a string${nullable ? " or null" : ""}`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (nullable) return null;
    throw new WorkspaceStoreError(`${field} is required`);
  }
  if (trimmed.length > max) throw new WorkspaceStoreError(`${field} is too long`);
  return trimmed;
}

function instructions(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new WorkspaceStoreError("instructions must be a string or null");
  if (Buffer.byteLength(value, "utf-8") > 256 * 1024) throw new WorkspaceStoreError("instructions are too large");
  return value;
}

function validateDefaultPair(provider: unknown, model: unknown): { provider: string | null; model: string | null } {
  if (provider == null && model == null) return { provider: null, model: null };
  if (typeof provider !== "string" || !provider.trim() || typeof model !== "string" || !model.trim()) {
    throw new WorkspaceStoreError("default_provider and default_model must both be set or both be null");
  }
  return { provider: provider.trim(), model: model.trim() };
}

function rejectCapabilityFields(input: object): void {
  if (
    Object.hasOwn(input, "capability_grants")
    || Object.hasOwn(input, "authorization_revision")
    || Object.hasOwn(input, "workspaceCapabilityAssociations")
    || Object.hasOwn(input, "workspaceCapabilityApprovalEvents")
    || Object.hasOwn(input, "capability_associations")
  ) {
    throw new WorkspaceStoreError("Capability authority cannot be changed through ordinary agent profile CRUD", 403);
  }
}

function ensureUniqueName(name: string, exceptId?: string): void {
  const collision = getStore().agentProfiles.find((profile) => profile.id !== exceptId && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (collision) throw new WorkspaceStoreError("An agent profile with that name already exists", 409);
}

function requireEnabledReplacement(id: string | undefined, replacedId: string): AgentProfileRow {
  if (!id) throw new WorkspaceStoreError("replacement_agent_profile_id is required because this profile is in use", 409);
  const replacement = getStore().agentProfiles.find((profile) => profile.id === id);
  if (!replacement) throw new WorkspaceStoreError("Replacement agent profile not found", 404);
  if (!replacement.enabled) throw new WorkspaceStoreError("Replacement agent profile must be enabled", 409);
  if (replacement.id === replacedId) throw new WorkspaceStoreError("Replacement agent profile must be different", 409);
  return replacement;
}

function isReferencedByPendingSwitch(id: string): boolean {
  return getStore().sessions.some((session: SessionRow) =>
    session.pending_agent_switch?.from_agent_profile_id === id
    || session.pending_agent_switch?.to_agent_profile_id === id);
}

function rejectPendingSwitchReference(id: string): void {
  if (isReferencedByPendingSwitch(id)) {
    throw new WorkspaceStoreError("Agent profile cannot be updated or deleted while an agent switch references it", 409);
  }
}

function isInUse(id: string): boolean {
  const store = getStore();
  return store.workspaceSettings.default_agent_profile_id === id
    || store.projects.some((project) => project.default_agent_profile_id === id || project.access_policy.allowed_agent_profile_ids?.includes(id))
    || store.sessions.some((session: SessionRow) => session.agent_profile_id === id)
    || store.scheduledJobs.some((job: StoredScheduledJobRow) => job.agent_profile_id === id)
    || store.protectedAutomationJobs.some((job) => job.agent_profile_id === id)
    || store.protectedAutomationRuns.some((run) => run.agent_profile_id === id);
}

function hasProtectedAutomationReferences(id: string): boolean {
  const store = getStore();
  return store.protectedAutomationJobs.some((job) => job.agent_profile_id === id)
    || store.protectedAutomationRuns.some((run) => run.agent_profile_id === id);
}

function hasMessagingReferences(id: string): boolean {
  return getStore().messagingEndpoints.some((endpoint) => endpoint.agent_profile_id === id);
}

function isDefaultInUse(id: string): boolean {
  const store = getStore();
  return store.workspaceSettings.default_agent_profile_id === id
    || store.projects.some((project) => project.default_agent_profile_id === id);
}

function replaceReferences(store: StoreData, fromId: string, toId: string): void {
  for (const project of store.projects) {
    let changed = false;
    if (project.default_agent_profile_id === fromId) {
      project.default_agent_profile_id = toId;
      changed = true;
    }
    const allowed = project.access_policy.allowed_agent_profile_ids;
    if (allowed?.includes(fromId)) {
      project.access_policy.allowed_agent_profile_ids = [...new Set(allowed.map((id) => id === fromId ? toId : id))];
      changed = true;
    }
    if (changed) project.updated_at = Date.now();
  }
  if (store.workspaceSettings.default_agent_profile_id === fromId) {
    store.workspaceSettings.default_agent_profile_id = toId;
  }
  for (const session of store.sessions) {
    if (session.agent_profile_id === fromId) {
      session.agent_profile_id = toId;
      session.legacy_capability_ineligible = true;
    }
  }
  for (const job of store.scheduledJobs) {
    if (job.agent_profile_id === fromId) {
      job.agent_profile_id = toId;
      job.legacy_capability_ineligible = true;
    }
  }
}

export function listAgentProfiles(): AgentProfileRow[] {
  return getStore().agentProfiles.map(cloneProfile).sort((a, b) => a.name.localeCompare(b.name));
}

export function getWorkspaceDefaultAgentProfileId(): string {
  return getStore().workspaceSettings.default_agent_profile_id;
}

export function setWorkspaceDefaultAgentProfile(id: string): string {
  const profile = getStore().agentProfiles.find((candidate) => candidate.id === id);
  if (!profile) throw new WorkspaceStoreError("Workspace default agent profile not found", 404);
  if (!profile.enabled) throw new WorkspaceStoreError("Workspace default agent profile must be enabled", 409);
  return commitStoreMutation((draft) => {
    const target = draft.agentProfiles.find((candidate) => candidate.id === id);
    if (!target?.enabled) throw new WorkspaceStoreError("Workspace default agent profile changed concurrently", 409);
    draft.workspaceSettings.default_agent_profile_id = id;
    return id;
  });
}

export function getAgentProfile(id: string): AgentProfileRow | undefined {
  const profile = getStore().agentProfiles.find((candidate) => candidate.id === id);
  return profile ? cloneProfile(profile) : undefined;
}

export function createAgentProfile(input: AgentProfileCreateInput): AgentProfileRow {
  rejectCapabilityFields(input);
  const name = text(input.name, "name", 80, false)!;
  ensureUniqueName(name);
  const pair = validateDefaultPair(input.default_provider ?? null, input.default_model ?? null);
  const resourceMode = input.resource_mode ?? "project_only";
  if (!["standard", "project_only", "custom"].includes(resourceMode)) {
    throw new WorkspaceStoreError("Invalid resource_mode");
  }
  const memoryAccess = input.memory_access ?? "none";
  if (!["none", "read", "read_write"].includes(memoryAccess)) throw new WorkspaceStoreError("Invalid memory_access");
  const now = Date.now();
  const profile: AgentProfileRow = {
    id: randomUUID(),
    name,
    description: input.description === undefined ? null : text(input.description, "description", 2_000, true),
    builtin_kind: null,
    deletable: true,
    enabled: true,
    resource_mode: resourceMode,
    instructions: input.instructions === undefined ? null : instructions(input.instructions),
    memory_access: memoryAccess,
    default_provider: pair.provider,
    default_model: pair.model,
    // Restricted-profile resources are reviewed by the runtime owner. CRUD
    // cannot turn arbitrary installed tools/extensions on.
    allowed_tools: [],
    allowed_extensions: [],
    created_at: now,
    updated_at: now,
  };
  return commitStoreMutation((draft) => {
    if (draft.agentProfiles.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new WorkspaceStoreError("An agent profile with that name already exists", 409);
    }
    draft.agentProfiles.push(profile);
    return cloneProfile(profile);
  });
}

export function updateAgentProfile(id: string, input: AgentProfileUpdateInput, replacementAgentProfileId?: string): AgentProfileRow {
  // Kept in the transitional call signature only; disable never rewrites attribution.
  void replacementAgentProfileId;
  rejectCapabilityFields(input);
  const profile = getStore().agentProfiles.find((candidate) => candidate.id === id);
  if (!profile) throw new WorkspaceStoreError("Agent profile not found", 404);
  rejectPendingSwitchReference(id);
  const next = cloneProfile(profile);

  if (input.name !== undefined) {
    const name = text(input.name, "name", 80, false)!;
    ensureUniqueName(name, id);
    next.name = name;
  }
  if (input.description !== undefined) next.description = text(input.description, "description", 2_000, true);
  if (input.instructions !== undefined) next.instructions = instructions(input.instructions);
  if (input.memory_access !== undefined) {
    if (!["none", "read", "read_write"].includes(input.memory_access)) throw new WorkspaceStoreError("Invalid memory_access");
    next.memory_access = input.memory_access;
  }
  if (input.resource_mode !== undefined) {
    if (!["standard", "project_only", "custom"].includes(input.resource_mode)) throw new WorkspaceStoreError("Invalid resource_mode");
    next.resource_mode = input.resource_mode;
  }
  if (input.default_provider !== undefined || input.default_model !== undefined) {
    const pair = validateDefaultPair(
      input.default_provider === undefined ? profile.default_provider : input.default_provider,
      input.default_model === undefined ? profile.default_model : input.default_model,
    );
    next.default_provider = pair.provider;
    next.default_model = pair.model;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new WorkspaceStoreError("enabled must be a boolean");
    if (!input.enabled && profile.enabled && isDefaultInUse(id)) {
      throw new WorkspaceStoreError("Workspace and project defaults must be changed before disabling this profile", 409);
    }
    next.enabled = input.enabled;
  }

  next.updated_at = Date.now();
  const runtimeDefinitionChanged = profile.enabled !== next.enabled
    || profile.resource_mode !== next.resource_mode
    || profile.instructions !== next.instructions
    || profile.memory_access !== next.memory_access
    || profile.default_provider !== next.default_provider
    || profile.default_model !== next.default_model;
  const updated = commitStoreMutation((draft) => {
    const target = draft.agentProfiles.find((candidate) => candidate.id === id);
    if (!target) throw new WorkspaceStoreError("Agent profile not found", 404);
    Object.assign(target, next);
    // Disable and every profile-definition edit preserve the stable-ID
    // associations. Disable persistently pauses exact-pair automation; a
    // replacement profile never receives ownership or capability attribution.
    if (!target.enabled) {
      blockProtectedAutomationJobsDraft(
        draft,
        (job) => job.agent_profile_id === id,
        "agent_profile_disabled",
        next.updated_at,
      );
    }
    return cloneProfile(target);
  });
  if (runtimeDefinitionChanged) notifyPolicyChanged();
  return updated;
}

export function deleteAgentProfile(id: string, replacementAgentProfileId?: string): void {
  const store = getStore();
  const index = store.agentProfiles.findIndex((candidate) => candidate.id === id);
  if (index < 0) throw new WorkspaceStoreError("Agent profile not found", 404);
  rejectPendingSwitchReference(id);
  if (hasProtectedAutomationReferences(id)) {
    throw new WorkspaceStoreError("Agent profile cannot be deleted while protected automation history references its exact stable ID", 409);
  }
  if (hasMessagingReferences(id)) {
    throw new WorkspaceStoreError("Agent profile cannot be deleted while messaging endpoints reference its exact stable ID", 409);
  }
  const replacement = isInUse(id) ? requireEnabledReplacement(replacementAgentProfileId, id) : null;
  commitStoreMutation((draft) => {
    const draftIndex = draft.agentProfiles.findIndex((candidate) => candidate.id === id);
    if (draftIndex < 0) throw new WorkspaceStoreError("Agent profile not found", 404);
    // Replacement attribution/allowlist cleanup cannot transfer authority.
    tombstoneWorkspaceCapabilityAssociationsDraft(draft, (association) => association.agent_profile_id === id);
    if (replacement) replaceReferences(draft, id, replacement.id);
    draft.agentProfiles.splice(draftIndex, 1);
  });
  notifyPolicyChanged();
}
