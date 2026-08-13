/**
 * db.ts — Versioned JSON persistence for Wayang metadata.
 *
 * The canonical agent conversation remains in pi's session format. This store
 * is intentionally strict: malformed or newer data aborts startup rather than
 * being replaced with an empty store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getConfig } from "./config.js";
import {
  inventoryBrowserProfilesForSchemaFour,
  validateBrowserCatalogRows,
  type BrowserCleanupRow,
  type BrowserProfileRow,
  type ProjectBrowserDefaultRow,
  type SessionBrowserStateRow,
} from "./browser/profile-catalog-store.js";
import type { AppEvent, AppManifest } from "./apps/types.js";
import type { ScheduledJobRow, ScheduledRunRow } from "./scheduler/types.js";
import type { FileFingerprint } from "./session-metadata.js";
import type {
  MessagingDeliveryRow,
  MessagingEndpointRow,
  MessagingEventRow,
  MessagingTransactionRow,
} from "./messaging/store-types.js";
import { validateMessagingStoreRows } from "./messaging/store-validation.js";
import { validateCronExpression } from "./scheduler/cron.js";
import {
  MAX_PROTECTED_AUTOMATION_ARGV_BYTES,
  MAX_PROTECTED_AUTOMATION_ARGV_ITEMS,
  MAX_PROTECTED_AUTOMATION_ARG_BYTES,
  MAX_PROTECTED_AUTOMATION_CRON_BYTES,
  MAX_PROTECTED_AUTOMATION_ENTRYPOINT_BYTES,
  MAX_PROTECTED_AUTOMATION_HTTPS_ORIGINS,
  MAX_PROTECTED_AUTOMATION_JOBS,
  MAX_PROTECTED_AUTOMATION_NAME_BYTES,
  MAX_PROTECTED_AUTOMATION_ORIGIN_BYTES,
  MAX_PROTECTED_AUTOMATION_OUTCOME_CODE_BYTES,
  MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB,
  MAX_PROTECTED_AUTOMATION_TIMEOUT_MS,
  MIN_PROTECTED_AUTOMATION_TIMEOUT_MS,
  PROTECTED_AUTOMATION_CAPABILITY_ID,
  type ProtectedAutomationJobRow,
  type ProtectedAutomationRunRow,
} from "./protected-automation/types.js";
import {
  WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL,
  WAYANG_WEBSOCKET_SUBMISSION_CHANNEL,
  type InterviewAuthenticatedPrincipal,
  type InterviewSubmissionChannel,
} from "./interview-provenance.js";
import {
  NEUTRAL_AGENT_PROFILE_ID,
  STORE_SCHEMA_VERSION,
  WREN_AGENT_PROFILE_ID,
  WORKSPACE_CAPABILITY_IDS,
  type AgentProfileRow,
  type PendingAgentSwitch,
  type ProjectRow,
  type SessionTitleSource,
  type WorkspaceCapabilityApprovalEventRow,
  type WorkspaceCapabilityAssociationRow,
  type WorkspaceSettingsRow,
} from "./workspace-types.js";

export interface SessionRow {
  id: string;
  pi_session_file: string | null;
  title: string;
  title_source: SessionTitleSource;
  cwd: string;
  /** Immutable Project authority; null is reserved for unresolved legacy rows. */
  project_id?: string | null;
  provider: string | null;
  model: string | null;
  /** Null means a legacy/imported session whose historical identity is unknown. */
  agent_profile_id?: string | null;
  /** Durable compare-and-set marker for a recoverable in-place agent switch. */
  pending_agent_switch: PendingAgentSwitch | null;
  /** @deprecated Schema-1 input only; migrated to the generic quarantine marker. */
  finance_private_data_taint?: boolean;
  /** Permanent generic quarantine for legacy private sessions. */
  legacy_private_session_quarantine?: boolean;
  /** Null-attribution legacy records can never inherit a later default grant. */
  legacy_capability_ineligible?: boolean;
  created_at: number;
  last_active: number;
  archived: number;
  archived_at: number | null;
  goal: string | null;
  goal_status: string | null;
  scheduled_job_id: string | null;
  scheduled_run_id: string | null;
  error: string | null;
  /** Fingerprint of the canonical file that produced catalog-derived fields. */
  catalog_fingerprint?: FileFingerprint | null;
  /** Incremented by direct user/runtime mutations to reject stale worker results. */
  catalog_mutation_version?: number;
}

export interface AgentTeamRow {
  id: string;
  name: string;
  description: string | null;
  orchestrator_id: string | null;
  created_at: number;
  last_active: number;
  archived: number;
}

export interface TeamMemberRow {
  team_id: string;
  agent_name: string;
  role: string;
  session_id: string | null;
  status: string;
}

export interface GoalRow {
  id: string;
  team_id: string | null;
  parent_goal_id: string | null;
  session_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  assigned_to: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface AppRegistrationRow {
  id: string;
  session_id: string | null;
  project_cwd: string;
  manifest_path: string;
  manifest: AppManifest;
  status: "registered" | "stopped" | "starting" | "running" | "errored";
  url: string | null;
  port: number | null;
  last_error: string | null;
  updated_at: number;
}

export interface AppStateRow {
  app_id: string;
  session_id: string | null;
  project_cwd: string;
  state: unknown;
  updated_at: number;
}

export interface AppEventRow extends AppEvent {}

export interface InterviewRecord {
  request_id: string;
  submission_id?: string;
  /** Absent on legacy records, which must not be treated as authoritative. */
  submission_channel?: InterviewSubmissionChannel;
  /** Absent on legacy records, which must not be treated as authoritative. */
  authenticated_principal?: InterviewAuthenticatedPrincipal;
  session_id: string;
  pi_session_id?: string | null;
  pi_session_file?: string | null;
  origin_tool_name: "interview" | "questionnaire";
  origin_tool_call_id?: string | null;
  questions: unknown[];
  status: "open" | "submitted" | "cancelled" | "delivered";
  answers?: unknown[];
  created_at: number;
  submitted_at?: number;
  cancelled_at?: number;
  delivered_at?: number;
  delivery_mode?: "tool_result" | "custom_message";
  delivery_entry_id?: string;
}

export type StoredScheduledJobRow = ScheduledJobRow & {
  agent_profile_id?: string | null;
  legacy_capability_ineligible?: boolean;
};

// Transitional input compatibility for pre-schema synthetic callers that push
// rows directly into getStore(). Persisted schema-1 rows are always SessionRow.
type LegacySessionRowInput = Omit<SessionRow, "pending_agent_switch" | "title_source">;
type SessionRowCollection = Omit<SessionRow[], "push"> & {
  push(...items: Array<SessionRow | LegacySessionRowInput>): number;
};

export interface StoreData {
  schema_version: typeof STORE_SCHEMA_VERSION;
  workspaceSettings: WorkspaceSettingsRow;
  workspaceCapabilityAssociations: WorkspaceCapabilityAssociationRow[];
  workspaceCapabilityApprovalEvents: WorkspaceCapabilityApprovalEventRow[];
  browserProfiles: BrowserProfileRow[];
  projectBrowserDefaults: ProjectBrowserDefaultRow[];
  sessionBrowserStates: SessionBrowserStateRow[];
  browserCleanups: BrowserCleanupRow[];
  sessions: SessionRowCollection;
  projects: ProjectRow[];
  agentProfiles: AgentProfileRow[];
  agentTeams: AgentTeamRow[];
  teamMembers: TeamMemberRow[];
  goals: GoalRow[];
  apps: AppRegistrationRow[];
  appStates: AppStateRow[];
  appEvents: AppEventRow[];
  scheduledJobs: StoredScheduledJobRow[];
  scheduledRuns: ScheduledRunRow[];
  protectedAutomationJobs: ProtectedAutomationJobRow[];
  protectedAutomationRuns: ProtectedAutomationRunRow[];
  messagingEndpoints: MessagingEndpointRow[];
  messagingEvents: MessagingEventRow[];
  messagingTransactions: MessagingTransactionRow[];
  messagingDeliveries: MessagingDeliveryRow[];
  interviews: InterviewRecord[];
}

const ARRAY_KEYS = [
  "workspaceCapabilityAssociations", "workspaceCapabilityApprovalEvents", "browserProfiles", "projectBrowserDefaults",
  "sessionBrowserStates", "browserCleanups", "sessions", "projects", "agentProfiles",
  "agentTeams", "teamMembers", "goals", "apps", "appStates", "appEvents", "scheduledJobs", "scheduledRuns",
  "protectedAutomationJobs", "protectedAutomationRuns", "messagingEndpoints", "messagingEvents",
  "messagingTransactions", "messagingDeliveries", "interviews",
] as const;

const STORE_LOCK_FILENAME = "store.json.lock";
const PROCESS_START_NONCE = randomUUID();

interface StoreLockRecord {
  pid: number;
  nonce: string;
  started_at: number;
}

interface OwnedStoreLock {
  storePath: string;
  lockPath: string;
  record: StoreLockRecord;
  dev: bigint;
  ino: bigint;
}

let _storeLock: OwnedStoreLock | null = null;

function canonicalStorePath(): string {
  const configuredDir = path.resolve(getConfig().dataDir);
  fs.mkdirSync(configuredDir, { recursive: true, mode: 0o700 });
  const dataDir = fs.realpathSync.native(configuredDir);
  return path.join(dataDir, "store.json");
}

export interface WorkspaceCapabilityProjectionBinding {
  capability_id: WorkspaceCapabilityAssociationRow["capability_id"];
  project_id: string;
  agent_profile_id: string;
}

/** Opaque model-independent project/profile/capability projection path. */
export function getWorkspaceCapabilityStoreProjectionPath(binding: WorkspaceCapabilityProjectionBinding): string {
  if (!(WORKSPACE_CAPABILITY_IDS as readonly string[]).includes(binding.capability_id)) {
    throw new Error("Unknown workspace capability projection");
  }
  const canonical: WorkspaceCapabilityProjectionBinding = {
    capability_id: binding.capability_id,
    project_id: binding.project_id,
    agent_profile_id: binding.agent_profile_id,
  };
  for (const [label, value] of Object.entries(canonical)) {
    if (typeof value !== "string" || !value || value.length > 256 || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`Invalid workspace capability projection ${label}`);
    }
  }
  const key = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return path.join(path.resolve(getConfig().dataDir), "agent-readable", "capabilities", binding.capability_id, `${key}.json`);
}


