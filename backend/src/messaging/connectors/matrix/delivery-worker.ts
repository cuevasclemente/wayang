import { randomUUID } from "node:crypto";
import type { MessagingEndpointDeclaration } from "../../contracts.js";
import { WorkspaceStoreError } from "../../../workspace-types.js";
import {
  acknowledgeMessagingDelivery,
  claimNextDueMessagingDelivery,
  failMessagingDelivery,
  getMessagingEndpoint,
  messagingDeclarationSha256,
  persistMessagingDeliveryAttestation,
  persistMessagingDeliveryRemoteProgress,
  recoverPriorBootMessagingDeliveryClaims,
  scheduleMessagingDeliveryRetry,
  withholdMessagingDeliveryGroup,
} from "../../store.js";
import type {
  MessagingDeliveryErrorCode,
  MessagingDeliveryRow,
  MessagingEndpointRow,
  MessagingOutboundParticipantSnapshot,
} from "../../store-types.js";
import type { MatrixAttestationAdapter } from "./attestation.js";
import { chunkMatrixText, deriveMatrixDeliveryTransactionId, matrixHandoffUrl } from "./chunking.js";
import { MatrixClientError, type MatrixClient } from "./client.js";
import { deriveMatrixPersonaUserId, type MatrixNamespace } from "./identifiers.js";

export interface MatrixDeliveryStorePort {
  recoverPriorBoot(input: { connectorId: string; workerBootId: string; now?: number }): readonly MessagingDeliveryRow[];
  claimNextDue(input: { connectorId: string; workerBootId: string; now?: number }): MessagingDeliveryRow | null;
  getEndpoint(endpointId: string): MessagingEndpointRow | undefined;
  persistAttestation(input: {
    deliveryId: string; claimId: string; claimGeneration: number; workerBootId: string;
    payloadSha256: string; declarationSha256: string; declaration: MessagingEndpointDeclaration;
    participantSnapshot: MessagingOutboundParticipantSnapshot; connectorTransactionIds: readonly string[]; now?: number;
  }): MessagingDeliveryRow;
  persistRemoteProgress(input: {
    deliveryId: string; claimId: string; claimGeneration: number; workerBootId: string;
    connectorTransactionId: string; remoteDeliveryId: string; expectedSubchunkIndex: number; now?: number;
  }): MessagingDeliveryRow;
  acknowledge(input: {
    deliveryId: string; claimId: string; claimGeneration: number; workerBootId: string;
    connectorTransactionIds: readonly string[]; remoteDeliveryIds: readonly string[]; now?: number;
  }): MessagingDeliveryRow;
  retry(input: {
    deliveryId: string; claimId: string; claimGeneration: number; workerBootId: string;
    errorCode: MessagingDeliveryErrorCode; nextAttemptAt: number; now?: number;
  }): MessagingDeliveryRow;
  withhold(input: {
    deliveryId: string; claimId: string; claimGeneration: number; workerBootId: string;
    errorCode: MessagingDeliveryErrorCode; now?: number;
  }): readonly MessagingDeliveryRow[];
  fail(input: {
    deliveryId: string; claimId: string; claimGeneration: number; workerBootId: string;
    errorCode: MessagingDeliveryErrorCode; now?: number;
  }): readonly MessagingDeliveryRow[];
}

export interface MatrixOutboundAttestationPort {
  attest(input: {
    readonly endpointId: string;
    readonly roomId: string;
    readonly actingUserId: string;
  }): Promise<MessagingOutboundParticipantSnapshot>;
}

export function createMatrixOutboundAttestationPort(adapter: MatrixAttestationAdapter): MatrixOutboundAttestationPort {
  return Object.freeze({
    async attest(input: {
      readonly endpointId: string;
      readonly roomId: string;
      readonly actingUserId: string;
    }) {
      const snapshot = await adapter.attest({
        roomId: input.roomId,
        senderUserId: input.actingUserId,
        actingUserId: input.actingUserId,
      });
      return Object.freeze({
        connectorId: snapshot.connectorId,
        externalConversationId: snapshot.externalConversationId,
        joinedHumanSubjectIds: snapshot.joinedHumanSubjectIds,
        complete: true,
        observedAt: snapshot.observedAt,
        revision: snapshot.revision,
        confidentiality: snapshot.confidentiality,
      });
    },
  });
}

