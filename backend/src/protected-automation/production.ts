import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CredentialBroker } from "../browser/credentials.js";
import {
  ProtectedCredentialProtection,
  guardedSend,
  settledTopLevelDocument,
} from "../browser/guarded-page.js";
import type { BrowserCredentialContext } from "../browser/manager.js";
import type { SettingsPinAttemptPort, SettingsRequestOwner } from "../workspace-capability-approval/types.js";
import { onPolicyChanged } from "../policy-generation.js";
import { protectedAutomationAttentionMetadata } from "./attention.js";
import { createProtectedAutomationServices, type ProtectedAutomationServices } from "./assembly.js";
import {
  ProtectedAutomationBrowserRealmRegistry,
  protectedAutomationBrowserRealmRoot,
} from "./browser-realm.js";
import { ProtectedAutomationBrowserRpc } from "./browser-rpc.js";
import {
  ProtectedAutomationBrowserPreparationCore,
  installProtectedAutomationPreparationPort,
  type ProtectedAutomationPreparationLease,
  type ProtectedAutomationPreparationMetadata,
  type ProtectedAutomationPreparationPort,
  type ProtectedAutomationPreparationViewerContext,
} from "./browser-preparation.js";
import { protectedAutomationJobAuthorityIsCurrent, type ProtectedAutomationBinding } from "./authority.js";
import {
  getProtectedAutomationJob,
  listProtectedAutomationActiveRuns,
  listProtectedAutomationJobs,
  listProtectedAutomationRuns,
  purgeTombstonedProtectedAutomationJob,
  transitionProtectedAutomationJobLifecycle,
} from "./store.js";
import { stageProtectedAutomationSnapshotJobPurge } from "./snapshots.js";
import type { ProtectedAutomationJobRow, ProtectedAutomationRunRow } from "./types.js";

const PREPARATION_TTL_MS = 30 * 60 * 1_000;
const PURGE_TTL_MS = 2 * 60 * 1_000;
const PURGE_REALM = "wayang.protected-automation-purge.v1";
const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_INTERVAL_MS = 50;
const PREPARATION_PASTE_MAX_CHARS = 4_096;
const PREPARATION_PASTE_MAX_BYTES = 16_384;

export interface ProtectedAutomationViewerTransport {
  dispatch(message: Buffer, isBinary: boolean): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: Buffer, isBinary: boolean) => void): () => void;
}

export interface ProtectedAutomationPreparationSelection {
  sourceSessionId: string;
  jobId: string;
  preparationId: string;
}

export interface ProtectedAutomationPreparationPublicState extends ProtectedAutomationPreparationMetadata {
  project_id: string;
  agent_profile_id: string;
  capability_revision: number;
  source_revision: number;
  allowed_https_origins: string[];
  credential_broker: { supported: boolean; guarded: true };
}

export interface ProtectedAutomationPurgeChallenge {
  request_id: string;
  job_id: string;
  expected_revision: number;
  operation_digest: string;
  expires_at: number;
  summary: string;
}

export interface ProtectedAutomationProductionIntegration {
  listJobs(): ReturnType<typeof publicJob>[];
  getJob(jobId: string): ReturnType<typeof publicJob>;
  listRuns(jobId: string): ReturnType<typeof publicRun>[];
  pauseJob(owner: SettingsRequestOwner, jobId: string, expectedRevision: number): ReturnType<typeof publicJob>;
  cancelRun(owner: SettingsRequestOwner, jobId: string, runId: string): ReturnType<typeof publicRun>;
  getPreparation(owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection): ProtectedAutomationPreparationPublicState;
  closePreparation(owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection): Promise<void>;
  openPreparationViewer(owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection): Promise<ProtectedAutomationViewerTransport>;
  navigatePreparation(owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection, url: string): Promise<ProtectedAutomationPreparationPublicState>;
  credentialStatus(owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection): Promise<{ available: boolean; unlocked: boolean; unlockExpiresAt?: number; origin: string | null }>;
  credentialMatches(owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection): Promise<unknown>;
  credentialFill(owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection, token: string, operation: "login" | "totp"): Promise<{ filled: Array<"username" | "password" | "totp"> }>;
  credentialLock(owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection): Promise<void>;
  requestPurge(owner: SettingsRequestOwner, jobId: string, expectedRevision: number): Promise<ProtectedAutomationPurgeChallenge>;
  commitPurge(owner: SettingsRequestOwner, jobId: string, requestId: string, pin: string): Promise<{ purged_job_id: string; purged_run_ids: string[] }>;
  cancelPurge(owner: SettingsRequestOwner, jobId: string, requestId: string, authenticationLost?: boolean): Promise<void>;
}

export interface ProtectedAutomationProductionOptions {
  dataDir: string;
  credentialBroker: CredentialBroker;
  pinAttempts: SettingsPinAttemptPort;
  realms?: ProtectedAutomationBrowserRealmRegistry;
  services?: ProtectedAutomationServices;
  subscribePolicy?: typeof onPolicyChanged;
  now?: () => number;
}

export interface ProtectedAutomationProductionBootstrap {
  integration: ProtectedAutomationProductionIntegration;
  services: ProtectedAutomationServices;
  realms: ProtectedAutomationBrowserRealmRegistry;
  start(): void;
  close(): Promise<void>;
}

function error(message: string, statusCode = 403): Error {
  return Object.assign(new Error(message), { statusCode });
}

const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9-]{1,64}$/u;

function diagnosticError(code: string): Error {
  const bounded = DIAGNOSTIC_CODE_PATTERN.test(code) ? code : "unclassified";
  return Object.assign(error("Preparation viewer transport failed", 503), {
    protectedAutomationDiagnosticCode: bounded,
  });
}