function lockRecordEquals(left: StoreLockRecord, right: StoreLockRecord): boolean {
  return left.pid === right.pid && left.nonce === right.nonce && left.started_at === right.started_at;
}

function readLockRecord(lockPath: string): { record: StoreLockRecord; stat: fs.BigIntStats } {
  const stat = fs.lstatSync(lockPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Wayang store lock is not a regular file: ${lockPath}`);
  }
  if (stat.size > 4096n) throw new Error(`Wayang store lock is unexpectedly large: ${lockPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(`Wayang store lock is malformed; refusing unsafe recovery: ${lockPath}`);
  }
  const value = raw as Partial<StoreLockRecord> | null;
  if (
    !value || typeof value !== "object" || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0
    || typeof value.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(value.nonce)
    || typeof value.started_at !== "number" || !Number.isFinite(value.started_at)
  ) {
    throw new Error(`Wayang store lock is malformed; refusing unsafe recovery: ${lockPath}`);
  }
  return { record: value as StoreLockRecord, stat };
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable. Only ESRCH is safe
    // evidence that no process currently owns this PID.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function createStoreLock(storePath: string, lockPath: string): OwnedStoreLock {
  const record: StoreLockRecord = {
    pid: process.pid,
    nonce: PROCESS_START_NONCE,
    started_at: Date.now(),
  };
  let fd: number | null = null;
  let created = false;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    created = true;
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf-8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    const stat = fs.lstatSync(lockPath, { bigint: true });
    return { storePath, lockPath, record, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    if (created) {
      try {
        const current = readLockRecord(lockPath);
        if (lockRecordEquals(current.record, record)) fs.unlinkSync(lockPath);
      } catch { /* never remove a lock whose ownership cannot be verified */ }
    }
    throw error;
  }
}

function restoreUnexpectedMovedLock(stalePath: string, lockPath: string): void {
  try {
    fs.linkSync(stalePath, lockPath);
    fs.unlinkSync(stalePath);
  } catch {
    // Never overwrite or delete either path when another contender won the
    // canonical name. Ownership checks prevent any displaced owner writing.
  }
}

function acquireStoreLock(storePath: string): OwnedStoreLock {
  const lockPath = path.join(path.dirname(storePath), STORE_LOCK_FILENAME);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return createStoreLock(storePath, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let observed: { record: StoreLockRecord; stat: fs.BigIntStats };
    try {
      observed = readLockRecord(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (pidIsLive(observed.record.pid)) {
      throw new Error(`Wayang store is already owned by live backend PID ${observed.record.pid}: ${storePath}`);
    }

    // Move the exact stale record out of the canonical name atomically, then
    // retry O_EXCL creation. If a concurrent recovery moved a newer lock, put
    // it back without overwriting any contender and fail rather than stealing.
    const stalePath = `${lockPath}.stale.${observed.record.nonce}.${PROCESS_START_NONCE}`;
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let moved: { record: StoreLockRecord; stat: fs.BigIntStats };
    try {
      moved = readLockRecord(stalePath);
    } catch (error) {
      restoreUnexpectedMovedLock(stalePath, lockPath);
      throw error;
    }
    if (
      !lockRecordEquals(moved.record, observed.record)
      || moved.stat.dev !== observed.stat.dev
      || moved.stat.ino !== observed.stat.ino
    ) {
      restoreUnexpectedMovedLock(stalePath, lockPath);
      throw new Error(`Wayang store lock changed during stale recovery: ${storePath}`);
    }

    try {
      const owned = createStoreLock(storePath, lockPath);
      try { fs.unlinkSync(stalePath); } catch { /* harmless stale artifact */ }
      return owned;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try { fs.unlinkSync(stalePath); } catch { /* verified stale record only */ }
        continue;
      }
      restoreUnexpectedMovedLock(stalePath, lockPath);
      throw error;
    }
  }
  throw new Error(`Wayang store lock acquisition did not stabilize: ${storePath}`);
}

function assertStoreLockOwned(storePath: string): void {
  const owned = _storeLock;
  if (!owned || owned.storePath !== storePath) throw new Error(`Wayang store ownership lock is not held: ${storePath}`);
  const current = readLockRecord(owned.lockPath);
  if (
    current.stat.dev !== owned.dev || current.stat.ino !== owned.ino
    || !lockRecordEquals(current.record, owned.record)
  ) {
    throw new Error(`Wayang store ownership lock was lost: ${storePath}`);
  }
}

function releaseStoreLock(): void {
  const owned = _storeLock;
  if (!owned) return;
  try {
    const current = readLockRecord(owned.lockPath);
    if (
      current.stat.dev === owned.dev && current.stat.ino === owned.ino
      && lockRecordEquals(current.record, owned.record)
    ) {
      fs.unlinkSync(owned.lockPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Refuse to remove malformed, replaced, or otherwise unverifiable locks.
    }
  } finally {
    _storeLock = null;
  }
}

process.once("exit", releaseStoreLock);

function canonicalizeLegacyCwd(cwd: string): string {
  let expanded = cwd.trim();
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
  const resolved = path.resolve(expanded);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function projectName(cwd: string): string {
  return path.basename(cwd) || cwd;
}

/**
 * Old schemas had only cwd attribution. Promote it to Project authority only
 * when one exact canonical Project row already owns that exact cwd. Never
 * guess across aliases or duplicate registrations.
 */
function backfillLegacySessionProjectIds(sessions: SessionRow[], projects: ProjectRow[]): void {
  const projectsByCwd = new Map<string, ProjectRow[]>();
  for (const project of projects) {
    if (canonicalizeLegacyCwd(project.cwd) !== project.cwd) continue;
    const matches = projectsByCwd.get(project.cwd) ?? [];
    matches.push(project);
    projectsByCwd.set(project.cwd, matches);
  }
  for (const session of sessions) {
    const matches = projectsByCwd.get(session.cwd) ?? [];
    session.project_id = matches.length === 1 ? matches[0]!.id : null;
    if (session.project_id === null) session.legacy_capability_ineligible = true;
  }
}

function legacySeededProfiles(now: number): AgentProfileRow[] {
  return [
    {
      id: WREN_AGENT_PROFILE_ID,
      name: "Wren",
      description: "Wayang's default agent using standard Pi resources.",
      builtin_kind: "wren",
      deletable: false,
      enabled: true,
      resource_mode: "standard",
      instructions: null,
      memory_access: "read_write",
      default_provider: null,
      default_model: null,
      allowed_tools: null,
      allowed_extensions: null,
      created_at: now,
      updated_at: now,
    },
    {
      id: NEUTRAL_AGENT_PROFILE_ID,
      name: "Neutral",
      description: "Project-only agent without Wren's global personal overlay.",
      builtin_kind: "neutral",
      deletable: false,
      enabled: true,
      resource_mode: "project_only",
      instructions: null,
      memory_access: "none",
      default_provider: null,
      default_model: null,
      allowed_tools: [],
      allowed_extensions: [],
      created_at: now,
      updated_at: now,
    },
  ];
}

function freshDefaultProfile(now: number): AgentProfileRow {
  return {
    id: randomUUID(),
    name: "Default",
    description: "Generic project-only workspace default.",
    builtin_kind: null,
    deletable: true,
    enabled: true,
    resource_mode: "project_only",
    instructions: null,
    memory_access: "none",
    default_provider: null,
    default_model: null,
    allowed_tools: [],
    allowed_extensions: [],
    created_at: now,
    updated_at: now,
  };
}

function emptyStore(now = Date.now()): StoreData {
  const defaultProfile = freshDefaultProfile(now);
  return {
    schema_version: STORE_SCHEMA_VERSION,
    workspaceSettings: { default_agent_profile_id: defaultProfile.id },
    workspaceCapabilityAssociations: [],
    workspaceCapabilityApprovalEvents: [],
    browserProfiles: [],
    projectBrowserDefaults: [],
    sessionBrowserStates: [],
    browserCleanups: [],
    sessions: [],
    projects: [],
    agentProfiles: [defaultProfile],
    agentTeams: [],
    teamMembers: [],
    goals: [],
    apps: [],
    appStates: [],
    appEvents: [],
    scheduledJobs: [],
    scheduledRuns: [],
    protectedAutomationJobs: [],
    protectedAutomationRuns: [],
    messagingEndpoints: [],
    messagingEvents: [],
    messagingTransactions: [],
    messagingDeliveries: [],
    interviews: [],
  };
}

function requireObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Wayang store root must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function readSchemaVersion(raw: Record<string, unknown>): number {
  if (!("schema_version" in raw)) return 0;
  if (!Number.isInteger(raw.schema_version) || (raw.schema_version as number) < 0) {
    throw new Error("Wayang store has an invalid schema_version");
  }
  return raw.schema_version as number;
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function validStableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validDefaultPair(provider: unknown, model: unknown): boolean {
  return (provider === null && model === null) || (validExactModelValue(provider) && validExactModelValue(model));
}

function validExactModelValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value === value.normalize("NFC") && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value) && !value.includes("*");
}

function validPositiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < Number.MAX_SAFE_INTEGER;
}

function capabilityPrivacyMode(capabilityId: WorkspaceCapabilityAssociationRow["capability_id"]): "standard" | "protected" {
  return capabilityId === "wayang.protected-browser.v1" || capabilityId === PROTECTED_AUTOMATION_CAPABILITY_ID
    ? "protected"
    : "standard";
}

function exactObjectKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function finiteTimestamp(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function boundedNfcText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value === value.normalize("NFC")
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validAutomationEntrypoint(value: unknown): value is string {
  return boundedNfcText(value, MAX_PROTECTED_AUTOMATION_ENTRYPOINT_BYTES)
    && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

function validAutomationArgv(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_PROTECTED_AUTOMATION_ARGV_ITEMS) return false;
  let bytes = 0;
  for (const item of value) {
    if (!boundedNfcText(item, MAX_PROTECTED_AUTOMATION_ARG_BYTES, true)) return false;
    bytes += Buffer.byteLength(item, "utf8");
  }
  return bytes <= MAX_PROTECTED_AUTOMATION_ARGV_BYTES;
}

function validAutomationOrigins(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_PROTECTED_AUTOMATION_HTTPS_ORIGINS) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > MAX_PROTECTED_AUTOMATION_ORIGIN_BYTES) return false;
    let parsed: URL;
    try { parsed = new URL(item); } catch { return false; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash || parsed.origin !== item || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function validAutomationCron(value: unknown): value is string {
  if (!boundedNfcText(value, MAX_PROTECTED_AUTOMATION_CRON_BYTES) || value.trim() !== value) return false;
  try { validateCronExpression(value); return true; } catch { return false; }
}

function validLocalOccurrenceKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const roundTrip = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return year >= 1 && roundTrip.getUTCFullYear() === year && roundTrip.getUTCMonth() === month - 1
    && roundTrip.getUTCDate() === day && roundTrip.getUTCHours() === hour && roundTrip.getUTCMinutes() === minute;
}

function protectedAutomationLocalOccurrenceKey(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function validateProtectedAutomationRows(
  raw: Record<string, unknown>,
  projectIds: ReadonlySet<string>,
  profileIds: ReadonlySet<string>,
  associationsByKey: ReadonlyMap<string, WorkspaceCapabilityAssociationRow>,
): void {
  const jobs = raw.protectedAutomationJobs as unknown[];
  const runs = raw.protectedAutomationRuns as unknown[];
  if (jobs.length > MAX_PROTECTED_AUTOMATION_JOBS) throw new Error("Wayang protected automation job limit exceeded");
  const jobIds = new Set<string>();
  const jobsById = new Map<string, ProtectedAutomationJobRow>();
  const jobKeys = [
    "id", "project_id", "agent_profile_id", "capability_revision", "revision", "source_revision", "name", "source_manifest_sha256",
    "entrypoint", "argv", "uses_browser_profile", "allowed_https_origins", "cron_expr", "timezone", "timeout_ms",
    "overlap_policy", "missed_run_policy", "enabled", "blocked_reason", "deleted_at", "created_at", "updated_at",
    "schedule_cursor_at", "last_occurrence_key", "last_run_at", "next_run_at",
  ] as const;
  for (const [index, candidate] of jobs.entries()) {
    const value = candidate as Partial<ProtectedAutomationJobRow> | null;
    if (!value || typeof value !== "object" || !exactObjectKeys(value, jobKeys)
      || !validStableId(value.id) || !validStableId(value.project_id) || !validStableId(value.agent_profile_id)
      || !validPositiveRevision(value.capability_revision) || !validPositiveRevision(value.revision)
      || !validPositiveRevision(value.source_revision) || value.source_revision! > value.revision!
      || !boundedNfcText(value.name, MAX_PROTECTED_AUTOMATION_NAME_BYTES)
      || typeof value.source_manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.source_manifest_sha256)
      || !validAutomationEntrypoint(value.entrypoint) || !validAutomationArgv(value.argv)
      || typeof value.uses_browser_profile !== "boolean" || !validAutomationOrigins(value.allowed_https_origins)
      || !validAutomationCron(value.cron_expr) || value.timezone !== "local"
      || !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms! < MIN_PROTECTED_AUTOMATION_TIMEOUT_MS
      || value.timeout_ms! > MAX_PROTECTED_AUTOMATION_TIMEOUT_MS || value.overlap_policy !== "skip"
      || !["skip", "run_once"].includes(value.missed_run_policy ?? "")
      || typeof value.enabled !== "boolean"
      || !(value.blocked_reason === null || boundedNfcText(value.blocked_reason, 256))
      || (value.enabled ? value.blocked_reason !== null : value.blocked_reason === null)
      || !finiteTimestamp(value.deleted_at, true) || !finiteTimestamp(value.created_at) || !finiteTimestamp(value.updated_at)
      || value.updated_at! < value.created_at! || (value.deleted_at !== null && value.deleted_at! < value.created_at!)
      || !finiteTimestamp(value.schedule_cursor_at) || value.schedule_cursor_at! < value.created_at!
      || !(value.last_occurrence_key === null || validLocalOccurrenceKey(value.last_occurrence_key))
      || !finiteTimestamp(value.last_run_at, true) || !finiteTimestamp(value.next_run_at, true)
      || (!value.enabled && value.next_run_at !== null)
      || (value.deleted_at !== null && (value.enabled || value.blocked_reason !== "tombstoned"))) {
      throw new Error(`Wayang store contains a malformed protected automation job at index ${index}`);
    }
    if (jobIds.has(value.id)) throw new Error("Wayang store contains duplicate protected automation job ids");
    jobIds.add(value.id);
    const row = value as ProtectedAutomationJobRow;
    jobsById.set(row.id, row);
    if (row.deleted_at === null) {
      if (!projectIds.has(row.project_id) || !profileIds.has(row.agent_profile_id)) {
        throw new Error("Wayang store contains an orphan live protected automation job");
      }
      const association = associationsByKey.get(`${row.project_id}\u0000${row.agent_profile_id}\u0000${PROTECTED_AUTOMATION_CAPABILITY_ID}`);
      if (!association || association.revision < row.capability_revision) {
        throw new Error("Wayang store contains unattributed protected automation capability state");
      }
      if ((!association.active || association.revision !== row.capability_revision) && row.blocked_reason === null) {
        throw new Error("Wayang store contains an unblocked stale protected automation job");
      }
    }
  }

  const runIds = new Set<string>();
  const occurrenceClaims = new Set<string>();
  const runCounts = new Map<string, number>();
  const lastRunAtByJob = new Map<string, number>();
  const latestCurrentOccurrenceByJob = new Map<string, { scheduledFor: number; id: string; occurrenceKey: string }>();
  const runKeys = [
    "id", "job_id", "project_id", "agent_profile_id", "job_revision", "capability_revision", "trigger",
    "scheduled_for", "occurrence_key", "started_at", "finished_at", "status", "outcome_code", "exit_code",
  ] as const;
  for (const [index, candidate] of runs.entries()) {
    const value = candidate as Partial<ProtectedAutomationRunRow> | null;
    const job = value && typeof value === "object" && typeof value.job_id === "string" ? jobsById.get(value.job_id) : undefined;
    if (!value || typeof value !== "object" || !exactObjectKeys(value, runKeys)
      || !validStableId(value.id) || !validStableId(value.job_id) || !validStableId(value.project_id)
      || !validStableId(value.agent_profile_id) || !validPositiveRevision(value.job_revision)
      || !validPositiveRevision(value.capability_revision) || !["schedule", "manual"].includes(value.trigger ?? "")
      || !finiteTimestamp(value.scheduled_for, true)
      || !(value.occurrence_key === null || validLocalOccurrenceKey(value.occurrence_key))
      // Historical wall-minute claims remain valid if the host timezone later changes.
      // Exact timestamp/key matching is enforced transactionally when a claim is created.
      || (value.trigger === "schedule" ? (value.scheduled_for === null || value.occurrence_key === null)
        : (value.scheduled_for !== null || value.occurrence_key !== null))
      || !finiteTimestamp(value.started_at) || !finiteTimestamp(value.finished_at, true)
      || !["queued", "running", "completed", "failed", "skipped", "cancelled", "needs_user", "interrupted", "denied"].includes(value.status ?? "")
      || (["queued", "running"].includes(value.status ?? "")
        ? value.finished_at !== null || value.outcome_code !== null || value.exit_code !== null
        : value.finished_at === null || value.finished_at! < value.started_at!
          || !boundedNfcText(value.outcome_code, MAX_PROTECTED_AUTOMATION_OUTCOME_CODE_BYTES))
      || !(value.exit_code === null || (Number.isSafeInteger(value.exit_code) && value.exit_code! >= 0 && value.exit_code! <= 255))
      || (value.scheduled_for !== null && value.scheduled_for! > value.started_at!)
      || !job || value.project_id !== job.project_id || value.agent_profile_id !== job.agent_profile_id
      || value.started_at! < job.created_at || value.job_revision! > job.revision
      || value.capability_revision! > job.capability_revision) {
      throw new Error(`Wayang store contains a malformed protected automation run at index ${index}`);
    }
    if (runIds.has(value.id)) throw new Error("Wayang store contains duplicate protected automation run ids");
    runIds.add(value.id);
    if (value.occurrence_key !== null) {
      const claim = `${value.job_id}\u0000${value.occurrence_key}`;
      if (occurrenceClaims.has(claim)) throw new Error("Wayang store contains duplicate protected automation occurrence claims");
      occurrenceClaims.add(claim);
    }
    const count = (runCounts.get(value.job_id) ?? 0) + 1;
    if (count > MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB) throw new Error("Wayang protected automation run history limit exceeded");
    runCounts.set(value.job_id, count);
    lastRunAtByJob.set(value.job_id, Math.max(lastRunAtByJob.get(value.job_id) ?? 0, value.started_at!));
    if ((value.finished_at ?? value.started_at!) > job.updated_at) {
      throw new Error("Wayang store contains a protected automation run newer than its job metadata");
    }
    if (typeof value.scheduled_for === "number" && value.scheduled_for > job.schedule_cursor_at) {
      throw new Error("Wayang store contains a protected automation occurrence beyond its job cursor");
    }
    if (value.job_revision === job.revision && typeof value.scheduled_for === "number"
      && typeof value.occurrence_key === "string") {
      const prior = latestCurrentOccurrenceByJob.get(job.id);
      if (!prior || value.scheduled_for > prior.scheduledFor
        || (value.scheduled_for === prior.scheduledFor && value.id > prior.id)) {
        latestCurrentOccurrenceByJob.set(job.id, {
          scheduledFor: value.scheduled_for,
          id: value.id,
          occurrenceKey: value.occurrence_key,
        });
      }
    }
  }
  for (const job of jobsById.values()) {
    const expectedLastRunAt = lastRunAtByJob.get(job.id) ?? null;
    if (job.last_run_at !== expectedLastRunAt) {
      throw new Error("Wayang store contains incoherent protected automation last-run metadata");
    }
    const latestCurrentOccurrence = latestCurrentOccurrenceByJob.get(job.id);
    if (latestCurrentOccurrence && job.last_occurrence_key !== latestCurrentOccurrence.occurrenceKey) {
      throw new Error("Wayang store contains incoherent protected automation current occurrence metadata");
    }
    if (!latestCurrentOccurrence && job.last_occurrence_key !== null
      && !occurrenceClaims.has(`${job.id}\u0000${job.last_occurrence_key}`)) {
      throw new Error("Wayang store contains an unclaimed protected automation last occurrence");
    }
  }
}

function validateCurrentStore(raw: Record<string, unknown>): StoreData {
  const allowedRootKeys = new Set<string>(["schema_version", "workspaceSettings", ...ARRAY_KEYS]);
  for (const key of Object.keys(raw)) {
    if (!allowedRootKeys.has(key)) throw new Error(`Wayang store contains unsupported field ${key}`);
  }
  for (const key of ARRAY_KEYS) {
    if (!Array.isArray(raw[key])) throw new Error(`Wayang store field ${key} must be an array`);
  }
  const settings = raw.workspaceSettings as Partial<WorkspaceSettingsRow> | null;
  if (!settings || typeof settings !== "object" || typeof settings.default_agent_profile_id !== "string" || !settings.default_agent_profile_id) {
    throw new Error("Wayang store contains malformed workspace settings");
  }
  const sessionIds = new Set<string>();
  for (const [index, session] of (raw.sessions as unknown[]).entries()) {
    if (
      !session || typeof session !== "object" || typeof (session as SessionRow).id !== "string"
      || typeof (session as SessionRow).title !== "string"
      || typeof (session as SessionRow).cwd !== "string"
      || !["provisional", "explicit", "pi", "legacy_unknown"].includes((session as SessionRow).title_source)
      || !("project_id" in session)
      || !((session as SessionRow).project_id === null || validStableId((session as SessionRow).project_id))
      || !("agent_profile_id" in session) || !("pending_agent_switch" in session)
      || "finance_private_data_taint" in session
      || typeof (session as SessionRow).legacy_private_session_quarantine !== "boolean"
      || typeof (session as SessionRow).legacy_capability_ineligible !== "boolean"
      || ((session as SessionRow).legacy_private_session_quarantine && !(session as SessionRow).legacy_capability_ineligible)
      || ((session as SessionRow).agent_profile_id === null && !(session as SessionRow).legacy_capability_ineligible)
      || ((session as SessionRow).project_id === null && !(session as SessionRow).legacy_capability_ineligible)
    ) {
      throw new Error(`Wayang store contains a malformed session at index ${index}`);
    }
    const sessionId = (session as SessionRow).id;
    if (sessionIds.has(sessionId)) throw new Error("Wayang store contains duplicate session ids");
    sessionIds.add(sessionId);
  }
  const profileIds = new Set<string>();
  for (const profile of raw.agentProfiles as unknown[]) {
    const value = profile as Partial<AgentProfileRow> | null;
    if (
      !value || typeof value !== "object" || Object.hasOwn(value, "capability_grants") || Object.hasOwn(value, "authorization_revision")
      || !validStableId(value.id) || typeof value.name !== "string" || !value.name
      || !nullableString(value.description) || !["wren", "neutral", null].includes(value.builtin_kind as "wren" | "neutral" | null)
      || typeof value.deletable !== "boolean" || typeof value.enabled !== "boolean"
      || !["standard", "project_only", "custom"].includes(value.resource_mode ?? "")
      || !nullableString(value.instructions) || !["none", "read", "read_write"].includes(value.memory_access ?? "")
      || !validDefaultPair(value.default_provider, value.default_model)
      || !(value.allowed_tools === null || (Array.isArray(value.allowed_tools) && value.allowed_tools.every((name) => typeof name === "string")))
      || !(value.allowed_extensions === null || (Array.isArray(value.allowed_extensions) && value.allowed_extensions.every((name) => typeof name === "string")))
      || typeof value.created_at !== "number" || typeof value.updated_at !== "number"
    ) throw new Error("Wayang store contains a malformed agent profile");
    if (profileIds.has(value.id)) throw new Error("Wayang store contains duplicate agent profile ids");
    profileIds.add(value.id);
  }
  if (!profileIds.has(settings.default_agent_profile_id)) throw new Error("Wayang workspace default references an unknown agent profile");
  if (!(raw.agentProfiles as AgentProfileRow[]).find((profile) => profile.id === settings.default_agent_profile_id)?.enabled) {
    throw new Error("Wayang workspace default agent profile must be enabled");
  }

  const projectIds = new Set<string>();
  const projectsById = new Map<string, ProjectRow>();
  const projectCwds = new Set<string>();
  for (const project of raw.projects as unknown[]) {
    const value = project as Partial<ProjectRow> | null;
    const policy = value?.access_policy;
    const allowed = policy?.allowed_agent_profile_ids;
    if (
      !value || typeof value !== "object" || Object.hasOwn(value, "capability_grants") || Object.hasOwn(value, "authorization_revision")
      || !validStableId(value.id) || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)
      || canonicalizeLegacyCwd(value.cwd) !== value.cwd
      || typeof value.name !== "string" || !nullableString(value.description) || !nullableString(value.color)
      || typeof value.default_agent_profile_id !== "string" || !validDefaultPair(value.default_provider, value.default_model)
      || !policy || !["standard", "protected"].includes(policy.privacy_mode)
      || !(allowed === null || (Array.isArray(allowed) && allowed.every((id) => typeof id === "string" && profileIds.has(id))))
      || (policy.privacy_mode === "protected" && (!allowed || allowed.length === 0))
      || (Array.isArray(allowed) && !allowed.includes(value.default_agent_profile_id))
      || typeof value.created_at !== "number" || typeof value.updated_at !== "number"
    ) throw new Error("Wayang store contains a malformed project");
    if (projectIds.has(value.id) || projectCwds.has(value.cwd)) throw new Error("Wayang store contains duplicate project ids or cwds");
    if (!profileIds.has(value.default_agent_profile_id)) throw new Error("Wayang project references an unknown default agent profile");
    projectIds.add(value.id);
    projectsById.set(value.id, value as ProjectRow);
    projectCwds.add(value.cwd);
  }

  for (const session of raw.sessions as SessionRow[]) {
    if (session.project_id !== null) {
      const project = projectsById.get(session.project_id!);
      if (!project || session.cwd !== project.cwd || canonicalizeLegacyCwd(session.cwd) !== project.cwd) {
        throw new Error("Wayang session Project attribution does not match its canonical cwd");
      }
    }
    if (session.agent_profile_id !== null && (typeof session.agent_profile_id !== "string" || !profileIds.has(session.agent_profile_id))) {
      throw new Error("Wayang session references an unknown agent profile");
    }
    const pending = session.pending_agent_switch;
    if (pending !== null && (
      !pending || typeof pending !== "object" || typeof pending.switch_id !== "string" || !pending.switch_id
      || !(pending.from_agent_profile_id === null || (typeof pending.from_agent_profile_id === "string" && profileIds.has(pending.from_agent_profile_id)))
      || !validDefaultPair(pending.from_provider, pending.from_model)
      || typeof pending.to_agent_profile_id !== "string" || !profileIds.has(pending.to_agent_profile_id)
      || !(raw.agentProfiles as AgentProfileRow[]).find((profile) => profile.id === pending.to_agent_profile_id)?.enabled
      || pending.from_agent_profile_id !== (session.agent_profile_id ?? null)
      || pending.from_provider !== session.provider || pending.from_model !== session.model
      || typeof pending.target_provider !== "string" || !pending.target_provider
      || typeof pending.target_model !== "string" || !pending.target_model
      || typeof pending.changed_at !== "number" || !Number.isFinite(pending.changed_at)
    )) {
      throw new Error("Wayang session contains a malformed pending agent switch");
    }
  }

  const associationKeys = new Set<string>();
  const associationsByKey = new Map<string, WorkspaceCapabilityAssociationRow>();
  for (const candidate of raw.workspaceCapabilityAssociations as unknown[]) {
    const value = candidate as Partial<WorkspaceCapabilityAssociationRow> | null;
    if (
      !value || typeof value !== "object"
      || Object.keys(value).sort().join(",") !== "active,agent_profile_id,approved_at,capability_id,project_id,revision,revoked_at,updated_at"
      || !validStableId(value.project_id)
      || !validStableId(value.agent_profile_id)
      || !(WORKSPACE_CAPABILITY_IDS as readonly unknown[]).includes(value.capability_id)
      || !validPositiveRevision(value.revision) || typeof value.active !== "boolean"
      || typeof value.approved_at !== "number" || !Number.isFinite(value.approved_at) || value.approved_at < 0
      || typeof value.updated_at !== "number" || !Number.isFinite(value.updated_at) || value.updated_at < value.approved_at
      || (value.active && value.revoked_at !== null)
      || (!value.active && !(typeof value.revoked_at === "number" && Number.isFinite(value.revoked_at) && value.revoked_at >= value.approved_at))
    ) throw new Error("Wayang store contains a malformed workspace capability association");
    const key = `${value.project_id}\u0000${value.agent_profile_id}\u0000${value.capability_id}`;
    if (associationKeys.has(key)) throw new Error("Wayang store contains duplicate workspace capability associations");
    associationKeys.add(key);
    associationsByKey.set(key, value as WorkspaceCapabilityAssociationRow);
    if (value.active) {
      const project = (raw.projects as ProjectRow[]).find((row) => row.id === value.project_id);
      if (!project || !profileIds.has(value.agent_profile_id)) throw new Error("Wayang store contains an active orphan workspace capability association");
      if (capabilityPrivacyMode(value.capability_id!) !== project.access_policy.privacy_mode) {
        throw new Error("Wayang store contains an active privacy-incompatible capability association");
      }
      const allowed = project.access_policy.allowed_agent_profile_ids;
      if (allowed !== null && !allowed.includes(value.agent_profile_id)) {
        throw new Error("Wayang store contains an active allowlist-incompatible capability association");
      }
    }
  }

  if ((raw.workspaceCapabilityApprovalEvents as unknown[]).length > 4_096) {
    throw new Error("Wayang workspace capability approval history exceeds its durable limit");
  }
  const approvalEventIds = new Set<string>();
  const approvalMembershipKeys = new Set<string>();
  for (const candidate of raw.workspaceCapabilityApprovalEvents as unknown[]) {
    const value = candidate as Partial<WorkspaceCapabilityApprovalEventRow> | null;
    if (
      !value || typeof value !== "object"
      || Object.keys(value).sort().join(",") !== "agent_profile_id,approved_at,association_revision,capability_id,id,operation_digest,project_id,revoked_at"
      || !validStableId(value.id)
      || !validStableId(value.project_id)
      || !validStableId(value.agent_profile_id)
      || !(WORKSPACE_CAPABILITY_IDS as readonly unknown[]).includes(value.capability_id)
      || !validPositiveRevision(value.association_revision)
      || typeof value.operation_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.operation_digest)
      || typeof value.approved_at !== "number" || !Number.isFinite(value.approved_at) || value.approved_at < 0
      || !(value.revoked_at === null || (typeof value.revoked_at === "number" && Number.isFinite(value.revoked_at) && value.revoked_at >= value.approved_at))
    ) throw new Error("Wayang store contains a malformed workspace capability approval event");
    if (approvalEventIds.has(value.id)) throw new Error("Wayang store contains duplicate workspace capability approval event ids");
    approvalEventIds.add(value.id);
    const key = `${value.project_id}\u0000${value.agent_profile_id}\u0000${value.capability_id}`;
    const membershipKey = `${key}\u0000${value.association_revision}`;
    if (approvalMembershipKeys.has(membershipKey)) throw new Error("Wayang store contains duplicate workspace capability approval event membership");
    approvalMembershipKeys.add(membershipKey);
    const association = associationsByKey.get(key);
    if (association && association.revision < value.association_revision!) {
      throw new Error("Wayang store contains rolled-back workspace capability association revision state");
    }
  }
  validateProtectedAutomationRows(raw, projectIds, profileIds, associationsByKey);
  validateBrowserCatalogRows({
    dataDir: getConfig().dataDir,
    browserProfiles: raw.browserProfiles,
    projectBrowserDefaults: raw.projectBrowserDefaults,
    sessionBrowserStates: raw.sessionBrowserStates,
    browserCleanups: raw.browserCleanups,
    projectIds,
    sessionIds,
  });
  validateMessagingStoreRows({
    messagingEndpoints: raw.messagingEndpoints as unknown[],
    messagingEvents: raw.messagingEvents as unknown[],
    messagingTransactions: raw.messagingTransactions as unknown[],
    messagingDeliveries: raw.messagingDeliveries as unknown[],
  }, {
    projects: raw.projects as ProjectRow[],
    agentProfiles: raw.agentProfiles as AgentProfileRow[],
    sessions: raw.sessions as SessionRow[],
  });
  for (const [index, job] of (raw.scheduledJobs as unknown[]).entries()) {
    const value = job as StoredScheduledJobRow | null;
    if (!value || typeof value !== "object" || typeof value.legacy_capability_ineligible !== "boolean") {
      throw new Error(`Wayang store contains a malformed scheduled job attribution at index ${index}`);
    }
    if ((value.agent_profile_id === null || value.agent_profile_id === undefined) && !value.legacy_capability_ineligible) {
      throw new Error(`Wayang scheduled job ${index} has ambiguous capability attribution`);
    }
  }
  for (const [index, interview] of (raw.interviews as unknown[]).entries()) {
    if (!isPlausibleInterviewRecord(interview)) throw new Error(`Wayang store contains a malformed interview at index ${index}`);
  }
  return raw as unknown as StoreData;
}

