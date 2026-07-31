import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserCredentialsConfig } from "../config.js";
import type { BrowserCredentialContext } from "./manager.js";
import { exactProtectedBrowserBindingEqual } from "./protected-browser.js";
import type { ProtectedBrowserBinding } from "./types.js";

const MAX_UNLOCK_KEY_BYTES = 4096;
const MAX_LABEL_LENGTH = 160;

interface BitwardenItem {
  id?: unknown;
  name?: unknown;
  login?: {
    username?: unknown;
    password?: unknown;
    totp?: unknown;
    uris?: Array<{ uri?: unknown; match?: unknown }>;
  };
}

export interface CredentialChoice {
  choiceToken: string;
  label: string;
  maskedIdentifier: string;
  hasTotp: boolean;
  warning?: string;
}

interface PendingChoice {
  itemId: string;
  runtimeKey: string;
  targetId: string;
  documentIdentity: string;
  origin: string;
  capabilityBinding?: ProtectedBrowserBinding;
  operation: "login" | "totp" | "login-or-totp";
  expiresAt: number;
}

export interface CredentialStatus {
  available: boolean;
  unlocked: boolean;
  unlockExpiresAt?: number;
}

export interface BitwardenAdapter {
  readonly available: boolean;
  listItems(url: string, sessionKey: string): Promise<BitwardenItem[]>;
  getItem(itemId: string, sessionKey: string): Promise<BitwardenItem>;
  getTotp(itemId: string, sessionKey: string): Promise<string>;
  lock(): Promise<void>;
}

function executableOnPath(name: string): string | null {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // continue
    }
  }
  return null;
}

function resolveBwExecutable(configured: string): string | null {
  const candidate = configured || executableOnPath("bw");
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    const resolved = fs.realpathSync(candidate);
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

export class BwCliAdapter implements BitwardenAdapter {
  private readonly executable: string | null;

  constructor(private readonly config: BrowserCredentialsConfig) {
    this.executable = resolveBwExecutable(config.bwPath);
  }

  get available(): boolean {
    return this.executable !== null;
  }

  async listItems(url: string, sessionKey: string): Promise<BitwardenItem[]> {
    const output = await this.run(["list", "items", "--url", url], sessionKey);
    try {
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) throw new Error();
      return parsed as BitwardenItem[];
    } catch {
      throw new Error("Bitwarden returned an invalid item list");
    }
  }

  async getItem(itemId: string, sessionKey: string): Promise<BitwardenItem> {
    if (!isValidBitwardenItemId(itemId)) throw new Error("Invalid Bitwarden item identifier");
    const output = await this.run(["get", "item", itemId], sessionKey);
    try {
      const parsed = JSON.parse(output);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as BitwardenItem;
    } catch {
      throw new Error("Bitwarden returned an invalid item");
    }
  }

  async getTotp(itemId: string, sessionKey: string): Promise<string> {
    if (!isValidBitwardenItemId(itemId)) throw new Error("Invalid Bitwarden item identifier");
    const output = (await this.run(["get", "totp", itemId], sessionKey)).trim();
    if (!output || output.length > 128 || /[\r\n\0]/.test(output)) throw new Error("Bitwarden returned an invalid verification code");
    return output;
  }

  async lock(): Promise<void> {
    if (!this.executable) return;
    await this.run(["lock"]);
  }

  private run(argv: string[], sessionKey?: string): Promise<string> {
    if (!this.executable) return Promise.reject(new Error("Bitwarden CLI is unavailable"));
    return new Promise((resolve, reject) => {
      const env = buildBwChildEnvironment(process.env, sessionKey);
      const child = spawn(this.executable!, argv, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: os.tmpdir(),
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let exceeded = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.config.cliTimeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.config.maxCliOutputBytes) {
          exceeded = true;
          child.kill("SIGKILL");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this.config.maxCliOutputBytes) {
          exceeded = true;
          child.kill("SIGKILL");
        }
      });
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("Bitwarden CLI could not be started"));
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) reject(new Error("Bitwarden CLI command timed out"));
        else if (exceeded) reject(new Error("Bitwarden CLI output exceeded the safety limit"));
        else if (code !== 0) reject(new Error("Bitwarden CLI command failed"));
        else resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
  }
}

const BW_ENV_ALLOWLIST = [
  "HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "BITWARDENCLI_APPDATA_DIR",
  "LANG", "LC_ALL", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

export function buildBwChildEnvironment(source: NodeJS.ProcessEnv, sessionKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of BW_ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name];
  if (sessionKey !== undefined) env.BW_SESSION = sessionKey;
  return env;
}

