import { createHash, randomUUID } from "node:crypto";
import { commitStoreMutation, getStore, type StoreData } from "../db.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import { authorizeMessagingParticipant, compileMessagingEndpointDeclarations } from "./endpoint-policy.js";
import type {
  MessagingConversationBinding,
  MessagingEndpointDeclaration,
  MessagingErrorCode,
  MessagingParticipantSnapshot,
  NormalizedMessagingInboundEvent,
} from "./contracts.js";
import {
  MAX_MESSAGING_DELIVERIES,
  MAX_MESSAGING_ENDPOINTS,
  MAX_MESSAGING_EVENTS,
  MAX_MESSAGING_TRANSACTION_CHILDREN,
  MAX_MESSAGING_TRANSACTIONS,
  MAX_PENDING_MESSAGING_EVENTS_PER_ENDPOINT,
  MESSAGING_HISTORY_RETENTION_MS,
  type MessagingDeliveryErrorCode,
  type MessagingDeliveryPayload,
  type MessagingDeliveryRow,
  type MessagingEndpointRow,
  type MessagingEventRow,
  type MessagingOutboundParticipantSnapshot,
  type MessagingTransactionManifestEntry,
  type MessagingTransactionRow,
} from "./store-types.js";
import {
  canonicalMessagingAttestationSha256,
  canonicalMessagingDeliveryPayloadSha256,
  canonicalMessagingEventSha256,
  canonicalMessagingManifestSha256,
  canonicalMessagingOutboundAttestationSha256,
  messagingBodySha256,
} from "./store-validation.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface MessagingHistoryCompactionResult {
  readonly transactions: number;
  readonly events: number;
  readonly deliveries: number;
}

function compactMessagingHistoryDraft(draft: StoreData, now: number): MessagingHistoryCompactionResult {
  const cutoff = now - MESSAGING_HISTORY_RETENTION_MS;
  const priorTransactions = draft.messagingTransactions.length;
  draft.messagingTransactions = draft.messagingTransactions.filter((row) => row.completed_at > cutoff);
  const retainedEventKeys = new Set(draft.messagingTransactions.flatMap((transaction) =>
    transaction.child_manifest.map((entry) => `${transaction.connector_id}\0${entry.connector_event_id}`)));
  const removableEventKeys = new Set(draft.messagingEvents.filter((event) => {
    if (!event.completed_at || event.completed_at > cutoff
      || !["completed", "failed", "rejected"].includes(event.state)) return false;
    const key = `${event.connector_id}\0${event.connector_event_id}`;
    if (retainedEventKeys.has(key)) return false;
    const deliveries = draft.messagingDeliveries.filter((row) => row.connector_id === event.connector_id
      && row.connector_event_id === event.connector_event_id);
    return deliveries.every((row) => ["delivered", "failed", "withheld"].includes(row.state)
      && row.updated_at <= cutoff);
  }).map((event) => `${event.connector_id}\0${event.connector_event_id}`));
  const priorEvents = draft.messagingEvents.length;
  const priorDeliveries = draft.messagingDeliveries.length;
  draft.messagingEvents = draft.messagingEvents.filter((event) =>
    !removableEventKeys.has(`${event.connector_id}\0${event.connector_event_id}`));
  draft.messagingDeliveries = draft.messagingDeliveries.filter((row) =>
    !removableEventKeys.has(`${row.connector_id}\0${row.connector_event_id}`));
  return Object.freeze({
    transactions: priorTransactions - draft.messagingTransactions.length,
    events: priorEvents - draft.messagingEvents.length,
    deliveries: priorDeliveries - draft.messagingDeliveries.length,
  });
}

function historyAtHighWater(draft: StoreData): boolean {
  return draft.messagingTransactions.length >= Math.floor(MAX_MESSAGING_TRANSACTIONS * 0.75)
    || draft.messagingEvents.length >= Math.floor(MAX_MESSAGING_EVENTS * 0.75)
    || draft.messagingDeliveries.length >= Math.floor(MAX_MESSAGING_DELIVERIES * 0.75);
}

export function compactMessagingHistory(now = Date.now()): MessagingHistoryCompactionResult {
  return commitStoreMutation((draft) => compactMessagingHistoryDraft(draft, now));
}

