export const WORKSPACE_CAPABILITY_IDS = [
  "wayang.standard-resources.v1",
  "wayang.host-execution.v1",
  "wayang.protected-browser.v1",
] as const;

export type WorkspaceCapabilityId = typeof WORKSPACE_CAPABILITY_IDS[number];
export type WorkspacePrivacyMode = "standard" | "protected";

export interface SettingsRequestOwner {
  /** Opaque authenticated web-session identity supplied by the auth bridge. */
  sessionId: string;
  /** Exact, already-validated browser Origin (URL.origin form). */
  origin: string;
}

/** The complete public activation request. Provider/model are never accepted. */
export interface CapabilityActivationIntent {
  capabilityId: WorkspaceCapabilityId;
  projectId: string;
  agentProfileId: string;
}

export interface CapabilityAssociationState {
  revision: number;
  active: boolean;
}

export type AffectedRuntimeStatus = "idle" | "streaming" | "queued" | "starting" | "mutation_locked";

export interface AffectedRuntimePreview {
  runtimeId: string;
  status: AffectedRuntimeStatus;
}

/** Exact authority-relevant state produced by the workspace schema owner. */
export interface CapabilityActivationPreview {
  intent: CapabilityActivationIntent;
  projectLabel: string;
  projectCwd: string;
  privacyMode: WorkspacePrivacyMode;
  profileAllowed: boolean;
  agentProfileLabel: string;
  profileEnabled: boolean;
  associationBefore: CapabilityAssociationState | null;
  associationAfter: CapabilityAssociationState;
  /** Canonical digest of only live association/project/profile authority state. */
  previewStateDigest: string;
  affectedRuntimes: readonly AffectedRuntimePreview[];
}

export interface CapabilityApprovalBinding {
  requestId: string;
  reservationId: string;
  expiresAt: number;
  owner: SettingsRequestOwner;
}

export interface CapabilityAssociationRecord {
  capabilityId: WorkspaceCapabilityId;
  projectId: string;
  agentProfileId: string;
  revision: number;
  active: boolean;
  approvedAt: number;
  revokedAt: number | null;
  updatedAt: number;
}

export interface CapabilityApprovalEventRecord {
  id: string;
  capabilityId: WorkspaceCapabilityId;
  projectId: string;
  agentProfileId: string;
  associationRevision: number;
  operationDigest: string;
  approvedAt: number;
  revokedAt: number | null;
}

export interface CapabilityActivationCommit {
  association: CapabilityAssociationRecord;
  approvalEvent: CapabilityApprovalEventRecord;
}

export interface CapabilityStatusProjection {
  associations: readonly CapabilityAssociationRecord[];
  approvalEvents: readonly CapabilityApprovalEventRecord[];
  history: {
    returned: number;
    limit: number;
    hasMore: boolean;
  };
}

export interface CapabilityCatalogStatus extends CapabilityStatusProjection {
  capabilities: readonly {
    id: WorkspaceCapabilityId;
    compatiblePrivacyMode: WorkspacePrivacyMode;
    title: string;
    riskSummary: string;
  }[];
}

export interface RenderedCapabilityChallenge {
  requestId: string;
  operationDigest: string;
  expiresAt: number;
  capabilityId: WorkspaceCapabilityId;
  projectId: string;
  projectLabel: string;
  projectCwd: string;
  agentProfileId: string;
  agentProfileLabel: string;
  privacyMode: WorkspacePrivacyMode;
  profileAllowed: boolean;
  profileEnabled: boolean;
  association: {
    before: CapabilityAssociationState | null;
    after: CapabilityAssociationState;
  };
  previewStateDigest: string;
  summary: string;
  consequences: readonly string[];
  affectedRuntimes: readonly AffectedRuntimePreview[];
}

export interface CapabilityRevokeIntent extends CapabilityActivationIntent {
  expectedRevision: number;
}

export type PreviewActivationResult =
  | { status: "ok"; preview: CapabilityActivationPreview }
  | { status: "denied"; reason: string }
  | { status: "conflict" };

export type CommitActivationResult =
  | { status: "committed"; result: CapabilityActivationCommit; idleRuntimeIds: readonly string[] }
  | { status: "conflict" }
  | { status: "history_full" }
  | { status: "denied"; reason: string };

export type DenyAssociationResult =
  | { status: "revoked"; association: CapabilityAssociationRecord; cleanupRuntimeIds: readonly string[] }
  | { status: "already_revoked"; association: CapabilityAssociationRecord; cleanupRuntimeIds: readonly string[] }
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "denied"; reason: string };

export interface WorkspaceCapabilityMutationPort {
  previewActivation(intent: CapabilityActivationIntent): Promise<PreviewActivationResult>;
  /** Atomically revalidates the preview, advances the association, and appends PIN audit history. */
  commitActivation(input: {
    preview: CapabilityActivationPreview;
    approvalBinding: CapabilityApprovalBinding;
    approvalDigest: string;
    approvedAt: number;
  }): Promise<CommitActivationResult>;
  /** Durable tombstone and synchronous runtime/control denial precede `revoked`. */
  denyAssociationFirst(intent: CapabilityRevokeIntent, revokedAt: number): Promise<DenyAssociationResult>;
  getCatalogStatus(historyLimit: number): Promise<CapabilityStatusProjection>;
}

export interface CapabilityRuntimeCleanupPort {
  stopAfterActivation(runtimeIds: readonly string[]): Promise<void>;
  cleanupAfterRevocation(runtimeIds: readonly string[]): Promise<void>;
}

export type ReservePinAttemptResult =
  | { status: "reserved" }
  | { status: "cooldown"; retryAt: number }
  | { status: "busy" }
  | { status: "unavailable" };

export type VerifyPinAttemptResult =
  | { status: "verified" }
  | { status: "wrong_pin" }
  | { status: "expired" }
  | { status: "unavailable" };

/** Hardened PIN implementations must reserve the exact preallocated attempt ID. */
export interface SettingsPinAttemptPort {
  reserve(input: {
    realm: string;
    reservationId: string;
    requestId: string;
    operationDigest: string;
    expiresAt: number;
  }): Promise<ReservePinAttemptResult>;
  verifyAndConsume(input: {
    realm: string;
    reservationId: string;
    requestId: string;
    pin: string;
    now: number;
  }): Promise<VerifyPinAttemptResult>;
  cancelAndConsume(input: {
    realm: string;
    reservationId: string;
    requestId: string;
    reason: "cancelled" | "authentication_lost" | "expired" | "conflict" | "backend_failure";
    now: number;
  }): Promise<void>;
}
