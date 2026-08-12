import { createHash } from "node:crypto";
import type { NormalizedMessagingInboundEvent } from "../../contracts.js";
import { parseStrictJson } from "./strict-json.js";
import {
  isManagedMatrixUser,
  isMatrixApplicationServiceSender,
  validateMatrixEventId,
  validateMatrixRoomId,
  validateMatrixUserId,
  type MatrixNamespace,
} from "./identifiers.js";

export const MAX_MATRIX_TRANSACTION_BYTES = 1024 * 1024;
export const MAX_MATRIX_EVENTS_PER_TRANSACTION = 256;
export const MAX_MATRIX_TEXT_BODY_BYTES = 64 * 1024;
const MATRIX_TRANSACTION_KEYS = new Set([
  "device_lists", "device_one_time_keys_count", "device_unused_fallback_key_types",
  "ephemeral", "events", "to_device",
]);

export interface ParsedMatrixTransaction {
  readonly transactionId: string;
  readonly events: readonly unknown[];
  readonly canonicalSha256: string;
}

export type MatrixEventDispositionCode =
  | "admissible_text"
  | "malformed"
  | "unknown_room"
  | "self_echo"
  | "managed_sender"
  | "encrypted"
  | "state_event"
  | "edit"
  | "reaction"
  | "redaction"
  | "redacted"
  | "unsupported_message"
  | "unsupported_event";

export type MatrixEventDisposition =
  | {
      readonly code: "admissible_text";
      readonly event: NormalizedMessagingInboundEvent;
    }
  | {
      readonly code: Exclude<MatrixEventDispositionCode, "admissible_text">;
      readonly eventId?: string;
      readonly roomId?: string;
    };

export interface MatrixEventFilterContext extends MatrixNamespace {
  readonly knownRoomIds: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length <= MAX_MATRIX_EVENTS_PER_TRANSACTION;
}

function validDeviceLists(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== "changed\0left"
    || !Array.isArray(value.changed) || !Array.isArray(value.left)
    || value.changed.length > MAX_MATRIX_EVENTS_PER_TRANSACTION || value.left.length > MAX_MATRIX_EVENTS_PER_TRANSACTION) return false;
  try {
    const users = [...value.changed, ...value.left].map((userId) => validateMatrixUserId(userId));
    return new Set(users).size === users.length;
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Matrix transaction contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Matrix transaction contains an unsupported JSON value");
}

function transactionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256
    || value !== value.normalize("NFC") || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error("Invalid Matrix transaction ID");
  }
  return value;
}