export function classifyMigratedSessionTitleSource(title: unknown): SessionTitleSource {
  return typeof title === "string" && title.trim() ? "legacy_unknown" : "provisional";
}

const BROWSER_CATALOG_ARRAY_KEYS = ["browserProfiles", "projectBrowserDefaults", "sessionBrowserStates", "browserCleanups"] as const;

function browserCatalogMigrationFields(data: Pick<StoreData, "workspaceCapabilityAssociations" | "projects" | "agentProfiles">, now = Date.now()) {
  return {
    browserProfiles: inventoryBrowserProfilesForSchemaFour({
      dataDir: getConfig().dataDir,
      associations: data.workspaceCapabilityAssociations,
      projects: data.projects,
      agentProfiles: data.agentProfiles,
      now,
    }),
    projectBrowserDefaults: [] as ProjectBrowserDefaultRow[],
    sessionBrowserStates: [] as SessionBrowserStateRow[],
    browserCleanups: [] as BrowserCleanupRow[],
  };
}

function normalizeLegacyStore(raw: Record<string, unknown>): StoreData {
  const now = Date.now();
  const data = emptyStore(now);
  // Schema-0 had no profile control plane. Preserve its former default as
  // stable migration rows. Migration creates no capability grant; the exact
  // Wren row retains only the documented Standard-project global workspace compatibility.
  data.agentProfiles = legacySeededProfiles(now);
  data.workspaceSettings = { default_agent_profile_id: WREN_AGENT_PROFILE_ID };
  const legacyKeys = new Set<string>(ARRAY_KEYS.filter((key) =>
    key !== "workspaceCapabilityAssociations" && key !== "workspaceCapabilityApprovalEvents"
    && key !== "projects" && key !== "agentProfiles"
    && key !== "protectedAutomationJobs" && key !== "protectedAutomationRuns"
    && key !== "messagingEndpoints" && key !== "messagingEvents"
    && key !== "messagingTransactions" && key !== "messagingDeliveries"
    && !BROWSER_CATALOG_ARRAY_KEYS.includes(key as typeof BROWSER_CATALOG_ARRAY_KEYS[number])));
  for (const key of Object.keys(raw)) {
    if (!legacyKeys.has(key)) throw new Error(`Legacy Wayang store contains unsupported field ${key}`);
  }
  for (const key of ARRAY_KEYS) {
    const value = raw[key];
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`Legacy Wayang store field ${key} must be an array`);
    }
  }

  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  data.sessions = sessions.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Legacy Wayang session ${index} is malformed`);
    const session = { ...(value as Partial<SessionRow>) };
    // Older stores may omit nullable fields that were added after the first
    // session schema. Absence is equivalent to the legacy null default; do not
    // reject an otherwise valid durable session during the v0 -> v1 migration.
    session.pi_session_file ??= null;
    session.provider ??= null;
    session.model ??= null;
    if (
      typeof session.id !== "string" || !session.id || typeof session.cwd !== "string" || !session.cwd.trim()
      || typeof session.title !== "string" || !nullableString(session.pi_session_file)
      || !nullableString(session.provider) || !nullableString(session.model)
      || typeof session.created_at !== "number" || typeof session.last_active !== "number" || typeof session.archived !== "number"
    ) {
      throw new Error(`Legacy Wayang session ${index} is malformed`);
    }
    if (
      "finance_private_data_taint" in session
      && typeof session.finance_private_data_taint !== "boolean"
    ) {
      throw new Error(`Legacy Wayang session ${index} has a malformed Finance private-data taint`);
    }
    const privateQuarantine = session.finance_private_data_taint === true;
    delete session.finance_private_data_taint;
    session.title_source = classifyMigratedSessionTitleSource(session.title);
    session.agent_profile_id = null;
    session.pending_agent_switch = null;
    session.legacy_private_session_quarantine = privateQuarantine;
    session.legacy_capability_ineligible = true;
    session.scheduled_job_id ??= null;
    session.scheduled_run_id ??= null;
    session.error ??= null;
    session.archived_at ??= session.archived ? session.last_active ?? null : null;
    session.catalog_fingerprint ??= null;
    session.catalog_mutation_version ??= 0;
    return session as SessionRow;
  }) as SessionRowCollection;

  const copyArray = <K extends keyof StoreData>(key: K): void => {
    if (Array.isArray(raw[key])) (data[key] as unknown[]) = [...(raw[key] as unknown[])];
  };
  copyArray("agentTeams");
  copyArray("teamMembers");
  copyArray("goals");
  copyArray("apps");
  copyArray("appStates");
  copyArray("appEvents");
  copyArray("scheduledRuns");

  data.scheduledJobs = (Array.isArray(raw.scheduledJobs) ? raw.scheduledJobs : []).map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Legacy scheduled job ${index} is malformed`);
    return {
      ...(value as StoredScheduledJobRow),
      command_guard_mode: (value as StoredScheduledJobRow).command_guard_mode ?? "default",
      agent_profile_id: null,
      legacy_capability_ineligible: true,
    };
  });
  data.interviews = (Array.isArray(raw.interviews) ? raw.interviews : []).map((record, index) => {
    if (!isPlausibleInterviewRecord(record)) throw new Error(`Legacy interview ${index} is malformed`);
    return { ...record };
  });

  const byCwd = new Set<string>();
  for (const session of data.sessions) {
    const cwd = canonicalizeLegacyCwd(session.cwd);
    session.cwd = cwd;
    if (byCwd.has(cwd)) continue;
    byCwd.add(cwd);
    data.projects.push({
      id: randomUUID(),
      cwd,
      name: projectName(cwd),
      description: null,
      color: null,
      default_agent_profile_id: WREN_AGENT_PROFILE_ID,
      default_provider: null,
      default_model: null,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
      created_at: now,
      updated_at: now,
    });
  }
  backfillLegacySessionProjectIds(data.sessions as SessionRow[], data.projects);
  Object.assign(data, browserCatalogMigrationFields(data, now));
  return data;
}

