import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_SESSIONS = 100;

interface StoredSession {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  authFingerprint: string;
}

interface StoreFile {
  version: 1;
  sessions: StoredSession[];
}

export interface CreatedSession {
  token: string;
  expiresAt: number;
}

export interface SessionStoreOptions {
  filePath: string;
  sessionSecret: string;
  passwordHash: string;
  sessionLifetimeMs: number;
  now?: () => number;
}

export class SessionStore {
  readonly filePath: string;
  private readonly sessionSecret: string;
  private readonly fingerprint: string;
  private readonly sessionLifetimeMs: number;
  private readonly now: () => number;

  constructor(options: SessionStoreOptions) {
    this.filePath = options.filePath;
    this.sessionSecret = options.sessionSecret;
    this.sessionLifetimeMs = options.sessionLifetimeMs;
    this.now = options.now ?? Date.now;
    this.fingerprint = createHash("sha256")
      .update(options.passwordHash)
      .update("\0")
      .update(options.sessionSecret)
      .digest("base64url");
  }

  create(): CreatedSession {
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.sessionLifetimeMs;
    const sessions = this.readValidSessions(now);
    sessions.push({
      tokenHash: this.hashToken(token),
      createdAt: now,
      expiresAt,
      authFingerprint: this.fingerprint,
    });
    this.write(sessions.slice(-MAX_SESSIONS));
    return { token, expiresAt };
  }

  verify(token: string | undefined): boolean {
    if (!token || token.length > 256) return false;
    const now = this.now();
    const sessions = this.readValidSessions(now);
    const tokenHash = Buffer.from(this.hashToken(token));
    const valid = sessions.some((session) => {
      const stored = Buffer.from(session.tokenHash);
      return stored.length === tokenHash.length && timingSafeEqual(stored, tokenHash);
    });
    this.persistCleanupIfNeeded(sessions);
    return valid;
  }

  revoke(token: string | undefined): void {
    if (!token || token.length > 256) return;
    const now = this.now();
    const tokenHash = this.hashToken(token);
    const sessions = this.readValidSessions(now).filter((session) => session.tokenHash !== tokenHash);
    this.write(sessions);
  }

  private hashToken(token: string): string {
    return createHmac("sha256", this.sessionSecret).update(token).digest("base64url");
  }

  private readStore(): StoreFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoreFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return { version: 1, sessions: [] };
      return {
        version: 1,
        sessions: parsed.sessions.filter((session): session is StoredSession => Boolean(
          session && typeof session.tokenHash === "string" &&
          Number.isFinite(session.createdAt) && Number.isFinite(session.expiresAt) &&
          typeof session.authFingerprint === "string",
        )),
      };
    } catch {
      return { version: 1, sessions: [] };
    }
  }

  private readValidSessions(now: number): StoredSession[] {
    return this.readStore().sessions.filter((session) =>
      session.expiresAt > now && session.authFingerprint === this.fingerprint,
    );
  }

  private persistCleanupIfNeeded(validSessions: StoredSession[]): void {
    const existing = this.readStore().sessions;
    if (existing.length !== validSessions.length) {
      try { this.write(validSessions); } catch {}
    }
  }

  private write(sessions: StoredSession[]): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== "win32") fs.chmodSync(this.filePath, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}
