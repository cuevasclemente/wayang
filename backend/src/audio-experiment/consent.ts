import { randomUUID } from "node:crypto";
import type { BrowserTurnProvenance } from "../interactive-turn-provenance.js";
import {
  FILE_AUDIO_EXPERIMENT_ARMS,
  type FileAudioAttachmentSnapshot,
  type FileAudioExperimentBinding,
  type FileAudioExperimentPermit,
} from "./types.js";

export const DEFAULT_FILE_AUDIO_PERMIT_TTL_MS = 60_000;
export const MAX_FILE_AUDIO_PERMIT_TTL_MS = 120_000;
const MAX_PERMITS_PER_RUNTIME = 256;

type PermitState = "ready" | "executing" | "used" | "revoked";
interface PrivatePermit {
  permit: FileAudioExperimentPermit;
  state: PermitState;
  controller?: AbortController;
}

function exactBindingEqual(
  left: Readonly<FileAudioExperimentBinding>,
  right: Readonly<FileAudioExperimentBinding>,
): boolean {
  return left.sourceSessionId === right.sourceSessionId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.processBootNonce === right.processBootNonce
    && left.projectId === right.projectId
    && left.projectCwd === right.projectCwd
    && left.agentProfileId === right.agentProfileId
    && left.provider === right.provider
    && left.model === right.model;
}

function exactCurrentTurnEqual(left: BrowserTurnProvenance, right: BrowserTurnProvenance): boolean {
  return Boolean(left.piUserEntryId && right.piUserEntryId)
    && left.token === right.token
    && left.piUserEntryId === right.piUserEntryId
    && left.acceptedAt === right.acceptedAt
    && left.contentSha256 === right.contentSha256
    && left.sourceKind === "browser_send_message"
    && right.sourceKind === "browser_send_message"
    && left.sourceSessionId === right.sourceSessionId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.agentProfileId === right.agentProfileId
    && left.projectId === right.projectId
    && left.projectCwd === right.projectCwd
    && left.provider === right.provider
    && left.model === right.model;
}

function turnMatchesBinding(turn: BrowserTurnProvenance, binding: Readonly<FileAudioExperimentBinding>): boolean {
  return Boolean(turn.piUserEntryId)
    && turn.sourceKind === "browser_send_message"
    && turn.sourceSessionId === binding.sourceSessionId
    && turn.runtimeGeneration === binding.runtimeGeneration
    && turn.agentProfileId === binding.agentProfileId
    && turn.projectId === binding.projectId
    && turn.projectCwd === binding.projectCwd
    && turn.provider === binding.provider
    && turn.model === binding.model;
}

export class FileAudioExperimentConsent {
  readonly binding: Readonly<FileAudioExperimentBinding>;
  readonly ttlMs: number;
  private readonly permits = new Map<string, PrivatePermit>();
  private closed = false;

  constructor(
    binding: Readonly<FileAudioExperimentBinding>,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    const ttlMs = options.ttlMs ?? DEFAULT_FILE_AUDIO_PERMIT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_FILE_AUDIO_PERMIT_TTL_MS) {
      throw new Error(`File-audio permit TTL must be between 1000 and ${MAX_FILE_AUDIO_PERMIT_TTL_MS} milliseconds`);
    }
    this.binding = Object.freeze({ ...binding });
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  private prune(): void {
    const now = this.now();
    for (const [id, record] of this.permits) {
      if (record.state !== "executing" && (record.permit.expiresAt <= now || record.state !== "ready")) {
        this.permits.delete(id);
      }
    }
    while (this.permits.size >= MAX_PERMITS_PER_RUNTIME) {
      const removable = [...this.permits].find(([, record]) => record.state !== "executing")?.[0];
      if (!removable) throw new Error("File-audio experiment has too many in-flight permits");
      this.permits.delete(removable);
    }
  }

  preview(options: {
    turn: BrowserTurnProvenance;
    attachment: FileAudioAttachmentSnapshot;
  }): FileAudioExperimentPermit {
    if (this.closed) throw new Error("File-audio experiment runtime is revoked");
    if (!turnMatchesBinding(options.turn, this.binding)) {
      throw new Error("File-audio preview requires the exact current persisted browser user turn");
    }
    this.prune();
    const issuedAt = this.now();
    const permit: FileAudioExperimentPermit = Object.freeze({
      permitId: randomUUID(),
      binding: this.binding,
      turn: options.turn,
      attachment: Object.freeze({ ...options.attachment }),
      arms: FILE_AUDIO_EXPERIMENT_ARMS,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    });
    this.permits.set(permit.permitId, { permit, state: "ready" });
    return permit;
  }

  /** Synchronous state transition prevents concurrent execute replay. */
  claim(permitId: string, currentTurn: BrowserTurnProvenance): {
    permit: FileAudioExperimentPermit;
    signal: AbortSignal;
  } {
    if (this.closed) throw new Error("File-audio experiment runtime is revoked");
    const record = this.permits.get(permitId);
    if (!record || record.state !== "ready") throw new Error("File-audio permit is unavailable or already used");
    if (record.permit.expiresAt <= this.now()) {
      record.state = "revoked";
      this.permits.delete(permitId);
      throw new Error("File-audio permit expired");
    }
    if (!exactBindingEqual(record.permit.binding, this.binding)
      || !turnMatchesBinding(currentTurn, this.binding)
      || !exactCurrentTurnEqual(record.permit.turn, currentTurn)) {
      throw new Error("File-audio permit does not belong to the exact current user turn");
    }
    const controller = new AbortController();
    record.state = "executing";
    record.controller = controller;
    return { permit: record.permit, signal: controller.signal };
  }

  finish(permitId: string): void {
    const record = this.permits.get(permitId);
    if (!record) return;
    record.state = "used";
    record.controller = undefined;
  }

  revoke(permitId: string, currentTurn: BrowserTurnProvenance): boolean {
    if (this.closed) throw new Error("File-audio experiment runtime is revoked");
    const record = this.permits.get(permitId);
    if (!record || record.state === "used" || record.state === "revoked") return false;
    if (!exactBindingEqual(record.permit.binding, this.binding)
      || !turnMatchesBinding(currentTurn, this.binding)
      || !exactCurrentTurnEqual(record.permit.turn, currentTurn)) {
      throw new Error("File-audio permit does not belong to the exact current user turn");
    }
    if (record.state !== "executing" && record.permit.expiresAt <= this.now()) {
      record.state = "revoked";
      this.permits.delete(permitId);
      return false;
    }
    record.state = "revoked";
    record.controller?.abort();
    record.controller = undefined;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.permits.values()) {
      record.state = "revoked";
      record.controller?.abort();
    }
    this.permits.clear();
  }
}
