import { createHash } from "node:crypto";
import type { SessionRow } from "../db.js";
import type { AgentProfileRow, ProjectRow } from "../workspace-types.js";
import type { MessagingParticipantSnapshot } from "./contracts.js";
import {
  MAX_MESSAGING_BODY_BYTES,
  MAX_MESSAGING_DELIVERIES,
  MAX_MESSAGING_DELIVERY_TEXT_BYTES,
  MAX_MESSAGING_ENDPOINTS,
  MAX_MESSAGING_EVENTS,
  MAX_MESSAGING_REMOTE_DELIVERY_IDS,
  MAX_MESSAGING_TRANSACTION_CHILDREN,
  MAX_MESSAGING_TRANSACTIONS,
  type MessagingDeliveryPayload,
  type MessagingDeliveryRow,
  type MessagingEndpointRow,
  type MessagingEventRow,
  type MessagingOutboundParticipantSnapshot,
  type MessagingTransactionManifestEntry,
  type MessagingTransactionRow,
} from "./store-types.js";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_ID_BYTES = 512;
const ENDPOINT_KEYS = [
  "active_session_id", "agent_profile_id", "connector_id", "created_at", "declaration_sha256",
  "endpoint_id", "external_conversation_id", "project_id", "provisioning_key", "revision", "updated_at",
] as const;
const EVENT_KEYS = [
  "acceptance_sequence", "accepted_at", "attestation_confidentiality", "attestation_observed_at",
  "attestation_revision", "attestation_sha256", "attested_human_subject_ids", "authorization_policy_version",
  "body", "body_sha256", "canonical_event_sha256", "claim_attempt", "claim_declaration_sha256",
  "claim_endpoint_revision", "claim_id", "claim_session_id", "claimed_at", "completed_at", "connector_event_id",
  "connector_id", "declaration_sha256", "delivery_id", "endpoint_id", "endpoint_revision_at_admission",
  "error_code", "external_conversation_id", "occurred_at", "sender_subject_id", "state", "wayang_session_id",
] as const;
const TRANSACTION_KEYS = [
  "accepted_at", "canonical_manifest_sha256", "canonical_transaction_sha256", "child_manifest", "completed_at",
  "connector_id", "state", "transaction_id",
] as const;
const MANIFEST_ENTRY_KEYS = ["canonical_event_sha256", "connector_event_id", "endpoint_id"] as const;
const DELIVERY_KEYS = [
  "attempt_count", "attestation_confidentiality", "attestation_observed_at", "attestation_revision",
  "attestation_sha256", "attested_human_subject_ids", "chunk_count", "chunk_index", "claim_generation", "claim_id",
  "claimed_at", "connector_event_id", "connector_id", "connector_transaction_ids", "created_at", "declaration_sha256",
  "delivered_at", "delivery_group_id", "endpoint_id", "external_conversation_id", "failed_at", "id",
  "last_error_code", "next_attempt_at", "payload", "payload_sha256", "remote_delivery_ids", "state", "updated_at",
  "withheld_at", "worker_boot_id",
] as const;

export interface MessagingStoreCollections {
  messagingEndpoints: unknown[];
  messagingEvents: unknown[];
  messagingTransactions: unknown[];
  messagingDeliveries: unknown[];
}

