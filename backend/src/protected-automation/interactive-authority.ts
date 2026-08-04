import { getAgentProfile } from "../agent-profiles.js";
import { authorizeProjectAction } from "../policy.js";
import { getProjectByCwd } from "../projects.js";
import { getSessionById } from "../sessions.js";
import { isSessionCapabilityEligible, resolveWorkspaceCapability } from "../workspace-capabilities.js";
import {
  assertProtectedAutomationBinding,
  type ProtectedAutomationBinding,
} from "./authority.js";
import { PROTECTED_AUTOMATION_CAPABILITY_ID } from "./types.js";

export interface ProtectedAutomationAuthorityOptions {
  isRuntimeCurrent(): boolean;
}

export function protectedAutomationBindingIsCurrent(
  binding: Readonly<ProtectedAutomationBinding>,
  options: ProtectedAutomationAuthorityOptions,
): boolean {
  try {
    assertProtectedAutomationBinding(binding as ProtectedAutomationBinding);
    if (!options.isRuntimeCurrent()) return false;
    const row = getSessionById(binding.sourceSessionId);
    if (!row || !isSessionCapabilityEligible(row) || row.pending_agent_switch !== null
      || row.scheduled_job_id !== null || row.scheduled_run_id !== null
      || row.legacy_private_session_quarantine !== false
      || row.cwd !== binding.projectCwd || row.agent_profile_id !== binding.agentProfileId) return false;
    const project = getProjectByCwd(binding.projectCwd);
    const profile = getAgentProfile(binding.agentProfileId);
    if (!project || !profile || project.id !== binding.projectId || project.cwd !== binding.projectCwd) return false;
    const authorization = authorizeProjectAction({ cwd: binding.projectCwd, actor: "interactive", agentProfileId: binding.agentProfileId });
    if (!authorization.allowed || authorization.project?.id !== binding.projectId
      || authorization.project.cwd !== binding.projectCwd
      || authorization.agentProfile?.id !== binding.agentProfileId) return false;
    const resolution = resolveWorkspaceCapability({ capability_id: PROTECTED_AUTOMATION_CAPABILITY_ID,
      project_id: binding.projectId, agent_profile_id: binding.agentProfileId });
    return resolution.authorized && resolution.association.revision === binding.associationRevision
      && resolution.project.cwd === binding.projectCwd && resolution.project.access_policy.privacy_mode === "protected";
  } catch { return false; }
}

export class ProtectedAutomationAuthority {
  readonly binding: Readonly<ProtectedAutomationBinding>;
  private revoked = false;
  constructor(binding: ProtectedAutomationBinding, private readonly options: ProtectedAutomationAuthorityOptions) {
    assertProtectedAutomationBinding(binding); this.binding = Object.freeze({ ...binding });
  }
  preflight(): { allowed: true } | { allowed: false; reason: string } {
    if (this.revoked) return { allowed: false, reason: "Protected automation runtime is revoked" };
    if (!protectedAutomationBindingIsCurrent(this.binding, this.options)) {
      this.revoked = true;
      return { allowed: false, reason: "Protected automation authority changed; a fresh runtime is required" };
    }
    return { allowed: true };
  }
  assertAuthorized(checkpoint: "preoperation" | "prerelease"): void {
    const decision = this.preflight();
    if (!decision.allowed) {
      const verb = checkpoint === "prerelease" ? "result was suppressed" : "operation was denied";
      throw new Error(`Protected automation ${verb}: ${decision.reason}`);
    }
  }
  close(): void { this.revoked = true; }
}
