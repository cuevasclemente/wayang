import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { commitStoreMutation, getStore, flush, type SessionRow } from "./db.js";
import { SessionCatalog, type CatalogScanCommit, type CatalogScanResult } from "./session-catalog.js";
import { fingerprintsEqual, type FileFingerprint } from "./session-metadata.js";
import { ensureProjectForCwd, ensureProjectForCwdDraft, resolveEffectiveSessionDefaults } from "./projects.js";
import { WorkspaceStoreError, type PendingAgentSwitch } from "./workspace-types.js";
import { isProjectableOpenInterview } from "./interview-attention-policy.js";

export type { SessionRow };

export interface CreateSessionOptions {
  title?: string;
  model?: string;
  goal?: string;
  provider?: string;
  agentProfileId?: string;
  scheduledJobId?: string | null;
  scheduledRunId?: string | null;
  /** Internal crash-idempotency key; never derived from connector display text. */
  idempotencyKey?: string;
}

export function normalizeSessionCwd(cwd: string): string {
  let expanded = cwd.trim();
  if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  } else if (expanded.startsWith("/src/") && !fs.existsSync(expanded)) {
    // Some browser/project-picker paths can lose the home prefix and arrive as
    // `/src/foo`. Repair common `~/src/foo` project paths before handing cwd to
    // pi, whose tools chdir before shell expansion and cannot recover from a
    // missing home prefix.
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  return path.resolve(expanded);
}

export function createSession(
  cwd: string,
  titleOrOptions?: string | CreateSessionOptions,
  model?: string,
  goal?: string,
  provider?: string,
): SessionRow {
  const requestedCwd = normalizeSessionCwd(cwd);
  const options: CreateSessionOptions =
    typeof titleOrOptions === "object" && titleOrOptions !== null
      ? titleOrOptions
      : { title: titleOrOptions, model, goal, provider };
  const session = commitStoreMutation((draft) => {
    const { project } = ensureProjectForCwdDraft(draft, requestedCwd);
    const effective = resolveEffectiveSessionDefaults({
      project,
      agentProfileId: options.agentProfileId,
      explicitProvider: options.provider ?? null,
      explicitModel: options.model ?? null,
    });
    let deterministicId: string | null = null;
    if (options.idempotencyKey !== undefined) {
      if (!options.idempotencyKey || Buffer.byteLength(options.idempotencyKey, "utf8") > 1024
        || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(options.idempotencyKey)) {
        throw new WorkspaceStoreError("Session idempotency key is invalid");
      }
      const hex = createHash("sha256").update(`wayang-session-idempotency-v1\0${options.idempotencyKey}`, "utf8").digest("hex");
      deterministicId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      const existing = draft.sessions.find((row) => row.id === deterministicId);
      if (existing) {
        if (existing.project_id !== project.id || existing.cwd !== project.cwd
          || existing.agent_profile_id !== effective.agent_profile_id
          || existing.scheduled_job_id !== (options.scheduledJobId || null)
          || existing.scheduled_run_id !== (options.scheduledRunId || null)) {
          throw new WorkspaceStoreError("Session idempotency key resolved to a different scope", 409);
        }
        return cloneSession(existing);
      }
    }
    const now = Date.now();
    const created: SessionRow = {
      id: deterministicId ?? randomUUID(),
      pi_session_file: null,
      title: options.title || "",
      cwd: project.cwd,
      project_id: project.id,
      provider: effective.provider,
      model: effective.model,
      agent_profile_id: effective.agent_profile_id,
      pending_agent_switch: null,
      legacy_private_session_quarantine: false,
      legacy_capability_ineligible: false,
      created_at: now,
      last_active: now,
      archived: 0,
      archived_at: null,
      goal: options.goal || null,
      goal_status: options.goal ? "pending" : null,
      scheduled_job_id: options.scheduledJobId || null,
      scheduled_run_id: options.scheduledRunId || null,
      error: null,
      catalog_mutation_version: 1,
    };
    draft.sessions.push(created);
    return cloneSession(created);
  });
  publishDirectMutation(false);
  return session;
}

export function getSessionById(id: string): SessionRow | undefined {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) return cloneSession(row);
  }
  return undefined;
}

/**
 * Legacy imported private sessions are permanently runtime-ineligible.
 * Only an exact durable `false` proves that a row is not quarantined; missing,
 * malformed, or truthy markers fail closed.
 */
export function isLegacyPrivateSessionQuarantined(
  row: Pick<SessionRow, "legacy_private_session_quarantine"> | null | undefined,
): boolean {
  return row?.legacy_private_session_quarantine !== false;
}