export function getMessagingHistoryUsage(): Readonly<{
  transactions: number; events: number; deliveries: number; highWater: boolean;
}> {
  const store = getStore();
  return Object.freeze({
    transactions: store.messagingTransactions.length,
    events: store.messagingEvents.length,
    deliveries: store.messagingDeliveries.length,
    highWater: historyAtHighWater(store),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function messagingDeclarationSha256(declaration: MessagingEndpointDeclaration): string {
  return sha256(JSON.stringify({
    endpoint_id: declaration.endpointId,
    connector_id: declaration.connectorId,
    provisioning_key: declaration.provisioningKey,
    project_id: declaration.projectId,
    agent_profile_id: declaration.agentProfileId,
    display_name: declaration.displayName,
    conversation_mode: declaration.conversationMode,
    allowed_subject_ids: [...declaration.allowedSubjectIds].sort(),
    transport_security: declaration.transportSecurity,
  }));
}

function requireDeclarationScope(draft: StoreData, declaration: MessagingEndpointDeclaration): void {
  const project = draft.projects.find((row) => row.id === declaration.projectId);
  const profile = draft.agentProfiles.find((row) => row.id === declaration.agentProfileId);
  if (!project) throw new WorkspaceStoreError("Messaging endpoint project was not found", 404);
  if (!profile) throw new WorkspaceStoreError("Messaging endpoint agent profile was not found", 404);
  if (!profile.enabled) throw new WorkspaceStoreError("Messaging endpoint agent profile is disabled", 409);
  const allowed = project.access_policy.allowed_agent_profile_ids;
  if (allowed !== null && !allowed.includes(profile.id)) {
    throw new WorkspaceStoreError("Messaging endpoint agent profile is not allowed for its project", 403);
  }
}

function currentEndpointDraft(
  draft: StoreData,
  endpointId: string,
  declarationSha256: string,
): MessagingEndpointRow {
  const endpoint = draft.messagingEndpoints.find((row) => row.endpoint_id === endpointId);
  if (!endpoint) throw new WorkspaceStoreError("Messaging endpoint was not provisioned", 404);
  if (endpoint.declaration_sha256 !== declarationSha256) {
    throw new WorkspaceStoreError("Messaging endpoint declaration changed; reconcile before use", 409);
  }
  const project = draft.projects.find((row) => row.id === endpoint.project_id);
  const profile = draft.agentProfiles.find((row) => row.id === endpoint.agent_profile_id);
  if (!project || !profile || !profile.enabled) throw new WorkspaceStoreError("Messaging endpoint scope is unavailable", 409);
  const allowed = project.access_policy.allowed_agent_profile_ids;
  if (allowed !== null && !allowed.includes(profile.id)) throw new WorkspaceStoreError("Messaging endpoint scope is no longer allowed", 403);
  return endpoint;
}

export function reconcileMessagingEndpointDeclarations(values: unknown, now = Date.now()): MessagingEndpointRow[] {
  const declarations = compileMessagingEndpointDeclarations(values);
  return commitStoreMutation((draft) => {
    const results: MessagingEndpointRow[] = [];
    for (const declaration of declarations) {
      const pairConflict = draft.messagingEndpoints.find((row) => row.project_id === declaration.projectId
        && row.agent_profile_id === declaration.agentProfileId && row.endpoint_id !== declaration.endpointId);
      if (pairConflict) {
        throw new WorkspaceStoreError("Messaging Project/Profile pair is already owned by another endpoint", 409);
      }
      requireDeclarationScope(draft, declaration);
      const digest = messagingDeclarationSha256(declaration);
      const existing = draft.messagingEndpoints.find((row) => row.endpoint_id === declaration.endpointId);
      if (!existing) {
        if (draft.messagingEndpoints.length >= MAX_MESSAGING_ENDPOINTS) {
          throw new WorkspaceStoreError("Messaging endpoint limit reached", 409);
        }
        const created: MessagingEndpointRow = {
          endpoint_id: declaration.endpointId,
          connector_id: declaration.connectorId,
          provisioning_key: declaration.provisioningKey,
          project_id: declaration.projectId,
          agent_profile_id: declaration.agentProfileId,
          declaration_sha256: digest,
          external_conversation_id: null,
          active_session_id: null,
          revision: 1,
          created_at: now,
          updated_at: now,
        };
        draft.messagingEndpoints.push(created);
        results.push(clone(created));
        continue;
      }
      if (existing.connector_id !== declaration.connectorId
        || existing.provisioning_key !== declaration.provisioningKey
        || existing.project_id !== declaration.projectId
        || existing.agent_profile_id !== declaration.agentProfileId) {
        throw new WorkspaceStoreError("Messaging endpoint immutable identity changed; use a new endpoint id", 409);
      }
      if (existing.declaration_sha256 !== digest) {
        existing.declaration_sha256 = digest;
        existing.revision++;
        existing.updated_at = now;
      }
      results.push(clone(existing));
    }
    return results;
  });
}

export function listMessagingEndpoints(): MessagingEndpointRow[] {
  return getStore().messagingEndpoints.map(clone).sort((a, b) => a.endpoint_id.localeCompare(b.endpoint_id));
}

export function getMessagingEndpoint(endpointId: string): MessagingEndpointRow | undefined {
  const row = getStore().messagingEndpoints.find((candidate) => candidate.endpoint_id === endpointId);
  return row ? clone(row) : undefined;
}

export function bindMessagingConversation(input: {
  endpointId: string;
  declarationSha256: string;
  expectedRevision: number;
  externalConversationId: string;
  now?: number;
}): MessagingEndpointRow {
  return commitStoreMutation((draft) => {
    const endpoint = currentEndpointDraft(draft, input.endpointId, input.declarationSha256);
    if (endpoint.revision !== input.expectedRevision) throw new WorkspaceStoreError("Messaging endpoint revision conflict", 409);
    if (endpoint.external_conversation_id !== null && endpoint.external_conversation_id !== input.externalConversationId) {
      throw new WorkspaceStoreError("Messaging endpoint is already bound to another conversation", 409);
    }
    const conversationConflict = draft.messagingEndpoints.find((row) => row.endpoint_id !== endpoint.endpoint_id
      && row.connector_id === endpoint.connector_id && row.external_conversation_id === input.externalConversationId);
    if (conversationConflict) {
      throw new WorkspaceStoreError("Messaging conversation is already bound to another endpoint", 409);
    }
    if (endpoint.external_conversation_id === input.externalConversationId) return clone(endpoint);
    endpoint.external_conversation_id = input.externalConversationId;
    endpoint.revision++;
    endpoint.updated_at = input.now ?? Date.now();
    return clone(endpoint);
  });
}

function sessionEligibleForEndpoint(draft: StoreData, endpoint: MessagingEndpointRow, sessionId: string): boolean {
  const session = draft.sessions.find((row) => row.id === sessionId);
  const project = draft.projects.find((row) => row.id === endpoint.project_id);
  return Boolean(session && project && session.project_id === endpoint.project_id
    && session.cwd === project.cwd && session.agent_profile_id === endpoint.agent_profile_id
    && !session.archived && session.legacy_private_session_quarantine === false && session.pending_agent_switch === null
    && session.scheduled_job_id === null && session.scheduled_run_id === null);
}

export function activateMessagingSession(input: {
  endpointId: string;
  declarationSha256: string;
  expectedRevision: number;
  sessionId: string | null;
  now?: number;
}): MessagingEndpointRow {
  return commitStoreMutation((draft) => {
    const endpoint = currentEndpointDraft(draft, input.endpointId, input.declarationSha256);
    if (endpoint.revision !== input.expectedRevision) throw new WorkspaceStoreError("Messaging endpoint revision conflict", 409);
    if (input.sessionId !== null && !sessionEligibleForEndpoint(draft, endpoint, input.sessionId)) {
      throw new WorkspaceStoreError("Wayang session is not eligible for this messaging endpoint", 403);
    }
    if (endpoint.active_session_id === input.sessionId) return clone(endpoint);
    endpoint.active_session_id = input.sessionId;
    endpoint.revision++;
    endpoint.updated_at = input.now ?? Date.now();
    return clone(endpoint);
  });
}

export interface MessagingEventAdmission {
  readonly endpointId: string;
  readonly declarationSha256: string;
  readonly declaration: MessagingEndpointDeclaration;
  readonly participantSnapshot: MessagingParticipantSnapshot;
  readonly event: NormalizedMessagingInboundEvent;
}

export type AcceptMessagingEventResult = { row: MessagingEventRow; duplicate: boolean };

function admitMessagingEventDraft(
  draft: StoreData,
  input: MessagingEventAdmission,
  acceptedAt: number,
): AcceptMessagingEventResult {
  const endpoint = currentEndpointDraft(draft, input.endpointId, input.declarationSha256);
  if (messagingDeclarationSha256(input.declaration) !== input.declarationSha256
    || input.declaration.endpointId !== endpoint.endpoint_id) {
    throw new WorkspaceStoreError("Messaging admission declaration mismatch", 409);
  }
  if (!endpoint.external_conversation_id) throw new WorkspaceStoreError("Messaging endpoint has no bound conversation", 409);
  const event = input.event;
  const currentBinding: MessagingConversationBinding = {
    endpointId: endpoint.endpoint_id,
    connectorId: endpoint.connector_id,
    externalConversationId: endpoint.external_conversation_id,
    activeWayangSessionId: endpoint.active_session_id,
    revision: endpoint.revision,
  };
  const authorization = authorizeMessagingParticipant(
    input.declaration,
    currentBinding,
    event,
    input.participantSnapshot,
    { now: acceptedAt },
  );
  if (!authorization.allowed) throw new WorkspaceStoreError(authorization.reason, 403);
  if (input.participantSnapshot.confidentiality === "unknown") {
    throw new WorkspaceStoreError("Messaging confidentiality attestation is unknown", 403);
  }
  if (event.connectorId !== endpoint.connector_id || event.externalConversationId !== endpoint.external_conversation_id) {
    throw new WorkspaceStoreError("Messaging event does not match its endpoint binding", 403);
  }
  const normalizedBody = event.body.normalize("NFC");
  const canonical = canonicalMessagingEventSha256({
    connectorId: event.connectorId,
    connectorEventId: event.connectorEventId,
    endpointId: endpoint.endpoint_id,
    externalConversationId: event.externalConversationId,
    senderSubjectId: event.senderSubjectId,
    body: normalizedBody,
  });
  const existing = draft.messagingEvents.find((row) => (
    row.connector_id === event.connectorId && row.connector_event_id === event.connectorEventId
  ));
  if (existing) {
    if (existing.canonical_event_sha256 !== canonical) {
      throw new WorkspaceStoreError("Messaging event identity was reused with different immutable content", 409);
    }
    return { row: clone(existing), duplicate: true };
  }
  if (historyAtHighWater(draft)) compactMessagingHistoryDraft(draft, acceptedAt);
  if (draft.messagingEvents.length >= MAX_MESSAGING_EVENTS) throw new WorkspaceStoreError("Messaging event limit reached", 409);
  const endpointBacklog = draft.messagingEvents.filter((row) => row.endpoint_id === endpoint.endpoint_id
    && (row.state === "accepted" || row.state === "processing")).length;
  if (endpointBacklog >= MAX_PENDING_MESSAGING_EVENTS_PER_ENDPOINT) {
    throw new WorkspaceStoreError("Messaging endpoint backlog limit reached", 429);
  }
  const lastSequence = draft.messagingEvents.reduce((maximum, row) => (
    row.endpoint_id === endpoint.endpoint_id ? Math.max(maximum, row.acceptance_sequence) : maximum
  ), 0);
  if (lastSequence >= Number.MAX_SAFE_INTEGER - 1) throw new WorkspaceStoreError("Messaging acceptance sequence exhausted", 409);
  const row: MessagingEventRow = {
    connector_id: event.connectorId,
    connector_event_id: event.connectorEventId,
    endpoint_id: endpoint.endpoint_id,
    external_conversation_id: event.externalConversationId,
    sender_subject_id: event.senderSubjectId,
    occurred_at: event.occurredAt,
    body: normalizedBody,
    body_sha256: messagingBodySha256(normalizedBody),
    canonical_event_sha256: canonical,
    declaration_sha256: input.declarationSha256,
    endpoint_revision_at_admission: endpoint.revision,
    attestation_sha256: canonicalMessagingAttestationSha256(input.participantSnapshot),
    attestation_revision: input.participantSnapshot.revision,
    attestation_observed_at: input.participantSnapshot.observedAt,
    attestation_confidentiality: input.participantSnapshot.confidentiality,
    attested_human_subject_ids: [...input.participantSnapshot.joinedHumanSubjectIds].sort(),
    authorization_policy_version: "messaging-participant-v1",
    acceptance_sequence: lastSequence + 1,
    state: "accepted",
    claim_id: null,
    claim_attempt: 0,
    claimed_at: null,
    claim_endpoint_revision: null,
    claim_declaration_sha256: null,
    claim_session_id: null,
    wayang_session_id: null,
    delivery_id: null,
    accepted_at: acceptedAt,
    completed_at: null,
    error_code: null,
  };
  draft.messagingEvents.push(row);
  return { row: clone(row), duplicate: false };
}

export function acceptMessagingEvent(input: MessagingEventAdmission & { readonly acceptedAt?: number }): AcceptMessagingEventResult {
  return commitStoreMutation((draft) => admitMessagingEventDraft(draft, input, input.acceptedAt ?? Date.now()));
}

export function claimNextMessagingEvent(input: {
  endpointId: string;
  declarationSha256: string;
}): MessagingEventRow | null {
  return commitStoreMutation((draft) => {
    const endpoint = currentEndpointDraft(draft, input.endpointId, input.declarationSha256);
    const row = draft.messagingEvents
      .filter((candidate) => candidate.endpoint_id === input.endpointId
        && (candidate.state === "accepted" || candidate.state === "processing"))
      .sort((a, b) => a.acceptance_sequence - b.acceptance_sequence)[0];
    if (!row || row.state === "processing") return null;
    row.state = "processing";
    row.claim_id = randomUUID();
    row.claim_attempt++;
    row.claimed_at = Date.now();
    row.claim_endpoint_revision = endpoint.revision;
    row.claim_declaration_sha256 = endpoint.declaration_sha256;
    row.claim_session_id = endpoint.active_session_id;
    return clone(row);
  });
}

export function hasClaimableMessagingEvents(endpointId: string): boolean {
  const rows = getStore().messagingEvents.filter((row) => row.endpoint_id === endpointId);
  return !rows.some((row) => row.state === "processing") && rows.some((row) => row.state === "accepted");
}

export function assertMessagingEventClaimBinding(input: {
  connectorId: string;
  connectorEventId: string;
  canonicalEventSha256: string;
  claimId: string;
  endpointRevision: number;
  declarationSha256: string;
  sessionId: string | null;
}): void {
  const store = getStore();
  const row = store.messagingEvents.find((candidate) => candidate.connector_id === input.connectorId
    && candidate.connector_event_id === input.connectorEventId);
  const endpoint = row ? store.messagingEndpoints.find((candidate) => candidate.endpoint_id === row.endpoint_id) : undefined;
  if (!row || !endpoint || row.state !== "processing" || row.claim_id !== input.claimId
    || row.canonical_event_sha256 !== input.canonicalEventSha256
    || row.claim_endpoint_revision !== input.endpointRevision
    || row.claim_declaration_sha256 !== input.declarationSha256
    || row.claim_session_id !== input.sessionId
    || endpoint.revision !== input.endpointRevision
    || endpoint.declaration_sha256 !== input.declarationSha256
    || endpoint.active_session_id !== input.sessionId) {
    throw new WorkspaceStoreError("Messaging event dispatch binding is stale", 409);
  }
}

export function listProcessingMessagingEvents(): MessagingEventRow[] {
  return getStore().messagingEvents.filter((row) => row.state === "processing").map(clone)
    .sort((a, b) => a.accepted_at - b.accepted_at || a.acceptance_sequence - b.acceptance_sequence);
}

export function requeueProcessingMessagingEvent(input: {
  connectorId: string;
  connectorEventId: string;
  canonicalEventSha256: string;
  claimId: string;
}): MessagingEventRow {
  return commitStoreMutation((draft) => {
    const row = draft.messagingEvents.find((candidate) => (
      candidate.connector_id === input.connectorId && candidate.connector_event_id === input.connectorEventId
    ));
    if (!row || row.canonical_event_sha256 !== input.canonicalEventSha256
      || row.state !== "processing" || row.claim_id !== input.claimId) {
      throw new WorkspaceStoreError("Messaging processing claim is stale", 409);
    }
    row.state = "accepted";
    row.claim_id = null;
    row.claimed_at = null;
    row.claim_endpoint_revision = null;
    row.claim_declaration_sha256 = null;
    row.claim_session_id = null;
    return clone(row);
  });
}

export function recordMessagingEventDispatchSession(input: {
  connectorId: string;
  connectorEventId: string;
  canonicalEventSha256: string;
  claimId: string;
  sessionId: string;
}): MessagingEventRow {
  return commitStoreMutation((draft) => {
    const row = draft.messagingEvents.find((candidate) => candidate.connector_id === input.connectorId
      && candidate.connector_event_id === input.connectorEventId);
    const endpoint = row ? draft.messagingEndpoints.find((candidate) => candidate.endpoint_id === row.endpoint_id) : undefined;
    if (!row || !endpoint || row.state !== "processing" || row.claim_id !== input.claimId
      || row.canonical_event_sha256 !== input.canonicalEventSha256
      || row.claim_session_id !== input.sessionId
      || !sessionEligibleForEndpoint(draft, endpoint, input.sessionId)) {
      throw new WorkspaceStoreError("Messaging dispatch session claim is stale", 409);
    }
    if (row.wayang_session_id !== null && row.wayang_session_id !== input.sessionId) {
      throw new WorkspaceStoreError("Messaging dispatch session is already bound", 409);
    }
    row.wayang_session_id = input.sessionId;
    return clone(row);
  });
}

export function refreshMessagingEventClaimBinding(input: {
  connectorId: string;
  connectorEventId: string;
  canonicalEventSha256: string;
  claimId: string;
  expectedEndpointRevision: number;
}): MessagingEventRow {
  return commitStoreMutation((draft) => {
    const row = draft.messagingEvents.find((candidate) => candidate.connector_id === input.connectorId
      && candidate.connector_event_id === input.connectorEventId);
    const endpoint = row
      ? draft.messagingEndpoints.find((candidate) => candidate.endpoint_id === row.endpoint_id)
      : undefined;
    if (!row || !endpoint || row.state !== "processing" || row.claim_id !== input.claimId
      || row.canonical_event_sha256 !== input.canonicalEventSha256
      || endpoint.revision !== input.expectedEndpointRevision) {
      throw new WorkspaceStoreError("Messaging processing claim binding is stale", 409);
    }
    row.claim_endpoint_revision = endpoint.revision;
    row.claim_declaration_sha256 = endpoint.declaration_sha256;
    row.claim_session_id = endpoint.active_session_id;
    return clone(row);
  });
}

export function completeMessagingEventWithDeliveries(input: {
  connectorId: string;
  connectorEventId: string;
  canonicalEventSha256: string;
  claimId: string;
  sessionId: string | null;
  eventState?: "completed" | "failed" | "rejected";
  errorCode?: MessagingErrorCode | null;
  payloads: readonly MessagingDeliveryPayload[];
  now?: number;
  deliveryGroupId?: string;
}): { event: MessagingEventRow; deliveries: MessagingDeliveryRow[] } {
  if (input.payloads.length === 0 || input.payloads.length > 64) {
    throw new WorkspaceStoreError("Messaging delivery chunk count is invalid");
  }
  return commitStoreMutation((draft) => {
    const event = draft.messagingEvents.find((candidate) => (
      candidate.connector_id === input.connectorId && candidate.connector_event_id === input.connectorEventId
    ));
    if (!event || event.canonical_event_sha256 !== input.canonicalEventSha256
      || event.state !== "processing" || event.claim_id !== input.claimId) {
      throw new WorkspaceStoreError("Messaging processing claim is stale", 409);
    }
    const endpoint = draft.messagingEndpoints.find((candidate) => candidate.endpoint_id === event.endpoint_id);
    if (!endpoint || endpoint.external_conversation_id !== event.external_conversation_id
      || endpoint.revision !== event.claim_endpoint_revision
      || endpoint.declaration_sha256 !== event.claim_declaration_sha256
      || endpoint.active_session_id !== event.claim_session_id
      || input.sessionId !== event.claim_session_id
      || (input.sessionId !== null && !sessionEligibleForEndpoint(draft, endpoint, input.sessionId))) {
      throw new WorkspaceStoreError("Messaging completion session is no longer eligible", 403);
    }
    const now = input.now ?? Date.now();
    if (historyAtHighWater(draft)) compactMessagingHistoryDraft(draft, now);
    if (draft.messagingDeliveries.length + input.payloads.length > MAX_MESSAGING_DELIVERIES) {
      throw new WorkspaceStoreError("Messaging delivery limit reached", 409);
    }
    const groupId = input.deliveryGroupId ?? randomUUID();
    if (draft.messagingDeliveries.some((row) => row.delivery_group_id === groupId)) {
      throw new WorkspaceStoreError("Messaging delivery group identity already exists", 409);
    }
    const deliveries = input.payloads.map((payload, chunkIndex): MessagingDeliveryRow => ({
      id: randomUUID(),
      delivery_group_id: groupId,
      connector_id: event.connector_id,
      endpoint_id: event.endpoint_id,
      external_conversation_id: event.external_conversation_id,
      connector_event_id: event.connector_event_id,
      chunk_index: chunkIndex,
      chunk_count: input.payloads.length,
      payload: clone(payload),
      payload_sha256: canonicalMessagingDeliveryPayloadSha256(payload),
      declaration_sha256: event.claim_declaration_sha256!,
      state: "pending",
      attempt_count: 0,
      claim_generation: 0,
      claim_id: null,
      worker_boot_id: null,
      claimed_at: null,
      next_attempt_at: now,
      last_error_code: null,
      attestation_sha256: null,
      attestation_revision: null,
      attestation_observed_at: null,
      attestation_confidentiality: null,
      attested_human_subject_ids: [],
      connector_transaction_ids: [],
      remote_delivery_ids: [],
      created_at: now,
      updated_at: now,
      delivered_at: null,
      failed_at: null,
      withheld_at: null,
    }));
    draft.messagingDeliveries.push(...deliveries);
    event.state = input.eventState ?? "completed";
    event.wayang_session_id ??= input.sessionId;
    event.delivery_id = groupId;
    event.error_code = input.errorCode ?? null;
    event.completed_at = now;
    return { event: clone(event), deliveries: deliveries.map(clone) };
  });
}

export function listMessagingDeliveries(): MessagingDeliveryRow[] {
  return getStore().messagingDeliveries.map(clone).sort((a, b) => (
    a.created_at - b.created_at || a.delivery_group_id.localeCompare(b.delivery_group_id) || a.chunk_index - b.chunk_index
  ));
}

function requireOpaqueMessagingId(value: string, label: string): void {
  if (!value || value !== value.normalize("NFC") || Buffer.byteLength(value, "utf8") > 512
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new WorkspaceStoreError(`Invalid messaging ${label}`);
  }
}

function clearDeliveryClaim(row: MessagingDeliveryRow): void {
  row.claim_id = null;
  row.worker_boot_id = null;
  row.claimed_at = null;
}

function clearDeliveryAttestation(row: MessagingDeliveryRow): void {
  row.attestation_sha256 = null;
  row.attestation_revision = null;
  row.attestation_observed_at = null;
  row.attestation_confidentiality = null;
  row.attested_human_subject_ids = [];
}

function currentDeliveryClaimDraft(draft: StoreData, input: {
  deliveryId: string;
  claimId: string;
  claimGeneration: number;
  workerBootId: string;
}): MessagingDeliveryRow {
  const row = draft.messagingDeliveries.find((candidate) => candidate.id === input.deliveryId);
  if (!row || row.state !== "delivering" || row.claim_id !== input.claimId
    || row.claim_generation !== input.claimGeneration || row.worker_boot_id !== input.workerBootId) {
    throw new WorkspaceStoreError("Messaging delivery claim is stale", 409);
  }
  return row;
}

/** Claim one due endpoint head. Later groups/chunks cannot pass an earlier pending or delivering row. */
export function claimNextDueMessagingDelivery(input: {
  connectorId: string;
  workerBootId: string;
  now?: number;
}): MessagingDeliveryRow | null {
  requireOpaqueMessagingId(input.connectorId, "connector id");
  requireOpaqueMessagingId(input.workerBootId, "worker boot id");
  const now = input.now ?? Date.now();
  return commitStoreMutation((draft) => {
    const candidates: MessagingDeliveryRow[] = [];
    const endpointIds = new Set(draft.messagingDeliveries
      .filter((row) => row.connector_id === input.connectorId)
      .map((row) => row.endpoint_id));
    for (const endpointId of endpointIds) {
      const nonterminal = draft.messagingDeliveries.filter((row) => row.endpoint_id === endpointId
        && (row.state === "pending" || row.state === "delivering"))
        .sort((left, right) => {
          const leftSequence = draft.messagingEvents.find((event) => event.connector_id === left.connector_id
            && event.connector_event_id === left.connector_event_id)!.acceptance_sequence;
          const rightSequence = draft.messagingEvents.find((event) => event.connector_id === right.connector_id
            && event.connector_event_id === right.connector_event_id)!.acceptance_sequence;
          return leftSequence - rightSequence || left.chunk_index - right.chunk_index;
        });
      const head = nonterminal[0];
      if (head?.state === "pending" && head.next_attempt_at !== null && head.next_attempt_at <= now) candidates.push(head);
    }
    candidates.sort((left, right) => left.next_attempt_at! - right.next_attempt_at!
      || left.created_at - right.created_at || left.id.localeCompare(right.id));
    const row = candidates[0];
    if (!row) return null;
    row.state = "delivering";
    row.claim_generation++;
    row.attempt_count++;
    row.claim_id = randomUUID();
    row.worker_boot_id = input.workerBootId;
    row.claimed_at = now;
    row.next_attempt_at = null;
    row.updated_at = now;
    // Preserve durable subchunk progress and its last audit attestation across
    // retries. The worker must still fetch and persist fresh authority before
    // every remaining remote send.
    return clone(row);
  });
}

/** Release only claims from an earlier process boot; same-boot work is never stolen. */
export function recoverPriorBootMessagingDeliveryClaims(input: {
  connectorId: string;
  workerBootId: string;
  now?: number;
}): MessagingDeliveryRow[] {
  requireOpaqueMessagingId(input.connectorId, "connector id");
  requireOpaqueMessagingId(input.workerBootId, "worker boot id");
  const now = input.now ?? Date.now();
  return commitStoreMutation((draft) => {
    const recovered: MessagingDeliveryRow[] = [];
    for (const row of draft.messagingDeliveries) {
      if (row.connector_id !== input.connectorId || row.state !== "delivering"
        || row.worker_boot_id === input.workerBootId) continue;
      row.state = "pending";
      clearDeliveryClaim(row);
      row.next_attempt_at = now;
      row.last_error_code = "worker_restarted";
      row.updated_at = now;
      recovered.push(clone(row));
    }
    return recovered;
  });
}

function authorizeOutboundSnapshot(
  declaration: MessagingEndpointDeclaration,
  endpoint: MessagingEndpointRow,
  snapshot: MessagingOutboundParticipantSnapshot,
  now: number,
): string[] {
  if (Object.keys(snapshot as unknown as object).sort().join("\0") !== [
    "complete", "confidentiality", "connectorId", "externalConversationId", "joinedHumanSubjectIds",
    "observedAt", "revision",
  ].sort().join("\0") || snapshot.complete !== true || snapshot.connectorId !== endpoint.connector_id
    || snapshot.externalConversationId !== endpoint.external_conversation_id
    || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now + 5_000 || now - snapshot.observedAt > 30_000
    || typeof snapshot.revision !== "string" || !snapshot.revision
    || !["end_to_end_encrypted", "server_visible"].includes(snapshot.confidentiality)
    || !Array.isArray(snapshot.joinedHumanSubjectIds) || snapshot.joinedHumanSubjectIds.length === 0
    || snapshot.joinedHumanSubjectIds.length > 128) {
    throw new WorkspaceStoreError("Outbound messaging attestation is invalid or stale", 403);
  }
  if (declaration.transportSecurity === "encrypted_required" && snapshot.confidentiality !== "end_to_end_encrypted") {
    throw new WorkspaceStoreError("Outbound messaging transport does not meet endpoint policy", 403);
  }
  const humans = [...snapshot.joinedHumanSubjectIds].sort();
  if (new Set(humans).size !== humans.length || humans.some((subject) => !declaration.allowedSubjectIds.includes(subject))) {
    throw new WorkspaceStoreError("Outbound messaging participants are not exactly authorized", 403);
  }
  for (const subject of humans) requireOpaqueMessagingId(subject, "participant id");
  return humans;
}

/** Persist fresh authorization and stable connector transaction IDs before any remote send. */
export function persistMessagingDeliveryAttestation(input: {
  deliveryId: string;
  claimId: string;
  claimGeneration: number;
  workerBootId: string;
  payloadSha256: string;
  declarationSha256: string;
  declaration: MessagingEndpointDeclaration;
  participantSnapshot: MessagingOutboundParticipantSnapshot;
  connectorTransactionIds: readonly string[];
  now?: number;
}): MessagingDeliveryRow {
  const now = input.now ?? Date.now();
  if (input.connectorTransactionIds.length === 0 || input.connectorTransactionIds.length > 256) {
    throw new WorkspaceStoreError("Messaging connector transaction manifest is invalid");
  }
  const transactionIds = [...input.connectorTransactionIds];
  for (const id of transactionIds) requireOpaqueMessagingId(id, "connector transaction id");
  if (new Set(transactionIds).size !== transactionIds.length) {
    throw new WorkspaceStoreError("Messaging connector transaction manifest contains duplicates");
  }
  return commitStoreMutation((draft) => {
    const row = currentDeliveryClaimDraft(draft, input);
    const endpoint = currentEndpointDraft(draft, row.endpoint_id, input.declarationSha256);
    if (row.payload_sha256 !== input.payloadSha256 || row.declaration_sha256 !== input.declarationSha256
      || messagingDeclarationSha256(input.declaration) !== input.declarationSha256
      || input.declaration.endpointId !== row.endpoint_id
      || endpoint.external_conversation_id !== row.external_conversation_id) {
      throw new WorkspaceStoreError("Messaging delivery declaration changed", 409);
    }
    const humans = authorizeOutboundSnapshot(input.declaration, endpoint, input.participantSnapshot, now);
    if (row.connector_transaction_ids.length > 0
      && JSON.stringify(row.connector_transaction_ids) !== JSON.stringify(transactionIds)) {
      throw new WorkspaceStoreError("Messaging connector transaction manifest changed across retry", 409);
    }
    row.connector_transaction_ids = transactionIds;
    row.attestation_sha256 = canonicalMessagingOutboundAttestationSha256(input.participantSnapshot);
    row.attestation_revision = input.participantSnapshot.revision;
    row.attestation_observed_at = input.participantSnapshot.observedAt;
    row.attestation_confidentiality = input.participantSnapshot.confidentiality as "end_to_end_encrypted" | "server_visible";
    row.attested_human_subject_ids = humans;
    row.updated_at = now;
    return clone(row);
  });
}

/** Persist one exact remote subchunk acknowledgement before advancing to the next send. */
export function persistMessagingDeliveryRemoteProgress(input: {
  deliveryId: string;
  claimId: string;
  claimGeneration: number;
  workerBootId: string;
  connectorTransactionId: string;
  remoteDeliveryId: string;
  expectedSubchunkIndex: number;
  now?: number;
}): MessagingDeliveryRow {
  requireOpaqueMessagingId(input.connectorTransactionId, "connector transaction id");
  requireOpaqueMessagingId(input.remoteDeliveryId, "remote delivery id");
  if (!Number.isSafeInteger(input.expectedSubchunkIndex) || input.expectedSubchunkIndex < 0) {
    throw new WorkspaceStoreError("Messaging remote progress index is invalid");
  }
  const now = input.now ?? Date.now();
  return commitStoreMutation((draft) => {
    const row = currentDeliveryClaimDraft(draft, input);
    if (!row.attestation_sha256 || row.remote_delivery_ids.length !== input.expectedSubchunkIndex
      || row.connector_transaction_ids[input.expectedSubchunkIndex] !== input.connectorTransactionId
      || row.remote_delivery_ids.includes(input.remoteDeliveryId)) {
      throw new WorkspaceStoreError("Messaging remote progress does not match persisted send authority", 409);
    }
    row.remote_delivery_ids.push(input.remoteDeliveryId);
    row.updated_at = now;
    return clone(row);
  });
}

/** Atomically acknowledge the exact persisted connector transactions with exact opaque remote IDs. */
export function acknowledgeMessagingDelivery(input: {
  deliveryId: string;
  claimId: string;
  claimGeneration: number;
  workerBootId: string;
  connectorTransactionIds: readonly string[];
  remoteDeliveryIds: readonly string[];
  now?: number;
}): MessagingDeliveryRow {
  const transactionIds = [...input.connectorTransactionIds];
  const remoteIds = [...input.remoteDeliveryIds];
  if (remoteIds.length === 0 || remoteIds.length !== transactionIds.length) {
    throw new WorkspaceStoreError("Messaging remote acknowledgement manifest is invalid");
  }
  for (const id of remoteIds) requireOpaqueMessagingId(id, "remote delivery id");
  if (new Set(remoteIds).size !== remoteIds.length) throw new WorkspaceStoreError("Messaging remote delivery ids contain duplicates");
  const now = input.now ?? Date.now();
  return commitStoreMutation((draft) => {
    const row = currentDeliveryClaimDraft(draft, input);
    if (!row.attestation_sha256 || JSON.stringify(row.connector_transaction_ids) !== JSON.stringify(transactionIds)) {
      throw new WorkspaceStoreError("Messaging delivery acknowledgement does not match persisted send authority", 409);
    }
    row.state = "delivered";
    row.remote_delivery_ids = remoteIds;
    row.delivered_at = now;
    row.updated_at = now;
    row.last_error_code = null;
    return clone(row);
  });
}

export function scheduleMessagingDeliveryRetry(input: {
  deliveryId: string;
  claimId: string;
  claimGeneration: number;
  workerBootId: string;
  errorCode: MessagingDeliveryErrorCode;
  nextAttemptAt: number;
  now?: number;
}): MessagingDeliveryRow {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(input.nextAttemptAt) || input.nextAttemptAt < now) {
    throw new WorkspaceStoreError("Messaging delivery retry time is invalid");
  }
  return commitStoreMutation((draft) => {
    const row = currentDeliveryClaimDraft(draft, input);
    row.state = "pending";
    clearDeliveryClaim(row);
    row.next_attempt_at = input.nextAttemptAt;
    row.last_error_code = input.errorCode;
    row.updated_at = now;
    return clone(row);
  });
}

function terminateMessagingDeliveryGroupDraft(
  draft: StoreData,
  input: { deliveryId: string; claimId: string; claimGeneration: number; workerBootId: string },
  currentState: "failed" | "withheld",
  errorCode: MessagingDeliveryErrorCode,
  now: number,
): MessagingDeliveryRow[] {
  const current = currentDeliveryClaimDraft(draft, input);
  if (currentState === "failed" && !current.attestation_sha256) {
    throw new WorkspaceStoreError("A delivery cannot fail remotely before send authority is persisted", 409);
  }
  const rows = draft.messagingDeliveries.filter((row) => row.delivery_group_id === current.delivery_group_id
    && row.chunk_index >= current.chunk_index).sort((a, b) => a.chunk_index - b.chunk_index);
  for (const row of rows) {
    row.state = row.id === current.id ? currentState : "withheld";
    row.next_attempt_at = null;
    row.last_error_code = errorCode;
    // The current chunk may already have durable remotely visible subchunks.
    // Preserve that exact prefix for audit/recovery; later chunks have none.
    if (row.id !== current.id) row.remote_delivery_ids = [];
    row.delivered_at = null;
    row.failed_at = row.state === "failed" ? now : null;
    row.withheld_at = row.state === "withheld" ? now : null;
    row.updated_at = now;
  }
  return rows.map(clone);
}

/** Withhold the claimed chunk and every remaining chunk in its group. */
export function withholdMessagingDeliveryGroup(input: {
  deliveryId: string;
  claimId: string;
  claimGeneration: number;
  workerBootId: string;
  errorCode: MessagingDeliveryErrorCode;
  now?: number;
}): MessagingDeliveryRow[] {
  return commitStoreMutation((draft) => terminateMessagingDeliveryGroupDraft(
    draft, input, "withheld", input.errorCode, input.now ?? Date.now(),
  ));
}

/** Terminally fail the claimed chunk and withhold every remaining group chunk. */
export function failMessagingDelivery(input: {
  deliveryId: string;
  claimId: string;
  claimGeneration: number;
  workerBootId: string;
  errorCode: MessagingDeliveryErrorCode;
  now?: number;
}): MessagingDeliveryRow[] {
  return commitStoreMutation((draft) => terminateMessagingDeliveryGroupDraft(
    draft, input, "failed", input.errorCode, input.now ?? Date.now(),
  ));
}

/**
 * Read-only exact identity lookup before policy or membership work. Callers may
 * short-circuit only for `completed` plus an exact canonical hash match; a
 * mismatched hash must enter admission and receive its collision error.
 */
export function getMessagingEvent(
  connectorId: string,
  connectorEventId: string,
): MessagingEventRow | undefined {
  const row = getStore().messagingEvents.find((candidate) => candidate.connector_id === connectorId
    && candidate.connector_event_id === connectorEventId);
  return row ? clone(row) : undefined;
}

export function getMessagingTransaction(
  connectorId: string,
  transactionId: string,
): MessagingTransactionRow | undefined {
  const row = getStore().messagingTransactions.find((candidate) => candidate.connector_id === connectorId
    && candidate.transaction_id === transactionId);
  return row ? clone(row) : undefined;
}

/**
 * Atomically authorize/collision-check every child event, insert every missing
 * child, and retain the exact completed manifest. Only this completed row is
 * connector acknowledgement authority.
 */
export function admitMessagingTransactionManifest(input: {
  connectorId: string;
  transactionId: string;
  canonicalTransactionSha256: string;
  children: readonly MessagingEventAdmission[];
  acceptedAt?: number;
}): { transaction: MessagingTransactionRow; events: AcceptMessagingEventResult[]; duplicate: boolean } {
  requireOpaqueMessagingId(input.connectorId, "connector id");
  requireOpaqueMessagingId(input.transactionId, "transaction id");
  if (!/^[a-f0-9]{64}$/u.test(input.canonicalTransactionSha256)
    || input.children.length > MAX_MESSAGING_TRANSACTION_CHILDREN) {
    throw new WorkspaceStoreError("Messaging transaction manifest is invalid");
  }
  const manifest: MessagingTransactionManifestEntry[] = input.children.map((child) => {
    if (child.event.connectorId !== input.connectorId || typeof child.event.body !== "string") {
      throw new WorkspaceStoreError("Messaging transaction child connector is invalid");
    }
    const body = child.event.body.normalize("NFC");
    return {
      connector_event_id: child.event.connectorEventId,
      endpoint_id: child.endpointId,
      canonical_event_sha256: canonicalMessagingEventSha256({
        connectorId: child.event.connectorId,
        connectorEventId: child.event.connectorEventId,
        endpointId: child.endpointId,
        externalConversationId: child.event.externalConversationId,
        senderSubjectId: child.event.senderSubjectId,
        body,
      }),
    };
  });
  if (new Set(manifest.map((entry) => entry.connector_event_id)).size !== manifest.length) {
    throw new WorkspaceStoreError("Messaging transaction manifest contains duplicate child identities", 409);
  }
  const manifestSha256 = canonicalMessagingManifestSha256(manifest);
  const acceptedAt = input.acceptedAt ?? Date.now();
  return commitStoreMutation((draft) => {
    const existing = draft.messagingTransactions.find((row) => row.connector_id === input.connectorId
      && row.transaction_id === input.transactionId);
    if (existing) {
      if (existing.canonical_transaction_sha256 !== input.canonicalTransactionSha256
        || existing.canonical_manifest_sha256 !== manifestSha256
        || JSON.stringify(existing.child_manifest) !== JSON.stringify(manifest)
        || existing.state !== "completed") {
        throw new WorkspaceStoreError("Messaging transaction identity was reused with different exact content", 409);
      }
      const events = existing.child_manifest.map((entry) => {
        const row = draft.messagingEvents.find((candidate) => candidate.connector_id === input.connectorId
          && candidate.connector_event_id === entry.connector_event_id)!;
        return { row: clone(row), duplicate: true };
      });
      return { transaction: clone(existing), events, duplicate: true };
    }
    if (historyAtHighWater(draft)) compactMessagingHistoryDraft(draft, acceptedAt);
    if (draft.messagingTransactions.length >= MAX_MESSAGING_TRANSACTIONS) {
      throw new WorkspaceStoreError("Messaging transaction limit reached", 409);
    }
    const events = input.children.map((child, index) => {
      const result = admitMessagingEventDraft(draft, child, acceptedAt);
      if (result.row.canonical_event_sha256 !== manifest[index]!.canonical_event_sha256) {
        throw new WorkspaceStoreError("Messaging transaction child manifest changed during admission", 409);
      }
      return result;
    });
    const transaction: MessagingTransactionRow = {
      connector_id: input.connectorId,
      transaction_id: input.transactionId,
      canonical_transaction_sha256: input.canonicalTransactionSha256,
      canonical_manifest_sha256: manifestSha256,
      child_manifest: clone(manifest),
      state: "completed",
      accepted_at: acceptedAt,
      completed_at: acceptedAt,
    };
    draft.messagingTransactions.push(transaction);
    return { transaction: clone(transaction), events, duplicate: false };
  });
}