export interface MessagingStoreReferences {
  projects: readonly ProjectRow[];
  agentProfiles: readonly AgentProfileRow[];
  sessions: readonly SessionRow[];
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function finiteTimestamp(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < Number.MAX_SAFE_INTEGER;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < Number.MAX_SAFE_INTEGER;
}

function boundedId(value: unknown, nullable = false): value is string | null {
  return (nullable && value === null) || (
    typeof value === "string" && value.length > 0 && value === value.normalize("NFC")
    && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function boundedContent(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC")
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function sortedUniqueIds(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= MAX_MESSAGING_REMOTE_DELIVERY_IDS
    && value.every((entry) => boundedId(entry)) && new Set(value).size === value.length
    && JSON.stringify(value) === JSON.stringify([...value].sort());
}

function uniqueIds(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= MAX_MESSAGING_REMOTE_DELIVERY_IDS
    && value.every((entry) => boundedId(entry)) && new Set(value).size === value.length;
}

export function messagingBodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function canonicalMessagingAttestationSha256(snapshot: MessagingParticipantSnapshot): string {
  return createHash("sha256").update(JSON.stringify({
    connector_id: snapshot.connectorId,
    external_conversation_id: snapshot.externalConversationId,
    sender_subject_id: snapshot.senderSubjectId,
    joined_human_subject_ids: [...snapshot.joinedHumanSubjectIds].sort(),
    complete: snapshot.complete,
    observed_at: snapshot.observedAt,
    revision: snapshot.revision,
    confidentiality: snapshot.confidentiality,
  }), "utf8").digest("hex");
}

export function canonicalMessagingOutboundAttestationSha256(snapshot: MessagingOutboundParticipantSnapshot): string {
  return createHash("sha256").update(JSON.stringify({
    connector_id: snapshot.connectorId,
    external_conversation_id: snapshot.externalConversationId,
    joined_human_subject_ids: [...snapshot.joinedHumanSubjectIds].sort(),
    complete: snapshot.complete,
    observed_at: snapshot.observedAt,
    revision: snapshot.revision,
    confidentiality: snapshot.confidentiality,
  }), "utf8").digest("hex");
}

/** Connector timestamps are retained on the row as audit metadata but never participate in identity or ordering. */
export function canonicalMessagingEventSha256(input: {
  connectorId: string;
  connectorEventId: string;
  endpointId: string;
  externalConversationId: string;
  senderSubjectId: string;
  body: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    connector_id: input.connectorId,
    connector_event_id: input.connectorEventId,
    endpoint_id: input.endpointId,
    external_conversation_id: input.externalConversationId,
    sender_subject_id: input.senderSubjectId,
    body: input.body,
  }), "utf8").digest("hex");
}

export function canonicalMessagingManifestSha256(entries: readonly MessagingTransactionManifestEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

export function canonicalMessagingDeliveryPayloadSha256(payload: MessagingDeliveryPayload): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function validErrorCode(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || [
    "endpoint_blocked", "membership_unverified", "transport_not_allowed", "session_unavailable", "turn_failed", "delivery_failed",
  ].includes(String(value));
}

function validDeliveryErrorCode(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || [
    "attestation_unavailable", "authorization_changed", "declaration_changed", "persistence_ambiguous",
    "remote_ambiguous", "remote_rejected", "retry_exhausted", "transport_error", "worker_restarted",
  ].includes(String(value));
}

function validHandoffCode(value: unknown): boolean {
  return [
    "approval_required", "browser_handoff_required", "questionnaire_unsupported", "secret_input_required", "privileged_input_required",
  ].includes(String(value));
}

function validPayload(value: unknown): value is MessagingDeliveryPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (payload.kind === "final" || payload.kind === "notice") {
    return exactKeys(payload, ["kind", "text"]) && boundedContent(payload.text, MAX_MESSAGING_DELIVERY_TEXT_BYTES);
  }
  if (payload.kind === "error") {
    return exactKeys(payload, ["code", "kind"]) && validErrorCode(payload.code);
  }
  if (payload.kind === "continue_in_wayang") {
    return exactKeys(payload, ["kind", "reason_code", "session_id"])
      && boundedId(payload.session_id) && validHandoffCode(payload.reason_code);
  }
  return false;
}

function completeOutboundAttestation(row: Partial<MessagingDeliveryRow>): boolean {
  if (!hash(row.attestation_sha256) || !boundedId(row.attestation_revision)
    || !finiteTimestamp(row.attestation_observed_at)
    || !["end_to_end_encrypted", "server_visible"].includes(row.attestation_confidentiality ?? "")
    || !sortedUniqueIds(row.attested_human_subject_ids)) return false;
  return row.attestation_sha256 === canonicalMessagingOutboundAttestationSha256({
    connectorId: row.connector_id!,
    externalConversationId: row.external_conversation_id!,
    joinedHumanSubjectIds: row.attested_human_subject_ids!,
    complete: true,
    observedAt: row.attestation_observed_at!,
    revision: row.attestation_revision!,
    confidentiality: row.attestation_confidentiality!,
  });
}

function absentOutboundAttestation(row: Partial<MessagingDeliveryRow>): boolean {
  return row.attestation_sha256 === null && row.attestation_revision === null
    && row.attestation_observed_at === null && row.attestation_confidentiality === null
    && Array.isArray(row.attested_human_subject_ids) && row.attested_human_subject_ids.length === 0;
}

export function validateMessagingStoreRows(
  collections: MessagingStoreCollections,
  references: MessagingStoreReferences,
): void {
  if (collections.messagingEndpoints.length > MAX_MESSAGING_ENDPOINTS
    || collections.messagingEvents.length > MAX_MESSAGING_EVENTS
    || collections.messagingTransactions.length > MAX_MESSAGING_TRANSACTIONS
    || collections.messagingDeliveries.length > MAX_MESSAGING_DELIVERIES) {
    throw new Error("Wayang messaging store collection limit exceeded");
  }

  const projects = new Map(references.projects.map((row) => [row.id, row]));
  const profiles = new Map(references.agentProfiles.map((row) => [row.id, row]));
  const sessions = new Map(references.sessions.map((row) => [row.id, row]));
  const endpoints = new Map<string, MessagingEndpointRow>();
  const provisioning = new Set<string>();
  const projectProfilePairs = new Set<string>();
  const boundConversations = new Set<string>();

  for (const [index, candidate] of collections.messagingEndpoints.entries()) {
    const row = candidate as Partial<MessagingEndpointRow> | null;
    if (!row || typeof row !== "object" || !exactKeys(row, ENDPOINT_KEYS)
      || !boundedId(row.endpoint_id) || !boundedId(row.connector_id) || !boundedId(row.provisioning_key)
      || !boundedId(row.project_id) || !boundedId(row.agent_profile_id) || !hash(row.declaration_sha256)
      || !boundedId(row.external_conversation_id, true) || !boundedId(row.active_session_id, true)
      || !positiveRevision(row.revision) || !finiteTimestamp(row.created_at) || !finiteTimestamp(row.updated_at)
      || row.updated_at! < row.created_at! || !projects.has(row.project_id!) || !profiles.has(row.agent_profile_id!)) {
      throw new Error(`Wayang store contains a malformed messaging endpoint at index ${index}`);
    }
    if (endpoints.has(row.endpoint_id!)) throw new Error("Wayang store contains duplicate messaging endpoint ids");
    const provisionKey = `${row.connector_id}\0${row.provisioning_key}`;
    if (provisioning.has(provisionKey)) throw new Error("Wayang store contains duplicate messaging provisioning identities");
    const pairKey = `${row.project_id}\0${row.agent_profile_id}`;
    if (projectProfilePairs.has(pairKey)) throw new Error("Wayang store contains duplicate messaging Project/Profile pairs");
    if (row.external_conversation_id !== null) {
      const conversationKey = `${row.connector_id}\0${row.external_conversation_id}`;
      if (boundConversations.has(conversationKey)) throw new Error("Wayang store contains duplicate bound messaging conversations");
      boundConversations.add(conversationKey);
    }
    if (row.active_session_id !== null) {
      const session = sessions.get(row.active_session_id!);
      const project = projects.get(row.project_id!);
      if (!session || !project || session.project_id !== row.project_id || session.cwd !== project.cwd
        || session.agent_profile_id !== row.agent_profile_id
        || session.archived || session.legacy_private_session_quarantine !== false || session.pending_agent_switch !== null
        || session.scheduled_job_id !== null || session.scheduled_run_id !== null) {
        throw new Error("Wayang store contains an ineligible active messaging session binding");
      }
    }
    endpoints.set(row.endpoint_id!, row as MessagingEndpointRow);
    provisioning.add(provisionKey);
    projectProfilePairs.add(pairKey);
  }

  const events = new Map<string, MessagingEventRow>();
  const endpointSequences = new Set<string>();
  for (const [index, candidate] of collections.messagingEvents.entries()) {
    const row = candidate as Partial<MessagingEventRow> | null;
    const endpoint = row?.endpoint_id ? endpoints.get(row.endpoint_id) : undefined;
    const terminal = row && ["completed", "rejected", "failed"].includes(row.state ?? "");
    const participants = row?.attested_human_subject_ids;
    const claimed = row?.state === "processing" || Boolean(terminal);
    const validClaim = claimed
      ? boundedId(row?.claim_id) && positiveRevision(row?.claim_attempt)
        && finiteTimestamp(row?.claimed_at) && positiveRevision(row?.claim_endpoint_revision)
        && hash(row?.claim_declaration_sha256) && boundedId(row?.claim_session_id, true)
      : row?.claim_id === null && nonnegativeInteger(row?.claim_attempt)
        && row?.claimed_at === null && row?.claim_endpoint_revision === null && row?.claim_declaration_sha256 === null
        && row?.claim_session_id === null;
    if (!row || typeof row !== "object" || !exactKeys(row, EVENT_KEYS)
      || !boundedId(row.connector_id) || !boundedId(row.connector_event_id) || !boundedId(row.endpoint_id)
      || !boundedId(row.external_conversation_id) || !boundedId(row.sender_subject_id) || !finiteTimestamp(row.occurred_at)
      || !boundedContent(row.body, MAX_MESSAGING_BODY_BYTES) || !hash(row.body_sha256) || !hash(row.canonical_event_sha256)
      || !hash(row.declaration_sha256) || !positiveRevision(row.endpoint_revision_at_admission)
      || !hash(row.attestation_sha256) || !boundedId(row.attestation_revision)
      || !finiteTimestamp(row.attestation_observed_at)
      || !["end_to_end_encrypted", "server_visible"].includes(row.attestation_confidentiality ?? "")
      || !sortedUniqueIds(participants) || !participants!.includes(row.sender_subject_id!)
      || row.authorization_policy_version !== "messaging-participant-v1"
      || row.attestation_observed_at! > row.accepted_at! || row.accepted_at! - row.attestation_observed_at! > 30_000
      || row.attestation_sha256 !== canonicalMessagingAttestationSha256({
        connectorId: row.connector_id!, externalConversationId: row.external_conversation_id!,
        senderSubjectId: row.sender_subject_id!, joinedHumanSubjectIds: participants!, complete: true,
        observedAt: row.attestation_observed_at!, revision: row.attestation_revision!,
        confidentiality: row.attestation_confidentiality!,
      })
      || !validClaim || row.body_sha256 !== messagingBodySha256(row.body!)
      || row.canonical_event_sha256 !== canonicalMessagingEventSha256({
        connectorId: row.connector_id!, connectorEventId: row.connector_event_id!, endpointId: row.endpoint_id!,
        externalConversationId: row.external_conversation_id!, senderSubjectId: row.sender_subject_id!, body: row.body!,
      })
      || !positiveRevision(row.acceptance_sequence) || !["accepted", "processing", "completed", "rejected", "failed"].includes(row.state ?? "")
      || !boundedId(row.wayang_session_id, true) || !boundedId(row.delivery_id, true)
      || !finiteTimestamp(row.accepted_at) || !finiteTimestamp(row.completed_at, true) || !validErrorCode(row.error_code, true)
      // Wall-clock values are audit metadata; terminal/null and outbox coherence are the durable authority.
      || (terminal ? row.completed_at === null || row.delivery_id === null
        : row.completed_at !== null || row.delivery_id !== null)
      || !endpoint || endpoint.connector_id !== row.connector_id
      || (endpoint.external_conversation_id !== null && endpoint.external_conversation_id !== row.external_conversation_id)
      || (row.wayang_session_id !== null && !sessions.has(row.wayang_session_id!))) {
      throw new Error(`Wayang store contains a malformed messaging event at index ${index}`);
    }
    const eventKey = `${row.connector_id}\0${row.connector_event_id}`;
    if (events.has(eventKey)) throw new Error("Wayang store contains duplicate messaging event identities");
    const sequenceKey = `${row.endpoint_id}\0${row.acceptance_sequence}`;
    if (endpointSequences.has(sequenceKey)) throw new Error("Wayang store contains duplicate messaging acceptance sequences");
    events.set(eventKey, row as MessagingEventRow);
    endpointSequences.add(sequenceKey);
  }

  const transactions = new Set<string>();
  for (const [index, candidate] of collections.messagingTransactions.entries()) {
    const row = candidate as Partial<MessagingTransactionRow> | null;
    const manifest = row?.child_manifest;
    const manifestIdentities = new Set<string>();
    const validManifest = Array.isArray(manifest) && manifest.length <= MAX_MESSAGING_TRANSACTION_CHILDREN
      && manifest.every((entry) => {
        if (!entry || typeof entry !== "object" || !exactKeys(entry, MANIFEST_ENTRY_KEYS)
          || !boundedId(entry.connector_event_id) || !boundedId(entry.endpoint_id) || !hash(entry.canonical_event_sha256)) return false;
        const identity = entry.connector_event_id;
        if (manifestIdentities.has(identity)) return false;
        manifestIdentities.add(identity);
        const event = row?.connector_id ? events.get(`${row.connector_id}\0${entry.connector_event_id}`) : undefined;
        return Boolean(event && event.endpoint_id === entry.endpoint_id
          && event.canonical_event_sha256 === entry.canonical_event_sha256);
      });
    if (!row || typeof row !== "object" || !exactKeys(row, TRANSACTION_KEYS)
      || !boundedId(row.connector_id) || !boundedId(row.transaction_id) || !hash(row.canonical_transaction_sha256)
      || !hash(row.canonical_manifest_sha256) || !validManifest
      || row.canonical_manifest_sha256 !== canonicalMessagingManifestSha256(manifest!)
      || !["completed", "rejected"].includes(row.state ?? "")
      || !finiteTimestamp(row.accepted_at) || !finiteTimestamp(row.completed_at) || row.completed_at! < row.accepted_at!) {
      throw new Error(`Wayang store contains a malformed messaging transaction at index ${index}`);
    }
    const key = `${row.connector_id}\0${row.transaction_id}`;
    if (transactions.has(key)) throw new Error("Wayang store contains duplicate messaging transaction identities");
    transactions.add(key);
  }

  const deliveryIds = new Set<string>();
  const deliveryGroups = new Map<string, { count: number; indexes: Map<number, MessagingDeliveryRow>; eventKey: string }>();
  for (const [index, candidate] of collections.messagingDeliveries.entries()) {
    const row = candidate as Partial<MessagingDeliveryRow> | null;
    const endpoint = row?.endpoint_id ? endpoints.get(row.endpoint_id) : undefined;
    const eventKey = row ? `${row.connector_id}\0${row.connector_event_id}` : "";
    const event = events.get(eventKey);
    const claimAbsent = row?.claim_id === null && row?.worker_boot_id === null && row?.claimed_at === null;
    const claimPresent = boundedId(row?.claim_id) && boundedId(row?.worker_boot_id) && finiteTimestamp(row?.claimed_at);
    const attestationAbsent = row ? absentOutboundAttestation(row) : false;
    const attestationComplete = row ? completeOutboundAttestation(row) : false;
    const timestamps = [row?.delivered_at, row?.failed_at, row?.withheld_at].filter((value) => value !== null).length;
    const remoteProgress = (row?.remote_delivery_ids?.length ?? 0) <= (row?.connector_transaction_ids?.length ?? 0);
    const validState = row?.state === "pending"
      ? claimAbsent && row.next_attempt_at !== null && timestamps === 0 && remoteProgress
        && (attestationAbsent || attestationComplete)
      : row?.state === "delivering"
        ? claimPresent && row.next_attempt_at === null && timestamps === 0 && remoteProgress
          && (attestationAbsent || attestationComplete)
        : row?.state === "delivered"
          ? claimPresent && row.next_attempt_at === null && timestamps === 1 && row.delivered_at !== null
            && attestationComplete && (row.remote_delivery_ids?.length ?? 0) > 0
            && row.remote_delivery_ids?.length === row.connector_transaction_ids?.length
        : row?.state === "failed"
          ? claimPresent && row.next_attempt_at === null && timestamps === 1 && row.failed_at !== null
            && attestationComplete && remoteProgress && row.last_error_code !== null
        : row?.state === "withheld"
          ? (claimAbsent || claimPresent) && row.next_attempt_at === null && timestamps === 1 && row.withheld_at !== null
            && remoteProgress && row.last_error_code !== null
        : false;
    if (!row || typeof row !== "object" || !exactKeys(row, DELIVERY_KEYS)
      || !boundedId(row.id) || !boundedId(row.delivery_group_id) || !boundedId(row.connector_id)
      || !boundedId(row.endpoint_id) || !boundedId(row.external_conversation_id) || !boundedId(row.connector_event_id)
      || !nonnegativeInteger(row.chunk_index) || !positiveRevision(row.chunk_count) || row.chunk_index! >= row.chunk_count!
      || !validPayload(row.payload) || !hash(row.payload_sha256)
      || row.payload_sha256 !== canonicalMessagingDeliveryPayloadSha256(row.payload!) || !hash(row.declaration_sha256)
      || !nonnegativeInteger(row.attempt_count) || !nonnegativeInteger(row.claim_generation)
      || row.attempt_count !== row.claim_generation || !finiteTimestamp(row.next_attempt_at, true)
      || !validDeliveryErrorCode(row.last_error_code, true)
      || !uniqueIds(row.connector_transaction_ids, true) || !uniqueIds(row.remote_delivery_ids, true)
      || !finiteTimestamp(row.created_at) || !finiteTimestamp(row.updated_at) || row.updated_at! < row.created_at!
      || !finiteTimestamp(row.delivered_at, true) || !finiteTimestamp(row.failed_at, true) || !finiteTimestamp(row.withheld_at, true)
      || !validState || !endpoint || endpoint.connector_id !== row.connector_id
      || endpoint.external_conversation_id !== row.external_conversation_id || !event
      || event.delivery_id !== row.delivery_group_id || event.claim_declaration_sha256 !== row.declaration_sha256) {
      throw new Error(`Wayang store contains a malformed messaging delivery at index ${index}`);
    }
    if (deliveryIds.has(row.id!)) throw new Error("Wayang store contains duplicate messaging delivery ids");
    deliveryIds.add(row.id!);
    const group = deliveryGroups.get(row.delivery_group_id!);
    if (group && (group.count !== row.chunk_count || group.eventKey !== eventKey || group.indexes.has(row.chunk_index!))) {
      throw new Error("Wayang store contains incoherent messaging delivery chunks");
    }
    if (group) group.indexes.set(row.chunk_index!, row as MessagingDeliveryRow);
    else deliveryGroups.set(row.delivery_group_id!, {
      count: row.chunk_count!, indexes: new Map([[row.chunk_index!, row as MessagingDeliveryRow]]), eventKey,
    });
  }

  for (const [groupId, group] of deliveryGroups) {
    if (group.indexes.size !== group.count) throw new Error("Wayang store contains an incomplete messaging delivery group");
    const rows = [...group.indexes.values()].sort((a, b) => a.chunk_index - b.chunk_index);
    const firstNonDelivered = rows.findIndex((row) => row.state !== "delivered");
    if (firstNonDelivered >= 0) {
      const first = rows[firstNonDelivered]!;
      const remainder = rows.slice(firstNonDelivered + 1);
      if ((first.state === "failed" || first.state === "withheld")
        && remainder.some((row) => row.state !== "withheld")) {
        throw new Error("Wayang store contains a delivery group continuing after terminal failure or withholding");
      }
      if ((first.state === "pending" || first.state === "delivering")
        && remainder.some((row) => row.state !== "pending")) {
        throw new Error("Wayang store contains out-of-order messaging delivery chunks");
      }
    }
    const event = events.get(group.eventKey);
    if (!event || event.delivery_id !== groupId) {
      throw new Error("Wayang store contains an orphan messaging delivery group");
    }
  }

  for (const event of events.values()) {
    if (event.delivery_id !== null && !deliveryGroups.has(event.delivery_id)) {
      throw new Error("Wayang store messaging event references an unknown delivery group");
    }
  }

  const deliveriesByEndpoint = new Map<string, MessagingDeliveryRow[]>();
  for (const row of collections.messagingDeliveries as MessagingDeliveryRow[]) {
    const rows = deliveriesByEndpoint.get(row.endpoint_id) ?? [];
    rows.push(row);
    deliveriesByEndpoint.set(row.endpoint_id, rows);
  }
  for (const rows of deliveriesByEndpoint.values()) {
    rows.sort((a, b) => {
      const left = events.get(`${a.connector_id}\0${a.connector_event_id}`)!.acceptance_sequence;
      const right = events.get(`${b.connector_id}\0${b.connector_event_id}`)!.acceptance_sequence;
      return left - right || a.chunk_index - b.chunk_index;
    });
    const deliveringIndex = rows.findIndex((row) => row.state === "delivering");
    if (deliveringIndex >= 0 && (rows.slice(deliveringIndex + 1).some((row) => row.state === "delivering")
      || rows.slice(0, deliveringIndex).some((row) => row.state === "pending" || row.state === "delivering"))) {
      throw new Error("Wayang store contains concurrent or out-of-order messaging delivery claims");
    }
  }
}
