import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { commitStoreMutation, getStore, type StoreData } from "./db.js";
import { getAgentProfile } from "./agent-profiles.js";
import { notifyPolicyChanged } from "./policy-generation.js";
import { blockProtectedAutomationJobsDraft } from "./protected-automation/draft-lifecycle.js";
import {
  isWorkspaceCapabilityCompatible,
  tombstoneWorkspaceCapabilityAssociationsDraft,
} from "./workspace-capabilities.js";
import {
  WorkspaceStoreError,
  type AgentProfileRow,
  type ProjectAccessPolicy,
  type ProjectRow,
} from "./workspace-types.js";

export interface ProjectCreateInput {
  cwd: string;
  name?: string;
  description?: string | null;
  color?: string | null;
  default_agent_profile_id?: string;
  default_provider?: string | null;
  default_model?: string | null;
  access_policy?: ProjectAccessPolicy;
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string | null;
  color?: string | null;
  default_agent_profile_id?: string;
  default_provider?: string | null;
  default_model?: string | null;
  access_policy?: ProjectAccessPolicy;
}

export interface EffectiveSessionDefaults {
  agent_profile_id: string;
  provider: string | null;
  model: string | null;
}

export interface ProjectRegistrationReferences {
  sessions: string[];
  scheduled_jobs: string[];
  scheduled_runs: string[];
  protected_automation_jobs: string[];
  protected_automation_runs: string[];
  apps: string[];
  app_states: string[];
  app_events: string[];
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

function stringField(value: unknown, field: string, max: number, nullable: boolean): string | null {
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

function validateDefaultPair(provider: unknown, model: unknown): { provider: string | null; model: string | null } {
  if (provider == null && model == null) return { provider: null, model: null };
  if (typeof provider !== "string" || !provider.trim() || typeof model !== "string" || !model.trim()) {
    throw new WorkspaceStoreError("default_provider and default_model must both be set or both be null");
  }
  return { provider: provider.trim(), model: model.trim() };
}

export function canonicalizeProjectCwd(cwd: string): string {
  if (typeof cwd !== "string" || !cwd.trim()) throw new WorkspaceStoreError("cwd is required");
  let expanded = cwd.trim();
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
  else if (expanded.startsWith("/src/") && !fs.existsSync(expanded)) expanded = path.join(os.homedir(), expanded.slice(1));
  const resolved = path.resolve(expanded);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function requireEnabledAgent(id: string): AgentProfileRow {
  const profile = getAgentProfile(id);
  if (!profile) throw new WorkspaceStoreError("Default agent profile not found", 404);
  if (!profile.enabled) throw new WorkspaceStoreError("Default agent profile must be enabled", 409);
  return profile;
}

function validateAccessPolicy(value: unknown, defaultAgentId: string): ProjectAccessPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceStoreError("access_policy is required");
  const raw = value as Partial<ProjectAccessPolicy>;
  if (raw.privacy_mode !== "standard" && raw.privacy_mode !== "protected") throw new WorkspaceStoreError("Invalid privacy_mode");
  let allowed: string[] | null;
  if (raw.allowed_agent_profile_ids === null) {
    allowed = null;
  } else if (Array.isArray(raw.allowed_agent_profile_ids) && raw.allowed_agent_profile_ids.every((id) => typeof id === "string" && id.length > 0)) {
    allowed = [...new Set(raw.allowed_agent_profile_ids)];
  } else {
    throw new WorkspaceStoreError("allowed_agent_profile_ids must be an array or null");
  }
  if (raw.privacy_mode === "protected" && (!allowed || allowed.length === 0)) {
    throw new WorkspaceStoreError("Protected projects require a nonempty agent allowlist");
  }
  if (allowed && !allowed.includes(defaultAgentId)) {
    throw new WorkspaceStoreError("The default agent profile must be in the project allowlist");
  }
  for (const id of allowed ?? []) {
    if (!getAgentProfile(id)) throw new WorkspaceStoreError("Allowed agent profile not found", 404);
  }
  return { privacy_mode: raw.privacy_mode, allowed_agent_profile_ids: allowed };
}

function defaultName(cwd: string): string {
  return path.basename(cwd) || cwd;
}

function rejectCapabilityFields(input: object): void {
  if (
    Object.hasOwn(input, "capability_grants")
    || Object.hasOwn(input, "authorization_revision")
    || Object.hasOwn(input, "workspaceCapabilityAssociations")
    || Object.hasOwn(input, "workspaceCapabilityApprovalEvents")
    || Object.hasOwn(input, "capability_associations")
  ) {
    throw new WorkspaceStoreError("Capability authority cannot be changed through ordinary project CRUD", 403);
  }
}

function ensureProjectInStore(store: StoreData, cwd: string): { project: ProjectRow; created: boolean } {
  const canonical = canonicalizeProjectCwd(cwd);
  const existing = store.projects.find((project) => project.cwd === canonical);
  if (existing) return { project: cloneProject(existing), created: false };
  const now = Date.now();
  const project: ProjectRow = {
    id: randomUUID(),
    cwd: canonical,
    name: defaultName(canonical),
    description: null,
    color: null,
    default_agent_profile_id: store.workspaceSettings.default_agent_profile_id,
    default_provider: null,
    default_model: null,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
    created_at: now,
    updated_at: now,
  };
  store.projects.push(project);
  return { project: cloneProject(project), created: true };
}

function sameStringSet(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function listProjects(): ProjectRow[] {
  return getStore().projects.map(cloneProject).sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(id: string): ProjectRow | undefined {
  const project = getStore().projects.find((candidate) => candidate.id === id);
  return project ? cloneProject(project) : undefined;
}

export function getProjectByCwd(cwd: string): ProjectRow | undefined {
  const canonical = canonicalizeProjectCwd(cwd);
  const project = getStore().projects.find((candidate) => candidate.cwd === canonical);
  return project ? cloneProject(project) : undefined;
}

export function createProject(input: ProjectCreateInput): ProjectRow {
  rejectCapabilityFields(input);
  const cwd = canonicalizeProjectCwd(input.cwd);
  let stat: fs.Stats;
  try { stat = fs.statSync(cwd); } catch { throw new WorkspaceStoreError("Project cwd must be an existing directory"); }
  if (!stat.isDirectory()) throw new WorkspaceStoreError("Project cwd must be an existing directory");
  if (getStore().projects.some((project) => project.cwd === cwd)) throw new WorkspaceStoreError("A project already exists for that cwd", 409);

  const defaultAgentId = input.default_agent_profile_id ?? getStore().workspaceSettings.default_agent_profile_id;
  requireEnabledAgent(defaultAgentId);
  const pair = validateDefaultPair(input.default_provider ?? null, input.default_model ?? null);
  const policy = validateAccessPolicy(
    input.access_policy ?? { privacy_mode: "standard", allowed_agent_profile_ids: null },
    defaultAgentId,
  );
  const now = Date.now();
  const project: ProjectRow = {
    id: randomUUID(),
    cwd,
    name: input.name === undefined ? defaultName(cwd) : stringField(input.name, "name", 120, false)!,
    description: input.description === undefined ? null : stringField(input.description, "description", 4_000, true),
    color: input.color === undefined ? null : stringField(input.color, "color", 64, true),
    default_agent_profile_id: defaultAgentId,
    default_provider: pair.provider,
    default_model: pair.model,
    access_policy: policy,
    created_at: now,
    updated_at: now,
  };
  const committed = commitStoreMutation((draft) => {
    if (draft.projects.some((candidate) => candidate.cwd === cwd)) {
      throw new WorkspaceStoreError("A project already exists for that cwd", 409);
    }
    draft.projects.push(project);
    return cloneProject(project);
  });
  notifyPolicyChanged();
  return committed;
}

/** Upsert used by session creation/catalog imports; intentionally permissive. */
export function ensureProjectForCwd(cwd: string, flushStore = true): { project: ProjectRow; created: boolean } {
  const canonical = canonicalizeProjectCwd(cwd);
  const existing = getStore().projects.find((project) => project.cwd === canonical);
  if (existing) return { project: cloneProject(existing), created: false };
  if (!flushStore) return ensureProjectInStore(getStore(), canonical);
  const result = commitStoreMutation((draft) => ensureProjectInStore(draft, canonical));
  if (result.created) notifyPolicyChanged();
  return result;
}

/** Internal transaction hook used to commit a new project with its first session. */
export function ensureProjectForCwdDraft(store: StoreData, cwd: string): { project: ProjectRow; created: boolean } {
  return ensureProjectInStore(store, cwd);
}

export function projectRegistrationHasBrowserData(id: string): boolean {
  const project = getStore().projects.find((candidate) => candidate.id === id);
  if (!project) throw new WorkspaceStoreError("Project not found", 404);
  try {
    fs.lstatSync(path.join(project.cwd, ".pi", "browser-workbench"));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function getProjectRegistrationReferences(id: string): ProjectRegistrationReferences {
  const store = getStore();
  const project = store.projects.find((candidate) => candidate.id === id);
  if (!project) throw new WorkspaceStoreError("Project not found", 404);
  const sessionIds = new Set(store.sessions.filter((session) => session.cwd === project.cwd).map((session) => session.id));
  const allSessionIds = new Set(store.sessions.map((session) => session.id));
  const jobIds = new Set(store.scheduledJobs.filter((job) => job.cwd === project.cwd).map((job) => job.id));
  const allJobIds = new Set(store.scheduledJobs.map((job) => job.id));
  return {
    sessions: [...sessionIds].sort(),
    scheduled_jobs: [...jobIds].sort(),
    scheduled_runs: store.scheduledRuns.filter((run) => {
      if (jobIds.has(run.job_id) || (run.session_id !== null && sessionIds.has(run.session_id))) return true;
      // A run whose job and session attribution are both missing cannot be
      // proven unrelated to this project. Block every registration deletion
      // until central metadata is repaired rather than orphaning ambiguity.
      return !allJobIds.has(run.job_id) && (run.session_id === null || !allSessionIds.has(run.session_id));
    }).map((run) => run.id).sort(),
    protected_automation_jobs: store.protectedAutomationJobs
      .filter((job) => job.project_id === project.id).map((job) => job.id).sort(),
    protected_automation_runs: store.protectedAutomationRuns
      .filter((run) => run.project_id === project.id).map((run) => run.id).sort(),
    apps: store.apps.filter((app) => app.project_cwd === project.cwd).map((app) => app.id).sort(),
    app_states: store.appStates.filter((state) => state.project_cwd === project.cwd).map((state) => state.app_id).sort(),
    app_events: store.appEvents.filter((event) => event.projectCwd === project.cwd).map((event) => event.id).sort(),
  };
}

export function deleteProjectRegistration(id: string): void {
  if (projectRegistrationHasBrowserData(id)) {
    throw new WorkspaceStoreError("Project registration retains managed browser profile data", 409);
  }
  const references = getProjectRegistrationReferences(id);
  const blocking = Object.entries(references).filter(([, ids]) => ids.length > 0).map(([kind]) => kind);
  if (blocking.length > 0) {
    throw new WorkspaceStoreError(`Project registration is still referenced by: ${blocking.join(", ")}`, 409);
  }
  commitStoreMutation((draft) => {
    const index = draft.projects.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new WorkspaceStoreError("Project not found", 404);
    // Denial is committed in the same transaction before subject cleanup.
    tombstoneWorkspaceCapabilityAssociationsDraft(draft, (association) => association.project_id === id);
    draft.projects.splice(index, 1);
  });
  notifyPolicyChanged();
}

export function updateProject(id: string, input: ProjectUpdateInput): ProjectRow {
  rejectCapabilityFields(input);
  const project = getStore().projects.find((candidate) => candidate.id === id);
  if (!project) throw new WorkspaceStoreError("Project not found", 404);
  const next = cloneProject(project);
  const defaultAgentId = input.default_agent_profile_id ?? project.default_agent_profile_id;
  requireEnabledAgent(defaultAgentId);
  const policy = input.access_policy === undefined
    ? validateAccessPolicy(project.access_policy, defaultAgentId)
    : validateAccessPolicy(input.access_policy, defaultAgentId);
  const pair = input.default_provider !== undefined || input.default_model !== undefined
    ? validateDefaultPair(
      input.default_provider === undefined ? project.default_provider : input.default_provider,
      input.default_model === undefined ? project.default_model : input.default_model,
    )
    : { provider: project.default_provider, model: project.default_model };

  if (input.name !== undefined) next.name = stringField(input.name, "name", 120, false)!;
  if (input.description !== undefined) next.description = stringField(input.description, "description", 4_000, true);
  if (input.color !== undefined) next.color = stringField(input.color, "color", 64, true);
  next.default_provider = pair.provider;
  next.default_model = pair.model;
  next.default_agent_profile_id = defaultAgentId;
  next.access_policy = policy;
  next.updated_at = Date.now();
  const runtimePolicyChanged = project.default_agent_profile_id !== next.default_agent_profile_id
    || project.default_provider !== next.default_provider
    || project.default_model !== next.default_model
    || project.access_policy.privacy_mode !== next.access_policy.privacy_mode
    || !sameStringSet(
      project.access_policy.allowed_agent_profile_ids,
      next.access_policy.allowed_agent_profile_ids,
    );
  const committed = commitStoreMutation((draft) => {
    const target = draft.projects.find((candidate) => candidate.id === id);
    if (!target) throw new WorkspaceStoreError("Project not found", 404);
    Object.assign(target, next);
    // Widening and exact-profile-preserving edits survive. Only newly excluded
    // pairs and capabilities incompatible with the new privacy mode tombstone.
    tombstoneWorkspaceCapabilityAssociationsDraft(
      draft,
      (association) => association.project_id === id && (
        !isWorkspaceCapabilityCompatible(association.capability_id, target)
        || !(
          target.access_policy.allowed_agent_profile_ids === null
          || target.access_policy.allowed_agent_profile_ids.includes(association.agent_profile_id)
        )
      ),
      next.updated_at,
    );
    blockProtectedAutomationJobsDraft(
      draft,
      (job) => job.project_id === id && (
        target.access_policy.privacy_mode !== "protected"
        || !target.access_policy.allowed_agent_profile_ids?.includes(job.agent_profile_id)
      ),
      "project_policy_incompatible",
      next.updated_at,
    );
    return cloneProject(target);
  });
  if (runtimePolicyChanged) notifyPolicyChanged();
  return committed;
}

export function resolveEffectiveSessionDefaults(options: {
  project: ProjectRow;
  agentProfile?: AgentProfileRow;
  agentProfileId?: string;
  explicitProvider?: string | null;
  explicitModel?: string | null;
}): EffectiveSessionDefaults {
  const agent = options.agentProfile ?? requireEnabledAgent(options.agentProfileId ?? options.project.default_agent_profile_id);
  if (!agent.enabled) throw new WorkspaceStoreError("Agent profile must be enabled", 409);
  const allowed = options.project.access_policy.allowed_agent_profile_ids;
  if (allowed && !allowed.includes(agent.id)) throw new WorkspaceStoreError("Agent profile is not allowed for this project", 403);
  const explicit = validateDefaultPair(options.explicitProvider ?? null, options.explicitModel ?? null);
  if (explicit.provider && explicit.model) return { agent_profile_id: agent.id, provider: explicit.provider, model: explicit.model };
  if (options.project.default_provider && options.project.default_model) {
    return { agent_profile_id: agent.id, provider: options.project.default_provider, model: options.project.default_model };
  }
  return { agent_profile_id: agent.id, provider: agent.default_provider, model: agent.default_model };
}