export function parseMatrixTransaction(transactionIdValue: unknown, body: Uint8Array): ParsedMatrixTransaction {
  const id = transactionId(transactionIdValue);
  if (!(body instanceof Uint8Array) || body.byteLength < 2 || body.byteLength > MAX_MATRIX_TRANSACTION_BYTES) {
    throw new Error("Matrix transaction body exceeds bounds");
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    value = parseStrictJson(text);
  } catch {
    throw new Error("Matrix transaction body is not strict UTF-8 JSON");
  }
  if (!isRecord(value) || !Object.hasOwn(value, "events")
    || Object.keys(value).some((key) => !MATRIX_TRANSACTION_KEYS.has(key))
    || !Array.isArray(value.events) || value.events.length > MAX_MATRIX_EVENTS_PER_TRANSACTION
    || (value.ephemeral !== undefined && (!Array.isArray(value.ephemeral) || value.ephemeral.length > MAX_MATRIX_EVENTS_PER_TRANSACTION))
    || (value.to_device !== undefined && (!Array.isArray(value.to_device) || value.to_device.length > MAX_MATRIX_EVENTS_PER_TRANSACTION))
    || (value.device_lists !== undefined && !validDeviceLists(value.device_lists))
    || (value.device_one_time_keys_count !== undefined && !boundedRecord(value.device_one_time_keys_count))
    || (value.device_unused_fallback_key_types !== undefined && !boundedRecord(value.device_unused_fallback_key_types))) {
    throw new Error("Matrix transaction envelope has unknown fields or invalid events");
  }
  const canonical = canonicalJson({ transaction_id: id, transaction: value });
  return Object.freeze({
    transactionId: id,
    events: Object.freeze([...value.events]),
    canonicalSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}

function ignored(
  code: Exclude<MatrixEventDispositionCode, "admissible_text">,
  eventId?: string,
  roomId?: string,
): MatrixEventDisposition {
  return Object.freeze({ code, ...(eventId ? { eventId } : {}), ...(roomId ? { roomId } : {}) });
}

function safeEventIdentity(value: Record<string, unknown>): { eventId: string; roomId: string; sender: string; occurredAt: number } | null {
  try {
    const eventId = validateMatrixEventId(value.event_id);
    const roomId = validateMatrixRoomId(value.room_id);
    const sender = validateMatrixUserId(value.sender);
    if (!Number.isSafeInteger(value.origin_server_ts) || (value.origin_server_ts as number) < 0) return null;
    return { eventId, roomId, sender, occurredAt: value.origin_server_ts as number };
  } catch {
    return null;
  }
}

/** Side-effect-free Matrix event filtering. Every non-prompt path has an explicit disposition. */
export function filterMatrixEvent(value: unknown, context: MatrixEventFilterContext): MatrixEventDisposition {
  if (!isRecord(value)) return ignored("malformed");
  const identity = safeEventIdentity(value);
  if (!identity || typeof value.type !== "string" || !isRecord(value.content)) return ignored("malformed");
  const { eventId, roomId, sender, occurredAt } = identity;
  if (!context.knownRoomIds.has(roomId)) return ignored("unknown_room", eventId, roomId);
  if (value.type === "m.room.encrypted") return ignored("encrypted", eventId, roomId);
  if (value.type === "m.room.redaction") return ignored("redaction", eventId, roomId);
  if (value.type === "m.reaction") return ignored("reaction", eventId, roomId);
  if (Object.hasOwn(value, "state_key")) return ignored("state_event", eventId, roomId);
  if (isRecord(value.unsigned) && Object.hasOwn(value.unsigned, "redacted_because")) {
    return ignored("redacted", eventId, roomId);
  }
  if (isMatrixApplicationServiceSender(sender, context)) return ignored("self_echo", eventId, roomId);
  if (isManagedMatrixUser(sender, context)) return ignored("managed_sender", eventId, roomId);
  if (value.type !== "m.room.message") return ignored("unsupported_event", eventId, roomId);
  const relation = value.content["m.relates_to"];
  if (relation !== undefined && !isRecord(relation)) return ignored("malformed", eventId, roomId);
  if (isRecord(relation)) {
    if (relation.rel_type !== undefined && typeof relation.rel_type !== "string") {
      return ignored("malformed", eventId, roomId);
    }
    if (relation.rel_type === "m.replace") return ignored("edit", eventId, roomId);
    // Reply-only relations legitimately contain m.in_reply_to without rel_type.
    if (relation.rel_type === undefined && !isRecord(relation["m.in_reply_to"])) {
      return ignored("malformed", eventId, roomId);
    }
  }
  if (value.content.msgtype !== "m.text") return ignored("unsupported_message", eventId, roomId);
  const body = value.content.body;
  if (typeof body !== "string" || body !== body.normalize("NFC") || body.trim().length === 0
    || Buffer.byteLength(body, "utf8") > MAX_MATRIX_TEXT_BODY_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(body)) {
    return ignored("malformed", eventId, roomId);
  }
  return Object.freeze({
    code: "admissible_text",
    event: Object.freeze({
      connectorId: "matrix",
      connectorEventId: eventId,
      externalConversationId: roomId,
      senderSubjectId: sender,
      body,
      occurredAt,
    }),
  });
}

export function filterMatrixTransaction(
  transaction: ParsedMatrixTransaction,
  context: MatrixEventFilterContext,
): readonly MatrixEventDisposition[] {
  return Object.freeze(transaction.events.map((event) => filterMatrixEvent(event, context)));
}
