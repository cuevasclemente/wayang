import { createHash } from "node:crypto";
import type { MessagingParticipantSnapshot } from "../../contracts.js";
import type { MatrixClient } from "./client.js";
import {
  isManagedMatrixUser,
  isMatrixApplicationServiceSender,
  validateMatrixRoomId,
  validateMatrixUserId,
  validateMatrixNamespace,
  type MatrixNamespace,
} from "./identifiers.js";

export interface AttestMatrixMembershipInput {
  readonly roomId: string;
  readonly senderUserId: string;
  readonly actingUserId: string;
  readonly observedAt?: number;
}

export interface MatrixAttestationAdapter {
  attest(input: AttestMatrixMembershipInput): Promise<MessagingParticipantSnapshot>;
}

export function createMatrixAttestationAdapter(client: MatrixClient, namespaceValue: MatrixNamespace): MatrixAttestationAdapter {
  const namespace = validateMatrixNamespace(namespaceValue);
  return Object.freeze({
    async attest(input: AttestMatrixMembershipInput): Promise<MessagingParticipantSnapshot> {
      const roomId = validateMatrixRoomId(input.roomId);
      const sender = validateMatrixUserId(input.senderUserId);
      const actingUser = validateMatrixUserId(input.actingUserId, namespace.serverName);
      const observedAt = input.observedAt ?? Date.now();
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("Invalid Matrix attestation timestamp");
      const [joinedMembers, encryptionPresent] = await Promise.all([
        client.getJoinedMembers(roomId, actingUser),
        client.hasRoomEncryptionState(roomId, actingUser),
      ]);
      const humans: string[] = [];
      for (const member of joinedMembers) {
        validateMatrixUserId(member);
        if (isMatrixApplicationServiceSender(member, namespace) || isManagedMatrixUser(member, namespace)) continue;
        if (humans.includes(member)) throw new Error("Matrix membership response contains duplicate users");
        humans.push(member);
      }
      humans.sort();
      const confidentiality = encryptionPresent ? "unknown" as const : "server_visible" as const;
      const revision = createHash("sha256").update(JSON.stringify({
        room_id: roomId,
        joined_human_subject_ids: humans,
        encryption_state: encryptionPresent ? "present-unverified" : "absent",
      }), "utf8").digest("hex");
      return Object.freeze({
        connectorId: "matrix",
        externalConversationId: roomId,
        senderSubjectId: sender,
        joinedHumanSubjectIds: Object.freeze(humans),
        complete: true,
        observedAt,
        revision,
        confidentiality,
      });
    },
  });
}