/** Extract only a bounded internal stage code; never release raw error text. */
export function protectedAutomationDiagnosticCode(value: unknown): string {
  const code = value && typeof value === "object" && "protectedAutomationDiagnosticCode" in value
    ? (value as { protectedAutomationDiagnosticCode?: unknown }).protectedAutomationDiagnosticCode
    : undefined;
  return typeof code === "string" && DIAGNOSTIC_CODE_PATTERN.test(code) ? code : "unclassified";
}

function publicRun(row: ProtectedAutomationRunRow) {
  return {
    id: row.id,
    job_id: row.job_id,
    project_id: row.project_id,
    agent_profile_id: row.agent_profile_id,
    job_revision: row.job_revision,
    capability_revision: row.capability_revision,
    trigger: row.trigger,
    scheduled_for: row.scheduled_for,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    outcome_code: row.outcome_code,
    exit_code: row.exit_code,
    attention: protectedAutomationAttentionMetadata(row),
  };
}

function publicJob(row: ProtectedAutomationJobRow) {
  const latestAttention = listProtectedAutomationRuns(row.id, 1)[0];
  return {
    id: row.id,
    project_id: row.project_id,
    agent_profile_id: row.agent_profile_id,
    capability_revision: row.capability_revision,
    revision: row.revision,
    source_revision: row.source_revision,
    name: row.name,
    source_manifest_sha256: row.source_manifest_sha256,
    entrypoint: row.entrypoint,
    argv_count: row.argv.length,
    uses_browser_profile: row.uses_browser_profile,
    allowed_https_origins: [...row.allowed_https_origins],
    cron_expr: row.cron_expr,
    timeout_ms: row.timeout_ms,
    missed_run_policy: row.missed_run_policy,
    enabled: row.enabled,
    blocked_reason: row.blocked_reason,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    attention: latestAttention ? protectedAutomationAttentionMetadata(latestAttention) : null,
    activationAvailable: true,
  };
}

function exactOwner(owner: SettingsRequestOwner): void {
  if (!owner || typeof owner.sessionId !== "string" || !owner.sessionId
    || typeof owner.origin !== "string" || !owner.origin) throw error("Authenticated owner is required", 401);
  let parsed: URL;
  try { parsed = new URL(owner.origin); } catch { throw error("Exact Origin is required"); }
  if (parsed.origin !== owner.origin || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw error("Exact Origin is required");
  }
}

function exactSelection(value: ProtectedAutomationPreparationSelection): void {
  for (const item of [value.sourceSessionId, value.jobId, value.preparationId]) {
    if (typeof item !== "string" || !item || item.length > 256 || item !== item.normalize("NFC")
      || /[\u0000-\u001f\u007f]/u.test(item)) throw error("Exact preparation selection is invalid", 400);
  }
}

function credentialRealmKey(projectId: string, agentProfileId: string, jobId: string): string {
  return createHash("sha256").update("automation-credential-realm-v1\0").update(projectId).update("\0")
    .update(agentProfileId).update("\0").update(jobId).digest("hex");
}

function exactJobCurrent(job: Readonly<ProtectedAutomationJobRow>, binding: Readonly<ProtectedAutomationBinding>): boolean {
  const current = getProtectedAutomationJob(job.id);
  return Boolean(current && current.project_id === binding.projectId && current.agent_profile_id === binding.agentProfileId
    && current.capability_revision === binding.associationRevision && current.revision === job.revision
    && current.source_revision === job.source_revision && current.source_manifest_sha256 === job.source_manifest_sha256
    && current.deleted_at === null && protectedAutomationJobAuthorityIsCurrent(current));
}

interface PreparationRecord {
  id: string;
  sourceBinding: Readonly<ProtectedAutomationBinding>;
  job: ProtectedAutomationJobRow;
  lease: ProtectedAutomationPreparationLease;
  owner: SettingsRequestOwner | null;
  createdAt: number;
  closed: boolean;
  protection: ProtectedCredentialProtection;
  expiryTimer?: NodeJS.Timeout;
}

function preparationState(record: PreparationRecord, credentialSupported: boolean): ProtectedAutomationPreparationPublicState {
  return {
    preparation_id: record.id,
    source_session_id: record.sourceBinding.sourceSessionId,
    job_id: record.job.id,
    job_revision: record.job.revision,
    state: record.closed ? "closed" : record.owner ? "ready" : "waiting_for_owner",
    websocket_path: `/ws/protected-automations/preparations/${encodeURIComponent(record.id)}?source_session_id=${encodeURIComponent(record.sourceBinding.sourceSessionId)}&job_id=${encodeURIComponent(record.job.id)}`,
    project_id: record.job.project_id,
    agent_profile_id: record.job.agent_profile_id,
    capability_revision: record.job.capability_revision,
    source_revision: record.job.source_revision,
    allowed_https_origins: [...record.job.allowed_https_origins],
    credential_broker: { supported: credentialSupported, guarded: true },
  };
}

function ownerEqual(left: SettingsRequestOwner, right: SettingsRequestOwner): boolean {
  return left.sessionId === right.sessionId && left.origin === right.origin;
}

function keyCodeFor(key: string): number | undefined {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return ({ Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38,
    ArrowRight: 39, ArrowDown: 40, Delete: 46 } as Record<string, number>)[key];
}

function exactPreparationPasteText(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > PREPARATION_PASTE_MAX_CHARS
    || Buffer.byteLength(value, "utf8") > PREPARATION_PASTE_MAX_BYTES || value.includes("\0")) {
    throw error("Preparation paste text is invalid", 400);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw error("Preparation paste text is invalid", 400);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw error("Preparation paste text is invalid", 400);
    }
  }
  return value;
}

