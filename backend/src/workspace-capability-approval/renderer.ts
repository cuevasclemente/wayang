import { createHash } from "node:crypto";
import { compiledCapability } from "./catalog.js";
import type {
  CapabilityActivationPreview,
  CapabilityApprovalBinding,
  CapabilityAssociationState,
  AffectedRuntimeStatus,
  RenderedCapabilityChallenge,
} from "./types.js";

const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 160;
const MAX_CWD_LENGTH = 4_096;
export const MAX_AFFECTED_RUNTIMES = 64;
const AFFECTED_RUNTIME_STATUSES = new Set<AffectedRuntimeStatus>([
  "idle",
  "streaming",
  "queued",
  "starting",
  "mutation_locked",
]);

function boundedText(value: string, name: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  if (value.normalize("NFC") !== value) throw new Error(`${name} must be NFC`);
  return value;
}

function positiveRevision(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) throw new Error(`invalid ${name}`);
  return value;
}

function canonicalAssociation(value: CapabilityAssociationState | null): CapabilityAssociationState | null {
  return value === null ? null : { revision: value.revision, active: value.active };
}

function previewStatePayload(preview: CapabilityActivationPreview): object {
  return {
    version: 1,
    association: {
      capability_id: preview.intent.capabilityId,
      project_id: preview.intent.projectId,
      agent_profile_id: preview.intent.agentProfileId,
      before: canonicalAssociation(preview.associationBefore),
      after: canonicalAssociation(preview.associationAfter),
    },
    project: {
      id: preview.intent.projectId,
      canonical_cwd: preview.projectCwd,
      privacy_mode: preview.privacyMode,
      exact_profile_allowed: preview.profileAllowed,
    },
    agent_profile: {
      id: preview.intent.agentProfileId,
      enabled: preview.profileEnabled,
    },
  };
}

export function capabilityPreviewStateDigest(preview: CapabilityActivationPreview): string {
  return createHash("sha256").update(JSON.stringify(previewStatePayload(preview)), "utf8").digest("hex");
}

function canonicalApprovalPayload(preview: CapabilityActivationPreview, binding: CapabilityApprovalBinding): object {
  const capability = compiledCapability(preview.intent.capabilityId);
  return {
    version: 2,
    action: "activate_project_agent_capability",
    capability: {
      id: capability.id,
      title: capability.title,
      risk_summary: capability.riskSummary,
      consequences: [...capability.consequences],
    },
    project: {
      id: preview.intent.projectId,
      label: preview.projectLabel,
      canonical_cwd: preview.projectCwd,
      privacy_mode: preview.privacyMode,
      exact_profile_allowed: preview.profileAllowed,
    },
    agent_profile: {
      id: preview.intent.agentProfileId,
      label: preview.agentProfileLabel,
      enabled: preview.profileEnabled,
    },
    association: {
      before: canonicalAssociation(preview.associationBefore),
      after: canonicalAssociation(preview.associationAfter),
    },
    preview_state_digest: preview.previewStateDigest,
    affected_runtimes: preview.affectedRuntimes.map((runtime) => ({
      runtime_id: runtime.runtimeId,
      status: runtime.status,
    })),
    approval: {
      owner_web_session: binding.owner.sessionId,
      origin: binding.owner.origin,
      request_id: binding.requestId,
      cooldown_attempt_reservation_id: binding.reservationId,
      expires_at: binding.expiresAt,
    },
  };
}

