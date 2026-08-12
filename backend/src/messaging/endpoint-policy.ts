import {
  MESSAGING_CONVERSATION_MODES,
  MESSAGING_OBSERVED_CONFIDENTIALITY,
  MESSAGING_TRANSPORT_SECURITY_MODES,
  type MessagingConversationBinding,
  type MessagingEndpointDeclaration,
  type MessagingParticipantSnapshot,
  type NormalizedMessagingInboundEvent,
} from "./contracts.js";

const ENDPOINT_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const PROVISIONING_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const MAX_OPAQUE_ID_BYTES = 256;
const MAX_DISPLAY_NAME_BYTES = 256;
const MAX_SUBJECT_ID_BYTES = 512;
const MAX_ALLOWED_SUBJECTS = 128;
const MAX_ENDPOINT_DECLARATIONS = 256;
export const DEFAULT_MEMBERSHIP_MAX_AGE_MS = 30_000;
const MAX_MEMBERSHIP_FUTURE_SKEW_MS = 5_000;
const MAX_EVENT_BODY_BYTES = 64 * 1024;
const MAX_CONFIGURED_MEMBERSHIP_AGE_MS = 5 * 60 * 1000;

const DECLARATION_KEYS = [
  "agentProfileId",
  "allowedSubjectIds",
  "connectorId",
  "conversationMode",
  "displayName",
  "endpointId",
  "projectId",
  "provisioningKey",
  "transportSecurity",
] as const;
const BINDING_KEYS = ["activeWayangSessionId", "connectorId", "endpointId", "externalConversationId", "revision"] as const;
const EVENT_KEYS = ["body", "connectorEventId", "connectorId", "externalConversationId", "occurredAt", "senderSubjectId"] as const;
const SNAPSHOT_KEYS = [
  "complete", "confidentiality", "connectorId", "externalConversationId", "joinedHumanSubjectIds",
  "observedAt", "revision", "senderSubjectId",
] as const;

export type MessagingParticipantDenialCode =
  | "invalid_event"
  | "invalid_snapshot"
  | "stale_snapshot"
  | "endpoint_binding_mismatch"
  | "event_snapshot_mismatch"
  | "transport_not_allowed"
  | "sender_not_joined"
  | "sender_not_allowed"
  | "unexpected_participant";

export type MessagingParticipantDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: MessagingParticipantDenialCode;
      readonly reason: string;
      readonly unexpectedSubjectIds?: readonly string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (!hasExactKeys(value, expected)) {
    throw new Error("Messaging endpoint declaration has unknown or missing fields");
  }
}

function safeBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maxBytes
    || UNSAFE_TEXT_PATTERN.test(value)
  ) throw new Error(`Invalid messaging endpoint ${label}`);
  return value;
}

function patternedString(
  value: unknown,
  label: string,
  maxBytes: number,
  pattern: RegExp,
): string {
  const text = safeBoundedString(value, label, maxBytes);
  if (!pattern.test(text)) throw new Error(`Invalid messaging endpoint ${label}`);
  return text;
}

function opaqueId(value: unknown, label: string): string {
  return safeBoundedString(value, label, MAX_OPAQUE_ID_BYTES);
}

function subjectId(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > MAX_SUBJECT_ID_BYTES
    || UNSAFE_TEXT_PATTERN.test(value)
  ) return null;
  return value;
}

