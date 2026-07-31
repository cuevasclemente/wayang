import * as fs from "node:fs";
import * as path from "node:path";
import { getStore } from "./db.js";
import { getAgentProfile } from "./agent-profiles.js";
import { canonicalizeProjectCwd, getProjectByCwd } from "./projects.js";
import {
  WorkspaceStoreError,
  type AgentProfileRow,
  type ProjectRow,
} from "./workspace-types.js";
import { getPolicyGeneration } from "./policy-generation.js";
export { getPolicyGeneration, notifyPolicyChanged, onPolicyChanged } from "./policy-generation.js";

export type ProjectActor = "interactive" | "scheduled" | "dream" | "subagent" | "indexer";
export type SessionConfigPurpose = "create" | "switch" | "resume" | "scheduled";

export interface ProjectAuthorizationDecision {
  allowed: boolean;
  reason?: string;
  code?: "project_not_registered" | "profile_not_found" | "profile_disabled" | "agent_not_allowed" | "protected_actor_denied";
  project?: ProjectRow;
  agentProfile?: AgentProfileRow;
}

export interface EffectiveSessionConfig {
  project: ProjectRow;
  agentProfile: AgentProfileRow;
  agent_profile_id: string;
  provider: string | null;
  model: string | null;
  purpose: SessionConfigPurpose;
}

export function authorizeProjectAction(options: {
  cwd: string;
  actor: ProjectActor;
  agentProfileId?: string | null;
}): ProjectAuthorizationDecision {
  const project = getProjectByCwd(options.cwd);
  if (!project) {
    return { allowed: false, code: "project_not_registered", reason: "Project is not registered" };
  }

  const profileId = options.agentProfileId ?? project.default_agent_profile_id;
  const agentProfile = getAgentProfile(profileId);
  if (!agentProfile) {
    return { allowed: false, code: "profile_not_found", reason: "Agent profile was not found", project };
  }
  if (!agentProfile.enabled) {
    return { allowed: false, code: "profile_disabled", reason: "Agent profile is disabled", project, agentProfile };
  }

  if (!projectAllowsAgentProfile(project, agentProfile.id)) {
    return {
      allowed: false,
      code: "agent_not_allowed",
      reason: "Agent profile is not allowed for this project",
      project,
      agentProfile,
    };
  }

  if (project.access_policy.privacy_mode === "protected" && options.actor !== "interactive") {
    return {
      allowed: false,
      code: "protected_actor_denied",
      reason: `Protected projects do not allow ${options.actor} access`,
      project,
      agentProfile,
    };
  }

  return { allowed: true, project, agentProfile };
}

function completePair(provider: string | null | undefined, model: string | null | undefined): [string, string] | null {
  return provider && model ? [provider, model] : null;
}

export function resolveEffectiveSessionConfig(options: {
  project: ProjectRow;
  agentProfile: AgentProfileRow;
  explicitProvider?: string | null;
  explicitModel?: string | null;
  purpose: SessionConfigPurpose;
}): EffectiveSessionConfig {
  const decision = authorizeProjectAction({
    cwd: options.project.cwd,
    actor: options.purpose === "scheduled" ? "scheduled" : "interactive",
    agentProfileId: options.agentProfile.id,
  });
  if (!decision.allowed) throw new WorkspaceStoreError(decision.reason ?? "Project action denied", 403);

  const explicit = completePair(options.explicitProvider, options.explicitModel);
  if ((options.explicitProvider == null) !== (options.explicitModel == null)) {
    throw new WorkspaceStoreError("provider and model must both be set or both be null");
  }
  const profileDefault = completePair(options.agentProfile.default_provider, options.agentProfile.default_model);
  const projectDefault = completePair(options.project.default_provider, options.project.default_model);

  let selected: [string, string] | null;
  if (options.purpose === "switch") selected = profileDefault ?? projectDefault;
  else selected = explicit ?? projectDefault ?? profileDefault;

  return {
    project: options.project,
    agentProfile: options.agentProfile,
    agent_profile_id: options.agentProfile.id,
    provider: selected?.[0] ?? null,
    model: selected?.[1] ?? null,
    purpose: options.purpose,
  };
}

/**
 * Canonicalize an existing tool target or a not-yet-created mutation target.
 * New targets inherit the nearest existing parent's real path, preventing a
 * symlinked parent from escaping a denied root.
 */
export function canonicalizePolicyPath(target: string, options: { cwd: string; forMutation?: boolean }): string {
  if (typeof target !== "string" || !target.trim()) throw new WorkspaceStoreError("Tool path is required");
  const absolute = path.resolve(options.cwd, target.trim().replace(/^@/, ""));
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (!options.forMutation) throw new WorkspaceStoreError(`Path does not exist: ${target}`, 403);
  }

  const missing: string[] = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new WorkspaceStoreError(`No existing parent for path: ${target}`, 403);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const parentReal = fs.realpathSync.native(cursor);
  return path.join(parentReal, ...missing);
}

export function pathIsWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Every non-null project allowlist applies independently of privacy mode. */
export function projectAllowsAgentProfile(project: ProjectRow, agentProfileId: string): boolean {
  const allowed = project.access_policy.allowed_agent_profile_ids;
  return allowed === null || allowed.includes(agentProfileId);
}

export function protectedProjectForPath(target: string): ProjectRow | undefined {
  return getStore().projects.find((project) => (
    project.access_policy.privacy_mode === "protected" && pathIsWithin(target, canonicalizeProjectCwd(project.cwd))
  ));
}

export interface ProjectPolicyProjection {
  schema_version: 1;
  generation: number;
  projects: Array<{
    cwd: string;
    privacy_mode: "standard" | "protected";
    allowed_agent_profile_ids: string[] | null;
    dream: boolean;
    scheduled: boolean;
    subagents: boolean;
    global_index: boolean;
  }>;
}

/** Metadata-only projection contract for scheduler/search/Dream owners. */
export function buildProjectPolicyProjection(): ProjectPolicyProjection {
  return {
    schema_version: 1,
    generation: getPolicyGeneration(),
    projects: getStore().projects.map((project) => {
      const protectedMode = project.access_policy.privacy_mode === "protected";
      return {
        cwd: project.cwd,
        privacy_mode: project.access_policy.privacy_mode,
        allowed_agent_profile_ids: project.access_policy.allowed_agent_profile_ids
          ? [...project.access_policy.allowed_agent_profile_ids]
          : null,
        dream: !protectedMode,
        scheduled: !protectedMode,
        subagents: !protectedMode,
        global_index: !protectedMode,
      };
    }),
  };
}