export function listSessions(includeArchived = false): SessionRow[] {
  const store = getStore();
  let list = store.sessions;
  if (!includeArchived) {
    // Recovery compatibility: an archived row carrying an authoritative open
    // gate remains visible until that gate is resolved. Current archive writes
    // reject this state, but older stores may already contain it.
    list = list.filter((row: SessionRow) => !row.archived
      || store.interviews.some((record) => isProjectableOpenInterview(record, row.id)));
  }
  // Sort by the most recent human/agent interaction, descending.
  return list.map(cloneSession).sort(
    (a: SessionRow, b: SessionRow) => b.last_active - a.last_active,
  );
}

/**
 * Import canonical pi session files into the web UI store.
 *
 * Early wayang builds only persisted lightweight web session rows and used
 * in-memory AgentSession storage. This makes the left rail look populated while
 * old rows have no transcript after a backend restart. The canonical pi session
 * files still exist under ~/.pi/agent/sessions, so we surface them as first-class
 * web sessions here.
 */
export interface SyncPiSessionFilesResult {
  imported: number;
  updated: number;
  archivedLegacy: number;
  discovered?: number;
  parsed?: number;
  parseBytes?: number;
  parseFailures?: number;
  durationMs?: number;
  generation?: number;
}

const BACKGROUND_SYNC_INTERVAL_MS = 5_000;
// Give the initial sessions response/render/WebSocket handshake a short head
// start before doing the comparatively heavy cross-project transcript scan.
const BACKGROUND_SYNC_START_DELAY_MS = 1_000;

function nowMs(): number {
  return performance.now();
}

function elapsedMs(start: number): string {
  return `${(nowMs() - start).toFixed(1)}ms`;
}

function syncProfile(event: string, details = ""): void {
  if (process.env.WAYANG_LATENCY_PROFILE_VERBOSE !== "1") return;
  console.log(
    `[sessions-sync-profile] ${new Date().toISOString()} event=${event}${details ? ` ${details}` : ""}`,
  );
}

function readPiSessionCurrentModel(
  sessionFile: string,
  cwd: string,
): { provider: string; model: string } | null {
  try {
    const context = SessionManager.open(sessionFile, undefined, cwd).buildSessionContext();
    const restored = context.model;
    if (!restored?.provider || !restored?.modelId) return null;
    return { provider: restored.provider, model: restored.modelId };
  } catch {
    return null;
  }
}
const WEB_ONLY_SESSION_ARCHIVE_GRACE_MS = 24 * 60 * 60 * 1000;
// If a file-backed archived row is modified very recently but lacks an
// archived_at timestamp (older store rows), treat it as an active TUI-resumed
// session and show it again. Rows archived through current code use archived_at
// and are only restored after post-archive transcript activity.
const RECENT_ARCHIVED_ACTIVITY_RESTORE_MS = 30 * 60 * 1000;
/** Grace period before archiving a session whose pi file is missing.
 *  pi may atomically rewrite its session files (delete + rename),
 *  creating a brief window where fs.existsSync returns false. */
const MISSING_FILE_ARCHIVE_MS = 30_000;
const deletedSessionIds = new Set<string>();
const deletedSessionFiles = new Set<string>();
let lastSyncStartedAt = 0;
let syncInFlight: Promise<SyncPiSessionFilesResult> | null = null;
let syncStartTimer: NodeJS.Timeout | null = null;
/** Tracks when a pi session file was first noticed missing, to
 *  avoid archiving sessions during brief atomic-rewrite windows. */
const missingSince = new Map<string, number>();
let sessionCatalog: SessionCatalog | null = null;
let legacyCatalogTimer: NodeJS.Timeout | null = null;

function rowMutationVersion(row: SessionRow): number {
  return row.catalog_mutation_version ?? 0;
}

function incrementDirectMutation(row: SessionRow): void {
  row.catalog_mutation_version = rowMutationVersion(row) + 1;
}

/**
 * Transcript cwd is mutable metadata, never Project authority. If an existing
 * row moves, preserve that fact only by making its historical Project binding
 * unresolved; never adopt the Project currently registered at the new cwd.
 */
