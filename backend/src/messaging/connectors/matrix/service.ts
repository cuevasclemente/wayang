import { authorizeMessagingParticipant } from "../../endpoint-policy.js";
import type {
  MessagingEndpointDeclaration,
  MessagingParticipantSnapshot,
  NormalizedMessagingInboundEvent,
} from "../../contracts.js";
import { listMessagingEndpoints, messagingDeclarationSha256 } from "../../store.js";
import type { MessagingEndpointRow } from "../../store-types.js";
import type { MatrixAttestationAdapter } from "./attestation.js";
import {
  filterMatrixTransaction,
  parseMatrixTransaction,
  type MatrixEventDisposition,
} from "./events.js";
import {
  deriveMatrixPersonaUserId,
  validateMatrixRoomAlias,
  validateMatrixUserId,
  type MatrixNamespace,
} from "./identifiers.js";
import type { MatrixProvisioningService } from "./provisioning.js";

export interface MatrixGatewayTransactionChild {
  readonly endpointId: string;
  readonly declarationSha256: string;
  readonly declaration: MessagingEndpointDeclaration;
  readonly participantSnapshot: MessagingParticipantSnapshot;
  readonly event: NormalizedMessagingInboundEvent;
}

export interface MatrixGatewayTransactionAdmission {
  readonly duplicate: boolean;
  readonly endpointIds: readonly string[];
}

/**
 * Narrow connector-neutral transaction port the gateway host must implement
 * using the durable atomic manifest repository, then schedule drains without
 * model wait. Agent profile names and workspace defaults are irrelevant here.
 */
export interface MatrixGatewayTransactionPort {
  lookupCompletedTransaction(input: {
    readonly connectorId: "matrix";
    readonly transactionId: string;
  }): { readonly canonicalTransactionSha256: string } | null;
  hasDurableEvent(input: { readonly connectorId: "matrix"; readonly connectorEventId: string }): boolean;
  admitTransaction(input: {
    readonly connectorId: "matrix";
    readonly transactionId: string;
    readonly canonicalTransactionSha256: string;
    readonly children: readonly MatrixGatewayTransactionChild[];
  }): MatrixGatewayTransactionAdmission | Promise<MatrixGatewayTransactionAdmission>;
  scheduleEndpointDrain(endpointId: string): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface MatrixEndpointBindingPort {
  list(): readonly MessagingEndpointRow[];
}

export interface MatrixApplicationServiceOptions {
  readonly namespace: MatrixNamespace;
  readonly declarations: readonly MessagingEndpointDeclaration[];
  readonly gateway: MatrixGatewayTransactionPort;
  readonly attestations: MatrixAttestationAdapter;
  readonly provisioning: Pick<MatrixProvisioningService,
    "ensurePersona" | "ensureAlias" | "declarationForPersona" | "declarationForAlias">;
  readonly endpoints?: MatrixEndpointBindingPort;
  readonly now?: () => number;
  readonly startupHorizonMs?: number;
}

export class MatrixServiceError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: "M_BAD_JSON" | "M_FORBIDDEN" | "M_NOT_FOUND" | "M_UNRECOGNIZED" | "M_UNKNOWN" | "M_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "MatrixServiceError";
  }
}

const productionEndpoints: MatrixEndpointBindingPort = { list: listMessagingEndpoints };

