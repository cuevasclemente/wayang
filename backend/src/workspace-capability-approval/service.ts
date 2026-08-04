import { CapabilityApprovalAuthority } from "./authority.js";
import { capabilityCatalog, compiledCapability, isWorkspaceCapabilityId } from "./catalog.js";
import { CapabilityApprovalError } from "./errors.js";
import { boundedHistoryLimit } from "./history-policy.js";
import type {
  CapabilityActivationCommit,
  CapabilityActivationIntent,
  CapabilityCatalogStatus,
  CapabilityRevokeIntent,
  CapabilityRuntimeCleanupPort,
  RenderedCapabilityChallenge,
  SettingsPinAttemptPort,
  SettingsRequestOwner,
  WorkspaceCapabilityMutationPort,
} from "./types.js";

const NOOP_CLEANUP: CapabilityRuntimeCleanupPort = {
  async stopAfterActivation() {},
  async cleanupAfterRevocation() {},
};

export interface WorkspaceCapabilityApprovalServiceOptions {
  workspace: WorkspaceCapabilityMutationPort;
  pinAttempts: SettingsPinAttemptPort;
  cleanup?: CapabilityRuntimeCleanupPort;
  now?: () => number;
  requestTtlMs?: number;
  randomId?: () => string;
  ownerKey?: Buffer;
}

export class WorkspaceCapabilityApprovalService {
  private readonly workspace: WorkspaceCapabilityMutationPort;
  private readonly cleanup: CapabilityRuntimeCleanupPort;
  private readonly now: () => number;
  private readonly authority: CapabilityApprovalAuthority<CapabilityActivationCommit>;

  constructor(options: WorkspaceCapabilityApprovalServiceOptions) {
    this.workspace = options.workspace;
    this.cleanup = options.cleanup ?? NOOP_CLEANUP;
    this.now = options.now ?? Date.now;
    this.authority = new CapabilityApprovalAuthority({
      pinAttempts: options.pinAttempts,
      now: this.now,
      requestTtlMs: options.requestTtlMs,
      randomId: options.randomId,
      ownerKey: options.ownerKey,
      commitVerified: async (input) => {
        const result = await this.workspace.commitActivation(input);
        if (result.status === "conflict") throw new CapabilityApprovalError("state_conflict", "Workspace state changed; create a fresh preview", 409);
        if (result.status === "history_full") throw new CapabilityApprovalError("history_full", "Capability activation history is full", 409);
        if (result.status === "denied") throw new CapabilityApprovalError("denied", "Capability activation was denied", 403);
        await this.cleanup.stopAfterActivation(result.idleRuntimeIds).catch(() => undefined);
        return result.result;
      },
    });
  }

  async status(historyLimitValue?: unknown): Promise<CapabilityCatalogStatus> {
    let historyLimit: number;
    try { historyLimit = boundedHistoryLimit(historyLimitValue); }
    catch { throw new CapabilityApprovalError("invalid_request", "Invalid capability history limit", 400); }
    const status = await this.workspace.getCatalogStatus(historyLimit);
    if (status.approvalEvents.length > historyLimit) throw new CapabilityApprovalError("denied", "Capability status exceeded its bound", 503);
    return {
      capabilities: capabilityCatalog().map(({ id, compatiblePrivacyMode, title, riskSummary }) => ({
        id, compatiblePrivacyMode, title, riskSummary,
      })),
      associations: status.associations,
      approvalEvents: status.approvalEvents,
      history: { ...status.history, returned: status.approvalEvents.length, limit: historyLimit },
    };
  }