export interface MatrixDeliveryTimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type MatrixDeliveryWorkerAttentionCode =
  | "idle" | "running" | "transport_retry" | "policy_withheld" | "delivery_failed" | "persistence_ambiguous" | "closed";

export interface MatrixDeliveryWorkerStatus {
  readonly code: MatrixDeliveryWorkerAttentionCode;
  readonly updatedAt: number;
}

export interface MatrixDeliveryWorkerOptions {
  readonly declarations: readonly MessagingEndpointDeclaration[];
  readonly namespace: MatrixNamespace;
  readonly wayangBaseUrl: string;
  readonly client: Pick<MatrixClient, "sendText">;
  readonly attestations: MatrixOutboundAttestationPort;
  readonly store?: MatrixDeliveryStorePort;
  readonly now?: () => number;
  readonly bootId?: () => string;
  readonly timer?: MatrixDeliveryTimerPort;
  readonly pollIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly chunkBytes?: number;
  readonly onStatus?: (status: MatrixDeliveryWorkerStatus) => void;
}

const productionStore: MatrixDeliveryStorePort = {
  recoverPriorBoot: recoverPriorBootMessagingDeliveryClaims,
  claimNextDue: claimNextDueMessagingDelivery,
  getEndpoint: getMessagingEndpoint,
  persistAttestation: persistMessagingDeliveryAttestation,
  persistRemoteProgress: persistMessagingDeliveryRemoteProgress,
  acknowledge: acknowledgeMessagingDelivery,
  retry: scheduleMessagingDeliveryRetry,
  withhold: withholdMessagingDeliveryGroup,
  fail: failMessagingDelivery,
};
const systemTimer: MatrixDeliveryTimerPort = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function projection(row: MessagingDeliveryRow, wayangBaseUrl: string): string {
  switch (row.payload.kind) {
    case "final": return row.payload.text;
    case "notice": return row.payload.text;
    case "error": return `Wayang could not complete this operation (${row.payload.code}).`;
    case "continue_in_wayang": return `Continue in Wayang: ${matrixHandoffUrl(wayangBaseUrl, row.payload.session_id)}`;
  }
}

function acceptanceAmbiguousSend(error: unknown): boolean {
  return error instanceof MatrixClientError && (error.code === "network" || error.code === "timeout"
    || error.code === "invalid_response" || error.code === "response_too_large"
    || error.status === 429 || (error.status !== null && error.status >= 500));
}

function claimInput(row: MessagingDeliveryRow, workerBootId: string) {
  if (!row.claim_id) throw new Error("Matrix delivery row has no claim");
  return {
    deliveryId: row.id,
    claimId: row.claim_id,
    claimGeneration: row.claim_generation,
    workerBootId,
  };
}

export class MatrixDeliveryWorker {
  readonly workerBootId: string;
  private readonly declarations: Map<string, MessagingEndpointDeclaration>;
  private readonly store: MatrixDeliveryStorePort;
  private readonly now: () => number;
  private readonly timer: MatrixDeliveryTimerPort;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly chunkBytes: number | undefined;
  private started = false;
  private closed = false;
  private timerHandle: unknown | null = null;
  private active: Promise<boolean> | null = null;
  private closePromise: Promise<void> | null = null;
  private currentStatus: MatrixDeliveryWorkerStatus;

