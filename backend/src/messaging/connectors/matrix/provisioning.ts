import type { MessagingEndpointDeclaration } from "../../contracts.js";
import {
  bindMessagingConversation,
  getMessagingEndpoint,
  messagingDeclarationSha256,
} from "../../store.js";
import type { MessagingEndpointRow } from "../../store-types.js";
import { MatrixClientError, type MatrixClient } from "./client.js";
import {
  deriveMatrixCanonicalAlias,
  deriveMatrixPersonaUserId,
  isManagedMatrixUser,
  isMatrixApplicationServiceSender,
  validateMatrixRoomId,
  validateMatrixUserId,
  validateMatrixNamespace,
  type MatrixNamespace,
} from "./identifiers.js";

export type MatrixProvisioningAttentionCode =
  | "ready"
  | "encrypted_required"
  | "homeserver_unavailable"
  | "declaration_changed"
  | "room_binding_conflict"
  | "unexpected_participant"
  | "encryption_unverified"
  | "provisioning_failed";

export interface MatrixProvisioningStatus {
  readonly endpointId: string;
  readonly code: MatrixProvisioningAttentionCode;
  readonly retrying: boolean;
  readonly updatedAt: number;
}

export interface MatrixProvisioningStorePort {
  getEndpoint(endpointId: string): MessagingEndpointRow | undefined;
  bindConversation(input: {
    endpointId: string;
    declarationSha256: string;
    expectedRevision: number;
    externalConversationId: string;
    now?: number;
  }): MessagingEndpointRow;
}

export interface MatrixProvisioningResult {
  readonly endpoint: MessagingEndpointRow;
  readonly personaUserId: string;
  readonly canonicalAlias: string;
  readonly status: MatrixProvisioningStatus;
}

export interface MatrixProvisioningServiceOptions {
  readonly namespace: MatrixNamespace;
  readonly declarations: readonly MessagingEndpointDeclaration[];
  readonly client: MatrixClient;
  readonly store?: MatrixProvisioningStorePort;
  readonly now?: () => number;
}

const productionStore: MatrixProvisioningStorePort = {
  getEndpoint: getMessagingEndpoint,
  bindConversation: bindMessagingConversation,
};

function unavailable(error: unknown): boolean {
  return error instanceof MatrixClientError
    && (error.code === "network" || error.code === "timeout"
      || error.status === 429 || (error.status !== null && error.status >= 500));
}

function status(endpointId: string, code: MatrixProvisioningAttentionCode, now: number): MatrixProvisioningStatus {
  return Object.freeze({ endpointId, code, retrying: code === "homeserver_unavailable", updatedAt: now });
}

export class MatrixProvisioningService {
  private readonly namespace: Readonly<MatrixNamespace>;
  private readonly declarations: Map<string, MessagingEndpointDeclaration>;
  private readonly store: MatrixProvisioningStorePort;
  private readonly now: () => number;
  private readonly statuses = new Map<string, MatrixProvisioningStatus>();
  private readonly inFlight = new Map<string, Promise<MatrixProvisioningResult>>();

  constructor(private readonly options: MatrixProvisioningServiceOptions) {
    this.namespace = validateMatrixNamespace(options.namespace);
    this.declarations = new Map(options.declarations.map((declaration) => [declaration.endpointId, declaration]));
    if (this.declarations.size !== options.declarations.length) throw new Error("Duplicate Matrix provisioning endpoint");
    this.store = options.store ?? productionStore;
    this.now = options.now ?? Date.now;
  }

  declarationForPersona(userId: string): MessagingEndpointDeclaration | undefined {
    return [...this.declarations.values()].find((declaration) =>
      deriveMatrixPersonaUserId(declaration.agentProfileId, this.namespace) === userId);
  }

  declarationForAlias(alias: string): MessagingEndpointDeclaration | undefined {
    return [...this.declarations.values()].find((declaration) =>
      deriveMatrixCanonicalAlias(declaration.provisioningKey, this.namespace) === alias);
  }

  getStatus(endpointId: string): MatrixProvisioningStatus {
    return this.statuses.get(endpointId) ?? status(endpointId, "provisioning_failed", this.now());
  }

  listStatuses(): readonly MatrixProvisioningStatus[] {
    return Object.freeze([...this.declarations.keys()].sort().map((id) => this.getStatus(id)));
  }

  ensureEndpoint(endpointId: string): Promise<MatrixProvisioningResult> {
    const existing = this.inFlight.get(endpointId);
    if (existing) return existing;
    const running = this.reconcile(endpointId).finally(() => {
      if (this.inFlight.get(endpointId) === running) this.inFlight.delete(endpointId);
    });
    this.inFlight.set(endpointId, running);
    return running;
  }

  async ensurePersona(userId: string): Promise<MatrixProvisioningResult | null> {
    const declaration = this.declarationForPersona(userId);
    if (!declaration) return null;
    return this.ensureEndpoint(declaration.endpointId);
  }

