import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Request, RequestHandler } from "express";
import type { AuthConfig } from "../config.js";
import { verifyPassword } from "./password.js";
import { SessionStore } from "./session-store.js";

export const SESSION_COOKIE_NAME = "wayang_session";
const UNAUTHORIZED_BODY = JSON.stringify({ error: "Authentication required" });

interface RateBucket {
  attempts: number;
  resetAt: number;
}

export interface AuthServiceOptions {
  now?: () => number;
  failureDelayMs?: number;
  rateLimitAttempts?: number;
  rateLimitWindowMs?: number;
  maxRateLimitSources?: number;
}

export type LoginResult =
  | { status: "success"; token: string; expiresAt: number }
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfterSeconds: number };

function firstHeader(value: string | string[] | undefined): string | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  return item?.split(",", 1)[0]?.trim();
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function unsafeMethod(method: string | undefined): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes((method || "GET").toUpperCase());
}

export class AuthService {
  readonly config: AuthConfig;
  private readonly store: SessionStore | null;
  private readonly now: () => number;
  private readonly failureDelayMs: number;
  private readonly rateLimitAttempts: number;
  private readonly rateLimitWindowMs: number;
  private readonly maxRateLimitSources: number;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly rateBuckets = new Map<string, RateBucket>();

  constructor(config: AuthConfig, options: AuthServiceOptions = {}) {
    this.config = config;
    this.now = options.now ?? Date.now;
    this.failureDelayMs = options.failureDelayMs ?? 250;
    this.rateLimitAttempts = options.rateLimitAttempts ?? 5;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 15 * 60 * 1000;
    this.maxRateLimitSources = options.maxRateLimitSources ?? 1_000;
    this.allowedOrigins = new Set(config.allowedOrigins);
    this.store = config.enabled ? new SessionStore({
      filePath: config.sessionStorePath,
      sessionSecret: config.sessionSecret,
      passwordHash: config.passwordHash,
      sessionLifetimeMs: config.sessionDays * 24 * 60 * 60 * 1000,
      now: this.now,
    }) : null;
  }

  isAuthenticated(request: IncomingMessage): boolean {
    if (!this.config.enabled) return true;
    return this.store?.verify(this.sessionToken(request)) === true;
  }

  status(request: IncomingMessage): { enabled: boolean; authenticated: boolean } {
    return { enabled: this.config.enabled, authenticated: this.isAuthenticated(request) };
  }

  async login(password: unknown, request: IncomingMessage): Promise<LoginResult> {
    if (!this.config.enabled) {
      return { status: "success", token: "", expiresAt: this.now() };
    }

    const source = this.sourceAddress(request);
    const now = this.now();
    const bucket = this.getRateBucket(source, now);
    if (bucket.attempts >= this.rateLimitAttempts) {
      return {
        status: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
      };
    }
    bucket.attempts += 1;

    const valid = await verifyPassword(password, this.config.passwordHash);
    if (!valid) {
      await new Promise((resolve) => setTimeout(resolve, this.failureDelayMs));
      return { status: "invalid" };
    }

    this.rateBuckets.delete(source);
    return { status: "success", ...this.store!.create() };
  }

  logout(request: IncomingMessage): void {
    if (!this.config.enabled) return;
    this.store?.revoke(this.sessionToken(request));
  }

  sessionCookie(request: IncomingMessage, token: string, expiresAt: number): string {
    const maxAge = Math.max(0, Math.ceil((expiresAt - this.now()) / 1_000));
    return [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`,
      ...(this.cookieIsSecure(request) ? ["Secure"] : []),
    ].join("; ");
  }

  clearSessionCookie(request: IncomingMessage): string {
    return [
      `${SESSION_COOKIE_NAME}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      ...(this.cookieIsSecure(request) ? ["Secure"] : []),
    ].join("; ");
  }

  requireAuthentication: RequestHandler = (req, res, next) => {
    if (this.isAuthenticated(req)) {
      next();
      return;
    }
    res.status(401).json({ error: "Authentication required" });
  };