export function validateActivationPreview(preview: CapabilityActivationPreview): void {
  const capability = compiledCapability(preview.intent.capabilityId);
  if (preview.privacyMode !== capability.compatiblePrivacyMode) throw new Error("capability is incompatible with project privacy mode");
  boundedText(preview.intent.projectId, "project id", MAX_ID_LENGTH);
  boundedText(preview.intent.agentProfileId, "agent profile id", MAX_ID_LENGTH);
  boundedText(preview.projectLabel, "project label", MAX_LABEL_LENGTH);
  boundedText(preview.projectCwd, "project cwd", MAX_CWD_LENGTH);
  boundedText(preview.agentProfileLabel, "agent profile label", MAX_LABEL_LENGTH);
  if (typeof preview.profileAllowed !== "boolean" || typeof preview.profileEnabled !== "boolean") throw new Error("invalid live policy decision");
  if (!preview.profileAllowed || !preview.profileEnabled) throw new Error("activation preview must be currently allowed");
  if (preview.associationBefore !== null) {
    positiveRevision(preview.associationBefore.revision, "association before revision");
    if (typeof preview.associationBefore.active !== "boolean") throw new Error("invalid association before state");
  }
  positiveRevision(preview.associationAfter.revision, "association after revision");
  if (!preview.associationAfter.active) throw new Error("activation must result in an active association");
  const expectedAfterRevision = preview.associationBefore === null ? 1 : preview.associationBefore.revision + 1;
  if (preview.associationBefore?.active || preview.associationAfter.revision !== expectedAfterRevision) {
    throw new Error("activation must advance an absent or inactive association exactly once");
  }
  if (!/^[a-f0-9]{64}$/u.test(preview.previewStateDigest)
    || preview.previewStateDigest !== capabilityPreviewStateDigest(preview)) {
    throw new Error("invalid preview state digest");
  }
  if (preview.affectedRuntimes.length > MAX_AFFECTED_RUNTIMES) throw new Error("too many affected runtimes");
  const runtimeIds = new Set<string>();
  for (const runtime of preview.affectedRuntimes) {
    boundedText(runtime.runtimeId, "runtime id", MAX_ID_LENGTH);
    if (!AFFECTED_RUNTIME_STATUSES.has(runtime.status)) throw new Error("invalid affected runtime status");
    if (runtimeIds.has(runtime.runtimeId)) throw new Error("duplicate affected runtime");
    runtimeIds.add(runtime.runtimeId);
  }
}

function validateBinding(binding: CapabilityApprovalBinding): void {
  boundedText(binding.requestId, "request id", MAX_ID_LENGTH);
  boundedText(binding.reservationId, "reservation id", MAX_ID_LENGTH);
  boundedText(binding.owner.sessionId, "owner web session", 4_096);
  boundedText(binding.owner.origin, "owner origin", 2_048);
  if (!Number.isSafeInteger(binding.expiresAt) || binding.expiresAt < 1) throw new Error("invalid request expiry");
  const parsed = new URL(binding.owner.origin);
  if (parsed.origin !== binding.owner.origin || !["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid owner origin");
}

export function capabilityOperationDigest(preview: CapabilityActivationPreview, binding: CapabilityApprovalBinding): string {
  validateActivationPreview(preview);
  validateBinding(binding);
  return createHash("sha256").update(JSON.stringify(canonicalApprovalPayload(preview, binding)), "utf8").digest("hex");
}

export function renderCapabilityChallenge(
  binding: CapabilityApprovalBinding,
  preview: CapabilityActivationPreview,
): RenderedCapabilityChallenge {
  const capability = compiledCapability(preview.intent.capabilityId);
  const operationDigest = capabilityOperationDigest(preview, binding);
  return Object.freeze({
    requestId: binding.requestId,
    operationDigest,
    expiresAt: binding.expiresAt,
    capabilityId: preview.intent.capabilityId,
    projectId: preview.intent.projectId,
    projectLabel: preview.projectLabel,
    projectCwd: preview.projectCwd,
    agentProfileId: preview.intent.agentProfileId,
    agentProfileLabel: preview.agentProfileLabel,
    privacyMode: preview.privacyMode,
    profileAllowed: preview.profileAllowed,
    profileEnabled: preview.profileEnabled,
    association: {
      before: canonicalAssociation(preview.associationBefore),
      after: canonicalAssociation(preview.associationAfter)!,
    },
    previewStateDigest: preview.previewStateDigest,
    summary: capability.riskSummary,
    consequences: capability.consequences,
    affectedRuntimes: preview.affectedRuntimes.map((runtime) => ({ ...runtime })),
  });
}
