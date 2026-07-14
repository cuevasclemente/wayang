import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getStore, flush, type SessionRow } from "./db.js";
import { removeInterviewsForSession } from "./interviews.js";
import { SessionCatalog, type CatalogScanCommit, type CatalogScanResult } from "./session-catalog.js";
import { fingerprintsEqual, type FileFingerprint } from "./session-metadata.js";

export type { SessionRow };

export interface CreateSessionOptions {
  title?: string;
  model?: string;
  goal?: string;
  provider?: string;
  scheduledJobId?: string | null;
  scheduledRunId?: string | null;
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
  const store = getStore();
  const now = Date.now();
  const normalizedCwd = normalizeSessionCwd(cwd);
  const options: CreateSessionOptions =
    typeof titleOrOptions === "object" && titleOrOptions !== null
      ? titleOrOptions
      : { title: titleOrOptions, model, goal, provider };
  const session: SessionRow = {
    id: randomUUID(),
    pi_session_file: null,
    title: options.title || "",
    cwd: normalizedCwd,
    provider: options.provider || null,
    model: options.model || null,
    created_at: now,
    last_active: now,
    archived: 0,
    archived_at: null,
    goal: options.goal || null,
    goal_status: options.goal ? "pending" : null,
    scheduled_job_id: options.scheduledJobId || null,
    scheduled_run_id: options.scheduledRunId || null,
    error: null,
  };
  store.sessions.push(session);
  markDirectMutation(session);
  flush();
  return { ...session };
}

export function getSessionById(id: string): SessionRow | undefined {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) return { ...row };
  }
  return undefined;
}

export function listSessions(includeArchived = false): SessionRow[] {
  const store = getStore();
  let list = store.sessions;
  if (!includeArchived) {
    list = list.filter((row: SessionRow) => !row.archived);
  }
  // Sort by the most recent human/agent interaction, descending.
  return [...list].sort(
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

function markDirectMutation(row: SessionRow, triggerScan = false): void {
  row.catalog_mutation_version = rowMutationVersion(row) + 1;
  sessionCatalog?.bumpGeneration();
  if (triggerScan) sessionCatalog?.requestScan("internal-write", 0);
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
    if (row.archived) continue;
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

    const cwd = normalizeSessionCwd(info.cwd);
    const derivedTitle = (info.name || info.firstMessage || "(empty session)").slice(0, 120);
    if (!row) {
      row = {
        id: info.id,
        pi_session_file: info.path,
        title: derivedTitle,
        cwd,
        provider: info.provider,
        model: info.model,
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
    if (row.cwd !== cwd) { row.cwd = cwd; rowChanged = true; }
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

  // Hide legacy web-only rows and dangling file links. Recently-created rows
  // are allowed to be temporarily web-only because /api/sessions now warms the
  // pi AgentSession asynchronously and fills pi_session_file after responding.
  //
  // For sessions with pi_session_file, use a grace period before archiving:
  // pi may atomically rewrite its session files (write temp → delete old →
  // rename), creating a brief window where fs.existsSync returns false.
  const now = Date.now();
  for (const row of store.sessions) {
    if (row.archived) continue;
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
    const cwd = normalizeSessionCwd(info.cwd);
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
      let changed = false;

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
        row.cwd !== cwd ||
        row.title !== nextTitle ||
        row.last_active !== lastInteractionAt ||
        row.created_at !== createdAt
      ) {
        row.cwd = cwd;
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
      row.cwd = cwd;
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
      provider: currentModel?.provider ?? null,
      model: currentModel?.model ?? null,
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

  const changed = imported > 0 || updated > 0 || archivedLegacy > 0;
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

export function updateSessionModel(id: string, model: string | null, provider?: string | null): void {
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) {
      if (row.model === model && (provider === undefined || row.provider === provider)) return;
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
  const store = getStore();
  for (const row of store.sessions) {
    if (row.id === id) {
      row.archived = 1;
      row.archived_at = Date.now();
      markDirectMutation(row);
      flush();
      return;
    }
  }
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
  markDirectMutation(session);
  // Archive intentionally retains durable submissions. Permanent deletion
  // removes them in the same StoreData mutation as the session row.
  removeInterviewsForSession(session.id, { flush: false });
  store.sessions.splice(index, 1);
  flush();
  return { session: { ...session }, deletedSessionFile };
}