function normalizeSchemaOneStore(raw: Record<string, unknown>): StoreData {
  const now = Date.now();
  const requiredArrays = [
    "sessions", "projects", "agentProfiles", "agentTeams", "teamMembers", "goals",
    "apps", "appStates", "appEvents", "scheduledJobs", "scheduledRuns", "interviews",
  ] as const;
  const allowedKeys = new Set<string>(["schema_version", ...requiredArrays]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`Schema-1 Wayang store contains unsupported field ${key}`);
  }
  for (const key of requiredArrays) {
    if (!Array.isArray(raw[key])) throw new Error(`Schema-1 Wayang store field ${key} must be an array`);
  }
  const profiles = (raw.agentProfiles as unknown[]).map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("Schema-1 Wayang store contains a malformed agent profile");
    const profile = { ...(candidate as AgentProfileRow) } as AgentProfileRow & Record<string, unknown>;
    delete profile.capability_grants;
    delete profile.authorization_revision;
    return profile;
  });
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const compatibilityDefault = profileIds.has(WREN_AGENT_PROFILE_ID)
    ? WREN_AGENT_PROFILE_ID
    : profiles[0]?.id;
  if (!compatibilityDefault) throw new Error("Schema-1 Wayang store has no profile for its workspace default");
  const sessions = (raw.sessions as unknown[]).map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error(`Schema-1 Wayang session ${index} is malformed`);
    const session = { ...(candidate as SessionRow) };
    const privateQuarantine = session.finance_private_data_taint === true;
    delete session.finance_private_data_taint;
    session.title_source = classifyMigratedSessionTitleSource(session.title);
    session.legacy_private_session_quarantine = privateQuarantine;
    session.legacy_capability_ineligible = privateQuarantine
      || session.agent_profile_id === null || session.agent_profile_id === undefined;
    session.agent_profile_id ??= null;
    return session;
  }) as SessionRowCollection;
  const projects = (raw.projects as unknown[]).map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("Schema-1 Wayang store contains a malformed project");
    const project = { ...(candidate as ProjectRow) } as ProjectRow & Record<string, unknown>;
    delete project.capability_grants;
    delete project.authorization_revision;
    return project;
  });
  const scheduledJobs = (raw.scheduledJobs as unknown[]).map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error(`Schema-1 scheduled job ${index} is malformed`);
    const job = { ...(candidate as StoredScheduledJobRow) };
    job.legacy_capability_ineligible = job.agent_profile_id === null || job.agent_profile_id === undefined;
    job.agent_profile_id ??= null;
    return job;
  });
  const data: StoreData = {
    schema_version: STORE_SCHEMA_VERSION,
    workspaceSettings: { default_agent_profile_id: compatibilityDefault },
    workspaceCapabilityAssociations: [],
    workspaceCapabilityApprovalEvents: [],
    browserProfiles: [],
    projectBrowserDefaults: [],
    sessionBrowserStates: [],
    browserCleanups: [],
    sessions,
    projects,
    agentProfiles: profiles,
    agentTeams: structuredClone(raw.agentTeams) as AgentTeamRow[],
    teamMembers: structuredClone(raw.teamMembers) as TeamMemberRow[],
    goals: structuredClone(raw.goals) as GoalRow[],
    apps: structuredClone(raw.apps) as AppRegistrationRow[],
    appStates: structuredClone(raw.appStates) as AppStateRow[],
    appEvents: structuredClone(raw.appEvents) as AppEventRow[],
    scheduledJobs,
    scheduledRuns: structuredClone(raw.scheduledRuns) as ScheduledRunRow[],
    protectedAutomationJobs: [],
    protectedAutomationRuns: [],
    messagingEndpoints: [],
    messagingEvents: [],
    messagingTransactions: [],
    messagingDeliveries: [],
    interviews: structuredClone(raw.interviews) as InterviewRecord[],
  };
  // Migration changes only schema-owned authority metadata. Existing display
  // names, descriptions, defaults, and ordinary runtime fields remain intact.
  for (const profile of data.agentProfiles) profile.updated_at = profile.updated_at ?? now;
  backfillLegacySessionProjectIds(data.sessions as SessionRow[], data.projects);
  Object.assign(data, browserCatalogMigrationFields(data, now));
  return validateCurrentStore(data as unknown as Record<string, unknown>);
}