/** Validate untrusted private-config input into a connector-neutral declaration. */
export function validateMessagingEndpointDeclaration(value: unknown): MessagingEndpointDeclaration {
  if (!isRecord(value)) throw new Error("Messaging endpoint declaration must be an object");
  assertExactKeys(value, DECLARATION_KEYS);

  const endpointId = patternedString(value.endpointId, "endpointId", 128, ENDPOINT_ID_PATTERN);
  const connectorId = patternedString(value.connectorId, "connectorId", 64, CONNECTOR_ID_PATTERN);
  const provisioningKey = patternedString(value.provisioningKey, "provisioningKey", 128, PROVISIONING_KEY_PATTERN);
  const projectId = opaqueId(value.projectId, "projectId");
  const agentProfileId = opaqueId(value.agentProfileId, "agentProfileId");
  const displayName = safeBoundedString(value.displayName, "displayName", MAX_DISPLAY_NAME_BYTES);

  if (!(MESSAGING_CONVERSATION_MODES as readonly unknown[]).includes(value.conversationMode)) {
    throw new Error("Invalid messaging endpoint conversationMode");
  }
  if (!(MESSAGING_TRANSPORT_SECURITY_MODES as readonly unknown[]).includes(value.transportSecurity)) {
    throw new Error("Invalid messaging endpoint transportSecurity");
  }
  if (
    !Array.isArray(value.allowedSubjectIds)
    || value.allowedSubjectIds.length === 0
    || value.allowedSubjectIds.length > MAX_ALLOWED_SUBJECTS
  ) throw new Error("Messaging endpoint allowedSubjectIds must be a nonempty bounded array");

  const allowedSubjectIds = value.allowedSubjectIds.map((subject) => {
    const validated = subjectId(subject);
    if (!validated) throw new Error("Invalid messaging endpoint allowedSubjectIds entry");
    return validated;
  });
  if (new Set(allowedSubjectIds).size !== allowedSubjectIds.length) {
    throw new Error("Messaging endpoint allowedSubjectIds contains duplicates");
  }

  return Object.freeze({
    endpointId,
    connectorId,
    provisioningKey,
    projectId,
    agentProfileId,
    displayName,
    conversationMode: value.conversationMode as MessagingEndpointDeclaration["conversationMode"],
    allowedSubjectIds: Object.freeze(allowedSubjectIds),
    transportSecurity: value.transportSecurity as MessagingEndpointDeclaration["transportSecurity"],
  });
}

/** Validate a declaration set and reject ambiguous adapter provisioning keys. */
export function compileMessagingEndpointDeclarations(values: unknown): readonly MessagingEndpointDeclaration[] {
  if (!Array.isArray(values) || values.length > MAX_ENDPOINT_DECLARATIONS) {
    throw new Error("Messaging endpoint declarations must be a bounded array");
  }
  const declarations = values.map(validateMessagingEndpointDeclaration);
  const endpointIds = new Set<string>();
  const provisioningKeys = new Set<string>();
  const projectProfilePairs = new Set<string>();
  for (const declaration of declarations) {
    if (endpointIds.has(declaration.endpointId)) {
      throw new Error(`Duplicate messaging endpointId: ${declaration.endpointId}`);
    }
    endpointIds.add(declaration.endpointId);

    const provisioningIdentity = `${declaration.connectorId}\0${declaration.provisioningKey}`;
    if (provisioningKeys.has(provisioningIdentity)) {
      throw new Error(`Duplicate messaging provisioning key for connector ${declaration.connectorId}`);
    }
    provisioningKeys.add(provisioningIdentity);

    const projectProfilePair = `${declaration.projectId}\0${declaration.agentProfileId}`;
    if (projectProfilePairs.has(projectProfilePair)) {
      throw new Error("Duplicate messaging endpoint for exact Project/Profile pair");
    }
    projectProfilePairs.add(projectProfilePair);
  }
  return Object.freeze(declarations);
}

function deny(code: MessagingParticipantDenialCode, reason: string, unexpectedSubjectIds?: string[]): MessagingParticipantDecision {
  return {
    allowed: false,
    code,
    reason,
    ...(unexpectedSubjectIds ? { unexpectedSubjectIds: Object.freeze(unexpectedSubjectIds) } : {}),
  };
}

/**
 * Fail-closed authorization for every inbound operation, including read-only
 * commands and help/error responses. The adapter must provide a complete,
 * freshly fetched human membership and confidentiality snapshot.
 */
