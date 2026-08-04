import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CapabilityApprovalError } from "./errors.js";
import { renderCapabilityChallenge } from "./renderer.js";
import type {
  CapabilityActivationPreview,
  CapabilityApprovalBinding,
  RenderedCapabilityChallenge,
  SettingsPinAttemptPort,
  SettingsRequestOwner,
  VerifyPinAttemptResult,
} from "./types.js";

export const WORKSPACE_CAPABILITY_APPROVAL_REALM = "wayang.workspace-capabilities.v1";

interface PendingRequest {
  requestId: string;
  reservationId: string;
  ownerDigest: Buffer;
  preview: CapabilityActivationPreview;
  binding: CapabilityApprovalBinding;
  challenge: RenderedCapabilityChallenge;
  phase: "pending" | "consuming";
}

export interface CapabilityApprovalAuthorityOptions<T> {
  pinAttempts: SettingsPinAttemptPort;
  commitVerified(input: {
    preview: CapabilityActivationPreview;
    approvalBinding: CapabilityApprovalBinding;
    approvalDigest: string;
    approvedAt: number;
  }): Promise<T>;
  now?: () => number;
  requestTtlMs?: number;
  randomId?: () => string;
  ownerKey?: Buffer;
}

/** Process-local one-use request owner; durable attempt/cooldown state belongs to pinAttempts. */
export class CapabilityApprovalAuthority<T> {
  private readonly requests = new Map<string, PendingRequest>();
  private readonly pinAttempts: SettingsPinAttemptPort;
  private readonly commitVerified: CapabilityApprovalAuthorityOptions<T>["commitVerified"];
  private readonly now: () => number;
  private readonly requestTtlMs: number;
  private readonly randomId: () => string;
  private readonly ownerKey: Buffer;
  private reservationInProgress = false;

  constructor(options: CapabilityApprovalAuthorityOptions<T>) {
    this.pinAttempts = options.pinAttempts;
    this.commitVerified = options.commitVerified;
    this.now = options.now ?? Date.now;
    this.requestTtlMs = options.requestTtlMs ?? 2 * 60 * 1_000;
    this.randomId = options.randomId ?? randomUUID;
    this.ownerKey = options.ownerKey ?? randomBytes(32);
    if (!Number.isSafeInteger(this.requestTtlMs) || this.requestTtlMs < 10_000 || this.requestTtlMs > 5 * 60 * 1_000) {
      throw new Error("capability approval request TTL must be from 10 seconds through 5 minutes");
    }
  }

  async create(owner: SettingsRequestOwner, preview: CapabilityActivationPreview): Promise<RenderedCapabilityChallenge> {
    this.validateOwner(owner);
    await this.expirePending();
    if (this.requests.size > 0 || this.reservationInProgress) {
      throw new CapabilityApprovalError("realm_busy", "Another Settings capability approval is pending", 409);
    }

    this.reservationInProgress = true;
    try {
      // Both opaque IDs exist before the digest is constructed. The hardened
      // adapter must reserve this exact attempt ID rather than substitute one.
      const requestId = this.randomId();
      const reservationId = this.randomId();
      const expiresAt = this.now() + this.requestTtlMs;
      const boundPreview = structuredClone(preview);
      const binding: CapabilityApprovalBinding = {
        requestId,
        reservationId,
        expiresAt,
        owner: { sessionId: owner.sessionId, origin: owner.origin },
      };
      const challenge = renderCapabilityChallenge(binding, boundPreview);
      const reservation = await this.pinAttempts.reserve({
        realm: WORKSPACE_CAPABILITY_APPROVAL_REALM,
        reservationId,
        requestId,
        operationDigest: challenge.operationDigest,
        expiresAt,
      });
      if (reservation.status === "cooldown") {
        throw new CapabilityApprovalError("cooldown", "Settings PIN approval is cooling down", 429, reservation.retryAt);
      }
      if (reservation.status === "busy") {
        throw new CapabilityApprovalError("realm_busy", "Another Settings capability approval is pending", 409);
      }
      if (reservation.status === "unavailable") {
        throw new CapabilityApprovalError("pin_unavailable", "Settings PIN approval is unavailable", 503);
      }
      this.requests.set(requestId, {
        requestId,
        reservationId,
        ownerDigest: this.digestOwner(owner),
        preview: boundPreview,
        binding,
        challenge,
        phase: "pending",
      });
      return challenge;
    } finally {
      this.reservationInProgress = false;
    }
  }