  constructor(private readonly options: MatrixDeliveryWorkerOptions) {
    this.declarations = new Map(options.declarations.map((value) => [value.endpointId, value]));
    if (this.declarations.size !== options.declarations.length) throw new Error("Duplicate Matrix delivery endpoint");
    this.store = options.store ?? productionStore;
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? systemTimer;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.chunkBytes = options.chunkBytes;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 50 || this.pollIntervalMs > 60_000
      || !Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 20
      || !Number.isInteger(this.retryBaseMs) || this.retryBaseMs < 100 || this.retryBaseMs > 60_000) {
      throw new Error("Invalid Matrix delivery worker bounds");
    }
    this.workerBootId = (options.bootId ?? randomUUID)();
    if (!this.workerBootId || Buffer.byteLength(this.workerBootId, "utf8") > 512) throw new Error("Invalid Matrix worker boot ID");
    this.currentStatus = Object.freeze({ code: "idle", updatedAt: this.now() });
  }

  status(): MatrixDeliveryWorkerStatus { return this.currentStatus; }

  private setStatus(code: MatrixDeliveryWorkerAttentionCode): void {
    this.currentStatus = Object.freeze({ code, updatedAt: this.now() });
    try { this.options.onStatus?.(this.currentStatus); } catch { /* diagnostics cannot alter delivery state */ }
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    // Recovery is synchronous durable CAS and must precede the first claim.
    this.store.recoverPriorBoot({ connectorId: "matrix", workerBootId: this.workerBootId, now: this.now() });
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.timerHandle !== null) return;
    this.timerHandle = this.timer.setTimeout(() => {
      this.timerHandle = null;
      void this.runOnce().then((worked) => this.schedule(worked ? 0 : this.pollIntervalMs), () => {
        this.setStatus("persistence_ambiguous");
        this.schedule(this.pollIntervalMs);
      });
    }, delayMs);
  }

  runOnce(): Promise<boolean> {
    if (this.active) return this.active;
    if (this.closed) return Promise.resolve(false);
    const running = this.processOne().finally(() => {
      if (this.active === running) this.active = null;
    });
    this.active = running;
    return running;
  }

  private retryDelay(attempt: number): number {
    return Math.min(5 * 60_000, this.retryBaseMs * (2 ** Math.min(attempt - 1, 8)));
  }

  private async retryOrWithhold(row: MessagingDeliveryRow, errorCode: MessagingDeliveryErrorCode): Promise<void> {
    if (row.attempt_count >= this.maxAttempts) {
      this.store.withhold({ ...claimInput(row, this.workerBootId), errorCode, now: this.now() });
      this.setStatus("policy_withheld");
      return;
    }
    const now = this.now();
    this.store.retry({
      ...claimInput(row, this.workerBootId), errorCode,
      now, nextAttemptAt: now + this.retryDelay(row.attempt_count),
    });
    this.setStatus("transport_retry");
  }

  private async processOne(): Promise<boolean> {
    const row = this.store.claimNextDue({ connectorId: "matrix", workerBootId: this.workerBootId, now: this.now() });
    if (!row) { this.setStatus("idle"); return false; }
    this.setStatus("running");
    const declaration = this.declarations.get(row.endpoint_id);
    const endpoint = this.store.getEndpoint(row.endpoint_id);
    if (!declaration || !endpoint || endpoint.declaration_sha256 !== row.declaration_sha256
      || messagingDeclarationSha256(declaration) !== row.declaration_sha256
      || endpoint.external_conversation_id !== row.external_conversation_id
      || declaration.transportSecurity === "encrypted_required") {
      this.store.withhold({ ...claimInput(row, this.workerBootId), errorCode: "declaration_changed", now: this.now() });
      this.setStatus("policy_withheld");
      return true;
    }
    const personaUserId = deriveMatrixPersonaUserId(declaration.agentProfileId, this.options.namespace);
    const body = projection(row, this.options.wayangBaseUrl);
    const chunks = this.chunkBytes === undefined ? chunkMatrixText(body) : chunkMatrixText(body, this.chunkBytes);
    const transactionIds = chunks.map((_, subchunkIndex) =>
      deriveMatrixDeliveryTransactionId(row.id, row.chunk_index, subchunkIndex));
    if (row.remote_delivery_ids.length > chunks.length) {
      this.setStatus("persistence_ambiguous");
      throw new Error("Durable Matrix subchunk progress exceeds deterministic manifest");
    }
    let persisted = row;
    const remoteIds = [...row.remote_delivery_ids];
    for (let index = remoteIds.length; index < chunks.length; index++) {
      // Membership/confidentiality is fetched and durably CAS-bound immediately
      // before every remotely visible subchunk, not merely once per delivery.
      let snapshot: MessagingOutboundParticipantSnapshot;
      try {
        snapshot = await this.options.attestations.attest({
          endpointId: row.endpoint_id,
          roomId: row.external_conversation_id,
          actingUserId: personaUserId,
        });
      } catch {
        await this.retryOrWithhold(persisted, "attestation_unavailable");
        return true;
      }
      const allowed = new Set(declaration.allowedSubjectIds);
      if (snapshot.connectorId !== "matrix" || snapshot.externalConversationId !== row.external_conversation_id
        || snapshot.confidentiality !== "server_visible" || snapshot.joinedHumanSubjectIds.length === 0
        || snapshot.joinedHumanSubjectIds.some((subject) => !allowed.has(subject))) {
        this.store.withhold({ ...claimInput(persisted, this.workerBootId), errorCode: "authorization_changed", now: this.now() });
        this.setStatus("policy_withheld");
        return true;
      }
      const persistInput = {
        ...claimInput(persisted, this.workerBootId),
        payloadSha256: row.payload_sha256,
        declarationSha256: row.declaration_sha256,
        declaration,
        participantSnapshot: snapshot,
        connectorTransactionIds: transactionIds,
        now: this.now(),
      };
      try {
        try { persisted = this.store.persistAttestation(persistInput); }
        catch { persisted = this.store.persistAttestation(persistInput); }
      } catch (error) {
        if (!(error instanceof WorkspaceStoreError)) {
          this.setStatus("persistence_ambiguous");
          throw error;
        }
        this.store.withhold({ ...claimInput(persisted, this.workerBootId), errorCode: "authorization_changed", now: this.now() });
        this.setStatus("policy_withheld");
        return true;
      }

      let remoteId: string;
      try {
        remoteId = await this.options.client.sendText(
          row.external_conversation_id, personaUserId, transactionIds[index]!, chunks[index]!,
        );
      } catch (error) {
        const ambiguous = acceptanceAmbiguousSend(error);
        if (ambiguous && persisted.attempt_count < this.maxAttempts) {
          const now = this.now();
          this.store.retry({
            ...claimInput(persisted, this.workerBootId), errorCode: "transport_error",
            now, nextAttemptAt: now + this.retryDelay(persisted.attempt_count),
          });
          this.setStatus("transport_retry");
        } else if (ambiguous) {
          this.store.withhold({
            ...claimInput(persisted, this.workerBootId), errorCode: "remote_ambiguous", now: this.now(),
          });
          this.setStatus("delivery_failed");
        } else {
          this.store.fail({
            ...claimInput(persisted, this.workerBootId), errorCode: "remote_rejected", now: this.now(),
          });
          this.setStatus("delivery_failed");
        }
        return true;
      }

      const progress = {
        ...claimInput(persisted, this.workerBootId),
        connectorTransactionId: transactionIds[index]!,
        remoteDeliveryId: remoteId,
        expectedSubchunkIndex: index,
        now: this.now(),
      };
      try { persisted = this.store.persistRemoteProgress(progress); }
      catch {
        // An accepted PUT without durable local progress must stop this boot.
        // Restart recovery repeats the same deterministic transaction ID.
        try { persisted = this.store.persistRemoteProgress(progress); }
        catch (error) {
          this.setStatus("persistence_ambiguous");
          throw error;
        }
      }
      remoteIds.push(remoteId);
    }
    const acknowledgement = {
      ...claimInput(persisted, this.workerBootId),
      connectorTransactionIds: transactionIds,
      remoteDeliveryIds: remoteIds,
      now: this.now(),
    };
    try { this.store.acknowledge(acknowledgement); }
    catch {
      // Retry the exact durable acknowledgement once. If persistence remains
      // ambiguous, keep the claim for prior-boot recovery and identical send IDs.
      this.store.acknowledge(acknowledgement);
    }
    this.setStatus("idle");
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.timerHandle !== null) this.timer.clearTimeout(this.timerHandle);
    this.timerHandle = null;
    this.closePromise = (this.active ?? Promise.resolve(false)).then(() => { this.setStatus("closed"); });
    return this.closePromise;
  }
}
