import { timingSafeEqual } from "node:crypto";

const MAX_TOKEN_BYTES = 4096;
const BEARER = /^Bearer ([^\s,]+)$/u;
const QUERY_CREDENTIALS = new Set(["access_token", "as_token", "hs_token"]);

export interface MatrixHsTokenVerifier {
  verify(candidate: string): boolean;
}

export interface MatrixAsTokenAuthorizer {
  authorize(headers: Headers): void;
}

export interface MatrixInboundAuthRequest {
  readonly authorization?: string | readonly string[];
  readonly url: string;
}

export type MatrixInboundAuthDecision =
  | { readonly authorized: true }
  | { readonly authorized: false; readonly code: "missing" | "multiple" | "malformed" | "query_credentials" | "mismatch" };

function validateOpaqueMatrixToken(value: unknown, label: "hs_token" | "as_token"): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 16
    || Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES || /[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new Error(`Invalid Matrix ${label}`);
  }
  return value;
}

export function createMatrixCredentialAuthority(hsTokenValue: unknown, asTokenValue: unknown): {
  readonly hsTokenVerifier: MatrixHsTokenVerifier;
  readonly asTokenAuthorizer: MatrixAsTokenAuthorizer;
} {
  const hsToken = Buffer.from(validateOpaqueMatrixToken(hsTokenValue, "hs_token"), "utf8");
  const asToken = validateOpaqueMatrixToken(asTokenValue, "as_token");
  const hsTokenVerifier = Object.freeze({
    verify(candidate: string): boolean {
      const supplied = Buffer.from(candidate, "utf8");
      const sameLength = supplied.length === hsToken.length;
      const padded = Buffer.alloc(hsToken.length);
      supplied.copy(padded, 0, 0, hsToken.length);
      return timingSafeEqual(hsToken, padded) && sameLength;
    },
  });
  const asTokenAuthorizer = Object.freeze({
    authorize(headers: Headers): void {
      if (headers.has("authorization")) throw new Error("Matrix authorization header was already set");
      headers.set("authorization", `Bearer ${asToken}`);
    },
  });
  return Object.freeze({ hsTokenVerifier, asTokenAuthorizer });
}

function hasQueryCredentials(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl, "https://matrix.invalid");
    for (const name of QUERY_CREDENTIALS) if (parsed.searchParams.has(name)) return true;
    return false;
  } catch {
    return true;
  }
}

/** Matrix AS authentication only. Cookies, Origin, and browser sessions are intentionally irrelevant. */
export function verifyMatrixInboundAuthorization(
  request: MatrixInboundAuthRequest,
  verifier: MatrixHsTokenVerifier,
): MatrixInboundAuthDecision {
  if (hasQueryCredentials(request.url)) return { authorized: false, code: "query_credentials" };
  if (Array.isArray(request.authorization)) {
    if (request.authorization.length !== 1) return { authorized: false, code: "multiple" };
    request = { ...request, authorization: request.authorization[0] };
  }
  const authorization = request.authorization;
  if (authorization === undefined) return { authorized: false, code: "missing" };
  if (typeof authorization !== "string" || authorization.includes(",")) return { authorized: false, code: "multiple" };
  const match = BEARER.exec(authorization);
  if (!match || Buffer.byteLength(match[1]!, "utf8") > MAX_TOKEN_BYTES) return { authorized: false, code: "malformed" };
  return verifier.verify(match[1]!) ? { authorized: true } : { authorized: false, code: "mismatch" };
}