  async commit(owner: SettingsRequestOwner, requestId: string, pin: string): Promise<T> {
    this.validateOwner(owner);
    const request = await this.pendingOwned(owner, requestId);
    if (request.phase !== "pending") throw new CapabilityApprovalError("request_consumed", "Approval request was already consumed", 409);
    if (typeof pin !== "string" || pin.length < 1 || pin.length > 1_024) {
      await this.terminate(request, "backend_failure");
      throw new CapabilityApprovalError("invalid_request", "A bounded Settings PIN is required", 400);
    }

    request.phase = "consuming";
    let verification: VerifyPinAttemptResult;
    try {
      verification = await this.pinAttempts.verifyAndConsume({
        realm: WORKSPACE_CAPABILITY_APPROVAL_REALM,
        reservationId: request.reservationId,
        requestId: request.requestId,
        pin,
        now: this.now(),
      });
      this.requests.delete(request.requestId);
    } catch {
      try {
        await this.pinAttempts.cancelAndConsume({
          realm: WORKSPACE_CAPABILITY_APPROVAL_REALM,
          reservationId: request.reservationId,
          requestId: request.requestId,
          reason: "backend_failure",
          now: this.now(),
        });
        this.requests.delete(request.requestId);
      } catch {
        // Keep the consuming request latched until restart-safe adapter recovery.
      }
      throw new CapabilityApprovalError("pin_unavailable", "Settings PIN approval is unavailable", 503);
    }

    if (verification.status === "wrong_pin") throw new CapabilityApprovalError("wrong_pin", "Settings PIN was not accepted", 403);
    if (verification.status === "expired") throw new CapabilityApprovalError("request_expired", "Approval request expired", 410);
    if (verification.status === "unavailable") throw new CapabilityApprovalError("pin_unavailable", "Settings PIN approval is unavailable", 503);

    return this.commitVerified({
      preview: request.preview,
      approvalBinding: request.binding,
      approvalDigest: request.challenge.operationDigest,
      approvedAt: this.now(),
    });
  }

  async cancel(owner: SettingsRequestOwner, requestId: string, authenticationLost = false): Promise<void> {
    this.validateOwner(owner);
    const request = await this.pendingOwned(owner, requestId);
    if (request.phase !== "pending") throw new CapabilityApprovalError("request_consumed", "Approval request was already consumed", 409);
    await this.terminate(request, authenticationLost ? "authentication_lost" : "cancelled");
  }

  async expirePending(): Promise<void> {
    const now = this.now();
    const expired = [...this.requests.values()].filter((request) => request.phase === "pending" && request.challenge.expiresAt <= now);
    await Promise.all(expired.map((request) => this.terminate(request, "expired")));
  }

  hasPendingRequest(requestId: string): boolean {
    return this.requests.has(requestId);
  }

  private async pendingOwned(owner: SettingsRequestOwner, requestId: string): Promise<PendingRequest> {
    const request = this.requests.get(requestId);
    if (!request) throw new CapabilityApprovalError("request_not_found", "Approval request was not found", 404);
    if (!this.ownerMatches(request.ownerDigest, owner)) {
      throw new CapabilityApprovalError("owner_mismatch", "Approval request belongs to another web session or Origin", 403);
    }
    if (request.phase === "pending" && request.challenge.expiresAt <= this.now()) {
      await this.terminate(request, "expired");
      throw new CapabilityApprovalError("request_expired", "Approval request expired", 410);
    }
    return request;
  }

  private async terminate(request: PendingRequest, reason: Parameters<SettingsPinAttemptPort["cancelAndConsume"]>[0]["reason"]): Promise<void> {
    if (!this.requests.has(request.requestId)) return;
    request.phase = "consuming";
    try {
      await this.pinAttempts.cancelAndConsume({
        realm: WORKSPACE_CAPABILITY_APPROVAL_REALM,
        reservationId: request.reservationId,
        requestId: request.requestId,
        reason,
        now: this.now(),
      });
      this.requests.delete(request.requestId);
    } catch {
      request.phase = "pending";
      throw new CapabilityApprovalError("pin_unavailable", "Settings PIN approval is unavailable", 503);
    }
  }

  private digestOwner(owner: SettingsRequestOwner): Buffer {
    return createHmac("sha256", this.ownerKey)
      .update(owner.sessionId, "utf8")
      .update("\0", "utf8")
      .update(owner.origin, "utf8")
      .digest();
  }

  private ownerMatches(expected: Buffer, owner: SettingsRequestOwner): boolean {
    const actual = this.digestOwner(owner);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private validateOwner(owner: SettingsRequestOwner): void {
    if (!owner || typeof owner.sessionId !== "string" || owner.sessionId.length < 1 || owner.sessionId.length > 4_096) {
      throw new CapabilityApprovalError("unauthenticated", "An exact authenticated Settings session is required", 401);
    }
    if (typeof owner.origin !== "string" || owner.origin.length < 1 || owner.origin.length > 2_048) {
      throw new CapabilityApprovalError("invalid_origin", "An exact Settings Origin is required", 403);
    }
    try {
      const parsed = new URL(owner.origin);
      if (parsed.origin !== owner.origin || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) throw new Error("not exact");
    } catch {
      throw new CapabilityApprovalError("invalid_origin", "An exact Settings Origin is required", 403);
    }
  }
}