  async requestActivation(owner: SettingsRequestOwner, input: unknown): Promise<RenderedCapabilityChallenge> {
    const intent = parseActivationIntent(input);
    if (!compiledCapability(intent.capabilityId).activationAvailable) {
      throw new CapabilityApprovalError("denied", "Capability activation is not available", 403);
    }
    const result = await this.workspace.previewActivation(intent);
    if (result.status === "conflict") throw new CapabilityApprovalError("state_conflict", "Workspace state changed; retry the preview", 409);
    if (result.status === "denied" && result.reason === "activation_history_full") {
      throw new CapabilityApprovalError("history_full", "Capability activation history is full", 409);
    }
    if (result.status === "denied") throw new CapabilityApprovalError("denied", "Capability activation was denied", 403);
    if (!sameIntent(intent, result.preview.intent)) {
      throw new CapabilityApprovalError("denied", "Capability preview did not match the exact requested association", 503);
    }
    return this.authority.create(owner, result.preview);
  }

  async commit(owner: SettingsRequestOwner, requestId: string, pin: string): Promise<CapabilityActivationCommit> {
    return this.authority.commit(owner, parseOpaqueId(requestId, "request id"), pin);
  }

  async cancel(owner: SettingsRequestOwner, requestId: string, authenticationLost = false): Promise<void> {
    await this.authority.cancel(owner, parseOpaqueId(requestId, "request id"), authenticationLost);
  }

  async revoke(owner: SettingsRequestOwner, input: unknown) {
    validateOwnerShape(owner);
    const intent = parseRevokeIntent(input);
    const result = await this.workspace.denyAssociationFirst(intent, this.now());
    if (result.status === "not_found") throw new CapabilityApprovalError("request_not_found", "Capability association was not found", 404);
    if (result.status === "conflict") throw new CapabilityApprovalError("state_conflict", "Capability association revision changed", 409);
    if (result.status === "denied") throw new CapabilityApprovalError("denied", "Capability revocation was denied", 403);
    await this.cleanup.cleanupAfterRevocation(result.cleanupRuntimeIds).catch(() => undefined);
    return result.association;
  }
}

function parseActivationIntent(input: unknown): CapabilityActivationIntent {
  const record = exactObject(input, ["capabilityId", "projectId", "agentProfileId"], "activation request");
  if (!isWorkspaceCapabilityId(record.capabilityId)) invalid("unknown capability id");
  return {
    capabilityId: record.capabilityId,
    projectId: exactText(record.projectId, "project id", 256),
    agentProfileId: exactText(record.agentProfileId, "agent profile id", 256),
  };
}

function parseRevokeIntent(input: unknown): CapabilityRevokeIntent {
  const record = exactObject(input, ["capabilityId", "projectId", "agentProfileId", "expectedRevision"], "revocation request");
  if (!isWorkspaceCapabilityId(record.capabilityId)) invalid("unknown capability id");
  if (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 1) invalid("invalid expected revision");
  return {
    capabilityId: record.capabilityId,
    projectId: exactText(record.projectId, "project id", 256),
    agentProfileId: exactText(record.agentProfileId, "agent profile id", 256),
    expectedRevision: record.expectedRevision as number,
  };
}

function exactObject(input: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`${label} must be an object`);
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    invalid(`${label} contains missing or unsupported fields`);
  }
  return record;
}

function sameIntent(left: CapabilityActivationIntent, right: CapabilityActivationIntent): boolean {
  return left.capabilityId === right.capabilityId
    && left.projectId === right.projectId
    && left.agentProfileId === right.agentProfileId;
}

function exactText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`invalid ${name}`);
  }
  return value;
}

function parseOpaqueId(value: unknown, name: string): string {
  return exactText(value, name, 256);
}

function validateOwnerShape(owner: SettingsRequestOwner): void {
  if (!owner || typeof owner.sessionId !== "string" || owner.sessionId.length < 1 || owner.sessionId.length > 4_096
    || typeof owner.origin !== "string" || owner.origin.length < 1 || owner.origin.length > 2_048) {
    throw new CapabilityApprovalError("unauthenticated", "An exact authenticated Settings owner is required", 401);
  }
  try {
    const parsed = new URL(owner.origin);
    if (parsed.origin !== owner.origin || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) throw new Error("not exact");
  } catch {
    throw new CapabilityApprovalError("invalid_origin", "An exact Settings Origin is required", 403);
  }
}

function invalid(message: string): never {
  throw new CapabilityApprovalError("invalid_request", message, 400);
}