function normalizeSchemaTwoStore(raw: Record<string, unknown>): StoreData {
  const schemaTwoArrayKeys = ARRAY_KEYS.filter((key) => key !== "protectedAutomationJobs" && key !== "protectedAutomationRuns"
    && key !== "messagingEndpoints" && key !== "messagingEvents"
    && key !== "messagingTransactions" && key !== "messagingDeliveries"
    && !BROWSER_CATALOG_ARRAY_KEYS.includes(key as typeof BROWSER_CATALOG_ARRAY_KEYS[number]));
  const allowedKeys = new Set<string>(["schema_version", "workspaceSettings", ...schemaTwoArrayKeys]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`Schema-2 Wayang store contains unsupported field ${key}`);
  }
  for (const key of schemaTwoArrayKeys) {
    if (!Array.isArray(raw[key])) throw new Error(`Schema-2 Wayang store field ${key} must be an array`);
  }
  for (const collection of [raw.workspaceCapabilityAssociations, raw.workspaceCapabilityApprovalEvents] as unknown[][]) {
    if (collection.some((candidate) => candidate && typeof candidate === "object"
      && (candidate as { capability_id?: unknown }).capability_id === PROTECTED_AUTOMATION_CAPABILITY_ID)) {
      throw new Error("Schema-2 Wayang store cannot contain protected automation authority");
    }
  }
  // Schema 2 had no automation domain. Migration deliberately creates no
  // authority, job, run, timer cursor, browser realm, or execution request.
  const migrated = {
    ...structuredClone(raw),
    schema_version: STORE_SCHEMA_VERSION,
    protectedAutomationJobs: [],
    protectedAutomationRuns: [],
    messagingEndpoints: [],
    messagingEvents: [],
    messagingTransactions: [],
    messagingDeliveries: [],
    browserProfiles: [],
    projectBrowserDefaults: [],
    sessionBrowserStates: [],
    browserCleanups: [],
  } as unknown as StoreData;
  for (const session of migrated.sessions) session.title_source = classifyMigratedSessionTitleSource(session.title);
  backfillLegacySessionProjectIds(migrated.sessions as SessionRow[], migrated.projects);
  Object.assign(migrated, browserCatalogMigrationFields(migrated));
  return validateCurrentStore(migrated as unknown as Record<string, unknown>);
}