function updateTranscriptCwd(row: SessionRow, cwd: string): boolean {
  if (row.cwd === cwd) return false;
  row.cwd = cwd;
  row.project_id = null;
  row.legacy_capability_ineligible = true;
  // Keep the same durable write valid and denial-first if a catalog update
  // discovers the move while this session is selected by an endpoint.
  const now = Date.now();
  for (const endpoint of getStore().messagingEndpoints) {
    if (endpoint.active_session_id !== row.id) continue;
    endpoint.active_session_id = null;
    endpoint.revision++;
    endpoint.updated_at = now;
  }
  return true;
}

function publishDirectMutation(triggerScan = false): void {
  sessionCatalog?.bumpGeneration();
  if (triggerScan) sessionCatalog?.requestScan("internal-write", 0);
}

/** Publish a change to a field derived into the existing session summaries. */
export function notifySessionSummaryProjectionChanged(): void {
  publishDirectMutation(false);
}

function markDirectMutation(row: SessionRow, triggerScan = false): void {
  incrementDirectMutation(row);
  publishDirectMutation(triggerScan);
}

function catalogAdapterCommit(scan: CatalogScanCommit): { imported: number; updated: number; archivedLegacy: number; changed: boolean } {
  const store = getStore();
  const byPath = new Map<string, SessionRow>();
  const byId = new Map<string, SessionRow>();
  for (const row of store.sessions) {
    if (row.pi_session_file) byPath.set(row.pi_session_file, row);
    byId.set(row.id, row);
  }

  let imported = 0;
  let updated = 0;
  let archivedLegacy = 0;
  let changed = false;
  const now = Date.now();

  // Preserve web-only grace and missing-file grace without parsing anything.
  for (const row of store.sessions) {
    if (row.archived
      || store.messagingEndpoints.some((endpoint) => endpoint.active_session_id === row.id)
      || store.interviews.some((record) => isProjectableOpenInterview(record, row.id))) continue;
    if (!row.pi_session_file) {
      if (now - (row.created_at || now) < WEB_ONLY_SESSION_ARCHIVE_GRACE_MS) continue;
      row.archived = 1;
      row.archived_at = now;
      archivedLegacy++;
      changed = true;
      continue;
    }
    if (scan.discovered.has(row.pi_session_file)) {
      missingSince.delete(row.pi_session_file);
      continue;
    }
    const firstSeen = missingSince.get(row.pi_session_file);
    if (firstSeen === undefined) {
      missingSince.set(row.pi_session_file, now);
      continue;
    }
    if (now - firstSeen < MISSING_FILE_ARCHIVE_MS) continue;
    missingSince.delete(row.pi_session_file);
    row.archived = 1;
    row.archived_at = now;
    archivedLegacy++;
    changed = true;
  }

  for (const parsed of scan.parsed) {
    const info = parsed.metadata;
    if (deletedSessionIds.has(info.id) || deletedSessionFiles.has(info.path)) continue;
    let row = byPath.get(info.path);
    const matchedByPath = Boolean(row);
    row ??= byId.get(info.id);
    if (matchedByPath && row && rowMutationVersion(row) !== parsed.expectedMutationVersion) continue;

    const projectResult = ensureProjectForCwd(normalizeSessionCwd(info.cwd), false);
    if (projectResult.created) changed = true;
    const cwd = projectResult.project.cwd;
    const derivedTitle = (info.name || info.firstMessage || "(empty session)").slice(0, 120);
    if (!row) {
      row = {
        id: info.id,
        pi_session_file: info.path,
        title: derivedTitle,
        cwd,
        project_id: projectResult.project.id,
        provider: info.provider,
        model: info.model,
        agent_profile_id: null,
        pending_agent_switch: null,
        legacy_private_session_quarantine: false,
        legacy_capability_ineligible: true,
        created_at: info.createdAt,
        last_active: info.lastInteractionAt,
        archived: 0,
        archived_at: null,
        goal: null,
        goal_status: null,
        scheduled_job_id: null,
        scheduled_run_id: null,
        error: null,
        catalog_fingerprint: info.fingerprint,
        catalog_mutation_version: 0,
      };
      store.sessions.push(row);
      byPath.set(info.path, row);
      byId.set(info.id, row);
      imported++;
      changed = true;
      continue;
    }

    let rowChanged = false;
    const previousLastActive = row.last_active || 0;
    if (row.pi_session_file !== info.path) {
      row.pi_session_file = info.path;
      byPath.set(info.path, row);
      rowChanged = true;
    }
    if (updateTranscriptCwd(row, cwd)) rowChanged = true;
    // Explicit, non-empty Wayang titles win over transcript-derived titles.
    if (!row.title && row.title !== derivedTitle) { row.title = derivedTitle; rowChanged = true; }
    if (row.created_at !== info.createdAt) { row.created_at = info.createdAt; rowChanged = true; }
    if (row.last_active !== info.lastInteractionAt) { row.last_active = info.lastInteractionAt; rowChanged = true; }
    if ((info.lastInteractionAt > previousLastActive || !row.provider || !row.model)
      && (row.provider !== info.provider || row.model !== info.model)) {
      row.provider = info.provider;
      row.model = info.model;
      rowChanged = true;
    }
    if (row.archived) {
      const shouldRestore = typeof row.archived_at === "number"
        ? info.lastInteractionAt > row.archived_at
        : Date.now() - info.lastInteractionAt < RECENT_ARCHIVED_ACTIVITY_RESTORE_MS;
      if (shouldRestore) {
        row.archived = 0;
        row.archived_at = null;
        rowChanged = true;
      }
    }
    if (!fingerprintsEqual(row.catalog_fingerprint, info.fingerprint)) {
      row.catalog_fingerprint = info.fingerprint;
      rowChanged = true;
    }
    missingSince.delete(info.path);
    if (rowChanged) {
      updated++;
      changed = true;
    }
  }

  if (changed) flush();
  return { imported, updated, archivedLegacy, changed };
}

