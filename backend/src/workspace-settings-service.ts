import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  getWorkspaceDefaultAgentProfileId,
  listAgentProfiles,
  updateAgentProfile,
  type AgentProfileCreateInput,
  type AgentProfileUpdateInput,
} from "./agent-profiles.js";
import { getStore } from "./db.js";
import { getInterviewForSession, type InterviewRecord } from "./interviews.js";
import {
  createProject,
  deleteProjectRegistration,
  getProject,
  getProjectRegistrationReferences,
  listProjects,
  projectRegistrationHasBrowserData,
  updateProject,
  type ProjectCreateInput,
  type ProjectUpdateInput,
} from "./projects.js";
import { readProjectInstructions, writeProjectInstructions } from "./project-instructions.js";
import { authorizeProjectAction } from "./policy.js";
import type { RuntimeCleanupFailure, RuntimeMutationImpactLease } from "./runtime-impact.js";
import { getSessionById } from "./sessions.js";
import {
  canonicalizeWorkspaceMutation,
  stableWorkspaceJson,
  WORKSPACE_APPROVAL_TTL_MS,
  workspaceApprovalQuestion,
  workspaceOperationDigest,
  workspaceSha256,
  type CanonicalAgentProfileUpdateMutation,
  type CanonicalProjectUpdateMutation,
  type CanonicalWorkspaceMutation,
  type WorkspaceApprovalPreview,
  type WorkspaceMutationEnvelope,
} from "./workspace-control.js";
import {
  WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL,
  WAYANG_WEBSOCKET_SUBMISSION_CHANNEL,
} from "./interview-provenance.js";
import type { CapabilityAssociationRecord } from "./workspace-capability-approval/types.js";
import {
  WorkspaceStoreError,
  type AgentProfileRow,
  type ProjectAccessPolicy,
  type ProjectRow,
  type WorkspaceCapabilityAssociationRow,
} from "./workspace-types.js";

export type WorkspaceMutationAuthority =
  | { kind: "authenticated_ui" }
  | { kind: "agent_approval"; sourceSessionId: string; requestId: string; submissionId: string };

export interface WorkspaceCapabilityInvalidationPort {
  /** Synchronously latches runtime/control denial after durable tombstoning and before cleanup. */
  latchDenied(input: {
    associations: readonly CapabilityAssociationRecord[];
    runtimeIds: readonly string[];
    reason: "ordinary_workspace_mutation";
  }): void;
  /** Best-effort teardown; failure can never restore the already durable denial. */
  cleanupAfterDenial(input: { runtimeIds: readonly string[] }): Promise<void>;
}

export type WorkspaceReadAction =
  | { action: "list_projects" }
  | { action: "get_project"; id: string }
  | { action: "list_agent_profiles" }
  | { action: "get_agent_profile"; id: string }
  | { action: "get_project_instructions_metadata"; project_id: string }
  | { action: "get_project_instructions"; project_id: string };

interface PreparedMutation {
  canonical: CanonicalWorkspaceMutation;
  precondition: { kind: string; sha256: string };
  summary: string;
  target: { id?: string; label: string; path?: string };
  warning?: string;
  projectCwd?: string;
  profileId?: string;
}

interface IssuedWorkspacePreview {
  sourceSessionId: string;
  operationDigest: string;
  envelope: WorkspaceMutationEnvelope;
  preview: WorkspaceApprovalPreview;
  canonical: CanonicalWorkspaceMutation;
  precondition: PreparedMutation["precondition"];
  issuedAt: number;
  expiresAt: number;
}

const MAX_LIST_RESULTS = 200;
const MAX_ISSUED_WORKSPACE_PREVIEWS = 512;

// Loaded only when a mutation actually needs a lease. This avoids making the
// pi runtime assembly module and runtime-impact adapter initialize through a
// circular static dependency merely because custom tool definitions are built.
async function runtimeImpact() {
  return (await import("./runtime-impact.js")).runtimeImpactService;
}

function withoutInstructions(profile: AgentProfileRow): Omit<AgentProfileRow, "instructions"> {
  const { instructions: _instructions, ...safe } = profile;
  return safe;
}

function requireStandardInteractiveSource(sourceSessionId: string): void {
  const row = getSessionById(sourceSessionId);
  if (!row) throw new WorkspaceStoreError("Workspace control source session was not found", 403);
  if (row.scheduled_job_id !== null || row.scheduled_run_id !== null) {
    throw new WorkspaceStoreError("Scheduled sessions cannot use workspace control", 403);
  }
  if (typeof row.agent_profile_id !== "string" || !row.agent_profile_id) {
    throw new WorkspaceStoreError("Workspace control source profile is missing", 403);
  }
  const authorization = authorizeProjectAction({ cwd: row.cwd, actor: "interactive", agentProfileId: row.agent_profile_id });
  if (!authorization.allowed || !authorization.agentProfile) {
    throw new WorkspaceStoreError("Workspace control source session is no longer authorized", 403);
  }
  if (authorization.agentProfile.resource_mode !== "standard") {
    throw new WorkspaceStoreError("Restricted profiles cannot use workspace control", 403);
  }
}

function requireProfile(id: string, label = "Agent profile"): AgentProfileRow {
  const profile = getAgentProfile(id);
  if (!profile) throw new WorkspaceStoreError(`${label} not found`, 404);
  return profile;
}

function requireEnabledProfile(id: string): AgentProfileRow {
  const profile = requireProfile(id, "Default agent profile");
  if (!profile.enabled) throw new WorkspaceStoreError("Default agent profile must be enabled", 409);
  return profile;
}

function validatePair(provider: string | null, model: string | null): void {
  if ((provider === null) !== (model === null)) throw new WorkspaceStoreError("default_provider and default_model must both be set or both be null");
}

