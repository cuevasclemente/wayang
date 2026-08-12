import * as fs from "node:fs";
import * as path from "node:path";
import { compileMessagingEndpointDeclarations } from "../../endpoint-policy.js";
import { isLoopbackHost } from "../../../loopback.js";
import type { MessagingEndpointDeclaration } from "../../contracts.js";
import {
  createMatrixCredentialAuthority,
  type MatrixAsTokenAuthorizer,
  type MatrixHsTokenVerifier,
} from "./auth.js";
import { parseStrictJson } from "./strict-json.js";
import {
  isManagedMatrixUser,
  isMatrixApplicationServiceSender,
  validateMatrixNamespace,
  validateMatrixUserId,
  type MatrixNamespace,
} from "./identifiers.js";

export const MAX_MATRIX_CONFIG_BYTES = 256 * 1024;

export interface MatrixMessagingEnvironment {
  readonly WAYANG_MESSAGING_ENABLED?: string;
  readonly WAYANG_MESSAGING_CONFIG_PATH?: string;
}

export interface MatrixMessagingConfig extends MatrixNamespace {
  readonly enabled: true;
  readonly homeserverOrigin: string;
  readonly applicationServiceId: string;
  readonly wayangBaseUrl: string;
  readonly endpoints: readonly MessagingEndpointDeclaration[];
  readonly hsTokenVerifier: MatrixHsTokenVerifier;
  readonly asTokenAuthorizer: MatrixAsTokenAuthorizer;
}

export type LoadedMatrixMessagingConfig = { readonly enabled: false } | MatrixMessagingConfig;

