import { isLoopbackHost } from "../../../loopback.js";
import type { MatrixAsTokenAuthorizer } from "./auth.js";
import { parseStrictJson } from "./strict-json.js";
import {
  parseMatrixIdentifier,
  validateMatrixEventId,
  validateMatrixRoomAlias,
  validateMatrixRoomId,
  validateMatrixServerName,
  validateMatrixUserId,
} from "./identifiers.js";

export const DEFAULT_MATRIX_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_MATRIX_RESPONSE_BYTES = 1024 * 1024;
const MAX_JOINED_MEMBERS = 256;

type FetchImplementation = typeof globalThis.fetch;

export class MatrixClientError extends Error {
  readonly code: "timeout" | "network" | "response_too_large" | "http_error" | "invalid_response";
  readonly status: number | null;
  readonly matrixErrcode: string | null;

  constructor(
    code: MatrixClientError["code"],
    options: { status?: number; matrixErrcode?: string } = {},
  ) {
    super(`Matrix client request failed (${code})`);
    this.name = "MatrixClientError";
    this.code = code;
    this.status = options.status ?? null;
    this.matrixErrcode = options.matrixErrcode ?? null;
  }
}

export interface MatrixClientOptions {
  readonly homeserverOrigin: string;
  readonly serverName: string;
  readonly asTokenAuthorizer: MatrixAsTokenAuthorizer;
  readonly fetch: FetchImplementation;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface CreateMatrixRoomInput {
  readonly creatorUserId: string;
  readonly canonicalAlias: string;
  readonly name?: string;
  readonly topic?: string;
}

export interface MatrixClient {
  registerApplicationServiceUser(userId: string): Promise<void>;
  setDisplayName(userId: string, displayName: string): Promise<void>;
  resolveRoomAlias(alias: string, actingUserId: string): Promise<string | null>;
  createPrivateRoom(input: CreateMatrixRoomInput): Promise<string>;
  inviteUser(roomId: string, inviterUserId: string, inviteeUserId: string): Promise<void>;
  joinRoom(roomId: string, userId: string): Promise<string>;
  getJoinedMembers(roomId: string, actingUserId: string): Promise<readonly string[]>;
  hasRoomEncryptionState(roomId: string, actingUserId: string): Promise<boolean>;
  setTyping(roomId: string, userId: string, active: boolean, timeoutMs?: number): Promise<void>;
  sendText(roomId: string, senderUserId: string, transactionId: string, body: string): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedPresentation(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > 512 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error(`Invalid Matrix ${label}`);
  }
  return value;
}

function validateTransactionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || !/^[A-Za-z0-9._~-]+$/u.test(value)) {
    throw new Error("Invalid Matrix send transaction ID");
  }
  return value;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    throw new MatrixClientError("response_too_large", { status: response.status });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new MatrixClientError("response_too_large", { status: response.status });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseJson(bytes: Uint8Array, status: number): unknown {
  if (bytes.byteLength === 0) return {};
  try {
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new MatrixClientError("invalid_response", { status });
  }
}