function validatePolicy(policy: ProjectAccessPolicy, defaultProfileId: string): void {
  if (policy.privacy_mode === "protected" && (!policy.allowed_agent_profile_ids || policy.allowed_agent_profile_ids.length === 0)) {
    throw new WorkspaceStoreError("Protected projects require a nonempty agent allowlist");
  }
  if (policy.allowed_agent_profile_ids && !policy.allowed_agent_profile_ids.includes(defaultProfileId)) {
    throw new WorkspaceStoreError("The default agent profile must be in the project allowlist");
  }
  for (const id of policy.allowed_agent_profile_ids ?? []) requireProfile(id, "Allowed agent profile");
}

function canonicalProjectState(project: ProjectRow): ProjectRow {
  return {
    ...project,
    access_policy: {
      ...project.access_policy,
      allowed_agent_profile_ids: project.access_policy.allowed_agent_profile_ids
        ? [...project.access_policy.allowed_agent_profile_ids].sort()
        : null,
    },
  };
}

function canonicalProfileState(profile: AgentProfileRow): AgentProfileRow {
  return {
    ...profile,
    allowed_tools: profile.allowed_tools ? [...profile.allowed_tools].sort() : null,
    allowed_extensions: profile.allowed_extensions ? [...profile.allowed_extensions].sort() : null,
  };
}

// Bind the reference topology that can change profile update/delete semantics,
// not volatile display/runtime fields on the referenced rows. Transcript and
// catalog activity must not invalidate an otherwise exact human approval.
function profileReferences(id: string): unknown {
  const store = getStore();
  const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return {
    workspace_default: store.workspaceSettings.default_agent_profile_id === id,
    projects: store.projects
      .filter((project) => project.default_agent_profile_id === id || project.access_policy.allowed_agent_profile_ids?.includes(id))
      .map((project) => ({
        id: project.id,
        default_agent_profile_id: project.default_agent_profile_id,
        allowed_agent_profile_ids: project.access_policy.allowed_agent_profile_ids
          ? [...project.access_policy.allowed_agent_profile_ids].sort()
          : null,
      }))
      .sort(byId),
    sessions: store.sessions
      .filter((session) => session.agent_profile_id === id || session.pending_agent_switch?.from_agent_profile_id === id || session.pending_agent_switch?.to_agent_profile_id === id)
      .map((session) => ({
        id: session.id,
        agent_profile_id: session.agent_profile_id ?? null,
        pending_agent_switch: session.pending_agent_switch ? {
          switch_id: session.pending_agent_switch.switch_id,
          from_agent_profile_id: session.pending_agent_switch.from_agent_profile_id,
          to_agent_profile_id: session.pending_agent_switch.to_agent_profile_id,
        } : null,
      }))
      .sort(byId),
    scheduled_jobs: store.scheduledJobs
      .filter((job) => job.agent_profile_id === id)
      .map((job) => ({ id: job.id, agent_profile_id: job.agent_profile_id }))
      .sort(byId),
    protected_automation_jobs: store.protectedAutomationJobs
      .filter((job) => job.agent_profile_id === id)
      .map((job) => ({ id: job.id, agent_profile_id: job.agent_profile_id }))
      .sort(byId),
    protected_automation_runs: store.protectedAutomationRuns
      .filter((run) => run.agent_profile_id === id)
      .map((run) => ({ id: run.id, agent_profile_id: run.agent_profile_id }))
      .sort(byId),
  };
}

function profileIsInUse(id: string): boolean {
  const refs = profileReferences(id) as {
    workspace_default: boolean;
    projects: unknown[];
    sessions: unknown[];
    scheduled_jobs: unknown[];
    protected_automation_jobs: unknown[];
    protected_automation_runs: unknown[];
  };
  return refs.workspace_default || refs.projects.length > 0 || refs.sessions.length > 0 || refs.scheduled_jobs.length > 0
    || refs.protected_automation_jobs.length > 0 || refs.protected_automation_runs.length > 0;
}

function validateReplacement(replacementId: string | null, replacedId: string): void {
  if (!replacementId) throw new WorkspaceStoreError("replacement_agent_profile_id is required because this profile is in use", 409);
  const replacement = requireProfile(replacementId, "Replacement agent profile");
  if (!replacement.enabled) throw new WorkspaceStoreError("Replacement agent profile must be enabled", 409);
  if (replacement.id === replacedId) throw new WorkspaceStoreError("Replacement agent profile must be different", 409);
}