  async ensureAlias(alias: string): Promise<MatrixProvisioningResult | null> {
    const declaration = this.declarationForAlias(alias);
    if (!declaration) return null;
    return this.ensureEndpoint(declaration.endpointId);
  }

  private setStatus(endpointId: string, code: MatrixProvisioningAttentionCode): MatrixProvisioningStatus {
    const next = status(endpointId, code, this.now());
    this.statuses.set(endpointId, next);
    return next;
  }

  private async reconcile(endpointId: string): Promise<MatrixProvisioningResult> {
    const declaration = this.declarations.get(endpointId);
    if (!declaration) throw new Error("Matrix endpoint is not declared");
    if (declaration.connectorId !== "matrix") throw new Error("Matrix provisioning received another connector");
    if (declaration.transportSecurity === "encrypted_required") {
      this.setStatus(endpointId, "encrypted_required");
      throw new Error("Matrix E2EE is unavailable for encrypted-required endpoints");
    }
    const digest = messagingDeclarationSha256(declaration);
    const current = this.store.getEndpoint(endpointId);
    if (!current || current.declaration_sha256 !== digest || current.connector_id !== "matrix") {
      this.setStatus(endpointId, "declaration_changed");
      throw new Error("Matrix endpoint declaration is not reconciled");
    }
    const personaUserId = deriveMatrixPersonaUserId(declaration.agentProfileId, this.namespace);
    const canonicalAlias = deriveMatrixCanonicalAlias(declaration.provisioningKey, this.namespace);
    try {
      try {
        await this.options.client.registerApplicationServiceUser(personaUserId);
      } catch (error) {
        if (!(error instanceof MatrixClientError && error.status === 400 && error.matrixErrcode === "M_USER_IN_USE")) throw error;
      }
      await this.options.client.setDisplayName(personaUserId, declaration.displayName);

      // Durable room identity, not a mutable alias, is authoritative after the
      // first successful bind. For an unbound endpoint create first: resolving
      // an absent AS-namespace alias can synchronously callback into this same
      // provisioning operation and deadlock. Resolve only to recover an
      // ambiguous/conflicting create which may already have succeeded.
      let roomId = current.external_conversation_id;
      if (roomId === null) {
        try {
          roomId = await this.options.client.createPrivateRoom({
            creatorUserId: personaUserId,
            canonicalAlias,
            name: declaration.displayName,
          });
        } catch (creationError) {
          roomId = await this.options.client.resolveRoomAlias(canonicalAlias, personaUserId);
          if (roomId === null) throw creationError;
        }
      }
      validateMatrixRoomId(roomId);
      let bound: MessagingEndpointRow;
      try {
        bound = this.store.bindConversation({
          endpointId,
          declarationSha256: digest,
          expectedRevision: current.revision,
          externalConversationId: roomId,
          now: this.now(),
        });
      } catch (error) {
        this.setStatus(endpointId, "room_binding_conflict");
        throw error;
      }

      // The durable room ID is authority before any invite or ingress effect.
      await this.options.client.joinRoom(roomId, personaUserId);
      let joinedBeforeInvites = await this.options.client.getJoinedMembers(roomId, personaUserId);
      for (const subjectId of declaration.allowedSubjectIds) {
        validateMatrixUserId(subjectId, this.namespace.serverName);
        if (joinedBeforeInvites.includes(subjectId)) continue;
        try {
          await this.options.client.inviteUser(roomId, personaUserId, subjectId);
        } catch (error) {
          // Only a freshly proven joined member makes an ambiguous invite idempotent.
          joinedBeforeInvites = await this.options.client.getJoinedMembers(roomId, personaUserId);
          if (!joinedBeforeInvites.includes(subjectId)) throw error;
        }
      }
      const [members, encrypted] = await Promise.all([
        this.options.client.getJoinedMembers(roomId, personaUserId),
        this.options.client.hasRoomEncryptionState(roomId, personaUserId),
      ]);
      const humans = members.filter((member) => !isMatrixApplicationServiceSender(member, this.namespace)
        && !isManagedMatrixUser(member, this.namespace));
      const unexpected = humans.filter((member) => !declaration.allowedSubjectIds.includes(member));
      const finalStatus = this.setStatus(endpointId,
        unexpected.length > 0 ? "unexpected_participant" : encrypted ? "encryption_unverified" : "ready");
      return Object.freeze({ endpoint: bound, personaUserId, canonicalAlias, status: finalStatus });
    } catch (error) {
      const prior = this.statuses.get(endpointId)?.code;
      if (prior !== "room_binding_conflict") {
        this.setStatus(endpointId, unavailable(error) ? "homeserver_unavailable" : "provisioning_failed");
      }
      throw error;
    }
  }
}