function getSessionCatalog(): SessionCatalog {
  sessionCatalog ??= new SessionCatalog({
    getKnownFile(filePath) {
      const row = getStore().sessions.find((candidate) => candidate.pi_session_file === filePath);
      return {
        fingerprint: row?.catalog_fingerprint ?? null,
        mutationVersion: row ? rowMutationVersion(row) : 0,
      };
    },
    commit: catalogAdapterCommit,
  });
  return sessionCatalog;
}

export function startSessionCatalog(): void {
  if (process.env.WAYANG_LEGACY_SESSION_SCAN === "1") {
    if (legacyCatalogTimer) return;
    void legacySyncPiSessionFiles().catch((error) => console.error("[sessions] legacy startup scan failed", error));
    legacyCatalogTimer = setInterval(() => {
      void legacySyncPiSessionFiles().catch((error) => console.error("[sessions] legacy safety scan failed", error));
    }, 30_000);
    legacyCatalogTimer.unref?.();
    return;
  }
  getSessionCatalog().start();
}

export async function stopSessionCatalog(): Promise<void> {
  if (legacyCatalogTimer) clearInterval(legacyCatalogTimer);
  legacyCatalogTimer = null;
  const catalog = sessionCatalog;
  sessionCatalog = null;
  await catalog?.stop();
}

export function getSessionCatalogGeneration(): number {
  return sessionCatalog?.getGeneration() ?? 1;
}

export function onSessionCatalogGeneration(listener: (generation: number) => void): () => void {
  return getSessionCatalog().onGeneration(listener);
}

export function requestSessionCatalogScan(reason = "internal-write"): void {
  if (process.env.WAYANG_LEGACY_SESSION_SCAN === "1") return;
  getSessionCatalog().requestScan(reason, 0);
}

export async function syncPiSessionFiles(): Promise<SyncPiSessionFilesResult> {
  if (process.env.WAYANG_LEGACY_SESSION_SCAN === "1") return legacySyncPiSessionFiles();
  const result: CatalogScanResult = await getSessionCatalog().scan();
  return result;
}

