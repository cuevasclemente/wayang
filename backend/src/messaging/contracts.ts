export const MESSAGING_CONVERSATION_MODES = ["shared"] as const;
export type MessagingConversationMode = typeof MESSAGING_CONVERSATION_MODES[number];

export const MESSAGING_TRANSPORT_SECURITY_MODES = [
  "encrypted_required",
  "unencrypted_accepted",
] as const;
export type MessagingTransportSecurityMode = typeof MESSAGING_TRANSPORT_SECURITY_MODES[number];

export const MESSAGING_OBSERVED_CONFIDENTIALITY = [
  "end_to_end_encrypted",
  "server_visible",
  "unknown",
] as const;
export type MessagingObservedConfidentiality = typeof MESSAGING_OBSERVED_CONFIDENTIALITY[number];

/**
 * Connector-neutral authority for one externally reachable Wayang endpoint.
 * Names are presentation only; immutable Project/Profile IDs own the binding.
 */
export interface MessagingEndpointDeclaration {
  readonly endpointId: string;
  readonly connectorId: string;
  readonly provisioningKey: string;
  readonly projectId: string;
  readonly agentProfileId: string;
  readonly displayName: string;
  readonly conversationMode: MessagingConversationMode;
  readonly allowedSubjectIds: readonly string[];
  readonly transportSecurity: MessagingTransportSecurityMode;
}

/** Durable result of adapter provisioning. External names/aliases are not authority. */
export interface MessagingConversationBinding {
  readonly endpointId: string;
  readonly connectorId: string;
  readonly externalConversationId: string;
  readonly activeWayangSessionId: string | null;
  readonly revision: number;
}

/**
 * Adapter-attested current human membership. Managed service/virtual users must
 * be removed by an exact adapter namespace check before constructing this value.
 */
export interface MessagingParticipantSnapshot {
  readonly connectorId: string;
  readonly externalConversationId: string;
  readonly senderSubjectId: string;
  readonly joinedHumanSubjectIds: readonly string[];
  readonly complete: true;
  readonly observedAt: number;
  readonly revision: string;
  readonly confidentiality: MessagingObservedConfidentiality;
}

export type MessagingCommand =
  | { readonly name: "new" }
  | { readonly name: "sessions" }
  | { readonly name: "use"; readonly sessionHandle: string }
  | { readonly name: "status" }
  | { readonly name: "help" };

export type ParsedMessagingInput =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "command"; readonly command: MessagingCommand }
  | {
      readonly kind: "invalid";
      readonly code: "invalid_input" | "empty" | "too_large" | "unknown_command" | "invalid_arguments";
      readonly message: string;
    };

export interface NormalizedMessagingInboundEvent {
  readonly connectorId: string;
  readonly connectorEventId: string;
  readonly externalConversationId: string;
  readonly senderSubjectId: string;
  readonly body: string;
  /** Connector timestamp is audit/display metadata, never processing order authority. */
  readonly occurredAt: number;
}

export type MessagingHandoffReasonCode =
  | "approval_required"
  | "browser_handoff_required"
  | "questionnaire_unsupported"
  | "secret_input_required"
  | "privileged_input_required";

export type MessagingErrorCode =
  | "endpoint_blocked"
  | "membership_unverified"
  | "transport_not_allowed"
  | "session_unavailable"
  | "turn_failed"
  | "delivery_failed";

/** Durable messages use an envelope with a stable delivery ID; typing is ephemeral. */
export type MessagingOutboundEffect =
  | { readonly kind: "typing"; readonly active: boolean }
  | {
      readonly kind: "delivery";
      readonly deliveryId: string;
      readonly endpointId: string;
      readonly externalConversationId: string;
      readonly chunkIndex: number;
      readonly chunkCount: number;
      readonly payload:
        | { readonly kind: "final"; readonly text: string }
        | { readonly kind: "notice"; readonly text: string }
        | { readonly kind: "error"; readonly code: MessagingErrorCode }
        | {
            readonly kind: "continue_in_wayang";
            readonly sessionId: string;
            readonly reasonCode: MessagingHandoffReasonCode;
          };
    };