function ensureUniqueProfileName(name: string, exceptId?: string): void {
  if (listAgentProfiles().some((profile) => profile.id !== exceptId && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new WorkspaceStoreError("An agent profile with that name already exists", 409);
  }
}

function canonicalProjectUpdate(current: ProjectRow, mutation: CanonicalProjectUpdateMutation): CanonicalProjectUpdateMutation {
  const updates = { ...mutation.updates };
  if ("default_provider" in updates || "default_model" in updates) {
    const provider = updates.default_provider === undefined ? current.default_provider : updates.default_provider;
    const model = updates.default_model === undefined ? current.default_model : updates.default_model;
    validatePair(provider, model);
    updates.default_provider = provider;
    updates.default_model = model;
  }
  return { ...mutation, updates };
}

function canonicalProfileUpdate(current: AgentProfileRow, mutation: CanonicalAgentProfileUpdateMutation): CanonicalAgentProfileUpdateMutation {
  const updates = { ...mutation.updates };
  if ("default_provider" in updates || "default_model" in updates) {
    const provider = updates.default_provider === undefined ? current.default_provider : updates.default_provider;
    const model = updates.default_model === undefined ? current.default_model : updates.default_model;
    validatePair(provider, model);
    updates.default_provider = provider;
    updates.default_model = model;
  }
  return { ...mutation, updates };
}

function noChange(before: unknown, after: unknown): boolean {
  return stableWorkspaceJson(before) === stableWorkspaceJson(after);
}

function prepareMutation(raw: unknown): PreparedMutation {
  let canonical = canonicalizeWorkspaceMutation(raw);
  switch (canonical.mutation_type) {
    case "project_create": {
      const mutation = canonical.mutation;
      let stat: fs.Stats;
      try { stat = fs.statSync(mutation.cwd); } catch { throw new WorkspaceStoreError("Project cwd must be an existing directory"); }
      if (!stat.isDirectory()) throw new WorkspaceStoreError("Project cwd must be an existing directory");
      if (listProjects().some((project) => project.cwd === mutation.cwd)) throw new WorkspaceStoreError("A project already exists for that cwd", 409);
      const defaultId = mutation.default_agent_profile_id ?? getWorkspaceDefaultAgentProfileId();
      requireEnabledProfile(defaultId);
      validatePair(mutation.default_provider, mutation.default_model);
      validatePolicy(mutation.access_policy, defaultId);
      const resolved = { ...mutation, name: mutation.name ?? (path.basename(mutation.cwd) || mutation.cwd), default_agent_profile_id: defaultId };
      canonical = { mutation_type: canonical.mutation_type, mutation: resolved };
      return {
        canonical,
        precondition: { kind: "project_cwd_absent", sha256: workspaceSha256({ cwd: mutation.cwd, existing_project_id: null }) },
        summary: `register project ${resolved.name} at ${resolved.cwd} (${resolved.access_policy.privacy_mode})`,
        target: { label: resolved.name, path: resolved.cwd },
        warning: resolved.access_policy.privacy_mode === "protected" ? undefined : "This registration uses Standard privacy policy.",
      };
    }
    case "project_update": {
      const current = getProject(canonical.mutation.id);
      if (!current) throw new WorkspaceStoreError("Project not found", 404);
      const mutation = canonicalProjectUpdate(current, canonical.mutation);
      const next: ProjectRow = {
        ...current,
        ...mutation.updates,
        default_agent_profile_id: mutation.updates.default_agent_profile_id ?? current.default_agent_profile_id,
        default_provider: mutation.updates.default_provider === undefined ? current.default_provider : mutation.updates.default_provider,
        default_model: mutation.updates.default_model === undefined ? current.default_model : mutation.updates.default_model,
        access_policy: mutation.updates.access_policy ?? current.access_policy,
      };
      requireEnabledProfile(next.default_agent_profile_id);
      validatePair(next.default_provider, next.default_model);
      validatePolicy(next.access_policy, next.default_agent_profile_id);
      const comparableCurrent = { ...canonicalProjectState(current), updated_at: 0 };
      const comparableNext = { ...canonicalProjectState(next), updated_at: 0 };
      if (noChange(comparableCurrent, comparableNext)) throw new WorkspaceStoreError("Project update is a no-op", 409);
      canonical = { mutation_type: canonical.mutation_type, mutation };
      const widening = current.access_policy.privacy_mode === "protected" && next.access_policy.privacy_mode === "standard"
        || (current.access_policy.allowed_agent_profile_ids !== null && next.access_policy.allowed_agent_profile_ids === null)
        || Boolean(current.access_policy.allowed_agent_profile_ids && next.access_policy.allowed_agent_profile_ids
          && next.access_policy.allowed_agent_profile_ids.some((id) => !current.access_policy.allowed_agent_profile_ids!.includes(id)));
      return {
        canonical,
        precondition: { kind: "project_row", sha256: workspaceSha256(canonicalProjectState(current)) },
        summary: `update project ${current.name} (${Object.keys(mutation.updates).sort().join(", ")})`,
        target: { id: current.id, label: current.name, path: current.cwd },
        warning: widening ? "This change removes protection or widens the agent allowlist." : undefined,
        projectCwd: current.cwd,
      };
    }
    case "project_delete_registration": {
      const current = getProject(canonical.mutation.id);
      if (!current) throw new WorkspaceStoreError("Project not found", 404);
      if (projectRegistrationHasBrowserData(current.id)) {
        throw new WorkspaceStoreError("Project registration retains managed browser profile data", 409);
      }
      const references = getProjectRegistrationReferences(current.id);
      const blockers = Object.values(references).reduce((sum, ids) => sum + ids.length, 0);
      if (blockers > 0) throw new WorkspaceStoreError("Project registration still has central references", 409);
      return {
        canonical,
        precondition: { kind: "project_row_and_references", sha256: workspaceSha256({ project: canonicalProjectState(current), references }) },
        summary: `delete Wayang registration for ${current.name} at ${current.cwd}; files are retained`,
        target: { id: current.id, label: current.name, path: current.cwd },
        warning: "This deletes the Wayang registration only; project files and other user data are not deleted.",
        projectCwd: current.cwd,
      };
    }
    case "agent_profile_create": {
      const mutation = canonical.mutation;
      ensureUniqueProfileName(mutation.name);
      validatePair(mutation.default_provider, mutation.default_model);
      return {
        canonical,
        precondition: { kind: "profile_name_absent", sha256: workspaceSha256({ casefold_name: mutation.name.toLowerCase(), existing_profile_id: null }) },
        summary: `create restricted agent profile ${mutation.name} (${mutation.resource_mode}, memory ${mutation.memory_access}, instruction bytes ${Buffer.byteLength(mutation.instructions ?? "", "utf8")}, instruction sha256 ${workspaceSha256(mutation.instructions ?? "")})`,
        target: { label: mutation.name },
        warning: mutation.memory_access === "read_write" ? "This profile can write to registered memory roots." : undefined,
      };
    }
    case "agent_profile_update": {
      const current = requireProfile(canonical.mutation.id);
      const mutation = canonicalProfileUpdate(current, canonical.mutation);
      const next: AgentProfileRow = {
        ...current,
        ...mutation.updates,
        default_provider: mutation.updates.default_provider === undefined ? current.default_provider : mutation.updates.default_provider,
        default_model: mutation.updates.default_model === undefined ? current.default_model : mutation.updates.default_model,
      };
      if (mutation.updates.name !== undefined) ensureUniqueProfileName(mutation.updates.name, current.id);
      validatePair(next.default_provider, next.default_model);
      if (!next.enabled && current.enabled) {
        const store = getStore();
        if (store.workspaceSettings.default_agent_profile_id === current.id
          || store.projects.some((project) => project.default_agent_profile_id === current.id)) {
          throw new WorkspaceStoreError("Workspace and project defaults must be changed before disabling this profile", 409);
        }
      }
      if (getStore().sessions.some((session) => session.pending_agent_switch?.from_agent_profile_id === current.id || session.pending_agent_switch?.to_agent_profile_id === current.id)) {
        throw new WorkspaceStoreError("Agent profile cannot be updated while an agent switch references it", 409);
      }
      const comparableCurrent = { ...canonicalProfileState(current), updated_at: 0 };
      const comparableNext = { ...canonicalProfileState(next), updated_at: 0 };
      if (noChange(comparableCurrent, comparableNext)) throw new WorkspaceStoreError("Agent profile update is a no-op", 409);
      canonical = { mutation_type: canonical.mutation_type, mutation };
      const memoryRank = { none: 0, read: 1, read_write: 2 } as const;
      const permissionWidening = memoryRank[next.memory_access] > memoryRank[current.memory_access]
        || (!current.enabled && next.enabled);
      return {
        canonical,
        precondition: { kind: "profile_row_and_references", sha256: workspaceSha256({ profile: canonicalProfileState(current), references: profileReferences(current.id) }) },
        summary: `update agent profile ${current.name} (${Object.keys(mutation.updates).sort().join(", ")}${mutation.updates.instructions !== undefined ? `; instruction bytes ${Buffer.byteLength(mutation.updates.instructions ?? "", "utf8")}, instruction sha256 ${workspaceSha256(mutation.updates.instructions ?? "")}` : ""})`,
        target: { id: current.id, label: current.name },
        warning: permissionWidening
          ? "This change widens the agent profile's permissions or enables it."
          : mutation.updates.enabled === false ? "This disables runtime use but preserves stable-ID attribution and capability associations." : undefined,
        profileId: current.id,
      };
    }
    case "agent_profile_delete": {
      const current = requireProfile(canonical.mutation.id);
      if (getStore().sessions.some((session) => session.pending_agent_switch?.from_agent_profile_id === current.id || session.pending_agent_switch?.to_agent_profile_id === current.id)) {
        throw new WorkspaceStoreError("Agent profile cannot be deleted while an agent switch references it", 409);
      }
      const references = profileReferences(current.id) as {
        protected_automation_jobs: unknown[];
        protected_automation_runs: unknown[];
      };
      if (references.protected_automation_jobs.length > 0 || references.protected_automation_runs.length > 0) {
        throw new WorkspaceStoreError("Agent profile cannot be deleted while protected automation history references its exact stable ID", 409);
      }
      if (profileIsInUse(current.id)) validateReplacement(canonical.mutation.replacement_agent_profile_id, current.id);
      return {
        canonical,
        precondition: { kind: "profile_row_and_references", sha256: workspaceSha256({ profile: canonicalProfileState(current), references: profileReferences(current.id) }) },
        summary: `delete agent profile ${current.name}${canonical.mutation.replacement_agent_profile_id ? " and replace its references" : ""}`,
        target: { id: current.id, label: current.name },
        warning: "This permanently deletes an agent profile registration and may replace central references.",
        profileId: current.id,
      };
    }
    case "project_instructions_write": {
      const project = getProject(canonical.mutation.project_id);
      if (!project) throw new WorkspaceStoreError("Project not found", 404);
      const current = readProjectInstructions(project.id);
      if (current.exists) {
        if (!canonical.mutation.expected_sha256) throw new WorkspaceStoreError("expected_sha256 is required when AGENTS.md exists", 428);
        if (current.sha256 !== canonical.mutation.expected_sha256) throw new WorkspaceStoreError("AGENTS.md changed externally", 412);
      } else if (!canonical.mutation.create_if_missing) throw new WorkspaceStoreError("create_if_missing must be true when AGENTS.md does not exist", 412);
      const nextHash = workspaceSha256(canonical.mutation.text);
      if (current.sha256 === nextHash) throw new WorkspaceStoreError("Project instructions write is a no-op", 409);
      return {
        canonical,
        precondition: { kind: "project_row_and_instruction_hash", sha256: workspaceSha256({ project: canonicalProjectState(project), exists: current.exists, sha256: current.sha256 }) },
        summary: `write AGENTS.md for ${project.name} at ${current.path} (bytes ${Buffer.byteLength(canonical.mutation.text, "utf8")}, sha256 ${nextHash})`,
        target: { id: project.id, label: project.name, path: current.path },
        warning: "Project instructions affect future agent behavior.",
        projectCwd: project.cwd,
      };
    }
  }
}

function envelope(prepared: PreparedMutation, sourceSessionId: string, expiresAt: string): WorkspaceMutationEnvelope {
  return {
    schema_version: 1,
    source_session_id: sourceSessionId,
    mutation_type: prepared.canonical.mutation_type,
    mutation: prepared.canonical.mutation,
    precondition: prepared.precondition,
    expires_at: expiresAt,
  };
}

function previewFromPrepared(prepared: PreparedMutation, sourceSessionId: string, expiresAt: string): WorkspaceApprovalPreview {
  const digest = workspaceOperationDigest(envelope(prepared, sourceSessionId, expiresAt));
  return {
    mutation_type: prepared.canonical.mutation_type,
    summary: prepared.summary,
    target: prepared.target,
    precondition_sha256: prepared.precondition.sha256,
    operation_digest: digest,
    expires_at: expiresAt,
    questionnaire: workspaceApprovalQuestion({ digest, summary: prepared.summary, sourceSessionId, expiresAt, warning: prepared.warning }),
  };
}

function verifyApproval(record: InterviewRecord | undefined, expected: WorkspaceApprovalPreview, issued: IssuedWorkspacePreview, authority: Extract<WorkspaceMutationAuthority, { kind: "agent_approval" }>): void {
  if (!record || (record.status !== "submitted" && record.status !== "delivered")) throw new WorkspaceStoreError("Workspace approval was not submitted", 403);
  if (!record.submission_id || record.submission_id !== authority.submissionId) throw new WorkspaceStoreError("Workspace approval submission does not match", 403);
  if (record.submission_channel !== WAYANG_WEBSOCKET_SUBMISSION_CHANNEL || record.authenticated_principal !== WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL) {
    throw new WorkspaceStoreError("Workspace approval lacks authoritative WebSocket provenance", 403);
  }
  if (record.origin_tool_name !== "questionnaire" && record.origin_tool_name !== "interview") throw new WorkspaceStoreError("Workspace approval has an invalid origin", 403);
  if (stableWorkspaceJson(record.questions) !== stableWorkspaceJson(expected.questionnaire)) throw new WorkspaceStoreError("Workspace approval question does not match the operation", 403);
  const answer = record.answers?.[0];
  if (record.answers?.length !== 1 || !answer || answer.id !== expected.questionnaire[0]!.id || answer.wasCustom || answer.value !== "APPROVE" || answer.label !== "APPROVE" || answer.index !== 0) {
    throw new WorkspaceStoreError("Workspace change was not approved with the predefined APPROVE option", 403);
  }
  const expires = Date.parse(expected.expires_at);
  const submitted = record.submitted_at;
  if (!Number.isFinite(expires) || !submitted
    || record.created_at < issued.issuedAt || submitted < issued.issuedAt
    || submitted < record.created_at || submitted - record.created_at > WORKSPACE_APPROVAL_TTL_MS
    || expires < record.created_at || expires - record.created_at > WORKSPACE_APPROVAL_TTL_MS
    || submitted > expires || Date.now() < issued.issuedAt || Date.now() > expires) {
    throw new WorkspaceStoreError("Workspace approval is stale or expired", 403);
  }
}

function associationKey(row: Pick<WorkspaceCapabilityAssociationRow, "project_id" | "agent_profile_id" | "capability_id">): string {
  return `${row.project_id}\u0000${row.agent_profile_id}\u0000${row.capability_id}`;
}

function plannedInvalidatedAssociationKeys(prepared: PreparedMutation): string[] {
  const store = getStore();
  if (prepared.canonical.mutation_type === "project_update") {
    const mutation = prepared.canonical.mutation;
    const project = store.projects.find((candidate) => candidate.id === mutation.id);
    if (!project) return [];
    const nextPolicy = mutation.updates.access_policy ?? project.access_policy;
    return store.workspaceCapabilityAssociations.filter((association) => {
      if (!association.active || association.project_id !== project.id) return false;
      const compatibleMode = association.capability_id === "wayang.protected-browser.v1"
        || association.capability_id === "wayang.protected-automation.v1"
        ? "protected"
        : "standard";
      return compatibleMode !== nextPolicy.privacy_mode
        || (nextPolicy.allowed_agent_profile_ids !== null
          && !nextPolicy.allowed_agent_profile_ids.includes(association.agent_profile_id));
    }).map(associationKey);
  }
  if (prepared.canonical.mutation_type === "project_delete_registration") {
    const projectId = prepared.canonical.mutation.id;
    return store.workspaceCapabilityAssociations
      .filter((association) => association.active && association.project_id === projectId)
      .map(associationKey);
  }
  if (prepared.canonical.mutation_type === "agent_profile_delete") {
    const profileId = prepared.canonical.mutation.id;
    return store.workspaceCapabilityAssociations
      .filter((association) => association.active && association.agent_profile_id === profileId)
      .map(associationKey);
  }
  // Disable/reenable and every definition/default/instruction edit preserve authority.
  return [];
}

function runtimeIdsForAssociationKeys(keys: readonly string[]): string[] {
  const selected = new Set(keys);
  const store = getStore();
  const pairKeys = new Set(store.workspaceCapabilityAssociations
    .filter((association) => selected.has(associationKey(association)))
    .map((association) => `${association.project_id}\u0000${association.agent_profile_id}`));
  const projectCwds = new Map(store.projects.map((project) => [project.id, project.cwd]));
  return store.sessions.filter((session) => {
    if (typeof session.agent_profile_id !== "string") return false;
    for (const pairKey of pairKeys) {
      const separator = pairKey.indexOf("\u0000");
      const projectId = pairKey.slice(0, separator);
      const profileId = pairKey.slice(separator + 1);
      if (session.cwd === projectCwds.get(projectId) && session.agent_profile_id === profileId) return true;
    }
    return false;
  }).map((session) => session.id).sort();
}

function tombstonedAssociationRecords(keys: readonly string[]): CapabilityAssociationRecord[] {
  const selected = new Set(keys);
  return getStore().workspaceCapabilityAssociations
    .filter((association) => selected.has(associationKey(association)))
    .map((row) => ({
      capabilityId: row.capability_id,
      projectId: row.project_id,
      agentProfileId: row.agent_profile_id,
      revision: row.revision,
      active: row.active,
      approvedAt: row.approved_at,
      revokedAt: row.revoked_at,
      updatedAt: row.updated_at,
    }));
}

async function settleMutation(
  prepared: PreparedMutation,
  invalidation: WorkspaceCapabilityInvalidationPort | undefined,
  onMutationCommitted?: () => void,
): Promise<{ result: unknown; cleanupFailures: RuntimeCleanupFailure[] }> {
  const impact = await runtimeImpact();
  let lease: RuntimeMutationImpactLease | null = prepared.projectCwd
    ? impact.acquireProject(prepared.projectCwd)
    : prepared.profileId ? impact.acquireProfile(prepared.profileId) : null;
  try {
    const current = prepareMutation(prepared.canonical);
    if (current.precondition.sha256 !== prepared.precondition.sha256 || stableWorkspaceJson(current.canonical) !== stableWorkspaceJson(prepared.canonical)) {
      throw new WorkspaceStoreError("Workspace state changed after approval", 409);
    }
    const invalidatedKeys = plannedInvalidatedAssociationKeys(prepared);
    const deniedRuntimeIds = runtimeIdsForAssociationKeys(invalidatedKeys);
    if (invalidatedKeys.length > 0 && !invalidation) {
      throw new WorkspaceStoreError("Capability invalidation runtime latch is unavailable", 503);
    }
    let result: unknown;
    switch (prepared.canonical.mutation_type) {
      case "project_create": result = createProject(prepared.canonical.mutation as ProjectCreateInput); break;
      case "project_update": result = updateProject(prepared.canonical.mutation.id, prepared.canonical.mutation.updates as ProjectUpdateInput); break;
      case "project_delete_registration": deleteProjectRegistration(prepared.canonical.mutation.id); result = { deleted: true, registration_only: true }; break;
      case "agent_profile_create": result = createAgentProfile(prepared.canonical.mutation as AgentProfileCreateInput); break;
      case "agent_profile_update": result = updateAgentProfile(prepared.canonical.mutation.id, prepared.canonical.mutation.updates as AgentProfileUpdateInput, prepared.canonical.mutation.replacement_agent_profile_id ?? undefined); break;
      case "agent_profile_delete": deleteAgentProfile(prepared.canonical.mutation.id, prepared.canonical.mutation.replacement_agent_profile_id ?? undefined); result = { deleted: true }; break;
      case "project_instructions_write": {
        const written = writeProjectInstructions(prepared.canonical.mutation.project_id, {
          text: prepared.canonical.mutation.text,
          expected_sha256: prepared.canonical.mutation.expected_sha256,
          create_if_missing: prepared.canonical.mutation.create_if_missing,
        });
        result = { path: written.path, exists: written.exists, sha256: written.sha256, git_tracked: written.git_tracked, git_changed: written.git_changed };
        break;
      }
    }
    // At this point the atomic store mutation or guarded file replacement has
    // succeeded. Consume issuance before post-commit idle-runtime cleanup so a
    // cleanup error cannot leave reusable authority for an already-applied op.
    onMutationCommitted?.();
    const runtimeIds = lease?.affected_session_ids ?? [];
    if (invalidatedKeys.length > 0) {
      invalidation!.latchDenied({
        associations: tombstonedAssociationRecords(invalidatedKeys),
        runtimeIds: deniedRuntimeIds,
        reason: "ordinary_workspace_mutation",
      });
    }
    await lease?.commitAndStopIdle();
    const cleanupFailures = lease ? [...lease.cleanup_failures] : [];
    lease = null;
    if (invalidatedKeys.length > 0) {
      await invalidation!.cleanupAfterDenial({ runtimeIds: deniedRuntimeIds }).catch(() => undefined);
    }
    return { result, cleanupFailures };
  } catch (error) {
    lease?.release();
    throw error;
  }
}

export class WorkspaceSettingsService {
  private capabilityInvalidation?: WorkspaceCapabilityInvalidationPort;

  constructor(capabilityInvalidation?: WorkspaceCapabilityInvalidationPort) {
    this.capabilityInvalidation = capabilityInvalidation;
  }

  installCapabilityInvalidationPort(port: WorkspaceCapabilityInvalidationPort): void {
    if (this.capabilityInvalidation && this.capabilityInvalidation !== port) {
      throw new Error("Workspace capability invalidation port is already installed");
    }
    this.capabilityInvalidation = port;
  }

  // Preview issuance is deliberately process-local and service-instance-local.
  // A restart or a different service instance loses authority and therefore
  // fails closed without adding a durable approval-consumption table.
  private readonly issuedPreviews = new Map<string, IssuedWorkspacePreview>();

  private previewKey(sourceSessionId: string, operationDigest: string): string {
    return `${sourceSessionId}\u0000${operationDigest}`;
  }

  private pruneIssuedPreviews(now = Date.now()): void {
    for (const [key, issued] of this.issuedPreviews) {
      if (issued.expiresAt < now) this.issuedPreviews.delete(key);
    }
    while (this.issuedPreviews.size > MAX_ISSUED_WORKSPACE_PREVIEWS) {
      const oldest = this.issuedPreviews.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.issuedPreviews.delete(oldest);
    }
  }

  private recordIssuedPreview(sourceSessionId: string, prepared: PreparedMutation, preview: WorkspaceApprovalPreview, issuedAt: number): void {
    const issued: IssuedWorkspacePreview = {
      sourceSessionId,
      operationDigest: preview.operation_digest,
      envelope: structuredClone(envelope(prepared, sourceSessionId, preview.expires_at)),
      preview: structuredClone(preview),
      canonical: structuredClone(prepared.canonical),
      precondition: structuredClone(prepared.precondition),
      issuedAt,
      expiresAt: Date.parse(preview.expires_at),
    };
    this.issuedPreviews.set(this.previewKey(sourceSessionId, preview.operation_digest), issued);
    this.pruneIssuedPreviews(issuedAt);
  }

  private requireIssuedPreview(sourceSessionId: string, prepared: PreparedMutation, candidate: WorkspaceApprovalPreview): IssuedWorkspacePreview {
    const now = Date.now();
    this.pruneIssuedPreviews(now);
    const key = this.previewKey(sourceSessionId, candidate.operation_digest);
    const issued = this.issuedPreviews.get(key);
    if (!issued || !Number.isFinite(issued.expiresAt) || issued.expiresAt < now) {
      throw new WorkspaceStoreError("Workspace commit requires an unexpired server-issued preview", 403);
    }
    const recomputedEnvelope = envelope(prepared, sourceSessionId, candidate.expires_at);
    if (
      issued.sourceSessionId !== sourceSessionId
      || issued.operationDigest !== candidate.operation_digest
      || stableWorkspaceJson(issued.envelope) !== stableWorkspaceJson(recomputedEnvelope)
      || stableWorkspaceJson(issued.canonical) !== stableWorkspaceJson(prepared.canonical)
      || stableWorkspaceJson(issued.precondition) !== stableWorkspaceJson(prepared.precondition)
      || stableWorkspaceJson(issued.preview) !== stableWorkspaceJson(candidate)
    ) {
      throw new WorkspaceStoreError("Workspace commit does not match the exact server-issued preview", 403);
    }
    return issued;
  }

  read(sourceSessionId: string, request: WorkspaceReadAction): unknown {
    requireStandardInteractiveSource(sourceSessionId);
    switch (request.action) {
      case "list_projects": {
        const rows = listProjects();
        return { projects: rows.slice(0, MAX_LIST_RESULTS), total: rows.length, truncated: rows.length > MAX_LIST_RESULTS };
      }
      case "get_project": {
        const project = getProject(request.id);
        if (!project) throw new WorkspaceStoreError("Project not found", 404);
        return project;
      }
      case "list_agent_profiles": {
        const rows = listAgentProfiles().map(withoutInstructions);
        return { agent_profiles: rows.slice(0, MAX_LIST_RESULTS), total: rows.length, truncated: rows.length > MAX_LIST_RESULTS };
      }
      case "get_agent_profile": {
        const profile = getAgentProfile(request.id);
        if (!profile) throw new WorkspaceStoreError("Agent profile not found", 404);
        return profile;
      }
      case "get_project_instructions_metadata": {
        const value = readProjectInstructions(request.project_id);
        const { text: _text, ...metadata } = value;
        return metadata;
      }
      case "get_project_instructions": return readProjectInstructions(request.project_id);
    }
  }

  previewAgentMutation(sourceSessionId: string, raw: unknown, now = Date.now()): WorkspaceApprovalPreview {
    requireStandardInteractiveSource(sourceSessionId);
    const prepared = prepareMutation(raw);
    const preview = previewFromPrepared(prepared, sourceSessionId, new Date(now + WORKSPACE_APPROVAL_TTL_MS).toISOString());
    this.recordIssuedPreview(sourceSessionId, prepared, preview, now);
    return preview;
  }

  async commitAgentMutation(options: { sourceSessionId: string; raw: unknown; requestId: string; submissionId: string; expiresAt: string }): Promise<unknown> {
    requireStandardInteractiveSource(options.sourceSessionId);
    const prepared = prepareMutation(options.raw);
    const expected = previewFromPrepared(prepared, options.sourceSessionId, options.expiresAt);
    const issued = this.requireIssuedPreview(options.sourceSessionId, prepared, expected);
    const authority: Extract<WorkspaceMutationAuthority, { kind: "agent_approval" }> = {
      kind: "agent_approval",
      sourceSessionId: options.sourceSessionId,
      requestId: options.requestId,
      submissionId: options.submissionId,
    };
    verifyApproval(getInterviewForSession(options.sourceSessionId, options.requestId), issued.preview, issued, authority);
    const issuedKey = this.previewKey(options.sourceSessionId, issued.operationDigest);
    const settled = await settleMutation(prepared, this.capabilityInvalidation, () => this.issuedPreviews.delete(issuedKey));
    // Runtime conflicts and every pre-commit failure retain issuance for a
    // bounded retry. Successful durable/file mutation consumed it above.
    return {
      mutation_type: prepared.canonical.mutation_type,
      operation_digest: issued.operationDigest,
      target: prepared.target,
      result: redactMutationResult(settled.result),
      ...(settled.cleanupFailures.length > 0 ? {
        cleanup_warning: {
          applied: true,
          code: "runtime_cleanup_incomplete",
          failures: settled.cleanupFailures,
        },
      } : {}),
    };
  }

  createProjectForUi(input: ProjectCreateInput): ProjectRow { return createProject(input); }

  async updateProjectForUi(id: string, input: ProjectUpdateInput, runtimeAffecting: boolean): Promise<ProjectRow> {
    const current = getProject(id);
    if (!current) throw new WorkspaceStoreError("Project not found", 404);
    const prepared = prepareMutation({ mutation_type: "project_update", mutation: { id, updates: input } });
    const impact = await runtimeImpact();
    const invalidatedKeys = plannedInvalidatedAssociationKeys(prepared);
    const deniedRuntimeIds = runtimeIdsForAssociationKeys(invalidatedKeys);
    if (invalidatedKeys.length > 0 && !this.capabilityInvalidation) {
      throw new WorkspaceStoreError("Capability invalidation runtime latch is unavailable", 503);
    }
    let lease = runtimeAffecting || invalidatedKeys.length > 0 ? impact.acquireProject(current.cwd) : null;
    try {
      const result = updateProject(id, input);
      if (invalidatedKeys.length > 0) {
        this.capabilityInvalidation!.latchDenied({
          associations: tombstonedAssociationRecords(invalidatedKeys),
          runtimeIds: deniedRuntimeIds,
          reason: "ordinary_workspace_mutation",
        });
      }
      await lease?.commitAndStopIdle(); lease = null;
      if (invalidatedKeys.length > 0) {
        await this.capabilityInvalidation!.cleanupAfterDenial({ runtimeIds: deniedRuntimeIds }).catch(() => undefined);
      }
      return result;
    } catch (error) { lease?.release(); throw error; }
  }

  async deleteProjectForUi(id: string): Promise<void> {
    const current = getProject(id);
    if (!current) throw new WorkspaceStoreError("Project not found", 404);
    const prepared = prepareMutation({ mutation_type: "project_delete_registration", mutation: { id } });
    const invalidatedKeys = plannedInvalidatedAssociationKeys(prepared);
    const deniedRuntimeIds = runtimeIdsForAssociationKeys(invalidatedKeys);
    if (invalidatedKeys.length > 0 && !this.capabilityInvalidation) {
      throw new WorkspaceStoreError("Capability invalidation runtime latch is unavailable", 503);
    }
    const impact = await runtimeImpact();
    let lease: RuntimeMutationImpactLease | null = impact.acquireProject(current.cwd);
    try {
      deleteProjectRegistration(id);
      if (invalidatedKeys.length > 0) {
        this.capabilityInvalidation!.latchDenied({
          associations: tombstonedAssociationRecords(invalidatedKeys),
          runtimeIds: deniedRuntimeIds,
          reason: "ordinary_workspace_mutation",
        });
      }
      await lease.commitAndStopIdle(); lease = null;
      if (invalidatedKeys.length > 0) {
        await this.capabilityInvalidation!.cleanupAfterDenial({ runtimeIds: deniedRuntimeIds }).catch(() => undefined);
      }
    } catch (error) { lease?.release(); throw error; }
  }

  createAgentProfileForUi(input: AgentProfileCreateInput): AgentProfileRow { return createAgentProfile(input); }

  async updateAgentProfileForUi(id: string, input: AgentProfileUpdateInput, replacementId: string | undefined, runtimeAffecting: boolean): Promise<AgentProfileRow> {
    if (!getAgentProfile(id)) throw new WorkspaceStoreError("Agent profile not found", 404);
    const prepared = prepareMutation({
      mutation_type: "agent_profile_update",
      mutation: { id, updates: input, replacement_agent_profile_id: replacementId ?? null },
    });
    const impact = await runtimeImpact();
    const invalidatedKeys = plannedInvalidatedAssociationKeys(prepared);
    if (invalidatedKeys.length > 0 && !this.capabilityInvalidation) {
      throw new WorkspaceStoreError("Capability invalidation runtime latch is unavailable", 503);
    }
    let lease = runtimeAffecting || invalidatedKeys.length > 0 ? impact.acquireProfile(id) : null;
    try {
      const result = updateAgentProfile(id, input, replacementId);
      const runtimeIds = lease?.affected_session_ids ?? [];
      if (invalidatedKeys.length > 0) {
        this.capabilityInvalidation!.latchDenied({
          associations: tombstonedAssociationRecords(invalidatedKeys), runtimeIds, reason: "ordinary_workspace_mutation",
        });
      }
      await lease?.commitAndStopIdle(); lease = null;
      if (invalidatedKeys.length > 0) {
        await this.capabilityInvalidation!.cleanupAfterDenial({ runtimeIds }).catch(() => undefined);
      }
      return result;
    } catch (error) { lease?.release(); throw error; }
  }

  async deleteAgentProfileForUi(id: string, replacementId?: string): Promise<void> {
    if (!getAgentProfile(id)) throw new WorkspaceStoreError("Agent profile not found", 404);
    const prepared = prepareMutation({
      mutation_type: "agent_profile_delete",
      mutation: { id, replacement_agent_profile_id: replacementId ?? null },
    });
    const impact = await runtimeImpact();
    const invalidatedKeys = plannedInvalidatedAssociationKeys(prepared);
    const deniedRuntimeIds = runtimeIdsForAssociationKeys(invalidatedKeys);
    if (invalidatedKeys.length > 0 && !this.capabilityInvalidation) {
      throw new WorkspaceStoreError("Capability invalidation runtime latch is unavailable", 503);
    }
    let lease: RuntimeMutationImpactLease | null = impact.acquireProfile(id);
    try {
      deleteAgentProfile(id, replacementId);
      if (invalidatedKeys.length > 0) {
        this.capabilityInvalidation!.latchDenied({
          associations: tombstonedAssociationRecords(invalidatedKeys),
          runtimeIds: deniedRuntimeIds,
          reason: "ordinary_workspace_mutation",
        });
      }
      await lease.commitAndStopIdle(); lease = null;
      if (invalidatedKeys.length > 0) {
        await this.capabilityInvalidation!.cleanupAfterDenial({ runtimeIds: deniedRuntimeIds }).catch(() => undefined);
      }
    } catch (error) { lease?.release(); throw error; }
  }

  readProjectInstructionsForUi(id: string) { return readProjectInstructions(id); }

  async writeProjectInstructionsForUi(id: string, input: { text: string; expected_sha256?: string | null; create_if_missing?: boolean }) {
    const project = getProject(id);
    if (!project) throw new WorkspaceStoreError("Project not found", 404);
    const impact = await runtimeImpact();
    let lease: RuntimeMutationImpactLease | null = impact.acquireProject(project.cwd);
    try { const result = writeProjectInstructions(id, input); await lease.commitAndStopIdle(); lease = null; return result; }
    catch (error) { lease?.release(); throw error; }
  }
}

function redactMutationResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = { ...(result as Record<string, unknown>) };
  if ("instructions" in value) {
    const instructions = typeof value.instructions === "string" ? value.instructions : "";
    value.instructions_sha256 = workspaceSha256(instructions);
    value.instructions_bytes = Buffer.byteLength(instructions, "utf8");
    delete value.instructions;
  }
  // Descriptions/colors are UI content, not needed to audit an approved agent
  // commit and may contain user-domain details. Keep only identifiers, safe
  // labels/paths, policy effects, hashes, byte counts, and timestamps.
  delete value.description;
  delete value.color;
  if ("text" in value) delete value.text;
  return value;
}

export const workspaceSettingsService = new WorkspaceSettingsService();