export class MatrixApplicationService {
  private readonly declarations: Map<string, MessagingEndpointDeclaration>;
  private readonly endpoints: MatrixEndpointBindingPort;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly startupHorizonMs: number;
  private ready = false;
  private accepting = true;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly options: MatrixApplicationServiceOptions) {
    this.declarations = new Map(options.declarations.map((row) => [row.endpointId, row]));
    if (this.declarations.size !== options.declarations.length
      || options.declarations.some((row) => row.connectorId !== "matrix")) {
      throw new Error("Invalid Matrix Application Service declarations");
    }
    this.endpoints = options.endpoints ?? productionEndpoints;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.startupHorizonMs = options.startupHorizonMs ?? 5 * 60_000;
    if (!Number.isInteger(this.startupHorizonMs) || this.startupHorizonMs < 0 || this.startupHorizonMs > 24 * 60 * 60_000) {
      throw new Error("Invalid Matrix startup horizon");
    }
  }

  status(): Readonly<{ ready: boolean; accepting: boolean }> {
    return Object.freeze({ ready: this.ready, accepting: this.accepting });
  }

  start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.options.gateway.start().then(() => {
        if (this.accepting) this.ready = true;
      });
    }
    return this.startPromise;
  }

  stopAdmission(): void {
    this.accepting = false;
    this.ready = false;
  }

  async close(): Promise<void> {
    this.stopAdmission();
    await this.options.gateway.close();
  }

  private requireReady(): void {
    if (!this.accepting || !this.ready) throw new MatrixServiceError(503, "M_UNAVAILABLE", "Matrix service is recovering");
  }

  private currentBindings(): Map<string, { row: MessagingEndpointRow; declaration: MessagingEndpointDeclaration }> {
    const result = new Map<string, { row: MessagingEndpointRow; declaration: MessagingEndpointDeclaration }>();
    for (const row of this.endpoints.list()) {
      if (row.connector_id !== "matrix" || !row.external_conversation_id) continue;
      const declaration = this.declarations.get(row.endpoint_id);
      if (!declaration || row.declaration_sha256 !== messagingDeclarationSha256(declaration)) continue;
      result.set(row.external_conversation_id, { row, declaration });
    }
    return result;
  }

  async ingestTransaction(transactionId: string, body: Uint8Array): Promise<MatrixGatewayTransactionAdmission> {
    this.requireReady();
    let transaction;
    try {
      transaction = parseMatrixTransaction(transactionId, body);
    } catch {
      throw new MatrixServiceError(400, "M_BAD_JSON", "Invalid Matrix transaction");
    }
    const completed = this.options.gateway.lookupCompletedTransaction({ connectorId: "matrix", transactionId });
    if (completed) {
      if (completed.canonicalTransactionSha256 !== transaction.canonicalSha256) {
        throw new MatrixServiceError(409, "M_UNKNOWN", "Matrix transaction identity was reused with different content");
      }
      return Object.freeze({ duplicate: true, endpointIds: Object.freeze([]) });
    }
    const rooms = this.currentBindings();
    const dispositions = filterMatrixTransaction(transaction, {
      ...this.options.namespace,
      knownRoomIds: new Set(rooms.keys()),
    });
    const children: MatrixGatewayTransactionChild[] = [];
    for (const disposition of dispositions) {
      if (disposition.code !== "admissible_text") continue;
      const event = disposition.event;
      if (event.occurredAt < this.startedAt - this.startupHorizonMs
        && !this.options.gateway.hasDurableEvent({ connectorId: "matrix", connectorEventId: event.connectorEventId })) {
        continue;
      }
      const current = rooms.get(event.externalConversationId);
      if (!current) continue;
      const personaUserId = deriveMatrixPersonaUserId(current.declaration.agentProfileId, this.options.namespace);
      const observedAt = this.now();
      const snapshot = await this.options.attestations.attest({
        roomId: event.externalConversationId,
        senderUserId: event.senderSubjectId,
        actingUserId: personaUserId,
        observedAt,
      });
      const decision = authorizeMessagingParticipant(
        current.declaration,
        {
          endpointId: current.row.endpoint_id,
          connectorId: current.row.connector_id,
          externalConversationId: current.row.external_conversation_id!,
          activeWayangSessionId: current.row.active_session_id,
          revision: current.row.revision,
        },
        event,
        snapshot,
        { now: observedAt },
      );
      // A blocked room must not wedge the homeserver's global AS transaction
      // queue. The exact transaction is durably completed without admitting
      // this event; fresh policy still runs again inside atomic admission for
      // every allowed child.
      if (!decision.allowed) continue;
      children.push(Object.freeze({
        endpointId: current.declaration.endpointId,
        declarationSha256: current.row.declaration_sha256,
        declaration: current.declaration,
        participantSnapshot: snapshot,
        event,
      }));
    }
    const admitted = await this.options.gateway.admitTransaction({
      connectorId: "matrix",
      transactionId: transaction.transactionId,
      canonicalTransactionSha256: transaction.canonicalSha256,
      children: Object.freeze(children),
    });
    for (const endpointId of new Set(admitted.endpointIds)) this.options.gateway.scheduleEndpointDrain(endpointId);
    return admitted;
  }

  async queryUser(rawUserId: string): Promise<void> {
    this.requireReady();
    let userId: string;
    try { userId = validateMatrixUserId(rawUserId, this.options.namespace.serverName); }
    catch { throw new MatrixServiceError(404, "M_NOT_FOUND", "User is not managed"); }
    // Query callbacks are side-effect free namespace answers. CS registration
    // can synchronously callback here, so awaiting provisioning would deadlock.
    if (!this.options.provisioning.declarationForPersona(userId)) {
      throw new MatrixServiceError(404, "M_NOT_FOUND", "User is not managed");
    }
  }

  async queryAlias(rawAlias: string): Promise<void> {
    this.requireReady();
    let alias: string;
    try { alias = validateMatrixRoomAlias(rawAlias, this.options.namespace.serverName); }
    catch { throw new MatrixServiceError(404, "M_NOT_FOUND", "Room alias is not managed"); }
    const declaration = this.options.provisioning.declarationForAlias(alias);
    // Claim only an alias whose exact endpoint already has a durable room bind;
    // never recursively initiate createRoom from the AS callback.
    const endpoint = declaration
      ? this.endpoints.list().find((candidate) => candidate.endpoint_id === declaration.endpointId)
      : null;
    if (!declaration || !endpoint || endpoint.external_conversation_id === null) {
      throw new MatrixServiceError(404, "M_NOT_FOUND", "Room alias is not managed");
    }
  }
}

export type { MatrixEventDisposition };