export function createMatrixClient(options: MatrixClientOptions): MatrixClient {
  if (typeof options.fetch !== "function") throw new Error("Matrix client requires injected fetch");
  validateMatrixServerName(options.serverName);
  const origin = new URL(options.homeserverOrigin);
  if (origin.origin !== options.homeserverOrigin || origin.pathname !== "/" || origin.search || origin.hash
    || origin.username || origin.password
    || (origin.protocol !== "https:" && origin.protocol !== "http:")
    || (origin.protocol === "http:" && !isLoopbackHost(origin.hostname))) {
    throw new Error("Matrix homeserver origin must be exact HTTPS or loopback HTTP");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_MATRIX_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_MATRIX_RESPONSE_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_MATRIX_RESPONSE_BYTES) {
    throw new Error("Invalid Matrix client bounds");
  }

  async function request(
    method: "GET" | "POST" | "PUT",
    pathname: string,
    input: { userId?: string; body?: unknown; allowNotFound?: boolean; notFoundErrcode?: string } = {},
  ): Promise<unknown | null> {
    const url = new URL(pathname, origin);
    if (input.userId !== undefined) url.searchParams.set("user_id", validateMatrixUserId(input.userId, options.serverName));
    const headers = new Headers({ accept: "application/json" });
    options.asTokenAuthorizer.authorize(headers);
    let body: string | undefined;
    if (input.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(input.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await options.fetch(url, { method, headers, body, signal: controller.signal, redirect: "error" });
      const bytes = await readBounded(response, maxResponseBytes);
      const parsed = parseJson(bytes, response.status);
      if (!response.ok) {
        const matrixErrcode = isRecord(parsed) && typeof parsed.errcode === "string"
          && /^[A-Z0-9_]{1,64}$/u.test(parsed.errcode) ? parsed.errcode : undefined;
        if (input.allowNotFound && response.status === 404
          && (input.notFoundErrcode === undefined || matrixErrcode === input.notFoundErrcode)) return null;
        throw new MatrixClientError("http_error", { status: response.status, ...(matrixErrcode ? { matrixErrcode } : {}) });
      }
      return parsed;
    } catch (error) {
      if (error instanceof MatrixClientError) throw error;
      if (controller.signal.aborted) throw new MatrixClientError("timeout");
      throw new MatrixClientError("network");
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async registerApplicationServiceUser(userId: string): Promise<void> {
      const parsed = parseMatrixIdentifier(validateMatrixUserId(userId, options.serverName), ["@"]) as { localpart: string };
      await request("POST", "/_matrix/client/v3/register", {
        body: { type: "m.login.application_service", username: parsed.localpart, inhibit_login: true },
      });
    },

    async setDisplayName(userId: string, displayName: string): Promise<void> {
      const mxid = validateMatrixUserId(userId, options.serverName);
      await request("PUT", `/_matrix/client/v3/profile/${encodeURIComponent(mxid)}/displayname`, {
        userId: mxid,
        body: { displayname: boundedPresentation(displayName, "display name") },
      });
    },

    async resolveRoomAlias(alias: string, actingUserId: string): Promise<string | null> {
      const result = await request("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(validateMatrixRoomAlias(alias, options.serverName))}`, {
        userId: actingUserId,
        allowNotFound: true,
      });
      if (result === null) return null;
      if (!isRecord(result)) throw new MatrixClientError("invalid_response");
      try {
        return validateMatrixRoomId(result.room_id);
      } catch {
        throw new MatrixClientError("invalid_response");
      }
    },

    async createPrivateRoom(input: CreateMatrixRoomInput): Promise<string> {
      const creator = validateMatrixUserId(input.creatorUserId, options.serverName);
      const alias = parseMatrixIdentifier(validateMatrixRoomAlias(input.canonicalAlias, options.serverName), ["#"]) as { localpart: string };
      const result = await request("POST", "/_matrix/client/v3/createRoom", {
        userId: creator,
        body: {
          visibility: "private",
          preset: "private_chat",
          room_alias_name: alias.localpart,
          invite: [],
          ...(input.name === undefined ? {} : { name: boundedPresentation(input.name, "room name") }),
          ...(input.topic === undefined ? {} : { topic: boundedPresentation(input.topic, "room topic") }),
        },
      });
      if (!isRecord(result)) throw new MatrixClientError("invalid_response");
      try {
        return validateMatrixRoomId(result.room_id);
      } catch {
        throw new MatrixClientError("invalid_response");
      }
    },

    async inviteUser(roomId: string, inviterUserId: string, inviteeUserId: string): Promise<void> {
      const room = validateMatrixRoomId(roomId);
      await request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`, {
        userId: validateMatrixUserId(inviterUserId, options.serverName),
        body: { user_id: validateMatrixUserId(inviteeUserId, options.serverName) },
      });
    },

    async joinRoom(roomId: string, userId: string): Promise<string> {
      const room = validateMatrixRoomId(roomId);
      const result = await request("POST", `/_matrix/client/v3/join/${encodeURIComponent(room)}`, {
        userId: validateMatrixUserId(userId, options.serverName), body: {},
      });
      if (!isRecord(result)) throw new MatrixClientError("invalid_response");
      try {
        return validateMatrixRoomId(result.room_id);
      } catch {
        throw new MatrixClientError("invalid_response");
      }
    },

    async getJoinedMembers(roomId: string, actingUserId: string): Promise<readonly string[]> {
      const room = validateMatrixRoomId(roomId);
      const result = await request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/joined_members`, {
        userId: actingUserId,
      });
      if (!isRecord(result) || !isRecord(result.joined)) throw new MatrixClientError("invalid_response");
      const ids = Object.keys(result.joined);
      if (ids.length > MAX_JOINED_MEMBERS) throw new MatrixClientError("invalid_response");
      try {
        for (const id of ids) {
          validateMatrixUserId(id);
          if (!isRecord(result.joined[id])) throw new Error();
        }
      } catch {
        throw new MatrixClientError("invalid_response");
      }
      return Object.freeze(ids.sort());
    },

    async hasRoomEncryptionState(roomId: string, actingUserId: string): Promise<boolean> {
      const room = validateMatrixRoomId(roomId);
      const result = await request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.encryption/`, {
        userId: actingUserId,
        allowNotFound: true,
        notFoundErrcode: "M_NOT_FOUND",
      });
      if (result === null) return false;
      if (!isRecord(result)) throw new MatrixClientError("invalid_response");
      return true;
    },

    async setTyping(roomId: string, userId: string, active: boolean, typingTimeoutMs = 30_000): Promise<void> {
      const room = validateMatrixRoomId(roomId);
      const mxid = validateMatrixUserId(userId, options.serverName);
      if (!Number.isInteger(typingTimeoutMs) || typingTimeoutMs < 1_000 || typingTimeoutMs > 30_000) {
        throw new Error("Invalid Matrix typing timeout");
      }
      await request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/typing/${encodeURIComponent(mxid)}`, {
        userId: mxid,
        body: active ? { typing: true, timeout: typingTimeoutMs } : { typing: false },
      });
    },

    async sendText(roomId: string, senderUserId: string, transactionIdValue: string, text: string): Promise<string> {
      const room = validateMatrixRoomId(roomId);
      const sender = validateMatrixUserId(senderUserId, options.serverName);
      const transaction = validateTransactionId(transactionIdValue);
      if (typeof text !== "string" || text.length === 0 || text !== text.normalize("NFC")
        || Buffer.byteLength(text, "utf8") > 64 * 1024
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
        throw new Error("Invalid Matrix text message body");
      }
      const result = await request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(transaction)}`, {
        userId: sender,
        body: { msgtype: "m.text", body: text },
      });
      if (!isRecord(result)) throw new MatrixClientError("invalid_response");
      try {
        return validateMatrixEventId(result.event_id);
      } catch {
        throw new MatrixClientError("invalid_response");
      }
    },
  });
}
