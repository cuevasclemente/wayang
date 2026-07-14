import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}
const RECORD_PREFIX = "scrypt";
const RECORD_VERSION = "1";
const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const DEFAULT_KEY_LENGTH = 32;
const MAX_PASSWORD_BYTES = 1_024;
const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;

interface ParsedRecord {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function encodedBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function parseRecord(record: string): ParsedRecord | null {
  const parts = record.split("$");
  if (parts.length !== 8 || parts[0] !== RECORD_PREFIX || parts[1] !== RECORD_VERSION) return null;

  const n = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  const keyLength = Number(parts[5]);
  if (
    !Number.isSafeInteger(n) || n < 2 || n > DEFAULT_N || (n & (n - 1)) !== 0 ||
    !Number.isSafeInteger(r) || r < 1 || r > DEFAULT_R ||
    !Number.isSafeInteger(p) || p < 1 || p > DEFAULT_P ||
    keyLength !== DEFAULT_KEY_LENGTH ||
    !encodedBase64Url(parts[6]) || !encodedBase64Url(parts[7])
  ) return null;

  try {
    const salt = Buffer.from(parts[6], "base64url");
    const hash = Buffer.from(parts[7], "base64url");
    if (salt.length !== 16 || hash.length !== keyLength) return null;
    return { n, r, p, salt, hash };
  } catch {
    return null;
  }
}

function validPassword(password: unknown): password is string {
  return typeof password === "string" && Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}

export async function createPasswordHash(password: string): Promise<string> {
  if (!validPassword(password) || password.length === 0) {
    throw new Error(`Password must be between 1 and ${MAX_PASSWORD_BYTES} UTF-8 bytes`);
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, DEFAULT_KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAX_SCRYPT_MEMORY,
  });
  return [
    RECORD_PREFIX,
    RECORD_VERSION,
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    DEFAULT_KEY_LENGTH,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/** Verify a password without throwing or revealing malformed-record details. */
export async function verifyPassword(password: unknown, record: string): Promise<boolean> {
  if (!validPassword(password)) return false;
  const parsed = parseRecord(record);
  if (!parsed) return false;

  try {
    const candidate = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_SCRYPT_MEMORY,
    });
    return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

export function isPasswordHashRecord(record: string): boolean {
  return parseRecord(record) !== null;
}