async function legacySyncPiSessionFiles(): Promise<SyncPiSessionFilesResult> {
  const syncStart = nowMs();
  syncProfile("sync_start");
  const listStart = nowMs();
  const infos = await SessionManager.listAll();
  syncProfile("list_all_done", `duration=${elapsedMs(listStart)} files=${infos.length}`);
  const processStart = nowMs();
  const store = getStore();
  let imported = 0;
  let updated = 0;
  let archivedLegacy = 0;
  let projectsCreated = false;

  // Hide legacy web-only rows and dangling file links. Recently-created rows
  // are allowed to be temporarily web-only because /api/sessions now warms the
  // pi AgentSession asynchronously and fills pi_session_file after responding.
  //
  // For sessions with pi_session_file, use a grace period before archiving:
  // pi may atomically rewrite its session files (write temp → delete old →
  // rename), creating a brief window where fs.existsSync returns false.
  const now = Date.now();
  for (const row of store.sessions) {
    if (row.archived
      || store.messagingEndpoints.some((endpoint) => endpoint.active_session_id === row.id)
      || store.interviews.some((record) => isProjectableOpenInterview(record, row.id))) continue;
    if (!row.pi_session_file) {
      const ageMs = now - (row.created_at || now);
      if (ageMs < WEB_ONLY_SESSION_ARCHIVE_GRACE_MS) continue;
      row.archived = 1;
      row.archived_at = now;
      archivedLegacy++;
      continue;
    }
    if (!fs.existsSync(row.pi_session_file)) {
      const firstSeen = missingSince.get(row.pi_session_file);
      if (firstSeen === undefined) {
        missingSince.set(row.pi_session_file, now);
        continue;
      }
      if (now - firstSeen < MISSING_FILE_ARCHIVE_MS) {
        continue;
      }
      missingSince.delete(row.pi_session_file);
      row.archived = 1;
      row.archived_at = now;
      archivedLegacy++;
    }
  }

  for (const info of infos) {
    const sessionFile = info.path;
    if (deletedSessionIds.has(info.id) || deletedSessionFiles.has(sessionFile)) {
      continue;
    }
    const projectResult = ensureProjectForCwd(normalizeSessionCwd(info.cwd), false);
    if (projectResult.created) projectsCreated = true;
    const cwd = projectResult.project.cwd;
    const title = (info.name || info.firstMessage || "(empty session)").slice(0, 120);
    const rawCreated = info.created instanceof Date ? info.created.getTime() : Date.now();
    const createdAt = Number.isFinite(rawCreated) ? rawCreated : Date.now();
    const rawModified = info.modified instanceof Date ? info.modified.getTime() : createdAt;
    const modifiedAt = Number.isFinite(rawModified) ? rawModified : createdAt;
    // SessionManager.listAll() already parses each transcript and computes
    // `modified` from the latest message/activity timestamp. Re-opening every
    // file here doubled the sync cost and could block the event loop long enough
    // to delay WebSocket handshakes.
    const lastInteractionAt = modifiedAt;

    // File exists — clear any missing tracking
    missingSince.delete(sessionFile);

    let row = store.sessions.find((candidate) => candidate.pi_session_file === sessionFile);
    if (row) {
      const nextTitle = row.title || title;
      const previousLastActive = row.last_active || 0;
      const hasNewFileActivity = lastInteractionAt > previousLastActive;
      let changed = updateTranscriptCwd(row, cwd);

      if (row.archived) {
        const archivedAt = row.archived_at;
        const shouldRestoreArchivedRow = typeof archivedAt === "number"
          ? lastInteractionAt > archivedAt
          : Date.now() - lastInteractionAt < RECENT_ARCHIVED_ACTIVITY_RESTORE_MS;
        if (shouldRestoreArchivedRow) {
          row.archived = 0;
          row.archived_at = null;
          changed = true;
        }
      }

      if (
        row.title !== nextTitle ||
        row.last_active !== lastInteractionAt ||
        row.created_at !== createdAt
      ) {
        row.title = nextTitle;
        row.created_at = createdAt;
        row.last_active = lastInteractionAt;
        changed = true;
      }
      if (hasNewFileActivity || !row.provider || !row.model) {
        const currentModel = readPiSessionCurrentModel(sessionFile, cwd);
        if (currentModel && (row.provider !== currentModel.provider || row.model !== currentModel.model)) {
          row.provider = currentModel.provider;
          row.model = currentModel.model;
          changed = true;
        }
      }
      if (changed) updated++;
      continue;
    }

    row = store.sessions.find((candidate) => candidate.id === info.id);
    if (row) {
      const previousLastActive = row.last_active || 0;
      const hasNewFileActivity = lastInteractionAt > previousLastActive;
      row.pi_session_file = sessionFile;
      updateTranscriptCwd(row, cwd);
      if (!row.title) row.title = title;
      row.created_at = createdAt;
      row.last_active = lastInteractionAt;
      if (row.archived) {
        const archivedAt = row.archived_at;
        const shouldRestoreArchivedRow = typeof archivedAt === "number"
          ? lastInteractionAt > archivedAt
          : Date.now() - lastInteractionAt < RECENT_ARCHIVED_ACTIVITY_RESTORE_MS;
        if (shouldRestoreArchivedRow) {
          row.archived = 0;
          row.archived_at = null;
        }
      }
      if (hasNewFileActivity || !row.provider || !row.model) {
        const currentModel = readPiSessionCurrentModel(sessionFile, cwd);
        if (currentModel) {
          row.provider = currentModel.provider;
          row.model = currentModel.model;
        }
      }
      // Keep archived rows archived. Matching by canonical pi id should link
      // the transcript without making a user-hidden session visible again.
      updated++;
      continue;
    }

    const currentModel = readPiSessionCurrentModel(sessionFile, cwd);
    store.sessions.push({
      id: info.id,
      pi_session_file: sessionFile,
      title,
      cwd,
      project_id: projectResult.project.id,
      provider: currentModel?.provider ?? null,
      model: currentModel?.model ?? null,
      agent_profile_id: null,
      pending_agent_switch: null,
      legacy_private_session_quarantine: false,
      legacy_capability_ineligible: true,
      created_at: createdAt,
      last_active: lastInteractionAt,
      archived: 0,
      archived_at: null,
      goal: null,
      goal_status: null,
      scheduled_job_id: null,
      scheduled_run_id: null,
      error: null,
    });
    imported++;
  }

  const changed = imported > 0 || updated > 0 || archivedLegacy > 0 || projectsCreated;
  syncProfile("process_done", `duration=${elapsedMs(processStart)} imported=${imported} updated=${updated} archivedLegacy=${archivedLegacy} changed=${changed}`);
  if (changed) {
    const flushStart = nowMs();
    flush();
    syncProfile("flush_done", `duration=${elapsedMs(flushStart)}`);
  }
  syncProfile("sync_done", `duration=${elapsedMs(syncStart)}`);
  return { imported, updated, archivedLegacy };
}