function normalizeSchemaThreeStore(raw: Record<string, unknown>): StoreData {
  const messagingKeys = new Set(["messagingEndpoints", "messagingEvents", "messagingTransactions", "messagingDeliveries"]);
  const schemaThreeArrayKeys = ARRAY_KEYS.filter((key) => !messagingKeys.has(key)
    && !BROWSER_CATALOG_ARRAY_KEYS.includes(key as typeof BROWSER_CATALOG_ARRAY_KEYS[number]));
  const allowedKeys = new Set<string>(["schema_version", "workspaceSettings", ...schemaThreeArrayKeys]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`Schema-3 Wayang store contains unsupported field ${key}`);
  }
  for (const key of schemaThreeArrayKeys) {
    if (!Array.isArray(raw[key])) throw new Error(`Schema-3 Wayang store field ${key} must be an array`);
  }
  // Schema 3 had no messaging domain. Migration creates no endpoint,
  // conversation binding, event claim, transaction, delivery, or authority.
  const migrated = {
    ...structuredClone(raw),
    schema_version: STORE_SCHEMA_VERSION,
    messagingEndpoints: [],
    messagingEvents: [],
    messagingTransactions: [],
    messagingDeliveries: [],
    browserProfiles: [],
    projectBrowserDefaults: [],
    sessionBrowserStates: [],
    browserCleanups: [],
  } as unknown as StoreData;
  for (const session of migrated.sessions) session.title_source = classifyMigratedSessionTitleSource(session.title);
  backfillLegacySessionProjectIds(migrated.sessions as SessionRow[], migrated.projects);
  Object.assign(migrated, browserCatalogMigrationFields(migrated));
  return validateCurrentStore(migrated as unknown as Record<string, unknown>);
}

