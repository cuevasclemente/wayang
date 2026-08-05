import * as path from "node:path";
import * as os from "node:os";
import { isPasswordHashRecord } from "./auth/password.js";
import { isLoopbackHost } from "./loopback.js";

export interface TtsConfig {
  /** Shared TTS broker base URL; preferred for streaming/job-based playback. */
  brokerUrl: string;
  /** Legacy direct Chatterbox base URL, retained as a fallback when brokerUrl is unset. */
  baseUrl: string;
  voice: string;
  model: string;
  format: string;
  speed: number;
  maxChars: number;
}

export interface AuthConfig {
  enabled: boolean;
  passwordHash: string;
  sessionSecret: string;
  sessionDays: number;
  sessionStorePath: string;
  trustProxy: "loopback" | false;
  /** Lowercase proxy-injected identity header trusted only from a loopback proxy. */
  proxyIdentityHeader: string;
  cookieSecure: "auto" | "always" | "never";
  allowedOrigins: string[];
}

export interface BrowserCredentialsConfig {
  bwPath: string;
  unlockSocketPath: string;
  idleTimeoutMs: number;
  choiceTtlMs: number;
  maxCliOutputBytes: number;
  cliTimeoutMs: number;
}

export interface BrowserConfig {
  transport: "auto" | "vnc" | "cdp";
  credentials: BrowserCredentialsConfig;
}

export interface FileAudioExperimentConfig {
  /** Inert unless the direct-audio/media/DSP/isolated-Sol composition is explicitly installed. */
  enabled: boolean;
  permitTtlMs: number;
  /** Values are captured at startup but paths/files are validated and opened only after valid execute. */
  wrenCapsulePath: string;
  wrenCapsuleSha256: string;
  sharedTaskPath: string;
  sharedTaskSha256: string;
  neutralAdapterPath: string;
  neutralAdapterSha256: string;
  responseSchemaPath: string;
  responseSchemaSha256: string;
  solSynthesisPromptPath: string;
  solSynthesisPromptSha256: string;
  mediaTempRoot: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  /** Root for filesystem operations (default: user home) */
  fsRoot: string;
  /** Max file read size in bytes */
  maxReadSize: number;
  tts: TtsConfig;
  auth: AuthConfig;
  browser: BrowserConfig;
  fileAudioExperiment: FileAudioExperimentConfig;
}

function getDataDir(): string {
  return (
    process.env.WAYANG_DATA_DIR ||
    process.env.PI_WEB_UI_DATA_DIR ||
    path.join(os.homedir(), ".wayang")
  );
}

function getEnvInt(name: string, fallback: number, legacyName?: string): number {
  const raw = process.env[name] || (legacyName ? process.env[legacyName] : undefined);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getPositiveEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function browserTransport(): BrowserConfig["transport"] {
  const raw = process.env.WAYANG_BROWSER_TRANSPORT || "auto";
  if (raw === "auto" || raw === "vnc" || raw === "cdp") return raw;
  throw new Error("WAYANG_BROWSER_TRANSPORT must be auto, vnc, or cdp");
}

function bitwardenCliPath(): string {
  const configured = process.env.WAYANG_BITWARDEN_CLI_PATH?.trim() || "";
  if (configured && !path.isAbsolute(configured)) throw new Error("WAYANG_BITWARDEN_CLI_PATH must be an absolute path");
  return configured;
}

function getAuthSessionDays(): number {
  const raw = process.env.WAYANG_AUTH_SESSION_DAYS;
  if (raw === undefined) return 30;
  if (!/^[0-9]+$/.test(raw)) throw new Error("WAYANG_AUTH_SESSION_DAYS must be an integer between 1 and 365");
  return Number(raw);
}

function envFlag(name: string, fallback = "0"): boolean {
  const raw = process.env[name] ?? fallback;
  if (raw !== "0" && raw !== "1") throw new Error(`${name} must be 0 or 1`);
  return raw === "1";
}

function authEnabled(): boolean {
  return envFlag("WAYANG_AUTH_ENABLED");
}

function trustProxy(): "loopback" | false {
  const raw = process.env.WAYANG_TRUST_PROXY ?? "loopback";
  if (raw === "loopback") return "loopback";
  if (raw === "0") return false;
  throw new Error("WAYANG_TRUST_PROXY must be loopback or 0");
}

function proxyIdentityHeader(): string {
  const raw = process.env.WAYANG_AUTH_PROXY_IDENTITY_HEADER?.trim() || "";
  if (!raw) return "";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(raw)) {
    throw new Error("WAYANG_AUTH_PROXY_IDENTITY_HEADER must be one valid HTTP header name");
  }
  return raw.toLowerCase();
}

function cookieSecure(): AuthConfig["cookieSecure"] {
  const raw = process.env.WAYANG_AUTH_COOKIE_SECURE ?? "auto";
  if (raw === "auto") return "auto";
  if (raw === "1") return "always";
  if (raw === "0") return "never";
  throw new Error("WAYANG_AUTH_COOKIE_SECURE must be auto, 1, or 0");
}

function allowedOrigins(port: number): string[] {
  const loopback = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
  const configured = process.env.WAYANG_PUBLIC_ORIGIN?.trim();
  if (!configured) return loopback;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("WAYANG_PUBLIC_ORIGIN must be an absolute http(s) origin");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("WAYANG_PUBLIC_ORIGIN must be an absolute http(s) origin without credentials, path, query, or fragment");
  }
  // Keep direct/SSH-tunneled loopback administration available even when the
  // normal browser-facing origin is a remote HTTPS reverse proxy. Settings
  // still requires a loopback socket+Origin when built-in auth is disabled.
  return [...new Set([parsed.origin, ...loopback])];
}

