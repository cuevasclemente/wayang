import type {
  MessagingErrorCode,
  MessagingHandoffReasonCode,
  MessagingObservedConfidentiality,
} from "./contracts.js";

export const MAX_MESSAGING_ENDPOINTS = 256;
export const MAX_MESSAGING_EVENTS = 16_384;
export const MAX_PENDING_MESSAGING_EVENTS_PER_ENDPOINT = 256;
export const MAX_MESSAGING_TRANSACTIONS = 8_192;
export const MAX_MESSAGING_DELIVERIES = 32_768;
export const MAX_MESSAGING_BODY_BYTES = 64 * 1024;
export const MAX_MESSAGING_DELIVERY_TEXT_BYTES = 64 * 1024;
export const MAX_MESSAGING_TRANSACTION_CHILDREN = 256;
export const MAX_MESSAGING_REMOTE_DELIVERY_IDS = 256;
/** Completed ingress/outbox graph remains collision-authoritative for seven days. */
export const MESSAGING_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type MessagingEventState = "accepted" | "processing" | "completed" | "rejected" | "failed";
export type MessagingTransactionState = "completed" | "rejected";
export type MessagingDeliveryState = "pending" | "delivering" | "delivered" | "failed" | "withheld";
export type MessagingDeliveryErrorCode =
  | "attestation_unavailable"
  | "authorization_changed"
  | "declaration_changed"
  | "persistence_ambiguous"
  | "remote_ambiguous"
  | "remote_rejected"
  | "retry_exhausted"
  | "transport_error"
  | "worker_restarted";

/** Current declarations remain the sole authority; this row is state plus its exact declaration hash. */
export interface MessagingEndpointRow {
  endpoint_id: string;
  connector_id: string;
  provisioning_key: string;
  project_id: string;
  agent_profile_id: string;
  declaration_sha256: string;
  external_conversation_id: string | null;
  active_session_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface MessagingEventRow {
  connector_id: string;
  connector_event_id: string;
  endpoint_id: string;
  external_conversation_id: string;
  sender_subject_id: string;
  occurred_at: number;
  body: string;
  body_sha256: string;
  canonical_event_sha256: string;
  declaration_sha256: string;
  endpoint_revision_at_admission: number;
  attestation_sha256: string;
  attestation_revision: string;
  attestation_observed_at: number;
  attestation_confidentiality: "end_to_end_encrypted" | "server_visible";
  attested_human_subject_ids: string[];
  authorization_policy_version: "messaging-participant-v1";
  acceptance_sequence: number;
  state: MessagingEventState;
  claim_id: string | null;
  claim_attempt: number;
  claimed_at: number | null;
  claim_endpoint_revision: number | null;
  claim_declaration_sha256: string | null;
  claim_session_id: string | null;
  wayang_session_id: string | null;
  delivery_id: string | null;
  accepted_at: number;
  completed_at: number | null;
  error_code: MessagingErrorCode | null;
}

/** Exact durable child identity retained alongside hashes for acknowledgement authority. */
export interface MessagingTransactionManifestEntry {
  connector_event_id: string;
  endpoint_id: string;
  canonical_event_sha256: string;
}

export interface MessagingTransactionRow {
  connector_id: string;
  transaction_id: string;
  canonical_transaction_sha256: string;
  canonical_manifest_sha256: string;
  child_manifest: MessagingTransactionManifestEntry[];
  state: MessagingTransactionState;
  accepted_at: number;
  completed_at: number;
}

export type MessagingDeliveryPayload =
  | { kind: "final"; text: string }
  | { kind: "notice"; text: string }
  | { kind: "error"; code: MessagingErrorCode }
  | { kind: "continue_in_wayang"; session_id: string; reason_code: MessagingHandoffReasonCode };

/** Connector-neutral fresh outbound authorization evidence. */
export interface MessagingOutboundParticipantSnapshot {
  readonly connectorId: string;
  readonly externalConversationId: string;
  readonly joinedHumanSubjectIds: readonly string[];
  readonly complete: true;
  readonly observedAt: number;
  readonly revision: string;
  readonly confidentiality: MessagingObservedConfidentiality;
}

export interface MessagingDeliveryRow {
  id: string;
  delivery_group_id: string;
  connector_id: string;
  endpoint_id: string;
  external_conversation_id: string;
  connector_event_id: string;
  chunk_index: number;
  chunk_count: number;
  payload: MessagingDeliveryPayload;
  payload_sha256: string;
  declaration_sha256: string;
  state: MessagingDeliveryState;
  attempt_count: number;
  claim_generation: number;
  claim_id: string | null;
  worker_boot_id: string | null;
  claimed_at: number | null;
  next_attempt_at: number | null;
  last_error_code: MessagingDeliveryErrorCode | null;
  attestation_sha256: string | null;
  attestation_revision: string | null;
  attestation_observed_at: number | null;
  attestation_confidentiality: "end_to_end_encrypted" | "server_visible" | null;
  attested_human_subject_ids: string[];
  connector_transaction_ids: string[];
  remote_delivery_ids: string[];
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  failed_at: number | null;
  withheld_at: number | null;
}
