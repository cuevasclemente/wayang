import { createHash } from "node:crypto";
import { canonicalizeProjectCwd } from "./projects.js";
import { WorkspaceStoreError, type MemoryAccess, type ProjectAccessPolicy, type ResourceMode } from "./workspace-types.js";
import type { InterviewQuestion } from "./interviews.js";

export const WORKSPACE_CONTROL_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_APPROVAL_TTL_MS = 10 * 60 * 1000;
export const WORKSPACE_APPROVAL_PREFIX = "WAYANG-WORKSPACE-";
export const WAYANG_WORKSPACE_READ_TOOL_NAME = "wayang_workspace_read";
export const WAYANG_WORKSPACE_CHANGE_TOOL_NAME = "wayang_workspace_change";

export type WorkspaceMutationType =
  | "project_create"
  | "project_update"
  | "project_delete_registration"
  | "agent_profile_create"
  | "agent_profile_update"
  | "agent_profile_delete"
  | "project_instructions_write";

export interface CanonicalProjectCreateMutation {
  cwd: string;
  name: string | null;
  description: string | null;
  color: string | null;
  default_agent_profile_id: string | null;
  default_provider: string | null;
  default_model: string | null;
  access_policy: ProjectAccessPolicy;
}

export interface CanonicalProjectUpdateMutation {
  id: string;
  updates: {
    name?: string;
    description?: string | null;
    color?: string | null;
    default_agent_profile_id?: string;
    default_provider?: string | null;
    default_model?: string | null;
    access_policy?: ProjectAccessPolicy;
  };
}

export interface CanonicalAgentProfileCreateMutation {
  name: string;
  description: string | null;
  resource_mode: Exclude<ResourceMode, "standard">;
  instructions: string | null;
  memory_access: MemoryAccess;
  default_provider: string | null;
  default_model: string | null;
}

export interface CanonicalAgentProfileUpdateMutation {
  id: string;
  updates: {
    name?: string;
    description?: string | null;
    enabled?: boolean;
    resource_mode?: ResourceMode;
    instructions?: string | null;
    memory_access?: MemoryAccess;
    default_provider?: string | null;
    default_model?: string | null;
  };
  replacement_agent_profile_id: string | null;
}

export type CanonicalWorkspaceMutation =
  | { mutation_type: "project_create"; mutation: CanonicalProjectCreateMutation }
  | { mutation_type: "project_update"; mutation: CanonicalProjectUpdateMutation }
  | { mutation_type: "project_delete_registration"; mutation: { id: string } }
  | { mutation_type: "agent_profile_create"; mutation: CanonicalAgentProfileCreateMutation }
  | { mutation_type: "agent_profile_update"; mutation: CanonicalAgentProfileUpdateMutation }
  | { mutation_type: "agent_profile_delete"; mutation: { id: string; replacement_agent_profile_id: string | null } }
  | { mutation_type: "project_instructions_write"; mutation: { project_id: string; text: string; expected_sha256: string | null; create_if_missing: boolean } };

export interface WorkspaceMutationEnvelope {
  schema_version: typeof WORKSPACE_CONTROL_SCHEMA_VERSION;
  source_session_id: string;
  mutation_type: WorkspaceMutationType;
  mutation: CanonicalWorkspaceMutation["mutation"];
  precondition: { kind: string; sha256: string };
  expires_at: string;
}