export function validateAuthConfig(auth: AuthConfig): void {
  if (!Array.isArray(auth.allowedOrigins) || auth.allowedOrigins.length === 0) {
    throw new Error("WAYANG_PUBLIC_ORIGIN must resolve to at least one allowed browser origin");
  }
  if (!Number.isInteger(auth.sessionDays) || auth.sessionDays < 1 || auth.sessionDays > 365) {
    throw new Error("WAYANG_AUTH_SESSION_DAYS must be an integer between 1 and 365");
  }
  if (auth.proxyIdentityHeader) {
    if (auth.enabled) throw new Error("WAYANG_AUTH_PROXY_IDENTITY_HEADER and built-in authentication are mutually exclusive");
    if (auth.trustProxy !== "loopback") throw new Error("WAYANG_AUTH_PROXY_IDENTITY_HEADER requires WAYANG_TRUST_PROXY=loopback");
    const hasRemoteHttpsOrigin = auth.allowedOrigins.some((origin) => {
      try {
        const parsed = new URL(origin);
        return parsed.protocol === "https:" && !isLoopbackHost(parsed.hostname);
      } catch { return false; }
    });
    if (!hasRemoteHttpsOrigin) throw new Error("WAYANG_AUTH_PROXY_IDENTITY_HEADER requires an exact remote HTTPS WAYANG_PUBLIC_ORIGIN");
  }
  if (!auth.enabled) return;
  if (!isPasswordHashRecord(auth.passwordHash)) {
    throw new Error("WAYANG_AUTH_PASSWORD_HASH is missing or invalid");
  }
  if (Buffer.byteLength(auth.sessionSecret, "utf8") < 32) {
    throw new Error("WAYANG_AUTH_SESSION_SECRET must contain at least 32 UTF-8 bytes");
  }
}

export function getConfig(overrides?: Partial<Config>): Config {
  const dataDir = getDataDir();
  const port = getEnvInt("WAYANG_PORT", 8787, "PI_WEB_UI_PORT");
  const config: Config = {
    port,
    host: process.env.WAYANG_HOST || process.env.PI_WEB_UI_HOST || "127.0.0.1",
    dataDir,
    dbPath: path.join(dataDir, "wayang.db"),
    fsRoot: os.homedir(),
    maxReadSize: 2 * 1024 * 1024, // 2 MiB
    tts: {
      brokerUrl: process.env.WAYANG_TTS_BROKER_URL || "",
      baseUrl: process.env.WAYANG_TTS_BASE_URL || "",
      voice: process.env.WAYANG_TTS_VOICE || "Ava.mp3",
      model: process.env.WAYANG_TTS_MODEL || "chatterbox-turbo",
      format: process.env.WAYANG_TTS_FORMAT || "mp3",
      speed: parseFloat(process.env.WAYANG_TTS_SPEED || "1.0"),
      maxChars: getEnvInt("WAYANG_TTS_MAX_CHARS", 500),
    },
    auth: {
      enabled: authEnabled(),
      passwordHash: process.env.WAYANG_AUTH_PASSWORD_HASH || "",
      sessionSecret: process.env.WAYANG_AUTH_SESSION_SECRET || "",
      sessionDays: getAuthSessionDays(),
      sessionStorePath: path.join(dataDir, "auth-sessions.json"),
      trustProxy: trustProxy(),
      proxyIdentityHeader: proxyIdentityHeader(),
      cookieSecure: cookieSecure(),
      allowedOrigins: allowedOrigins(port),
    },
    browser: {
      transport: browserTransport(),
      credentials: {
        bwPath: bitwardenCliPath(),
        unlockSocketPath: path.join(dataDir, "browser-credentials", "unlock.sock"),
        idleTimeoutMs: getPositiveEnvInt("WAYANG_BROWSER_CREDENTIALS_IDLE_MINUTES", 15, 1, 1440) * 60_000,
        choiceTtlMs: 30_000,
        maxCliOutputBytes: 4 * 1024 * 1024,
        cliTimeoutMs: 15_000,
      },
    },
    fileAudioExperiment: {
      enabled: envFlag("WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED"),
      permitTtlMs: getPositiveEnvInt("WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS", 60_000, 1_000, 120_000),
      wrenCapsulePath: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_WREN_CAPSULE_PATH || "",
      wrenCapsuleSha256: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_WREN_CAPSULE_SHA256 || "",
      sharedTaskPath: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_SHARED_TASK_PATH || "",
      sharedTaskSha256: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_SHARED_TASK_SHA256 || "",
      neutralAdapterPath: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_NEUTRAL_ADAPTER_PATH || "",
      neutralAdapterSha256: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_NEUTRAL_ADAPTER_SHA256 || "",
      responseSchemaPath: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_RESPONSE_SCHEMA_PATH || "",
      responseSchemaSha256: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_RESPONSE_SCHEMA_SHA256 || "",
      solSynthesisPromptPath: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_SOL_SYNTHESIS_PROMPT_PATH || "",
      solSynthesisPromptSha256: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_SOL_SYNTHESIS_PROMPT_SHA256 || "",
      mediaTempRoot: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_MEDIA_TEMP_ROOT || path.join(dataDir, "audio-experiment", "tmp"),
      ffmpegPath: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFMPEG_PATH || "/usr/bin/ffmpeg",
      ffprobePath: process.env.WAYANG_FILE_AUDIO_EXPERIMENT_FFPROBE_PATH || "/usr/bin/ffprobe",
    },
    ...overrides,
  };
  validateAuthConfig(config.auth);
  return config;
}