function normalizeSchemaFourStore(raw: Record<string, unknown>): StoreData {
  const schemaFourArrayKeys = ARRAY_KEYS.filter((key) => !BROWSER_CATALOG_ARRAY_KEYS.includes(key as typeof BROWSER_CATALOG_ARRAY_KEYS[number]));
  const allowedKeys = new Set<string>(["schema_version", "workspaceSettings", ...schemaFourArrayKeys]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`Schema-4 Wayang store contains unsupported field ${key}`);
  }
  for (const key of schemaFourArrayKeys) {
    if (!Array.isArray(raw[key])) throw new Error(`Schema-4 Wayang store field ${key} must be an array`);
  }
  // Schema 4 already owns messaging, interview/human-attention, automation,
  // and capability state. Add only title provenance; never inspect transcripts.
  // Blank titles are provably still provisional; nonblank provenance is unknown.
  const migrated = {
    ...structuredClone(raw),
    schema_version: STORE_SCHEMA_VERSION,
    browserProfiles: [],
    projectBrowserDefaults: [],
    sessionBrowserStates: [],
    browserCleanups: [],
  } as unknown as StoreData;
  for (const session of migrated.sessions) {
    session.title_source = classifyMigratedSessionTitleSource(session.title);
  }
  Object.assign(migrated, browserCatalogMigrationFields(migrated));
  return validateCurrentStore(migrated as unknown as Record<string, unknown>);
}

function normalizeSchemaFiveStore(raw: Record<string, unknown>): StoreData {
  const schemaFiveArrayKeys = ARRAY_KEYS.filter((key) => !BROWSER_CATALOG_ARRAY_KEYS.includes(key as typeof BROWSER_CATALOG_ARRAY_KEYS[number]));
  const allowedKeys = new Set<string>(["schema_version", "workspaceSettings", ...schemaFiveArrayKeys]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`Schema-5 Wayang store contains unsupported field ${key}`);
  }
  for (const key of schemaFiveArrayKeys) {
    if (!Array.isArray(raw[key])) throw new Error(`Schema-5 Wayang store field ${key} must be an array`);
  }
  // Schema 5 owns canonical title provenance. Browser schema 6 preserves every
  // byte of those rows and inventories only expected profile-root metadata.
  const migrated = {
    ...structuredClone(raw),
    schema_version: STORE_SCHEMA_VERSION,
    browserProfiles: [],
    projectBrowserDefaults: [],
    sessionBrowserStates: [],
    browserCleanups: [],
  } as unknown as StoreData;
  Object.assign(migrated, browserCatalogMigrationFields(migrated));
  return validateCurrentStore(migrated as unknown as Record<string, unknown>);
}

function isPlausibleInterviewRecord(record: unknown): record is InterviewRecord {
  if (!record || typeof record !== "object") return false;
  const value = record as Partial<InterviewRecord>;
  const hasSubmissionChannel = value.submission_channel !== undefined;
  const hasAuthenticatedPrincipal = value.authenticated_principal !== undefined;
  const provenanceIsAbsentOrExact = (!hasSubmissionChannel && !hasAuthenticatedPrincipal) || (
    value.submission_channel === WAYANG_WEBSOCKET_SUBMISSION_CHANNEL &&
    value.authenticated_principal === WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL
  );
  return (
    typeof value.request_id === "string" &&
    typeof value.session_id === "string" &&
    Array.isArray(value.questions) &&
    typeof value.created_at === "number" &&
    ["open", "submitted", "cancelled", "delivered"].includes(value.status ?? "") &&
    provenanceIsAbsentOrExact
  );
}

function backupName(storePath: string, sourceVersion: number): string {
  const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
  return `${storePath}.backup-v${sourceVersion}-${stamp}`;
}

export type StoreMigrationPersistencePhase = "backup_durable" | "store_published";
let storeMigrationPersistenceObserverForTests: ((phase: StoreMigrationPersistencePhase) => void) | null = null;

/** One-migration synthetic ordering seam; never used for persistence decisions. */
export function observeNextStoreMigrationPersistenceForTests(
  observer: (phase: StoreMigrationPersistencePhase) => void,
): void {
  storeMigrationPersistenceObserverForTests = observer;
}