export function syncPiSessionFilesInBackground(force = false): Promise<SyncPiSessionFilesResult | null> | null {
  if (process.env.WAYANG_LEGACY_SESSION_SCAN !== "1") {
    getSessionCatalog().requestScan(force ? "forced-background" : "background", force ? 0 : BACKGROUND_SYNC_START_DELAY_MS);
    return null;
  }
  const now = Date.now();
  if (!force && now - lastSyncStartedAt < BACKGROUND_SYNC_INTERVAL_MS) {
    syncProfile("background_reuse_or_skip", `force=${force} hasInFlight=${Boolean(syncInFlight)} ageMs=${now - lastSyncStartedAt}`);
    return syncInFlight;
  }

  if (syncInFlight) {
    syncProfile("background_reuse_inflight", `force=${force}`);
    return syncInFlight;
  }

  lastSyncStartedAt = now;
  syncProfile("background_schedule", `force=${force} delayMs=${force ? 0 : BACKGROUND_SYNC_START_DELAY_MS}`);
  syncInFlight = new Promise<SyncPiSessionFilesResult>((resolve, reject) => {
    const start = () => {
      syncStartTimer = null;
      syncProfile("background_start", `force=${force}`);
      legacySyncPiSessionFiles().then(resolve, reject);
    };

    if (force) {
      start();
      return;
    }

    syncStartTimer = setTimeout(start, BACKGROUND_SYNC_START_DELAY_MS);
    syncStartTimer.unref?.();
  }).finally(() => {
    syncProfile("background_done", `force=${force}`);
    syncInFlight = null;
    if (syncStartTimer) {
      clearTimeout(syncStartTimer);
      syncStartTimer = null;
    }
  });
  return syncInFlight;
}

export function updateSessionTitle(id: string, title: string): void {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) {
      if (row.title === title) return;
      row.title = title;
      markDirectMutation(row);
      flush();
      return;
    }
  }
}

function cloneSession(row: SessionRow): SessionRow {
  return {
    ...row,
    pending_agent_switch: row.pending_agent_switch ? { ...row.pending_agent_switch } : null,
  };
}

function switchableSession(id: string): SessionRow {
  const row = getStore().sessions.find((session) => session.id === id);
  if (!row) throw new WorkspaceStoreError("Session not found", 404);
  return row;
}

function validatePendingAgentSwitch(pending: PendingAgentSwitch): void {
  const store = getStore();
  if (
    !pending || typeof pending !== "object" || typeof pending.switch_id !== "string" || !pending.switch_id
    || !(pending.from_agent_profile_id === null || typeof pending.from_agent_profile_id === "string")
    || !(pending.from_provider === null || typeof pending.from_provider === "string")
    || !(pending.from_model === null || typeof pending.from_model === "string")
    || typeof pending.to_agent_profile_id !== "string" || !pending.to_agent_profile_id
    || typeof pending.target_provider !== "string" || !pending.target_provider
    || typeof pending.target_model !== "string" || !pending.target_model
    || typeof pending.changed_at !== "number" || !Number.isFinite(pending.changed_at)
  ) {
    throw new WorkspaceStoreError("Invalid pending agent switch");
  }
  if ((pending.from_provider === null) !== (pending.from_model === null)) {
    throw new WorkspaceStoreError("Pending switch source provider and model must both be set or both be null");
  }
  const target = store.agentProfiles.find((profile) => profile.id === pending.to_agent_profile_id);
  if (!target || !target.enabled) throw new WorkspaceStoreError("Target agent profile must exist and be enabled", 409);
}