export interface WorkspaceApprovalPreview {
  mutation_type: WorkspaceMutationType;
  summary: string;
  target: { id?: string; label: string; path?: string };
  precondition_sha256: string;
  operation_digest: string;
  expires_at: string;
  questionnaire: InterviewQuestion[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceStoreError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !set.has(key));
  if (unknown) throw new WorkspaceStoreError(`Unknown ${label} field: ${unknown}`);
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceStoreError(`${field} is required`);
  return value.trim();
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

function optionalText(value: unknown, field: string, max: number, nullable: boolean): string | null | undefined {
  return value === undefined ? undefined : text(value, field, max, nullable);
}

function exactInstructions(value: unknown, field: string, maxBytes: number): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new WorkspaceStoreError(`${field} must be a string or null`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new WorkspaceStoreError(`${field} is too large`, 413);
  return value;
}

function nullableTrimmed(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceStoreError(`${field} must be a nonempty string or null`);
  return value.trim();
}

function accessPolicy(value: unknown): ProjectAccessPolicy {
  const raw = object(value, "access_policy");
  only(raw, ["privacy_mode", "allowed_agent_profile_ids"], "access_policy");
  if (raw.privacy_mode !== "standard" && raw.privacy_mode !== "protected") throw new WorkspaceStoreError("Invalid privacy_mode");
  let allowed: string[] | null;
  if (raw.allowed_agent_profile_ids === null) allowed = null;
  else if (Array.isArray(raw.allowed_agent_profile_ids) && raw.allowed_agent_profile_ids.every((id) => typeof id === "string" && id.trim())) {
    allowed = [...new Set(raw.allowed_agent_profile_ids.map((id) => (id as string).trim()))].sort();
  } else throw new WorkspaceStoreError("allowed_agent_profile_ids must be an array or null");
  return { privacy_mode: raw.privacy_mode, allowed_agent_profile_ids: allowed };
}

function defaultPair(raw: Record<string, unknown>, includeDefaults: boolean): { default_provider: string | null; default_model: string | null } | Partial<{ default_provider: string | null; default_model: string | null }> {
  const hasProvider = Object.hasOwn(raw, "default_provider");
  const hasModel = Object.hasOwn(raw, "default_model");
  if (!includeDefaults && !hasProvider && !hasModel) return {};
  if (!includeDefaults && (!hasProvider || !hasModel)) {
    return {
      ...(hasProvider ? { default_provider: nullableTrimmed(raw.default_provider, "default_provider") } : {}),
      ...(hasModel ? { default_model: nullableTrimmed(raw.default_model, "default_model") } : {}),
    };
  }
  const provider = nullableTrimmed(raw.default_provider, "default_provider");
  const model = nullableTrimmed(raw.default_model, "default_model");
  if ((provider === null) !== (model === null)) throw new WorkspaceStoreError("default_provider and default_model must both be set or both be null");
  return { default_provider: provider, default_model: model };
}

function canonicalProjectCreate(raw: Record<string, unknown>): CanonicalProjectCreateMutation {
  only(raw, ["cwd", "name", "description", "color", "default_agent_profile_id", "default_provider", "default_model", "access_policy"], "project_create mutation");
  const cwd = canonicalizeProjectCwd(requiredId(raw.cwd, "cwd"));
  const pair = defaultPair(raw, true) as { default_provider: string | null; default_model: string | null };
  return {
    cwd,
    name: raw.name === undefined ? null : text(raw.name, "name", 120, false),
    description: raw.description === undefined ? null : text(raw.description, "description", 4_000, true),
    color: raw.color === undefined ? null : text(raw.color, "color", 64, true),
    default_agent_profile_id: raw.default_agent_profile_id === undefined ? null : requiredId(raw.default_agent_profile_id, "default_agent_profile_id"),
    ...pair,
    access_policy: raw.access_policy === undefined
      ? { privacy_mode: "standard", allowed_agent_profile_ids: null }
      : accessPolicy(raw.access_policy),
  };
}

function canonicalProjectUpdate(raw: Record<string, unknown>): CanonicalProjectUpdateMutation {
  only(raw, ["id", "updates"], "project_update mutation");
  const updatesRaw = object(raw.updates, "updates");
  only(updatesRaw, ["name", "description", "color", "default_agent_profile_id", "default_provider", "default_model", "access_policy"], "project update");
  const updates: CanonicalProjectUpdateMutation["updates"] = {};
  const name = optionalText(updatesRaw.name, "name", 120, false); if (name !== undefined) updates.name = name!;
  const description = optionalText(updatesRaw.description, "description", 4_000, true); if (description !== undefined) updates.description = description;
  const color = optionalText(updatesRaw.color, "color", 64, true); if (color !== undefined) updates.color = color;
  if (updatesRaw.default_agent_profile_id !== undefined) updates.default_agent_profile_id = requiredId(updatesRaw.default_agent_profile_id, "default_agent_profile_id");
  Object.assign(updates, defaultPair(updatesRaw, false));
  if (updatesRaw.access_policy !== undefined) updates.access_policy = accessPolicy(updatesRaw.access_policy);
  if (Object.keys(updates).length === 0) throw new WorkspaceStoreError("project_update requires at least one update");
  return { id: requiredId(raw.id, "id"), updates };
}

function canonicalProfileCreate(raw: Record<string, unknown>): CanonicalAgentProfileCreateMutation {
  only(raw, ["name", "description", "resource_mode", "instructions", "memory_access", "default_provider", "default_model"], "agent_profile_create mutation");
  const resourceMode = raw.resource_mode ?? "project_only";
  if (resourceMode !== "project_only" && resourceMode !== "custom") throw new WorkspaceStoreError("New agent profiles must use project_only or custom resources");
  const memoryAccess = raw.memory_access ?? "none";
  if (memoryAccess !== "none" && memoryAccess !== "read" && memoryAccess !== "read_write") throw new WorkspaceStoreError("Invalid memory_access");
  const pair = defaultPair(raw, true) as { default_provider: string | null; default_model: string | null };
  return {
    name: text(raw.name, "name", 80, false)!,
    description: raw.description === undefined ? null : text(raw.description, "description", 2_000, true),
    resource_mode: resourceMode,
    instructions: raw.instructions === undefined ? null : exactInstructions(raw.instructions, "instructions", 256 * 1024),
    memory_access: memoryAccess,
    ...pair,
  };
}

function canonicalProfileUpdate(raw: Record<string, unknown>): CanonicalAgentProfileUpdateMutation {
  only(raw, ["id", "updates", "replacement_agent_profile_id"], "agent_profile_update mutation");
  const updatesRaw = object(raw.updates, "updates");
  only(updatesRaw, ["name", "description", "enabled", "resource_mode", "instructions", "memory_access", "default_provider", "default_model"], "agent profile update");
  const updates: CanonicalAgentProfileUpdateMutation["updates"] = {};
  const name = optionalText(updatesRaw.name, "name", 80, false); if (name !== undefined) updates.name = name!;
  const description = optionalText(updatesRaw.description, "description", 2_000, true); if (description !== undefined) updates.description = description;
  if (updatesRaw.enabled !== undefined) {
    if (typeof updatesRaw.enabled !== "boolean") throw new WorkspaceStoreError("enabled must be a boolean");
    updates.enabled = updatesRaw.enabled;
  }
  if (updatesRaw.resource_mode !== undefined) {
    if (!['standard', 'project_only', 'custom'].includes(String(updatesRaw.resource_mode))) throw new WorkspaceStoreError("Invalid resource_mode");
    updates.resource_mode = updatesRaw.resource_mode as ResourceMode;
  }
  if (updatesRaw.instructions !== undefined) updates.instructions = exactInstructions(updatesRaw.instructions, "instructions", 256 * 1024);
  if (updatesRaw.memory_access !== undefined) {
    if (!['none', 'read', 'read_write'].includes(String(updatesRaw.memory_access))) throw new WorkspaceStoreError("Invalid memory_access");
    updates.memory_access = updatesRaw.memory_access as MemoryAccess;
  }
  Object.assign(updates, defaultPair(updatesRaw, false));
  if (Object.keys(updates).length === 0) throw new WorkspaceStoreError("agent_profile_update requires at least one update");
  return {
    id: requiredId(raw.id, "id"),
    updates,
    replacement_agent_profile_id: raw.replacement_agent_profile_id === undefined || raw.replacement_agent_profile_id === null
      ? null
      : requiredId(raw.replacement_agent_profile_id, "replacement_agent_profile_id"),
  };
}

export function canonicalizeWorkspaceMutation(rawValue: unknown): CanonicalWorkspaceMutation {
  const root = object(rawValue, "workspace mutation");
  only(root, ["mutation_type", "mutation"], "workspace mutation");
  const mutation = object(root.mutation, "mutation");
  switch (root.mutation_type) {
    case "project_create": return { mutation_type: root.mutation_type, mutation: canonicalProjectCreate(mutation) };
    case "project_update": return { mutation_type: root.mutation_type, mutation: canonicalProjectUpdate(mutation) };
    case "project_delete_registration":
      only(mutation, ["id"], "project_delete_registration mutation");
      return { mutation_type: root.mutation_type, mutation: { id: requiredId(mutation.id, "id") } };
    case "agent_profile_create": return { mutation_type: root.mutation_type, mutation: canonicalProfileCreate(mutation) };
    case "agent_profile_update": return { mutation_type: root.mutation_type, mutation: canonicalProfileUpdate(mutation) };
    case "agent_profile_delete":
      only(mutation, ["id", "replacement_agent_profile_id"], "agent_profile_delete mutation");
      return { mutation_type: root.mutation_type, mutation: {
        id: requiredId(mutation.id, "id"),
        replacement_agent_profile_id: mutation.replacement_agent_profile_id === undefined || mutation.replacement_agent_profile_id === null
          ? null
          : requiredId(mutation.replacement_agent_profile_id, "replacement_agent_profile_id"),
      } };
    case "project_instructions_write": {
      only(mutation, ["project_id", "text", "expected_sha256", "create_if_missing"], "project_instructions_write mutation");
      if (typeof mutation.text !== "string") throw new WorkspaceStoreError("text is required");
      if (Buffer.byteLength(mutation.text, "utf8") > 2 * 1024 * 1024) throw new WorkspaceStoreError("AGENTS.md is too large", 413);
      const expected = mutation.expected_sha256 === undefined || mutation.expected_sha256 === null ? null : requiredId(mutation.expected_sha256, "expected_sha256").toLowerCase();
      if (expected !== null && !/^[a-f0-9]{64}$/.test(expected)) throw new WorkspaceStoreError("expected_sha256 must be a SHA-256 hex digest");
      if (mutation.create_if_missing !== undefined && typeof mutation.create_if_missing !== "boolean") throw new WorkspaceStoreError("create_if_missing must be a boolean");
      return { mutation_type: root.mutation_type, mutation: {
        project_id: requiredId(mutation.project_id, "project_id"),
        text: mutation.text,
        expected_sha256: expected,
        create_if_missing: mutation.create_if_missing === true,
      } };
    }
    default: throw new WorkspaceStoreError("Unknown workspace mutation_type");
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => [key, sorted(child)]));
}