function createPrivateBackup(storePath: string, contents: Buffer, sourceVersion: number): string {
  const destination = backupName(storePath, sourceVersion);
  let fd: number | null = null;
  let created = false;
  try {
    fd = fs.openSync(destination, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    created = true;
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    // The backup inode is not durable until its directory entry is durable.
    // Migration must establish this boundary before replacing the store.
    const directoryFd = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    storeMigrationPersistenceObserverForTests?.("backup_durable");
    return destination;
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    if (created) {
      try { fs.unlinkSync(destination); } catch { /* best effort */ }
    }
    throw new Error(`Wayang store migration backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writePrivateProjection(destination: string, projection: unknown): void {
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const tempPath = `${destination}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  let created = false;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(projection, null, 2), "utf-8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    if (created) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
  }
}

function writeWorkspaceCapabilityStoreProjections(data: StoreData): void {
  for (const association of data.workspaceCapabilityAssociations) {
    const binding: WorkspaceCapabilityProjectionBinding = {
      capability_id: association.capability_id,
      project_id: association.project_id,
      agent_profile_id: association.agent_profile_id,
    };
    const destination = getWorkspaceCapabilityStoreProjectionPath(binding);
    if (!association.active) {
      writePrivateProjection(destination, {
        schema_version: 2,
        binding,
        association_revision: association.revision,
        active: false,
        available: false,
      });
      continue;
    }
    const project = data.projects.find((candidate) => candidate.id === association.project_id);
    const profile = data.agentProfiles.find((candidate) => candidate.id === association.agent_profile_id);
    if (!project || !profile) continue; // current-store validation rejects this state
    if (!profile.enabled) {
      writePrivateProjection(destination, {
        schema_version: 2,
        binding,
        association_revision: association.revision,
        active: true,
        available: false,
      });
      continue;
    }
    const sessions = data.sessions.filter((session) =>
      session.project_id === project.id
      && session.cwd === project.cwd
      && session.agent_profile_id === profile.id
      && !session.legacy_private_session_quarantine
      && !session.legacy_capability_ineligible);
    const projection = {
      schema_version: 2,
      binding,
      association_revision: association.revision,
      active: true,
      available: true,
      project: {
        id: project.id,
        cwd: project.cwd,
        name: project.name,
        description: project.description,
        color: project.color,
        access_policy: structuredClone(project.access_policy),
      },
      agent_profile: {
        id: profile.id,
        name: profile.name,
        description: profile.description,
        enabled: profile.enabled,
        resource_mode: profile.resource_mode,
        memory_access: profile.memory_access,
      },
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        agent_profile_id: session.agent_profile_id,
        created_at: session.created_at,
        last_active: session.last_active,
        archived: session.archived,
        goal: session.goal,
        goal_status: session.goal_status,
      })),
    };
    // Deliberately excludes provider/model, approval history/digests/timestamps,
    // other profiles, defaults, and every instruction body.
    writePrivateProjection(destination, projection);
  }
}

function canonicalizeCapabilityEligibility(data: StoreData): void {
  for (const session of data.sessions) {
    const quarantined = session.legacy_private_session_quarantine === true
      || session.finance_private_data_taint === true;
    delete session.finance_private_data_taint;
    session.legacy_private_session_quarantine = quarantined;
    if (session.legacy_capability_ineligible === undefined) {
      session.legacy_capability_ineligible = quarantined
        || session.agent_profile_id === null || session.agent_profile_id === undefined;
    }
    if (quarantined) session.legacy_capability_ineligible = true;
  }
  for (const job of data.scheduledJobs) {
    if (job.legacy_capability_ineligible === undefined) {
      job.legacy_capability_ineligible = job.agent_profile_id === null || job.agent_profile_id === undefined;
    }
  }
}

function saveStoreAtPath(data: StoreData, storePath: string): void {
  assertStoreLockOwned(storePath);
  canonicalizeCapabilityEligibility(data);
  validateCurrentStore(data as unknown as Record<string, unknown>);
  const dataDir = path.dirname(storePath);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  let created = false;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, storePath);
    if (storeMigrationPersistenceObserverForTests) {
      const observer = storeMigrationPersistenceObserverForTests;
      storeMigrationPersistenceObserverForTests = null;
      observer("store_published");
    }
    // A scheduled occurrence claim and its cursor advance share this rename.
    // Persist the directory entry before reporting the transaction committed,
    // so a power loss cannot retain the old cursor after external effects.
    const directoryFd = fs.openSync(dataDir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    // The canonical store bytes and directory entry are committed. Mode was
    // already set on the temp inode; post-publication reinforcement/projection
    // work must not make callers believe the durable transaction failed.
    try { fs.chmodSync(storePath, 0o600); } catch {
      console.warn("[db] Store mode reinforcement failed after durable publication");
    }
    try {
      writeWorkspaceCapabilityStoreProjections(data);
    } catch (error) {
      // The canonical store is already durable. A stale/missing exact
      // capability projection fails its consumer closed and is retried on save.
      console.warn(`[db] Workspace capability projection update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    if (created) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
  }
}

function loadStore(storePath: string): StoreData {
  if (!fs.existsSync(storePath)) {
    const data = emptyStore();
    saveStoreAtPath(data, storePath);
    return data;
  }

  const stat = fs.lstatSync(storePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Wayang store must be a regular file, not a symlink");
  const contents = fs.readFileSync(storePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf-8"));
  } catch (error) {
    throw new Error(`Wayang store contains malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = requireObject(parsed);
  const version = readSchemaVersion(raw);
  if (version > STORE_SCHEMA_VERSION) {
    throw new Error(`Wayang store schema ${version} is newer than supported schema ${STORE_SCHEMA_VERSION}`);
  }
  if (version === STORE_SCHEMA_VERSION) return validateCurrentStore(raw);

  // Never normalize or replace an old store until its exact bytes have a
  // durable private backup. Any backup error aborts startup.
  createPrivateBackup(storePath, contents, version);
  let migrated: StoreData;
  if (version === 5) migrated = normalizeSchemaFiveStore(raw);
  else if (version === 4) migrated = normalizeSchemaFourStore(raw);
  else if (version === 3) migrated = normalizeSchemaThreeStore(raw);
  else if (version === 2) migrated = normalizeSchemaTwoStore(raw);
  else if (version === 1) migrated = normalizeSchemaOneStore(raw);
  else if (version === 0) migrated = normalizeLegacyStore(raw);
  else throw new Error(`Wayang store schema ${version} has no supported migration path`);
  saveStoreAtPath(migrated, storePath);
  return migrated;
}

let _store: StoreData | null = null;
let _storePath: string | null = null;

function ensureStoreLock(storePath: string): boolean {
  if (_storeLock) {
    if (_storeLock.storePath !== storePath) {
      throw new Error(`Wayang store is already initialized for ${_storeLock.storePath}; close it before changing WAYANG_DATA_DIR`);
    }
    assertStoreLockOwned(storePath);
    return false;
  }
  _storeLock = acquireStoreLock(storePath);
  return true;
}

export function getStore(): StoreData {
  if (!_store) {
    const storePath = canonicalStorePath();
    const acquiredHere = ensureStoreLock(storePath);
    try {
      _store = loadStore(storePath);
      _storePath = storePath;
    } catch (error) {
      if (acquiredHere) releaseStoreLock();
      throw error;
    }
  }
  return _store;
}

export function flush(): void {
  if (_store && _storePath) saveStoreAtPath(_store, _storePath);
}

/**
 * Persist a workspace mutation against a private draft, then publish it to
 * readers only after the atomic store write succeeds. A failed write leaves
 * the prior in-memory store intact, so a later flush cannot accidentally
 * commit a mutation whose API call failed.
 */
let commitStoreMutationPersistenceFailureForTests: Error | null = null;

/** One-shot synthetic fault injected after draft mutation but before persistence/publication. */
export function failNextCommitStoreMutationPersistenceForTests(error = new Error("Synthetic store persistence failure")): void {
  commitStoreMutationPersistenceFailureForTests = error;
}

export function commitStoreMutation<T>(mutate: (draft: StoreData) => T): T {
  const current = getStore();
  if (!_storePath) throw new Error("Wayang store path is unavailable");
  const draft = structuredClone(current) as StoreData;
  const injectedFailure = commitStoreMutationPersistenceFailureForTests;
  commitStoreMutationPersistenceFailureForTests = null;
  const result = mutate(draft);
  if (injectedFailure) throw injectedFailure;
  saveStoreAtPath(draft, _storePath);
  // Preserve the long-standing stable getStore() root identity for callers
  // that retain it across repository operations, while publishing no draft
  // fields until persistence has succeeded.
  Object.assign(current, draft);
  _store = current;
  return result;
}

export function init(): void {
  const storePath = canonicalStorePath();
  const acquiredHere = ensureStoreLock(storePath);
  try {
    const loaded = loadStore(storePath);
    _store = loaded;
    _storePath = storePath;
    console.log(`[db] Store initialized at ${storePath}`);
  } catch (error) {
    storeMigrationPersistenceObserverForTests = null;
    if (acquiredHere) releaseStoreLock();
    throw error;
  }
}

export function close(): void {
  try {
    if (_store && _storePath) saveStoreAtPath(_store, _storePath);
  } finally {
    _store = null;
    _storePath = null;
    commitStoreMutationPersistenceFailureForTests = null;
    storeMigrationPersistenceObserverForTests = null;
    releaseStoreLock();
  }
}
