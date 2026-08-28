import * as path from "node:path";
import { getStore } from "../db.js";
import { resolveWorkspaceCapability } from "../workspace-capabilities.js";
import { PROTECTED_AUTOMATION_CAPABILITY_ID, type ProtectedAutomationJobRow } from "./types.js";

export interface ProtectedAutomationBinding {
  readonly capabilityId: typeof PROTECTED_AUTOMATION_CAPABILITY_ID;
  readonly sourceSessionId: string;
  readonly projectId: string;
  readonly projectCwd: string;
  readonly agentProfileId: string;
  readonly associationRevision: number;
  readonly runtimeGeneration: string;
  readonly processBootNonce: string;
}

const BINDING_KEYS = [
  "capabilityId", "sourceSessionId", "projectId", "projectCwd", "agentProfileId", "associationRevision",
  "runtimeGeneration", "processBootNonce",
] as const satisfies readonly (keyof ProtectedAutomationBinding)[];

function validExactString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024
    && value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function assertProtectedAutomationBinding(binding: ProtectedAutomationBinding): void {
  if (!binding || typeof binding !== "object" || Object.getPrototypeOf(binding) !== Object.prototype
    || binding.capabilityId !== PROTECTED_AUTOMATION_CAPABILITY_ID) throw new Error("Protected automation binding is invalid");
  const keys = Object.keys(binding).sort(); const expected = [...BINDING_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Protected automation binding contains unsupported fields");
  }
  for (const key of ["sourceSessionId", "projectId", "projectCwd", "agentProfileId", "runtimeGeneration", "processBootNonce"] as const) {
    if (!validExactString(binding[key])) throw new Error(`Protected automation ${key} is invalid`);
  }
  if (!path.isAbsolute(binding.projectCwd)) throw new Error("Protected automation projectCwd must be absolute");
  if (!Number.isSafeInteger(binding.associationRevision) || binding.associationRevision < 1) {
    throw new Error("Protected automation associationRevision is invalid");
  }
}

export function exactProtectedAutomationBindingEqual(
  left: Readonly<ProtectedAutomationBinding>, right: Readonly<ProtectedAutomationBinding>,
): boolean {
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}

/** Session/model-independent exact-pair authority used by deterministic production execution. */
export function protectedAutomationJobAuthorityIsCurrent(job: ProtectedAutomationJobRow): boolean {
  try {
    const store = getStore();
    const project = store.projects.find((candidate) => candidate.id === job.project_id);
    const profile = store.agentProfiles.find((candidate) => candidate.id === job.agent_profile_id);
    const authority = resolveWorkspaceCapability({
      capability_id: PROTECTED_AUTOMATION_CAPABILITY_ID,
      project_id: job.project_id,
      agent_profile_id: job.agent_profile_id,
    });
    return job.deleted_at === null && project?.access_policy.privacy_mode === "protected"
      && project.access_policy.allowed_agent_profile_ids?.includes(job.agent_profile_id) === true
      && profile?.enabled === true && authority.authorized
      && authority.association.revision === job.capability_revision;
  } catch { return false; }
}

export function assertProtectedAutomationJobAuthority(job: ProtectedAutomationJobRow): void {
  if (!protectedAutomationJobAuthorityIsCurrent(job)) throw new Error("Protected automation exact-pair authority is no longer current");
}