  requireValidOrigin: RequestHandler = (req, res, next) => {
    // Loopback binding is not an origin boundary: a hostile webpage can use
    // DNS rebinding to make its own hostname resolve to localhost. Validate the
    // effective request authority on every privileged request, then apply the
    // browser Origin check to unsafe methods.
    if (this.authorityIsAllowed(req) && (!unsafeMethod(req.method) || this.originIsValid(req))) {
      next();
      return;
    }
    res.status(403).json({ error: "Origin not allowed" });
  };

  authorizeWebSocket(request: IncomingMessage): { allowed: true } | { allowed: false; status: 401 | 403; message: string } {
    if (this.config.enabled && !this.isAuthenticated(request)) {
      return { allowed: false, status: 401, message: "Authentication required" };
    }
    if (!this.authorityIsAllowed(request) || !this.originIsValid(request)) {
      return { allowed: false, status: 403, message: "Origin not allowed" };
    }
    return { allowed: true };
  }

  rejectWebSocket(socket: Duplex, decision: { allowed: false; status: 401 | 403; message: string }): void {
    const body = decision.status === 401 ? UNAUTHORIZED_BODY : JSON.stringify({ error: decision.message });
    const reason = decision.status === 401 ? "Unauthorized" : "Forbidden";
    socket.end(
      `HTTP/1.1 ${decision.status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Cache-Control: no-store\r\n\r\n" + body,
    );
  }

  authorityIsAllowed(request: IncomingMessage): boolean {
    return this.allowedOrigins.has(this.requestOrigin(request));
  }

  originIsValid(request: IncomingMessage): boolean {
    const origin = firstHeader(request.headers.origin);
    if (!origin) return true;
    if (origin === "null") return false;
    try {
      return this.allowedOrigins.has(new URL(origin).origin);
    } catch {
      return false;
    }
  }

  sourceAddress(request: IncomingMessage): string {
    if (this.isTrustedProxy(request)) {
      return firstHeader(request.headers["x-forwarded-for"]) || request.socket.remoteAddress || "unknown";
    }
    return request.socket.remoteAddress || "unknown";
  }

  private requestOrigin(request: IncomingMessage): string {
    const trusted = this.isTrustedProxy(request);
    const forwardedProtocol = trusted ? firstHeader(request.headers["x-forwarded-proto"]) : undefined;
    const encrypted = Boolean((request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted);
    const protocol = forwardedProtocol === "https" || forwardedProtocol === "http"
      ? forwardedProtocol
      : encrypted ? "https" : "http";
    // Authorization always uses the actual Host authority. Browsers can send
    // X-Forwarded-Host, so trusting it would let DNS-rebinding pages spoof an
    // allowed public origin even on a loopback peer. Reverse proxies must
    // preserve/set Host to the configured browser-facing authority.
    const host = firstHeader(request.headers.host) || "localhost";
    try {
      return new URL(`${protocol}://${host}`).origin;
    } catch {
      return "invalid://request-origin";
    }
  }

  private cookieIsSecure(request: IncomingMessage): boolean {
    if (this.config.cookieSecure === "always") return true;
    if (this.config.cookieSecure === "never") return false;
    return this.requestOrigin(request).startsWith("https://");
  }

  private isTrustedProxy(request: IncomingMessage): boolean {
    return this.config.trustProxy === "loopback" && isLoopbackAddress(request.socket.remoteAddress);
  }

  private sessionToken(request: IncomingMessage): string | undefined {
    return cookieValue(firstHeader(request.headers.cookie), SESSION_COOKIE_NAME);
  }

  private getRateBucket(source: string, now: number): RateBucket {
    for (const [key, value] of this.rateBuckets) {
      if (value.resetAt <= now) this.rateBuckets.delete(key);
    }
    const existing = this.rateBuckets.get(source);
    if (existing) return existing;
    while (this.rateBuckets.size >= this.maxRateLimitSources) {
      const oldest = this.rateBuckets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.rateBuckets.delete(oldest);
    }
    const created = { attempts: 0, resetAt: now + this.rateLimitWindowMs };
    this.rateBuckets.set(source, created);
    return created;
  }
}
