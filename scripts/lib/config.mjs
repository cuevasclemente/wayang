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

function normalizeHttpOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) origin`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, a path, query, or fragment`);
  }
  return parsed.origin;
}

export function normalizePublicOrigin(value) {
  return normalizeHttpOrigin(value, "Public browser origin");
}

function hasExactOriginSyntax(value) {
  // This raw check is needed because WHATWG parsing erases empty components, controls, and dot segments.
  const match = value.match(/^https?:\/\/([^/?#@\\\u0000-\u0020\u007f]+)\/?$/i);
  return Boolean(match && !match[1].endsWith(":"));
}

export function normalizeCompanionUrl(value) {
  const origin = normalizeHttpOrigin(value, "Companion tool backend URL");
  if (!hasExactOriginSyntax(value)) {
    throw new Error("Companion tool backend URL must not contain credentials, a path, query, fragment, control characters, or backslashes");
  }
  return origin;
}

export function recommendCompanionUrl({ publicOrigin, host, port }) {
  if (publicOrigin) return publicOrigin;

  const normalizedHost = typeof host === "string" ? host.trim().toLowerCase() : "";
  if (normalizedHost === "::1" || normalizedHost === "[::1]") return `http://[::1]:${port}`;
  if (normalizedHost === "localhost") return `http://localhost:${port}`;

  const octets = normalizedHost.split(".");
  const isIpv4Loopback = octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
  return `http://${isIpv4Loopback ? normalizedHost : "127.0.0.1"}:${port}`;
}

export async function promptForCompanionUrl({ publicOrigin, host, port, existingValue, ask, notice }) {
  const recommendation = normalizeCompanionUrl(recommendCompanionUrl({ publicOrigin, host, port }));
  let safeFallback = recommendation;

  if (existingValue) {
    try {
      safeFallback = normalizeCompanionUrl(existingValue);
      if (safeFallback !== recommendation) {
        notice(`The recommended companion pi-tool backend URL for this configuration is ${recommendation}.`);
      }
    } catch {
      notice("Existing WAYANG_URL is invalid and must be replaced; its value was not displayed.");
    }
  }

  const answer = await ask("Companion pi-tool backend URL", safeFallback);
  return normalizeCompanionUrl(answer);
}

export function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