function unixSocketAccepting(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (active: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(active);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

function safeOrigin(value: unknown): string | null {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function itemMatchesOrigin(item: BitwardenItem, origin: string): boolean {
  return Array.isArray(item.login?.uris) && item.login!.uris!.some((entry) => safeOrigin(entry.uri) === origin);
}

const BITWARDEN_ITEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidBitwardenItemId(value: unknown): value is string {
  return typeof value === "string" && BITWARDEN_ITEM_ID_PATTERN.test(value);
}

function itemId(item: BitwardenItem): string | null {
  return isValidBitwardenItemId(item.id) ? item.id : null;
}

function safeLabel(value: unknown): string {
  const label = String(value || "Saved login").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (label || "Saved login").slice(0, MAX_LABEL_LENGTH);
}

function safeItemLabel(item: BitwardenItem): string {
  const label = safeLabel(item.name);
  const credentialValues = [item.login?.username, item.login?.password, item.login?.totp]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return credentialValues.some((value) => label.includes(value)) ? "Saved login" : label;
}

export function maskCredentialIdentifier(value: unknown): string {
  const identifier = String(value || "").trim();
  if (!identifier) return "••••";
  const at = identifier.indexOf("@");
  const maskPart = (part: string) => part.length <= 1 ? "•" : `${part[0]}${"•".repeat(Math.min(6, Math.max(2, part.length - 1)))}`;
  if (at > 0 && at < identifier.length - 1) {
    const local = identifier.slice(0, at);
    const domain = identifier.slice(at + 1);
    const dot = domain.lastIndexOf(".");
    const host = dot > 0 ? domain.slice(0, dot) : domain;
    const suffix = dot > 0 ? domain.slice(dot) : "";
    return `${maskPart(local)}@${maskPart(host)}${suffix}`;
  }
  return maskPart(identifier);
}

function sameContext(choice: PendingChoice, context: BrowserCredentialContext): boolean {
  const choiceBinding = choice.capabilityBinding;
  const contextBinding = context.capabilityBinding;
  return choice.runtimeKey === context.runtimeKey
    && choice.targetId === context.targetId
    && choice.documentIdentity === context.documentIdentity
    && choice.origin === context.origin
    && Boolean(choiceBinding) === Boolean(contextBinding)
    && (!choiceBinding || !contextBinding || exactProtectedBrowserBindingEqual(choiceBinding, contextBinding));
}

function sameProtectedRuntimeLease(left: Readonly<ProtectedBrowserBinding>, right: Readonly<ProtectedBrowserBinding>): boolean {
  return left.capabilityId === right.capabilityId
    && left.sourceSessionId === right.sourceSessionId
    && left.projectId === right.projectId
    && left.agentProfileId === right.agentProfileId
    && left.associationRevision === right.associationRevision
    && left.runtimeGeneration === right.runtimeGeneration
    && left.processBootNonce === right.processBootNonce;
}

export class CredentialBroker {
  private sessionKey: string | null = null;
  private unlockExpiresAt = 0;
  private sessionGeneration = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private socketServer: net.Server | null = null;
  private readonly choices = new Map<string, PendingChoice>();

  constructor(
    private readonly config: BrowserCredentialsConfig,
    private readonly adapter: BitwardenAdapter = new BwCliAdapter(config),
    private readonly now: () => number = Date.now,
  ) {}

  status(): CredentialStatus {
    this.expireIfNeeded();
    return {
      available: this.adapter.available,
      unlocked: this.sessionKey !== null,
      ...(this.sessionKey ? { unlockExpiresAt: this.unlockExpiresAt } : {}),
    };
  }

  acceptUnlockKey(raw: string): void {
    const key = raw.replace(/[\r\n]+$/g, "");
    const bytes = Buffer.byteLength(key, "utf8");
    if (bytes < 8 || bytes > MAX_UNLOCK_KEY_BYTES || key.includes("\0")) throw new Error("Invalid Bitwarden session key");
    this.sessionKey = key;
    this.sessionGeneration += 1;
    this.choices.clear();
    this.touch();
  }

  async matches(context: BrowserCredentialContext): Promise<{ origin: string; choices: CredentialChoice[] }> {
    const key = this.requireSessionKey();
    const generation = this.sessionGeneration;
    const items = await this.adapter.listItems(context.origin, key);
    if (generation !== this.sessionGeneration || key !== this.sessionKey) throw new Error("Bitwarden session changed during the operation");
    this.touch();
    const choices: CredentialChoice[] = [];
    for (const item of items) {
      const id = itemId(item);
      if (!id || !itemMatchesOrigin(item, context.origin)) continue;
      choices.push(this.makeChoice(item, id, context));
    }
    return { origin: context.origin, choices };
  }

  async fill(
    token: string,
    operation: "login" | "totp",
    context: BrowserCredentialContext,
    filler: (values: { username?: string; password?: string; totp?: string }) => Promise<Array<"username" | "password" | "totp">>,
  ): Promise<{ filled: Array<"username" | "password" | "totp"> }> {
    const choice = this.consumeChoice(token);
    if ((choice.operation !== operation && choice.operation !== "login-or-totp") || !sameContext(choice, context)) throw new Error("Credential choice is no longer valid for this page");
    const key = this.requireSessionKey();
    const generation = this.sessionGeneration;
    const matches = await this.adapter.listItems(context.origin, key);
    const matched = matches.find((item) => itemId(item) === choice.itemId && itemMatchesOrigin(item, context.origin));
    if (!matched) throw new Error("Credential no longer matches the current origin");

    let values: { username?: string; password?: string; totp?: string };
    if (operation === "totp") {
      values = { totp: await this.adapter.getTotp(choice.itemId, key) };
    } else {
      const item = await this.adapter.getItem(choice.itemId, key);
      if (itemId(item) !== choice.itemId || !itemMatchesOrigin(item, context.origin)) throw new Error("Credential item origin changed");
      const username = typeof item.login?.username === "string" ? item.login.username : undefined;
      const password = typeof item.login?.password === "string" ? item.login.password : undefined;
      if (!password) throw new Error("Credential item has no password");
      values = { username, password };
    }
    if (generation !== this.sessionGeneration || key !== this.sessionKey) throw new Error("Bitwarden session changed during the operation");
    const filled = await filler(values);
    if (operation === "login" && !filled.includes("password")) throw new Error("Credential login fill did not fill the required password field");
    if (operation === "totp" && !filled.includes("totp")) throw new Error("Credential verification fill did not fill the required code field");
    this.touch();
    return { filled };
  }

  /** Revoke every outstanding one-use choice for one exact runtime lease. */
  revokeChoicesForProtectedBinding(binding: Readonly<ProtectedBrowserBinding>): void {
    for (const [token, choice] of this.choices) {
      if (choice.capabilityBinding && sameProtectedRuntimeLease(choice.capabilityBinding, binding)) this.choices.delete(token);
    }
  }

  async lock(): Promise<void> {
    const wasUnlocked = this.sessionKey !== null;
    this.sessionKey = null;
    this.sessionGeneration += 1;
    this.unlockExpiresAt = 0;
    this.choices.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (wasUnlocked) await this.adapter.lock();
  }

  async startUnlockSocket(): Promise<void> {
    if (this.socketServer || process.platform === "win32") return;
    const directory = path.dirname(this.config.unlockSocketPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    try {
      const existing = fs.lstatSync(this.config.unlockSocketPath);
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error("Unsafe existing credential unlock socket path");
      if (await unixSocketAccepting(this.config.unlockSocketPath)) throw new Error("Another credential unlock socket is already active");
      fs.unlinkSync(this.config.unlockSocketPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      socket.on("data", (raw) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        bytes += chunk.length;
        if (bytes > MAX_UNLOCK_KEY_BYTES) {
          socket.destroy();
          return;
        }
        chunks.push(chunk);
      });
      socket.on("end", () => {
        try {
          this.acceptUnlockKey(Buffer.concat(chunks).toString("utf8"));
          socket.end("ok\n");
        } catch {
          socket.end("rejected\n");
        }
      });
      socket.setTimeout(10_000, () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.unlockSocketPath, () => resolve());
    });
    fs.chmodSync(this.config.unlockSocketPath, 0o600);
    this.socketServer = server;
  }

  async shutdown(): Promise<void> {
    const server = this.socketServer;
    this.socketServer = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { fs.unlinkSync(this.config.unlockSocketPath); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    await this.lock();
  }

  private makeChoice(item: BitwardenItem, id: string, context: BrowserCredentialContext): CredentialChoice {
    const choiceToken = crypto.randomBytes(24).toString("base64url");
    this.choices.set(choiceToken, {
      itemId: id,
      runtimeKey: context.runtimeKey,
      targetId: context.targetId,
      documentIdentity: context.documentIdentity,
      origin: context.origin,
      ...(context.capabilityBinding ? { capabilityBinding: { ...context.capabilityBinding } } : {}),
      operation: "login-or-totp",
      expiresAt: this.now() + this.config.choiceTtlMs,
    });
    return {
      choiceToken,
      label: safeItemLabel(item),
      maskedIdentifier: maskCredentialIdentifier(item.login?.username),
      hasTotp: Boolean(item.login?.totp),
    };
  }

  private consumeChoice(token: string): PendingChoice {
    if (typeof token !== "string" || token.length < 16 || token.length > 256) throw new Error("Invalid credential choice");
    const choice = this.choices.get(token);
    this.choices.delete(token);
    if (!choice || choice.expiresAt <= this.now()) throw new Error("Credential choice expired or was already used");
    return choice;
  }

  private requireSessionKey(): string {
    this.expireIfNeeded();
    if (!this.adapter.available) throw new Error("Bitwarden CLI is unavailable");
    if (!this.sessionKey) throw new Error("Bitwarden vault is not connected");
    return this.sessionKey;
  }

  private touch(): void {
    this.unlockExpiresAt = this.now() + this.config.idleTimeoutMs;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.lock().catch(() => undefined); }, this.config.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private expireIfNeeded(): void {
    if (this.sessionKey && this.unlockExpiresAt <= this.now()) void this.lock().catch(() => undefined);
    for (const [token, choice] of this.choices) if (choice.expiresAt <= this.now()) this.choices.delete(token);
  }
}
