import { createHash } from "node:crypto";

const GENERATED_LOCALPART = /^[a-z0-9._=-]+$/u;
// Matrix v1.19 historical user localpart grammar. Generated AS identities stay
// on the narrower grammar above, while external allowlisted humans may use +/.
const MATRIX_USER_LOCALPART = /^[a-z0-9._=+\/-]+$/u;
const SERVER_NAME = /^(?:[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?|\[[0-9a-f:.]+\])(?::(?:[1-9][0-9]{0,4}))?$/u;
const DERIVED_SUFFIX = /^[a-f0-9]{64}$/u;
const MAX_MATRIX_ID_BYTES = 512;

export interface MatrixNamespace {
  readonly serverName: string;
  readonly senderLocalpart: string;
  readonly userPrefix: string;
  readonly aliasPrefix: string;
}

export interface ParsedMatrixIdentifier {
  readonly sigil: "@" | "#" | "!" | "$";
  readonly localpart: string;
  readonly serverName: string;
}

function safeIdentifier(value: string): boolean {
  return value.length > 0 && value === value.normalize("NFC")
    && Buffer.byteLength(value, "utf8") <= MAX_MATRIX_ID_BYTES
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}

export function validateMatrixServerName(value: unknown): string {
  if (typeof value !== "string" || value.length > 255 || !SERVER_NAME.test(value)) {
    throw new Error("Invalid Matrix server name");
  }
  const port = value.match(/:([0-9]+)$/u)?.[1];
  if (port && Number(port) > 65_535) throw new Error("Invalid Matrix server name");
  return value;
}

export function validateMatrixLocalpart(value: unknown, label = "localpart"): string {
  if (typeof value !== "string" || value.length > 128 || !GENERATED_LOCALPART.test(value)) {
    throw new Error(`Invalid Matrix ${label}`);
  }
  return value;
}

export function validateMatrixNamespace(value: MatrixNamespace): Readonly<MatrixNamespace> {
  const namespace = Object.freeze({
    serverName: validateMatrixServerName(value.serverName),
    senderLocalpart: validateMatrixLocalpart(value.senderLocalpart, "sender localpart"),
    userPrefix: validateMatrixLocalpart(value.userPrefix, "managed user prefix"),
    aliasPrefix: validateMatrixLocalpart(value.aliasPrefix, "managed alias prefix"),
  });
  if (namespace.senderLocalpart.startsWith(namespace.userPrefix)) {
    throw new Error("Matrix Application Service sender must be outside the managed user namespace");
  }
  if (Buffer.byteLength(`${namespace.userPrefix}${"f".repeat(64)}`, "utf8") > 255
    || Buffer.byteLength(`${namespace.aliasPrefix}${"f".repeat(64)}`, "utf8") > 255) {
    throw new Error("Matrix managed namespace prefix is too long");
  }
  return namespace;
}

export function parseMatrixIdentifier(value: unknown, sigils: readonly ParsedMatrixIdentifier["sigil"][]): ParsedMatrixIdentifier {
  if (typeof value !== "string" || !safeIdentifier(value) || !sigils.includes(value[0] as ParsedMatrixIdentifier["sigil"])) {
    throw new Error("Invalid Matrix identifier");
  }
  const separator = value.indexOf(":");
  if (separator <= 1 || separator === value.length - 1) throw new Error("Invalid Matrix identifier");
  const localpart = value.slice(1, separator);
  const serverName = value.slice(separator + 1);
  validateMatrixServerName(serverName);
  if (value[0] === "@" && !MATRIX_USER_LOCALPART.test(localpart)) {
    throw new Error("Invalid Matrix identifier localpart");
  }
  if (value[0] === "#" && !GENERATED_LOCALPART.test(localpart)) {
    throw new Error("Invalid Matrix identifier localpart");
  }
  return Object.freeze({ sigil: value[0] as ParsedMatrixIdentifier["sigil"], localpart, serverName });
}

export function validateMatrixUserId(value: unknown, expectedServerName?: string): string {
  const parsed = parseMatrixIdentifier(value, ["@"]) as ParsedMatrixIdentifier;
  if (expectedServerName !== undefined && parsed.serverName !== expectedServerName) {
    throw new Error("Matrix user ID is on the wrong server");
  }
  return value as string;
}

export function validateMatrixRoomAlias(value: unknown, expectedServerName?: string): string {
  const parsed = parseMatrixIdentifier(value, ["#"]) as ParsedMatrixIdentifier;
  if (expectedServerName !== undefined && parsed.serverName !== expectedServerName) {
    throw new Error("Matrix room alias is on the wrong server");
  }
  return value as string;
}

export function validateMatrixRoomId(value: unknown): string {
  parseMatrixIdentifier(value, ["!"]);
  return value as string;
}

export function validateMatrixEventId(value: unknown): string {
  if (typeof value !== "string" || !safeIdentifier(value) || value[0] !== "$" || value.length < 2) {
    throw new Error("Invalid Matrix event ID");
  }
  return value;
}

function derivedSuffix(immutableKey: string): string {
  if (typeof immutableKey !== "string" || immutableKey.length === 0 || immutableKey !== immutableKey.normalize("NFC")
    || Buffer.byteLength(immutableKey, "utf8") > 512 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(immutableKey)) {
    throw new Error("Invalid immutable Matrix provisioning identity");
  }
  return createHash("sha256").update(immutableKey, "utf8").digest("hex");
}

export function deriveMatrixPersonaUserId(agentProfileId: string, namespace: MatrixNamespace): string {
  const checked = validateMatrixNamespace(namespace);
  return `@${checked.userPrefix}${derivedSuffix(agentProfileId)}:${checked.serverName}`;
}

export function deriveMatrixCanonicalAlias(provisioningKey: string, namespace: MatrixNamespace): string {
  const checked = validateMatrixNamespace(namespace);
  return `#${checked.aliasPrefix}${derivedSuffix(provisioningKey)}:${checked.serverName}`;
}

export function isMatrixApplicationServiceSender(userId: unknown, namespace: MatrixNamespace): boolean {
  const checked = validateMatrixNamespace(namespace);
  return userId === `@${checked.senderLocalpart}:${checked.serverName}`;
}

/** Exact server plus exclusive localpart prefix; display names and aliases never participate. */
export function isManagedMatrixUser(userId: unknown, namespace: MatrixNamespace): boolean {
  try {
    const checked = validateMatrixNamespace(namespace);
    const parsed = parseMatrixIdentifier(userId, ["@"]) as ParsedMatrixIdentifier;
    return parsed.serverName === checked.serverName && parsed.localpart.startsWith(checked.userPrefix);
  } catch {
    return false;
  }
}

export function isManagedMatrixAlias(alias: unknown, namespace: MatrixNamespace): boolean {
  try {
    const checked = validateMatrixNamespace(namespace);
    const parsed = parseMatrixIdentifier(alias, ["#"]) as ParsedMatrixIdentifier;
    return parsed.serverName === checked.serverName && parsed.localpart.startsWith(checked.aliasPrefix);
  } catch {
    return false;
  }
}

export function assertDerivedMatrixPersonaUserId(userId: unknown, agentProfileId: string, namespace: MatrixNamespace): string {
  if (userId !== deriveMatrixPersonaUserId(agentProfileId, namespace)) throw new Error("Matrix persona user ID does not match immutable profile identity");
  return userId as string;
}

export function assertDerivedMatrixCanonicalAlias(alias: unknown, provisioningKey: string, namespace: MatrixNamespace): string {
  if (alias !== deriveMatrixCanonicalAlias(provisioningKey, namespace)) throw new Error("Matrix alias does not match immutable provisioning identity");
  return alias as string;
}

export function isDerivedManagedLocalpart(localpart: string, prefix: string): boolean {
  return localpart.startsWith(prefix) && DERIVED_SUFFIX.test(localpart.slice(prefix.length));
}