function assertSessionNotActivelyMessagingBound(id: string, operation: "archive" | "delete" | "switch"): void {
  if (getStore().messagingEndpoints.some((endpoint) => endpoint.active_session_id === id)) {
    throw new WorkspaceStoreError(`Actively messaging-bound sessions cannot ${operation}`, 409);
  }
}

function pendingSwitchesEqual(a: PendingAgentSwitch, b: PendingAgentSwitch): boolean {
  return a.switch_id === b.switch_id
    && a.from_agent_profile_id === b.from_agent_profile_id
    && a.from_provider === b.from_provider
    && a.from_model === b.from_model
    && a.to_agent_profile_id === b.to_agent_profile_id
    && a.target_provider === b.target_provider
    && a.target_model === b.target_model
    && a.changed_at === b.changed_at;
}

/** Compare-and-set a durable switch marker against the session's current assignment. */
export function beginAgentSwitch(id: string, pending: PendingAgentSwitch): SessionRow {
  const row = switchableSession(id);
  if (isLegacyPrivateSessionQuarantined(row)) {
    throw new WorkspaceStoreError("Quarantined legacy sessions cannot switch agent profiles", 403);
  }
  assertSessionNotActivelyMessagingBound(id, "switch");
  validatePendingAgentSwitch(pending);
  const current = row.pending_agent_switch ?? null;
  if (current) {
    if (current.switch_id !== pending.switch_id) throw new WorkspaceStoreError("A different agent switch is already pending", 409);
    if (!pendingSwitchesEqual(current, pending)) throw new WorkspaceStoreError("Pending agent switch payload conflicts with the existing switch id", 409);
    return cloneSession(row);
  }
  if (
    (row.agent_profile_id ?? null) !== pending.from_agent_profile_id
    || row.provider !== pending.from_provider
    || row.model !== pending.from_model
  ) {
    throw new WorkspaceStoreError("Session assignment changed before the agent switch began", 409);
  }
  const committed = commitStoreMutation((draft) => {
    const target = draft.sessions.find((session) => session.id === id);
    if (!target) throw new WorkspaceStoreError("Session not found", 404);
    target.pending_agent_switch = { ...pending };
    incrementDirectMutation(target);
    return cloneSession(target);
  });
  publishDirectMutation(false);
  return committed;
}

/** Commit only the matching pending switch and atomically clear its marker. */
export function completeAgentSwitch(id: string, switchId: string): SessionRow {
  const row = switchableSession(id);
  if (isLegacyPrivateSessionQuarantined(row)) {
    throw new WorkspaceStoreError("Quarantined legacy sessions cannot switch agent profiles", 403);
  }
  const pending = row.pending_agent_switch ?? null;
  if (!pending || pending.switch_id !== switchId) throw new WorkspaceStoreError("Stale or missing pending agent switch id", 409);
  const committed = commitStoreMutation((draft) => {
    const target = draft.sessions.find((session) => session.id === id);
    if (!target) throw new WorkspaceStoreError("Session not found", 404);
    target.agent_profile_id = pending.to_agent_profile_id;
    target.provider = pending.target_provider;
    target.model = pending.target_model;
    target.pending_agent_switch = null;
    incrementDirectMutation(target);
    return cloneSession(target);
  });
  publishDirectMutation(true);
  return committed;
}

/** Restore the recorded source assignment only for the matching switch id. */
export function rollbackAgentSwitch(id: string, switchId: string): SessionRow {
  const row = switchableSession(id);
  if (isLegacyPrivateSessionQuarantined(row)) {
    throw new WorkspaceStoreError("Quarantined legacy sessions cannot switch agent profiles", 403);
  }
  const pending = row.pending_agent_switch ?? null;
  if (!pending || pending.switch_id !== switchId) throw new WorkspaceStoreError("Stale or missing pending agent switch id", 409);
  const committed = commitStoreMutation((draft) => {
    const target = draft.sessions.find((session) => session.id === id);
    if (!target) throw new WorkspaceStoreError("Session not found", 404);
    target.agent_profile_id = pending.from_agent_profile_id;
    target.provider = pending.from_provider;
    target.model = pending.from_model;
    target.pending_agent_switch = null;
    incrementDirectMutation(target);
    return cloneSession(target);
  });
  publishDirectMutation(true);
  return committed;
}