interface FileStat {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface MatrixConfigFileSystem {
  lstatSync(filePath: string): FileStat;
  realpathSync(filePath: string): string;
  openSync(filePath: string, flags: number): number;
  fstatSync(fd: number): FileStat;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
}

export interface LoadMatrixMessagingConfigOptions {
  readonly fileSystem?: MatrixConfigFileSystem;
  readonly currentUid?: number;
  readonly authorizeDeclarations?: (declarations: readonly MessagingEndpointDeclaration[]) => void;
}

const ROOT_KEYS = ["endpoints", "matrix", "version", "wayangBaseUrl"] as const;
const MATRIX_KEYS = [
  "aliasPrefix", "applicationServiceId", "asToken", "homeserverOrigin", "hsToken", "senderLocalpart", "serverName", "userPrefix",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactOrigin(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\p{Cc}\p{Cf}\p{Cs}\s]/u.test(value)) {
    throw new Error(`Invalid Matrix ${label}`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Matrix ${label}`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || url.origin !== value
    || (url.protocol === "http:" && !isLoopbackHost(url.hostname))) {
    throw new Error(`Invalid Matrix ${label}`);
  }
  return value;
}

function applicationServiceId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error("Invalid Matrix Application Service ID");
  }
  return value;
}

function sameFile(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: FileStat, right: FileStat): boolean {
  return sameFile(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertPrivateRegularFile(stat: FileStat, uid: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600
    || !Number.isSafeInteger(stat.size) || stat.size < 2 || stat.size > MAX_MATRIX_CONFIG_BYTES) {
    throw new Error("Matrix messaging configuration file is unsafe");
  }
}

function readPrivateConfigFile(
  configPath: string,
  fileSystem: MatrixConfigFileSystem,
  currentUid: number,
): Buffer {
  if (!path.isAbsolute(configPath) || path.resolve(configPath) !== configPath || fileSystem.realpathSync(configPath) !== configPath) {
    throw new Error("Matrix messaging configuration path must be absolute and canonical");
  }
  const before = fileSystem.lstatSync(configPath);
  assertPrivateRegularFile(before, currentUid);
  let fd: number | undefined;
  try {
    fd = fileSystem.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fileSystem.fstatSync(fd);
    assertPrivateRegularFile(opened, currentUid);
    if (!sameFileVersion(before, opened)) throw new Error("Matrix messaging configuration file changed during open");
    const output = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < output.length) {
      const count = fileSystem.readSync(fd, output, offset, output.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const afterFd = fileSystem.fstatSync(fd);
    const afterPath = fileSystem.lstatSync(configPath);
    assertPrivateRegularFile(afterFd, currentUid);
    assertPrivateRegularFile(afterPath, currentUid);
    if (!sameFileVersion(opened, afterFd) || !sameFileVersion(opened, afterPath) || offset !== opened.size) {
      throw new Error("Matrix messaging configuration file changed during read");
    }
    return output.subarray(0, offset);
  } finally {
    if (fd !== undefined) fileSystem.closeSync(fd);
  }
}

function parseEnabledConfig(bytes: Buffer, authorize?: LoadMatrixMessagingConfigOptions["authorizeDeclarations"]): MatrixMessagingConfig {
  let raw: unknown;
  try {
    raw = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Matrix messaging configuration is not valid strict UTF-8 JSON");
  }
  if (!isRecord(raw) || !exactKeys(raw, ROOT_KEYS) || raw.version !== 1 || !isRecord(raw.matrix)
    || !exactKeys(raw.matrix, MATRIX_KEYS)) {
    throw new Error("Matrix messaging configuration has unknown or missing fields");
  }
  const namespace = validateMatrixNamespace({
    serverName: raw.matrix.serverName as string,
    senderLocalpart: raw.matrix.senderLocalpart as string,
    userPrefix: raw.matrix.userPrefix as string,
    aliasPrefix: raw.matrix.aliasPrefix as string,
  });
  const endpoints = compileMessagingEndpointDeclarations(raw.endpoints);
  const pairs = new Set<string>();
  for (const endpoint of endpoints) {
    if (endpoint.connectorId !== "matrix") throw new Error("Matrix configuration contains a non-Matrix endpoint");
    const pair = `${endpoint.projectId}\0${endpoint.agentProfileId}`;
    if (pairs.has(pair)) throw new Error("Matrix configuration contains a duplicate Project/Profile endpoint pair");
    pairs.add(pair);
    for (const subjectId of endpoint.allowedSubjectIds) {
      validateMatrixUserId(subjectId, namespace.serverName);
      if (isManagedMatrixUser(subjectId, namespace) || isMatrixApplicationServiceSender(subjectId, namespace)) {
        throw new Error("Matrix endpoint subject cannot be an Application Service user");
      }
    }
  }
  authorize?.(endpoints);
  const credentials = createMatrixCredentialAuthority(raw.matrix.hsToken, raw.matrix.asToken);
  return Object.freeze({
    enabled: true,
    homeserverOrigin: exactOrigin(raw.matrix.homeserverOrigin, "homeserver origin"),
    applicationServiceId: applicationServiceId(raw.matrix.applicationServiceId),
    ...namespace,
    wayangBaseUrl: exactOrigin(raw.wayangBaseUrl, "Wayang base URL"),
    endpoints,
    ...credentials,
  });
}

/** Disabled means inert: the path is neither validated nor opened. */
export function loadMatrixMessagingConfig(
  environment: MatrixMessagingEnvironment,
  options: LoadMatrixMessagingConfigOptions = {},
): LoadedMatrixMessagingConfig {
  const enabled = environment.WAYANG_MESSAGING_ENABLED;
  if (enabled === undefined || enabled === "0") return Object.freeze({ enabled: false });
  if (enabled !== "1") throw new Error("WAYANG_MESSAGING_ENABLED must be 0 or 1");
  const configPath = environment.WAYANG_MESSAGING_CONFIG_PATH;
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new Error("WAYANG_MESSAGING_CONFIG_PATH is required when messaging is enabled");
  }
  const currentUid = options.currentUid ?? process.getuid?.();
  if (!Number.isSafeInteger(currentUid) || (currentUid as number) < 0) {
    throw new Error("Current uid is unavailable for Matrix configuration ownership checks");
  }
  const bytes = readPrivateConfigFile(configPath, options.fileSystem ?? fs, currentUid as number);
  return parseEnabledConfig(bytes, options.authorizeDeclarations);
}