export function stableWorkspaceJson(value: unknown): string {
  const serialized = JSON.stringify(sorted(value));
  if (serialized === undefined) throw new WorkspaceStoreError("Workspace value is not JSON-serializable");
  return serialized;
}

export function workspaceSha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableWorkspaceJson(value)).digest("hex");
}

export function workspaceOperationDigest(envelope: WorkspaceMutationEnvelope): string {
  return workspaceSha256(envelope);
}

export function workspaceApprovalQuestion(options: {
  digest: string;
  summary: string;
  sourceSessionId: string;
  expiresAt: string;
  warning?: string;
}): InterviewQuestion[] {
  const id = `${WORKSPACE_APPROVAL_PREFIX}${options.digest.slice(0, 16).toUpperCase()}`;
  const warning = options.warning ? ` Warning: ${options.warning}` : "";
  return [{
    id,
    label: id,
    prompt: `Wayang workspace approval v1. Operation digest: ${options.digest}. Summary: ${options.summary}. Source session: ${options.sourceSessionId}. Expires: ${options.expiresAt}.${warning} Approve only if this exact control-plane change is intended.`,
    options: [
      { value: "APPROVE", label: "APPROVE" },
      { value: "REJECT", label: "REJECT" },
    ],
    allowOther: true,
  }];
}