export function authorizeMessagingParticipant(
  endpoint: MessagingEndpointDeclaration,
  binding: MessagingConversationBinding,
  event: NormalizedMessagingInboundEvent,
  snapshot: MessagingParticipantSnapshot,
  options: { readonly now?: number; readonly maxSnapshotAgeMs?: number } = {},
): MessagingParticipantDecision {
  const now = options.now ?? Date.now();
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? DEFAULT_MEMBERSHIP_MAX_AGE_MS;
  const eventSender = subjectId(event?.senderSubjectId);
  if (
    !hasExactKeys(binding, BINDING_KEYS)
    || !subjectId(binding.externalConversationId)
    || !Number.isSafeInteger(binding.revision)
    || binding.revision < 0
    || !(binding.activeWayangSessionId === null || subjectId(binding.activeWayangSessionId))
    || !hasExactKeys(event, EVENT_KEYS)
    || !eventSender
    || !subjectId(event.connectorId)
    || !subjectId(event.connectorEventId)
    || !subjectId(event.externalConversationId)
    || typeof event.body !== "string"
    || Buffer.byteLength(event.body, "utf8") > MAX_EVENT_BODY_BYTES
    || !Number.isFinite(event.occurredAt)
  ) return deny("invalid_event", "Inbound event identity could not be proven");

  const snapshotSender = subjectId(snapshot?.senderSubjectId);
  if (
    !hasExactKeys(snapshot, SNAPSHOT_KEYS)
    || !snapshotSender
    || !subjectId(snapshot.connectorId)
    || !subjectId(snapshot.externalConversationId)
    || snapshot.complete !== true
    || typeof snapshot?.revision !== "string"
    || !subjectId(snapshot.revision)
    || !Number.isFinite(snapshot?.observedAt)
    || !(MESSAGING_OBSERVED_CONFIDENTIALITY as readonly unknown[]).includes(snapshot?.confidentiality)
    || !Array.isArray(snapshot?.joinedHumanSubjectIds)
    || snapshot.joinedHumanSubjectIds.length === 0
    || snapshot.joinedHumanSubjectIds.length > MAX_ALLOWED_SUBJECTS
  ) return deny("invalid_snapshot", "Current participant membership could not be proven");

  if (
    !Number.isFinite(now)
    || !Number.isFinite(maxSnapshotAgeMs)
    || maxSnapshotAgeMs < 0
    || maxSnapshotAgeMs > MAX_CONFIGURED_MEMBERSHIP_AGE_MS
    || snapshot.observedAt > now + MAX_MEMBERSHIP_FUTURE_SKEW_MS
    || now - snapshot.observedAt > maxSnapshotAgeMs
  ) return deny("stale_snapshot", "Current participant membership is stale");

  const joined: string[] = [];
  for (const candidate of snapshot.joinedHumanSubjectIds) {
    const validated = subjectId(candidate);
    if (!validated || joined.includes(validated)) {
      return deny("invalid_snapshot", "Current participant membership is malformed or ambiguous");
    }
    joined.push(validated);
  }

  if (
    endpoint.endpointId !== binding.endpointId
    || endpoint.connectorId !== binding.connectorId
    || event.connectorId !== binding.connectorId
    || event.externalConversationId !== binding.externalConversationId
  ) return deny("endpoint_binding_mismatch", "External conversation does not match the durable endpoint binding");

  if (
    snapshot.connectorId !== event.connectorId
    || snapshot.externalConversationId !== event.externalConversationId
    || snapshotSender !== eventSender
  ) return deny("event_snapshot_mismatch", "Inbound event does not match its participant attestation");

  if (
    snapshot.confidentiality === "unknown"
    || (endpoint.transportSecurity === "encrypted_required"
      && snapshot.confidentiality !== "end_to_end_encrypted")
  ) return deny("transport_not_allowed", "Observed conversation confidentiality does not meet endpoint policy");

  if (!joined.includes(eventSender)) {
    return deny("sender_not_joined", "Message sender is not a current joined human participant");
  }

  const allowed = new Set(endpoint.allowedSubjectIds);
  if (!allowed.has(eventSender)) {
    return deny("sender_not_allowed", "Message sender is not allowlisted for this endpoint");
  }

  const unexpected = joined.filter((participant) => !allowed.has(participant));
  if (unexpected.length > 0) {
    return deny(
      "unexpected_participant",
      "Endpoint is blocked because an unexpected human participant is joined",
      unexpected,
    );
  }

  return { allowed: true };
}