async function createPreparationViewer(context: ProtectedAutomationPreparationViewerContext): Promise<{
  transport: ProtectedAutomationViewerTransport;
  registration: { id: string; close(): Promise<void> };
}> {
  const attach = context.runtime.attachPageCdpViewer;
  if (typeof attach !== "function") throw diagnosticError("viewer-attach-unavailable");
  try { await context.assertAuthorized(); }
  catch { throw diagnosticError("viewer-authority-check"); }
  let attachment: Awaited<ReturnType<NonNullable<typeof attach>>>;
  try { attachment = await attach.call(context.runtime); }
  catch { throw diagnosticError("viewer-cdp-attach"); }
  const listeners = new Set<(message: Buffer, isBinary: boolean) => void>();
  const id = randomUUID();
  let closed = false;
  const emit = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    for (const listener of listeners) listener(bytes, false);
  };
  const offFrame = attachment.cdp.on("Page.screencastFrame", (params: any) => {
    // Browser-originated frames are result release too: a revision change must
    // suppress them even when the human sends no further viewer message.
    void context.assertAuthorized().then(() => {
      if (!closed) emit({ type: "frame", dataUrl: `data:image/jpeg;base64,${params.data}`, metadata: params.metadata, sessionId: params.sessionId });
    }).catch(() => { void close(); });
  });
  try { await guardedSend(attachment.cdp, context.assertAuthorized, "Page.enable"); }
  catch { attachment.close(); throw diagnosticError("viewer-page-enable"); }
  try { await guardedSend(attachment.cdp, context.assertAuthorized, "Runtime.enable"); }
  catch { attachment.close(); throw diagnosticError("viewer-runtime-enable"); }
  try {
    await guardedSend(attachment.cdp, context.assertAuthorized, "Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  } catch { attachment.close(); throw diagnosticError("viewer-screencast-start"); }
  const close = async () => {
    if (closed) return;
    closed = true;
    offFrame();
    try { await guardedSend(attachment.cdp, context.assertAuthorized, "Page.stopScreencast"); } catch {}
    listeners.clear();
    attachment.close();
  };
  const transport: ProtectedAutomationViewerTransport = {
    dispatch(raw, isBinary) {
      return context.handleMessage(async () => {
        if (closed || isBinary) throw error("Preparation viewer message is invalid", 400);
        let message: any;
        try { message = JSON.parse(raw.toString("utf8")); } catch { throw error("Preparation viewer message is invalid", 400); }
        if (message.type === "frame-ack") {
          const sessionId = Number(message.sessionId);
          if (!Number.isSafeInteger(sessionId) || sessionId < 0) throw error("Preparation frame acknowledgement is invalid", 400);
          await guardedSend(attachment.cdp, context.assertAuthorized, "Page.screencastFrameAck", { sessionId });
          return;
        }
        if (message.type === "mouse") {
          const x = Number(message.x); const y = Number(message.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw error("Preparation mouse input is invalid", 400);
          const type = message.event === "down" ? "mousePressed" : message.event === "up" ? "mouseReleased"
            : message.event === "wheel" ? "mouseWheel" : "mouseMoved";
          await guardedSend(attachment.cdp, context.assertAuthorized, "Input.dispatchMouseEvent", {
            type, x, y, button: message.button === "right" ? "right" : message.button === "middle" ? "middle" : "left",
            clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
            deltaX: Number(message.deltaX) || 0, deltaY: Number(message.deltaY) || 0,
          });
          return;
        }
        if (message.type === "paste") {
          if (Object.keys(message).sort().join("\0") !== "text\0type") throw error("Preparation paste message is invalid", 400);
          const text = exactPreparationPasteText(message.text);
          await guardedSend(attachment.cdp, context.assertAuthorized, "Input.insertText", { text });
          return;
        }
        if (message.type === "key") {
          const key = typeof message.key === "string" ? message.key : "";
          if (!key) throw error("Preparation key input is invalid", 400);
          if (message.event === "down" && key.length === 1 && !message.ctrlKey && !message.metaKey && !message.altKey) {
            await guardedSend(attachment.cdp, context.assertAuthorized, "Input.insertText", { text: key });
          } else {
            await guardedSend(attachment.cdp, context.assertAuthorized, "Input.dispatchKeyEvent", {
              type: message.event === "up" ? "keyUp" : "rawKeyDown", key, code: message.code || key,
              windowsVirtualKeyCode: keyCodeFor(key), nativeVirtualKeyCode: keyCodeFor(key),
              modifiers: (message.altKey ? 1 : 0) | (message.ctrlKey ? 2 : 0) | (message.metaKey ? 4 : 0) | (message.shiftKey ? 8 : 0),
            });
          }
          return;
        }
        throw error("Preparation viewer message is unsupported", 400);
      });
    },
    close,
    onMessage(listener) { if (closed) throw error("Preparation viewer is closed", 409); listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { transport, registration: { id, close } };
}

async function credentialContext(record: PreparationRecord): Promise<BrowserCredentialContext> {
  let result!: BrowserCredentialContext;
  // Credential inspection/fill remains available only while at least one
  // owner-bound viewer is actively registered for this preparation.
  const holder = preparationRuntimeContexts.get(record);
  if (!holder) throw error("Preparation browser is not running", 409);
  await holder.runtime.withPageCdp(async (cdp, target) => {
    const document = await settledTopLevelDocument(cdp, target, holder.assertAuthorized, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    const parsed = new URL(document.topLevelUrl);
    if (parsed.protocol !== "https:" || !record.job.allowed_https_origins.includes(parsed.origin)) {
      throw error("Current preparation page is outside the exact HTTPS origin allowlist", 409);
    }
    result = {
      runtimeKey: `automation-preparation:${record.id}`,
      targetId: document.targetId,
      documentIdentity: document.documentIdentity,
      url: document.topLevelUrl,
      origin: parsed.origin,
      automationPreparationBinding: { ...record.lease.binding },
    };
  });
  return result;
}

interface PreparationRuntimeContext {
  runtime: ProtectedAutomationPreparationViewerContext["runtime"];
  assertAuthorized(): Promise<void>;
  activeViewers: number;
}

const preparationRuntimeContexts = new WeakMap<PreparationRecord, PreparationRuntimeContext>();

async function fillPreparationCredential(
  record: PreparationRecord,
  expected: BrowserCredentialContext,
  values: { username?: string; password?: string; totp?: string },
): Promise<Array<"username" | "password" | "totp">> {
  const holder = preparationRuntimeContexts.get(record);
  if (!holder || !expected.automationPreparationBinding) throw error("Preparation credential context is unavailable", 409);
  return holder.runtime.withPageCdp(async (cdp, target) => {
    const current = await settledTopLevelDocument(cdp, target, holder.assertAuthorized, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    if (current.targetId !== expected.targetId || current.documentIdentity !== expected.documentIdentity
      || new URL(current.topLevelUrl).origin !== expected.origin) throw error("Credential choice is no longer valid for this page", 409);
    record.protection.recordFill(expected.documentIdentity, values);
    const documentResult = await guardedSend<any>(cdp, holder.assertAuthorized, "Runtime.evaluate", { expression: "document", returnByValue: false });
    const objectId = documentResult?.result?.objectId;
    if (!objectId) throw error("Credential fill could not access the page", 409);
    const result = await guardedSend<any>(cdp, holder.assertAuthorized, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(values) {
        const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return !el.disabled && !el.readOnly && el.type !== "hidden" && r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0; };
        const identity = (el) => [el.id, el.name, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].filter(Boolean).join(" ");
        const setValue = (el, value) => { el.focus({ preventScroll: true }); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set; if (setter) setter.call(el, value); else el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
        const inputs = Array.from(document.querySelectorAll("input,textarea")).filter(visible);
        const passwords = inputs.filter((el) => el instanceof HTMLInputElement && el.type === "password");
        const totps = inputs.filter((el) => /one-time-code/i.test(el.autocomplete || "") || /(?:otp|totp|verification|auth(?:entication)?[ _-]?code)/i.test(identity(el)));
        if (typeof values.password === "string" && passwords.length !== 1) return { error: "password", filled: [] };
        if (typeof values.totp === "string" && totps.length !== 1) return { error: "totp", filled: [] };
        const excluded = new Set([passwords[0], totps[0]].filter(Boolean));
        const usernames = inputs.filter((el) => !excluded.has(el) && (!(el instanceof HTMLInputElement) || ["text", "email", "tel", ""].includes(el.type)) && (/(?:user|email|login)/i.test(identity(el)) || /username|email/i.test(el.autocomplete || "")));
        const filled = [];
        if (typeof values.username === "string" && usernames.length === 1) { setValue(usernames[0], values.username); filled.push("username"); }
        if (typeof values.password === "string") { setValue(passwords[0], values.password); filled.push("password"); }
        if (typeof values.totp === "string") { setValue(totps[0], values.totp); filled.push("totp"); }
        return { filled };
      }`,
      arguments: [{ value: values }], returnByValue: true, awaitPromise: true,
    });
    const value = result?.result?.value ?? {};
    if (value.error === "password") throw error("Credential fill requires exactly one eligible password field", 409);
    if (value.error === "totp") throw error("Credential fill requires exactly one eligible verification-code field", 409);
    const after = await settledTopLevelDocument(cdp, target, holder.assertAuthorized, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    if (after.documentIdentity !== expected.documentIdentity) throw error("Credential document changed during fill", 409);
    return (Array.isArray(value.filled) ? value.filled : []).filter((field: unknown): field is "username" | "password" | "totp" =>
      field === "username" || field === "password" || field === "totp");
  });
}

interface PurgeRequest {
  requestId: string;
  reservationId: string;
  ownerDigest: Buffer;
  ownerOrigin: string;
  jobId: string;
  projectId: string;
  agentProfileId: string;
  expectedRevision: number;
  operationDigest: string;
  expiresAt: number;
  phase: "pending" | "consuming";
}

interface StagedDirectory {
  rollback(): void;
  finalize(): void;
}

function validatePrivateTree(root: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const visit = (target: string): void => {
    const metadata = fs.lstatSync(target);
    if (uid !== undefined && metadata.uid !== uid) throw error("Private purge artifact is unsafe", 409);
    // Chromium may create owner-held Singleton* symlinks. Recursive removal
    // unlinks rather than follows them, so they are safe inside this already
    // exact private root; directory traversal never descends through them.
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      if ((metadata.mode & 0o077) !== 0) throw error("Private purge artifact is not owner-only", 409);
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    } else if (!metadata.isFile() || metadata.nlink !== 1) throw error("Private purge artifact is unsafe", 409);
  };
  visit(root);
}

function stageDirectory(target: string): StagedDirectory {
  try { fs.lstatSync(target); } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return { rollback() {}, finalize() {} };
    throw failure;
  }
  validatePrivateTree(target);
  const staged = `${target}.purge-${randomUUID()}`;
  fs.renameSync(target, staged);
  let active = true;
  return {
    rollback() { if (active) { fs.renameSync(staged, target); active = false; } },
    finalize() {
      if (!active) return;
      validatePrivateTree(staged);
      fs.rmSync(staged, { recursive: true, force: false });
      active = false;
    },
  };
}

export function bootstrapProtectedAutomationProduction(options: ProtectedAutomationProductionOptions): ProtectedAutomationProductionBootstrap {
  if (!options || typeof options.dataDir !== "string" || !options.dataDir || !options.credentialBroker || !options.pinAttempts) {
    throw new Error("Protected automation production options are incomplete");
  }
  const configuredDataDir = path.resolve(options.dataDir);
  fs.mkdirSync(configuredDataDir, { recursive: true, mode: 0o700 });
  const dataDir = fs.realpathSync.native(configuredDataDir);
  const now = options.now ?? Date.now;
  const realms = options.realms ?? new ProtectedAutomationBrowserRealmRegistry({ dataDir });
  const preparationCore = new ProtectedAutomationBrowserPreparationCore(realms);
  const credentialProtections = new Map<string, ProtectedCredentialProtection>();
  const protectionFor = (projectId: string, agentProfileId: string, jobId: string): ProtectedCredentialProtection => {
    const key = credentialRealmKey(projectId, agentProfileId, jobId);
    let protection = credentialProtections.get(key);
    if (!protection) { protection = new ProtectedCredentialProtection(); credentialProtections.set(key, protection); }
    return protection;
  };
  const services = options.services ?? createProtectedAutomationServices({
    manager: {
      browserLeaseFactory: async (input) => {
        const lease = realms.acquire({
          projectId: input.job.project_id,
          projectCwd: input.projectCwd,
          agentProfileId: input.job.agent_profile_id,
          jobId: input.job.id,
          capabilityRevision: input.job.capability_revision,
          jobRevision: input.job.revision,
          sourceRevision: input.job.source_revision,
          sourceManifestSha256: input.job.source_manifest_sha256,
          allowedHttpsOrigins: input.job.allowed_https_origins,
          kind: "run",
          ownerId: input.run.id,
          runRoot: input.runRoot,
          signal: input.signal,
          assertAuthorized: input.assertAuthorized,
        });
        const rpc = new ProtectedAutomationBrowserRpc(lease);
        const protection = protectionFor(input.job.project_id, input.job.agent_profile_id, input.job.id);
        return {
          async request(request) { return protection.redact(await rpc.request(request)); },
          close: () => rpc.close(),
        };
      },
    },
  });
  const preparations = new Map<string, PreparationRecord>();
  const purgeRequests = new Map<string, PurgeRequest>();
  const ownerKey = randomBytes(32);
  let started = false;
  let closed = false;
  let unsubscribePolicy: () => void = () => undefined;
  let uninstallPreparation: () => void = () => undefined;

  const ownerDigest = (owner: SettingsRequestOwner): Buffer => createHmac("sha256", ownerKey)
    .update("wayang-protected-automation-purge-owner-v1\0").update(owner.sessionId)
    .update("\0").update(owner.origin).digest();
  const ownerMatches = (expected: Buffer, owner: SettingsRequestOwner): boolean => {
    const actual = ownerDigest(owner);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const closeRecord = async (record: PreparationRecord): Promise<void> => {
    if (record.closed) return;
    record.closed = true;
    preparations.delete(record.id);
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = undefined;
    preparationRuntimeContexts.delete(record);
    options.credentialBroker.revokeChoicesForAutomationPreparation(record.lease.binding);
    await record.lease.close();
  };

  const currentRecord = (owner: SettingsRequestOwner, selection: ProtectedAutomationPreparationSelection): PreparationRecord => {
    exactOwner(owner); exactSelection(selection);
    const record = preparations.get(selection.preparationId);
    if (!record || record.closed || record.id !== selection.preparationId
      || record.sourceBinding.sourceSessionId !== selection.sourceSessionId || record.job.id !== selection.jobId) {
      throw error("Exact automation preparation was not found", 404);
    }
    if (record.createdAt + PREPARATION_TTL_MS <= now()) {
      void closeRecord(record);
      throw error("Automation preparation expired", 410);
    }
    if (!exactJobCurrent(record.job, record.sourceBinding)) {
      void closeRecord(record);
      throw error("Automation preparation authority changed");
    }
    if (!record.owner) record.owner = { ...owner };
    else if (!ownerEqual(record.owner, owner)) throw error("Automation preparation belongs to another owner or Origin");
    return record;
  };

  const assertActiveViewerContext = async (
    record: PreparationRecord,
    holder: PreparationRuntimeContext,
  ): Promise<void> => {
    try {
      await holder.assertAuthorized();
      if (holder.activeViewers < 1 || preparationRuntimeContexts.get(record) !== holder) throw new Error("viewer context changed");
    } catch {
      options.credentialBroker.revokeChoicesForAutomationPreparation(record.lease.binding);
      throw error("Preparation viewer authority changed", 409);
    }
  };

  const preparationPort: ProtectedAutomationPreparationPort = {
    jobChanged(jobId) {
      realms.denyWhere((binding) => binding.jobId === jobId);
      for (const record of [...preparations.values()]) {
        if (record.job.id === jobId) void closeRecord(record);
      }
    },
    async prepare(input) {
      if (closed || !started) throw error("Protected automation production service is unavailable", 503);
      input.assertAuthorized();
      const job = getProtectedAutomationJob(input.job.id);
      if (!job || job.revision !== input.job.revision || !job.uses_browser_profile || job.enabled
        || job.deleted_at !== null || !exactJobCurrent(job, input.binding)) {
        throw error("Protected automation browser preparation requires the exact paused job revision", 409);
      }
      if (listProtectedAutomationActiveRuns().some((run) => run.job_id === job.id)) {
        throw error("Protected automation job has an active run", 409);
      }
      const preparationId = randomUUID();
      let record!: PreparationRecord;
      const lease = await preparationCore.acquire({
        projectId: job.project_id,
        projectCwd: input.binding.projectCwd,
        agentProfileId: job.agent_profile_id,
        jobId: job.id,
        capabilityRevision: job.capability_revision,
        jobRevision: job.revision,
        sourceRevision: job.source_revision,
        sourceManifestSha256: job.source_manifest_sha256,
        allowedHttpsOrigins: job.allowed_https_origins,
        ownerId: preparationId,
        assertAuthorized() {
          // Issuance requires the live management tool above. Once returned,
          // authenticated human preparation is backend-owned and survives
          // ordinary Pi idle cleanup, while exact durable job/policy revisions
          // remain mandatory at every CDP/viewer/credential checkpoint.
          if (!exactJobCurrent(job, input.binding)) throw error("Protected automation preparation revision is stale");
        },
      });
      record = {
        id: preparationId, sourceBinding: Object.freeze({ ...input.binding }), job: { ...job,
          argv: [...job.argv], allowed_https_origins: [...job.allowed_https_origins] }, lease,
        owner: null, createdAt: now(), closed: false,
        protection: protectionFor(job.project_id, job.agent_profile_id, job.id),
      };
      preparations.set(record.id, record);
      record.expiryTimer = setTimeout(() => { void closeRecord(record); }, PREPARATION_TTL_MS);
      record.expiryTimer.unref?.();
      try {
        input.assertAuthorized();
        return preparationState(record, options.credentialBroker.status().available);
      } catch (failure) {
        await closeRecord(record);
        throw failure;
      }
    },
  };

  const managerHasActiveJob = (jobId: string): boolean => {
    const method = (services.manager as typeof services.manager & {
      hasActiveJob?(candidateJobId: string): boolean;
    }).hasActiveJob;
    if (typeof method !== "function") {
      throw error("Protected automation live-process state is unavailable", 503);
    }
    try { return method.call(services.manager, jobId); }
    catch { throw error("Protected automation live-process state is unavailable", 503); }
  };

  const assertPurgeable = (jobId: string, expectedRevision: number): ProtectedAutomationJobRow => {
    const job = getProtectedAutomationJob(jobId);
    if (!job) throw error("Protected automation job not found", 404);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || job.revision !== expectedRevision
      || job.deleted_at === null || job.enabled) throw error("Protected automation tombstone revision conflict", 409);
    const activeRun = listProtectedAutomationActiveRuns().some((run) => run.job_id === job.id);
    const activeLease = realms.hasActiveLease(job.project_id, job.agent_profile_id, job.id);
    const activeProcess = managerHasActiveJob(job.id);
    if (activeLease) {
      realms.denyWhere((binding) => binding.projectId === job.project_id
        && binding.agentProfileId === job.agent_profile_id && binding.jobId === job.id);
      for (const record of preparations.values()) if (record.job.id === job.id) void closeRecord(record);
    }
    if (activeRun || activeLease || activeProcess) {
      throw error("Protected automation job still has an active run, process, controller, or browser lease", 409);
    }
    return job;
  };

  const terminatePurgeRequest = async (request: PurgeRequest, reason: "cancelled" | "authentication_lost" | "expired" | "conflict" | "backend_failure") => {
    request.phase = "consuming";
    await options.pinAttempts.cancelAndConsume({ realm: PURGE_REALM, reservationId: request.reservationId,
      requestId: request.requestId, reason, now: now() });
    purgeRequests.delete(request.requestId);
  };

  const integration: ProtectedAutomationProductionIntegration = {
    listJobs: () => listProtectedAutomationJobs().map(publicJob),
    getJob(jobId) {
      const job = getProtectedAutomationJob(jobId);
      if (!job) throw error("Protected automation job not found", 404);
      return publicJob(job);
    },
    listRuns(jobId) {
      if (!getProtectedAutomationJob(jobId)) throw error("Protected automation job not found", 404);
      return listProtectedAutomationRuns(jobId).map(publicRun);
    },
    pauseJob(owner, jobId, expectedRevision) {
      exactOwner(owner);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw error("Protected automation expected revision is invalid", 400);
      }
      const job = getProtectedAutomationJob(jobId);
      if (!job) throw error("Protected automation job not found", 404);
      const paused = transitionProtectedAutomationJobLifecycle(job.id, expectedRevision, false);
      services.manager.terminateJobs((candidate) => candidate.id === paused.id
        && candidate.project_id === paused.project_id && candidate.agent_profile_id === paused.agent_profile_id);
      preparationPort.jobChanged(paused.id);
      try { services.scheduler.reload(paused.id); } catch { /* durable pause remains authoritative */ }
      return publicJob(paused);
    },
    cancelRun(owner, jobId, runId) {
      exactOwner(owner);
      const job = getProtectedAutomationJob(jobId);
      if (!job) throw error("Protected automation job not found", 404);
      const run = listProtectedAutomationRuns(job.id, 500).find((candidate) => candidate.id === runId
        && candidate.job_id === job.id && candidate.project_id === job.project_id
        && candidate.agent_profile_id === job.agent_profile_id);
      if (!run) throw error("Protected automation run not found for this exact job", 404);
      const cancelled = services.manager.cancel(run.id);
      if (cancelled.job_id !== job.id || cancelled.project_id !== job.project_id
        || cancelled.agent_profile_id !== job.agent_profile_id) {
        throw error("Protected automation run ownership changed", 409);
      }
      return publicRun(cancelled);
    },
    getPreparation(owner, selection) { return preparationState(currentRecord(owner, selection), options.credentialBroker.status().available); },
    async closePreparation(owner, selection) { await closeRecord(currentRecord(owner, selection)); },
    async openPreparationViewer(owner, selection) {
      const record = currentRecord(owner, selection);
      let opened: Awaited<ReturnType<typeof createPreparationViewer>> | undefined;
      let viewerContext: ProtectedAutomationPreparationViewerContext | undefined;
      let registrationClosed = false;
      let releaseRuntimeContext: () => void = () => undefined;
      let registration: Awaited<ReturnType<typeof record.lease.attachViewer>>;
      try {
        registration = await record.lease.attachViewer({
          async open(context) {
            const created = await createPreparationViewer(context);
            opened = created;
            viewerContext = context;
            return {
              id: created.registration.id,
              async close() {
                registrationClosed = true;
                try { await created.registration.close(); }
                finally { releaseRuntimeContext(); }
              },
            };
          },
        });
      } catch (failure) {
        if (protectedAutomationDiagnosticCode(failure) !== "unclassified") throw failure;
        throw diagnosticError("viewer-lease-attach");
      }
      if (!opened || !viewerContext || registrationClosed) {
        await registration.close();
        throw diagnosticError("viewer-registration-closed");
      }
      const transport = opened.transport;
      let holder = preparationRuntimeContexts.get(record);
      if (!holder) {
        holder = {
          runtime: viewerContext.runtime,
          assertAuthorized: viewerContext.assertAuthorized,
          activeViewers: 0,
        };
        preparationRuntimeContexts.set(record, holder);
      }
      holder.activeViewers += 1;
      let contextReleased = false;
      releaseRuntimeContext = () => {
        if (contextReleased) return;
        contextReleased = true;
        holder!.activeViewers -= 1;
        if (holder!.activeViewers === 0 && preparationRuntimeContexts.get(record) === holder) {
          preparationRuntimeContexts.delete(record);
        }
      };
      let transportClosed = false;
      return {
        dispatch: (message, isBinary) => transport.dispatch(message, isBinary),
        onMessage: (listener) => transport.onMessage(listener),
        async close() {
          if (transportClosed) return;
          transportClosed = true;
          await Promise.allSettled([registration.close(), transport.close()]);
        },
      };
    },
    async navigatePreparation(owner, selection, requestedUrl) {
      const record = currentRecord(owner, selection);
      let parsed: URL;
      try { parsed = new URL(requestedUrl); } catch { throw error("Preparation navigation URL is invalid", 400); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password
        || !record.job.allowed_https_origins.includes(parsed.origin)) {
        throw error("Preparation navigation requires one exact configured HTTPS origin", 400);
      }
      const holder = preparationRuntimeContexts.get(record);
      if (!holder) throw error("Preparation viewer must be attached before navigation", 409);
      await holder.runtime.withPageCdp(async (cdp, target) => {
        const navigation = await guardedSend<any>(cdp, holder.assertAuthorized, "Page.navigate", { url: parsed.toString() });
        if (navigation?.errorText) throw error("Preparation navigation failed", 409);
        const document = await settledTopLevelDocument(cdp, target, holder.assertAuthorized, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
        if (new URL(document.topLevelUrl).origin !== parsed.origin) throw error("Preparation navigation left the exact configured origin", 409);
        record.protection.reconcile(document.documentIdentity);
      });
      return preparationState(record, options.credentialBroker.status().available);
    },
    async credentialStatus(owner, selection) {
      const record = currentRecord(owner, selection);
      const status = options.credentialBroker.status();
      const holder = preparationRuntimeContexts.get(record);
      if (!holder) return { ...status, origin: null };
      let origin: string | null = null;
      try { origin = (await credentialContext(record)).origin; }
      catch {
        await assertActiveViewerContext(record, holder);
        return { ...status, origin };
      }
      await assertActiveViewerContext(record, holder);
      return { ...status, origin };
    },
    async credentialMatches(owner, selection) {
      const record = currentRecord(owner, selection);
      const holder = preparationRuntimeContexts.get(record);
      if (!holder) throw error("Preparation viewer must be attached before credential inspection", 409);
      const context = await credentialContext(record);
      const result = await options.credentialBroker.matches(context);
      await assertActiveViewerContext(record, holder);
      return result;
    },
    async credentialFill(owner, selection, token, operation) {
      if (typeof token !== "string" || !token) throw error("choiceToken is required", 400);
      const record = currentRecord(owner, selection);
      const holder = preparationRuntimeContexts.get(record);
      if (!holder) throw error("Preparation viewer must be attached before credential fill", 409);
      const context = await credentialContext(record);
      const result = await options.credentialBroker.fill(token, operation, context, (values) => fillPreparationCredential(record, context, values));
      await assertActiveViewerContext(record, holder);
      return result;
    },
    async credentialLock(owner, selection) {
      currentRecord(owner, selection);
      await options.credentialBroker.lock();
    },
    async requestPurge(owner, jobId, expectedRevision) {
      exactOwner(owner);
      for (const request of [...purgeRequests.values()]) {
        if (request.expiresAt <= now() && request.phase === "pending") await terminatePurgeRequest(request, "expired").catch(() => undefined);
      }
      if (purgeRequests.size > 0) throw error("Another protected automation purge is pending", 409);
      const job = assertPurgeable(jobId, expectedRevision);
      const requestId = randomUUID(); const reservationId = randomUUID(); const expiresAt = now() + PURGE_TTL_MS;
      const operationDigest = createHash("sha256").update(JSON.stringify({
        realm: PURGE_REALM, requestId, reservationId, owner: { sessionId: owner.sessionId, origin: owner.origin },
        jobId: job.id, projectId: job.project_id, agentProfileId: job.agent_profile_id,
        expectedRevision: job.revision, expiresAt,
      })).digest("hex");
      const reservation = await options.pinAttempts.reserve({ realm: PURGE_REALM, reservationId, requestId, operationDigest, expiresAt });
      if (reservation.status === "cooldown") throw Object.assign(error("Settings PIN approval is cooling down", 429), { retryAt: reservation.retryAt });
      if (reservation.status === "busy") throw error("Another Settings PIN approval is pending", 409);
      if (reservation.status === "unavailable") throw error("Settings PIN approval is unavailable", 503);
      purgeRequests.set(requestId, {
        requestId, reservationId, ownerDigest: ownerDigest(owner), ownerOrigin: owner.origin, jobId: job.id,
        projectId: job.project_id, agentProfileId: job.agent_profile_id, expectedRevision: job.revision,
        operationDigest, expiresAt, phase: "pending",
      });
      return { request_id: requestId, job_id: job.id, expected_revision: job.revision,
        operation_digest: operationDigest, expires_at: expiresAt,
        summary: `Permanently purge private automation history and browser profile for tombstoned job ${job.id}; project outputs are retained.` };
    },
    async commitPurge(owner, jobId, requestId, pin) {
      exactOwner(owner);
      const request = purgeRequests.get(requestId);
      if (!request || request.jobId !== jobId) throw error("Protected automation purge request was not found", 404);
      if (!ownerMatches(request.ownerDigest, owner) || request.ownerOrigin !== owner.origin) throw error("Purge request belongs to another owner or Origin");
      if (request.phase !== "pending") throw error("Purge request was already consumed", 409);
      if (request.expiresAt <= now()) { await terminatePurgeRequest(request, "expired"); throw error("Purge request expired", 410); }
      if (typeof pin !== "string" || !pin || pin.length > 1_024) { await terminatePurgeRequest(request, "backend_failure"); throw error("A bounded PIN is required", 400); }
      request.phase = "consuming";
      let verification: Awaited<ReturnType<SettingsPinAttemptPort["verifyAndConsume"]>>;
      try {
        verification = await options.pinAttempts.verifyAndConsume({ realm: PURGE_REALM, reservationId: request.reservationId,
          requestId: request.requestId, pin, now: now() });
        purgeRequests.delete(request.requestId);
      } catch {
        try {
          await options.pinAttempts.cancelAndConsume({ realm: PURGE_REALM, reservationId: request.reservationId,
            requestId: request.requestId, reason: "backend_failure", now: now() });
          purgeRequests.delete(request.requestId);
        } catch { /* consuming stays latched until restart-safe recovery */ }
        throw error("Settings PIN approval is unavailable", 503);
      }
      if (verification.status === "wrong_pin") throw error("Settings PIN was not accepted", 403);
      if (verification.status === "expired") throw error("Purge request expired", 410);
      if (verification.status === "unavailable") throw error("Settings PIN approval is unavailable", 503);
      const job = assertPurgeable(request.jobId, request.expectedRevision);
      if (job.project_id !== request.projectId || job.agent_profile_id !== request.agentProfileId) throw error("Purge owner binding changed", 409);
      const runIds = listProtectedAutomationRuns(job.id, 500).map((run) => run.id);
      const stages: StagedDirectory[] = [];
      const snapshot = stageProtectedAutomationSnapshotJobPurge({ projectId: job.project_id,
        agentProfileId: job.agent_profile_id, jobId: job.id });
      stages.push(snapshot);
      let result: ReturnType<typeof purgeTombstonedProtectedAutomationJob>;
      try {
        const browserRoot = protectedAutomationBrowserRealmRoot(dataDir, job.project_id, job.agent_profile_id, job.id);
        stages.push(stageDirectory(browserRoot));
        assertPurgeable(request.jobId, request.expectedRevision);
        result = purgeTombstonedProtectedAutomationJob({ jobId: job.id, projectId: job.project_id,
          agentProfileId: job.agent_profile_id, expectedRevision: job.revision });
      } catch (failure) {
        for (const stage of stages.reverse()) { try { stage.rollback(); } catch {} }
        throw failure;
      }
      // Rows are now durably absent. Artifact deletion is best effort and can
      // be retried as private orphan cleanup; it must never restore store rows.
      for (const stage of stages) { try { stage.finalize(); } catch {} }
      // Canonical rows are durably absent and the manager has no live process.
      // Retire the exact job's bounded state, scratch, and diagnostics; startup
      // reconciliation retries any best-effort filesystem failure.
      try {
        services.manager.retireJobStorage({
          projectId: job.project_id,
          agentProfileId: job.agent_profile_id,
          jobId: job.id,
        });
      } catch { /* private orphan cleanup is restart-recoverable */ }
      const protectionKey = credentialRealmKey(job.project_id, job.agent_profile_id, job.id);
      credentialProtections.get(protectionKey)?.reset();
      credentialProtections.delete(protectionKey);
      return { purged_job_id: result.purgedJobId, purged_run_ids: result.purgedRunIds };
    },
    async cancelPurge(owner, jobId, requestId, authenticationLost = false) {
      exactOwner(owner);
      const request = purgeRequests.get(requestId);
      if (!request || request.jobId !== jobId) throw error("Protected automation purge request was not found", 404);
      if (!ownerMatches(request.ownerDigest, owner)) throw error("Purge request belongs to another owner or Origin");
      await terminatePurgeRequest(request, authenticationLost ? "authentication_lost" : "cancelled");
    },
  };

  const latchPolicy = () => {
    services.manager.terminateJobs((job) => !protectedAutomationJobAuthorityIsCurrent(job));
    for (const job of listProtectedAutomationJobs()) {
      if (!protectedAutomationJobAuthorityIsCurrent(job)) {
        try { services.scheduler.reload(job.id); } catch { /* denial remains latched */ }
      }
    }
    realms.denyWhere((binding) => {
      const job = getProtectedAutomationJob(binding.jobId);
      return !job || !protectedAutomationJobAuthorityIsCurrent(job)
        || job.project_id !== binding.projectId || job.agent_profile_id !== binding.agentProfileId
        || job.capability_revision !== binding.capabilityRevision || job.revision !== binding.jobRevision
        || job.source_revision !== binding.sourceRevision || job.source_manifest_sha256 !== binding.sourceManifestSha256;
    });
    for (const record of [...preparations.values()]) {
      if (!exactJobCurrent(record.job, record.sourceBinding)) void closeRecord(record);
    }
  };

  return {
    integration, services, realms,
    start() {
      if (started) return;
      if (closed) throw new Error("Protected automation production bootstrap is closed");
      started = true;
      try {
        services.start();
        uninstallPreparation = installProtectedAutomationPreparationPort(preparationPort);
        unsubscribePolicy = (options.subscribePolicy ?? onPolicyChanged)(latchPolicy);
        latchPolicy();
      } catch (failure) {
        started = false;
        try { unsubscribePolicy(); } catch {}
        try { uninstallPreparation(); } catch {}
        void Promise.allSettled([services.stop(), realms.close()]);
        throw failure;
      }
    },
    async close() {
      if (closed) return;
      closed = true; started = false;
      unsubscribePolicy(); uninstallPreparation();
      for (const request of [...purgeRequests.values()]) await terminatePurgeRequest(request, "backend_failure").catch(() => undefined);
      await Promise.allSettled([
        ...[...preparations.values()].map(closeRecord),
        services.stop(),
        realms.close(),
      ]);
      preparations.clear(); purgeRequests.clear();
      for (const protection of credentialProtections.values()) protection.reset();
      credentialProtections.clear();
    },
  };
}