export function updateSessionAgentProfile(id: string, agentProfileId: string | null): void {
  const row = getStore().sessions.find((session) => session.id === id);
  if (!row) return;
  if ((row.agent_profile_id ?? null) === agentProfileId) return;
  if (isLegacyPrivateSessionQuarantined(row)) {
    throw new WorkspaceStoreError("Quarantined legacy sessions cannot switch agent profiles", 403);
  }
  assertSessionNotActivelyMessagingBound(id, "switch");
  commitStoreMutation((draft) => {
    const target = draft.sessions.find((session) => session.id === id);
    if (!target) return;
    target.agent_profile_id = agentProfileId;
    incrementDirectMutation(target);
  });
  publishDirectMutation(false);
}

export function updateSessionModel(id: string, model: string | null, provider?: string | null): void {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) {
      if (row.model === model && (provider === undefined || row.provider === provider)) return;
      if (isLegacyPrivateSessionQuarantined(row)) {
        throw new WorkspaceStoreError("Quarantined legacy sessions cannot change models", 403);
      }
      row.model = model;
      if (provider !== undefined) row.provider = provider;
      markDirectMutation(row, true);
      flush();
      return;
    }
  }
}

export function updatePiSessionFile(id: string, file: string): void {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) {
      const wasWaitingForFile = !row.pi_session_file;
      row.pi_session_file = file;
      row.catalog_fingerprint = null;
      if (wasWaitingForFile && row.archived) {
        row.archived = 0;
        row.archived_at = null;
      }
      // Clear any dangling "missing since" tracking now that the file is set.
      missingSince.delete(file);
      markDirectMutation(row, true);
      flush();
      return;
    }
  }
}

export function updateGoal(
  id: string,
  goal: string | null,
  status: string | null,
): void {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) {
      row.goal = goal;
      row.goal_status = status;
      markDirectMutation(row);
      flush();
      return;
    }
  }
}

export function touchSession(id: string): void {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) {
      row.last_active = Date.now();
      markDirectMutation(row, true);
      flush();
      return;
    }
  }
}

export function updateSessionError(id: string, error: string | null): void {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) {
      row.error = error;
      markDirectMutation(row);
      flush();
      return;
    }
  }
}

export function archiveSession(id: string): void {
  const row = getStore().sessions.find((candidate) => candidate.id === id);
  if (!row || row.archived) return;
  assertSessionNotActivelyMessagingBound(id, "archive");
  const archived = commitStoreMutation((draft) => {
    const target = draft.sessions.find((candidate) => candidate.id === id);
    if (!target) return false;
    if (draft.interviews.some((record) => isProjectableOpenInterview(record, id))) {
      throw new WorkspaceStoreError(
        "Resolve or cancel the pending human-input request before archiving this session.",
        409,
      );
    }
    target.archived = 1;
    target.archived_at = Date.now();
    incrementDirectMutation(target);
    return true;
  });
  if (archived) publishDirectMutation(false);
}

export interface DeleteSessionResult {
  session: SessionRow;
  deletedSessionFile: string | null;
}

export function deleteSession(id: string): DeleteSessionResult | null {
  const store = getStore();
  const index = store.sessions.findIndex((row) => row.id === id);
  if (index < 0) return null;

  const session = store.sessions[index]!;
  assertSessionNotActivelyMessagingBound(id, "delete");
  let deletedSessionFile: string | null = null;
  if (session.pi_session_file) {
    deletedSessionFiles.add(session.pi_session_file);
    missingSince.delete(session.pi_session_file);
    if (fs.existsSync(session.pi_session_file)) {
      fs.unlinkSync(session.pi_session_file);
      deletedSessionFile = session.pi_session_file;
    }
  }

  deletedSessionIds.add(session.id);
  const deleted = commitStoreMutation((draft) => {
    const draftIndex = draft.sessions.findIndex((row) => row.id === id);
    if (draftIndex < 0) throw new WorkspaceStoreError("Session disappeared during deletion", 409);
    const target = draft.sessions[draftIndex]!;
    incrementDirectMutation(target);
    // Archive intentionally retains durable submissions. Permanent deletion
    // removes them atomically with the session row in the store transaction.
    draft.interviews = draft.interviews.filter((record) => record.session_id !== target.id);
    draft.sessions.splice(draftIndex, 1);
    return cloneSession(target);
  });
  publishDirectMutation(false);
  return { session: deleted, deletedSessionFile };
}
