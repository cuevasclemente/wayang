import { randomBytes, scrypt as nodeScrypt } from "node:crypto";
import { closeSync, chmodSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a dotenv file without evaluating shell syntax. */
export function parseEnv(text, source = ".env") {
  const values = new Map();
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) throw new Error(`${source}:${index + 1}: expected KEY=VALUE`);
    const [, key, encoded] = match;
    if (values.has(key)) throw new Error(`${source}:${index + 1}: duplicate key ${key}`);
    values.set(key, decodeValue(encoded, source, index + 1));
  }

  return { lines, values };
}

function decodeValue(encoded, source, lineNumber) {
  if (encoded.startsWith('"')) {
    try {
      const value = JSON.parse(encoded);
      if (typeof value !== "string") throw new Error("not a string");
      return value;
    } catch {
      throw new Error(`${source}:${lineNumber}: invalid double-quoted value`);
    }
  }
  if (encoded.startsWith("'")) {
    if (encoded.length < 2 || !encoded.endsWith("'")) {
      throw new Error(`${source}:${lineNumber}: invalid single-quoted value`);
    }
    return encoded.slice(1, -1);
  }
  return encoded;
}

export function encodeEnvValue(value) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Environment values must be strings without NUL bytes");
  return JSON.stringify(value);
}

/** Update selected keys while preserving comments, blank lines, and unknown keys. */
export function updateEnv(text, updates) {
  const parsed = parseEnv(text);
  const remaining = new Map(Object.entries(updates));
  for (const key of remaining.keys()) {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid environment key: ${key}`);
  }

  const output = parsed.lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !remaining.has(match[1])) return line;
    const key = match[1];
    const value = remaining.get(key);
    remaining.delete(key);
    return value === undefined ? null : `${key}=${encodeEnvValue(value)}`;
  }).filter((line) => line !== null);

  while (output.length > 0 && output.at(-1) === "") output.pop();
  if (output.length > 0 && remaining.size > 0) output.push("");
  for (const [key, value] of remaining) {
    if (value !== undefined) output.push(`${key}=${encodeEnvValue(value)}`);
  }
  return `${output.join("\n")}\n`;
}

/** Write a private config file through a same-directory temporary and atomic rename. */
export function writePrivateAtomic(filePath, contents) {
  const destination = resolve(filePath);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
}

/** Create the exact versioned scrypt record consumed by Wayang's backend. */
export async function createPasswordHash(password) {
  if (typeof password !== "string" || password.length === 0 || Buffer.byteLength(password, "utf8") > 1024) {
    throw new Error("Password must be between 1 and 1024 UTF-8 bytes");
  }
  const n = 16_384;
  const r = 8;
  const p = 1;
  const keyLength = 32;
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, keyLength, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", "1", n, r, p, keyLength, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export function normalizePublicOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Public browser origin must be an absolute http(s) origin");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Public browser origin must not contain credentials, a path, query, or fragment");
  }
  return parsed.origin;
}

export function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
