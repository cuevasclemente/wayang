import { getMessagingEndpoint, getMessagingHistoryUsage, messagingDeclarationSha256 } from "../../store.js";
import { MessagingGatewayService } from "../../gateway-service.js";
import { ProductionWayangMessagingSessionPort } from "../../session-port.js";
import type { MessagingEndpointDeclaration } from "../../contracts.js";
import { createMatrixAttestationAdapter } from "./attestation.js";
import { createMatrixClient } from "./client.js";
import type { LoadedMatrixMessagingConfig, MatrixMessagingConfig } from "./config.js";
import {
  MatrixDeliveryWorker,
  createMatrixOutboundAttestationPort,
} from "./delivery-worker.js";
import { deriveMatrixPersonaUserId } from "./identifiers.js";
import { createMatrixProductionBootstrap, type MatrixProductionBootstrap } from "./production.js";
import { MatrixProvisioningService } from "./provisioning.js";
import { MatrixApplicationService } from "./service.js";
import {
  createMatrixGatewayEphemeralEffectPort,
  MatrixTypingController,
} from "./typing.js";

export interface MatrixProductionWiringOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly deliveryBootId?: () => string;
}

function declarationMap(config: MatrixMessagingConfig): Map<string, MessagingEndpointDeclaration> {
  return new Map(config.endpoints.map((declaration) => [declaration.endpointId, declaration]));
}

/**
 * Compose exactly one Matrix gateway/client/worker graph. Configuration has
 * already crossed the owner-private loader boundary; this function never
 * reads environment, files, tokens, browser state, or live registration data.
 */
export function createProductionMatrixMessaging(
  config: LoadedMatrixMessagingConfig,
  options: MatrixProductionWiringOptions = {},
): MatrixProductionBootstrap {
  if (!config.enabled) return createMatrixProductionBootstrap({ enabled: false });

  const fetchImplementation = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImplementation !== "function") throw new Error("Matrix messaging requires fetch support");
  const now = options.now ?? Date.now;
  const declarations = declarationMap(config);
  const client = createMatrixClient({
    homeserverOrigin: config.homeserverOrigin,
    serverName: config.serverName,
    asTokenAuthorizer: config.asTokenAuthorizer,
    fetch: fetchImplementation,
  });
  const attestationAdapter = createMatrixAttestationAdapter(client, config);
  const outboundAttestations = createMatrixOutboundAttestationPort(attestationAdapter);

  const typing = new MatrixTypingController({
    client,
    authorization: {
      async authorize(target) {
        const declaration = declarations.get(target.endpointId);
        const endpoint = getMessagingEndpoint(target.endpointId);
        if (!declaration || !endpoint || endpoint.connector_id !== "matrix"
          || endpoint.external_conversation_id !== target.roomId
          || endpoint.declaration_sha256 !== messagingDeclarationSha256(declaration)
          || declaration.transportSecurity !== "unencrypted_accepted") return false;
        try {
          const snapshot = await outboundAttestations.attest({
            endpointId: target.endpointId,
            roomId: target.roomId,
            actingUserId: target.personaUserId,
          });
          const allowed = new Set(declaration.allowedSubjectIds);
          return snapshot.confidentiality === "server_visible"
            && snapshot.joinedHumanSubjectIds.length > 0
            && snapshot.joinedHumanSubjectIds.every((subject) => allowed.has(subject));
        } catch {
          return false;
        }
      },
    },
  });
  const ephemeralEffects = createMatrixGatewayEphemeralEffectPort(typing, {
    async resolve(endpointId) {
      const declaration = declarations.get(endpointId);
      const endpoint = getMessagingEndpoint(endpointId);
      if (!declaration || !endpoint?.external_conversation_id
        || endpoint.declaration_sha256 !== messagingDeclarationSha256(declaration)) return null;
      return {
        endpointId,
        roomId: endpoint.external_conversation_id,
        personaUserId: deriveMatrixPersonaUserId(declaration.agentProfileId, config),
      };
    },
  });

  let provisioning: MatrixProvisioningService | null = null;
  const gateway = new MessagingGatewayService(
    config.endpoints,
    {
      attest(declaration, binding, event) {
        return attestationAdapter.attest({
          roomId: binding.externalConversationId,
          senderUserId: event.senderSubjectId,
          actingUserId: deriveMatrixPersonaUserId(declaration.agentProfileId, config),
          observedAt: now(),
        });
      },
    },
    new ProductionWayangMessagingSessionPort(),
    {
      runWithTyping: (endpointId, operation) => ephemeralEffects.runWithTyping(endpointId, operation),
      getAttentionCode: (endpointId) => getMessagingHistoryUsage().highWater
        ? "history_high_water"
        : provisioning?.getStatus(endpointId).code ?? "provisioning_pending",
    },
  );
  provisioning = new MatrixProvisioningService({
    namespace: config,
    declarations: config.endpoints,
    client,
    now,
  });
  const service = new MatrixApplicationService({
    namespace: config,
    declarations: config.endpoints,
    gateway,
    attestations: attestationAdapter,
    provisioning,
    now,
  });
  const deliveryWorker = new MatrixDeliveryWorker({
    declarations: config.endpoints,
    namespace: config,
    wayangBaseUrl: config.wayangBaseUrl,
    client,
    attestations: outboundAttestations,
    now,
    ...(options.deliveryBootId ? { bootId: options.deliveryBootId } : {}),
  });

  return createMatrixProductionBootstrap({
    enabled: true,
    verifier: config.hsTokenVerifier,
    service,
    provisioning,
    deliveryWorker,
    typing,
    endpointIds: config.endpoints.map((endpoint) => endpoint.endpointId),
    now,
  });
}
