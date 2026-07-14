/**
 * db.ts — Simple JSON file store for session metadata.
 *
 * Uses a JSON file for persistence. Simple enough for single-user,
 * single-server operation. The canonical agent conversation is stored
 * in pi's own session format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "./config.js";
import type { AppEvent, AppManifest } from "./apps/types.js";
import type { ScheduledJobRow, ScheduledRunRow } from "./scheduler/types.js";
import type { FileFingerprint } from "./session-metadata.js";

export interface SessionRow {
  id: string;
  pi_session_file: string | null;
  title: string;
  cwd: string;
  provider: string | null;
  model: string | null;
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

export interface StoreData {
  sessions: SessionRow[];
  agentTeams: AgentTeamRow[];
  teamMembers: TeamMemberRow[];
  goals: GoalRow[];
  apps: AppRegistrationRow[];
  appStates: AppStateRow[];
  appEvents: AppEventRow[];
  scheduledJobs: ScheduledJobRow[];
  scheduledRuns: ScheduledRunRow[];
  interviews: InterviewRecord[];
}

function getStorePath(): string {
  const config = getConfig();
  return path.join(config.dataDir, "store.json");
}

function loadStore(): StoreData {
  const storePath = getStorePath();
  try {
    if (fs.existsSync(storePath)) {
      const data = fs.readFileSync(storePath, "utf-8");
      return normalizeStore(JSON.parse(data));
    }
  } catch {
    // ignore corrupted file
  }
  return normalizeStore({
    sessions: [],
    agentTeams: [],
    teamMembers: [],
    goals: [],
    apps: [],
    appStates: [],
    appEvents: [],
    scheduledJobs: [],
    scheduledRuns: [],
    interviews: [],
  });
}

function normalizeStore(raw: Partial<StoreData>): StoreData {
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  for (const session of sessions as Array<Partial<SessionRow>>) {
    session.scheduled_job_id ??= null;
    session.scheduled_run_id ??= null;
    session.error ??= null;
    session.archived_at ??= session.archived ? session.last_active ?? null : null;
    session.catalog_fingerprint ??= null;
    session.catalog_mutation_version ??= 0;
  }

  const scheduledJobs = Array.isArray(raw.scheduledJobs) ? raw.scheduledJobs : [];
  for (const job of scheduledJobs as Array<Partial<ScheduledJobRow>>) {
    job.command_guard_mode ??= "default";
  }

  return {
    sessions: sessions as SessionRow[],
    agentTeams: Array.isArray(raw.agentTeams) ? raw.agentTeams : [],
    teamMembers: Array.isArray(raw.teamMembers) ? raw.teamMembers : [],
    goals: Array.isArray(raw.goals) ? raw.goals : [],
    apps: Array.isArray(raw.apps) ? raw.apps : [],
    appStates: Array.isArray(raw.appStates) ? raw.appStates : [],
    appEvents: Array.isArray(raw.appEvents) ? raw.appEvents : [],
    scheduledJobs: scheduledJobs as ScheduledJobRow[],
    scheduledRuns: Array.isArray(raw.scheduledRuns) ? raw.scheduledRuns : [],
    interviews: Array.isArray(raw.interviews)
      ? raw.interviews.filter((record): record is InterviewRecord => isPlausibleInterviewRecord(record))
      : [],
  };
}

function isPlausibleInterviewRecord(record: unknown): record is InterviewRecord {
  if (!record || typeof record !== "object") return false;
  const value = record as Partial<InterviewRecord>;
  return (
    typeof value.request_id === "string" &&
    typeof value.session_id === "string" &&
    Array.isArray(value.questions) &&
    typeof value.created_at === "number" &&
    ["open", "submitted", "cancelled", "delivered"].includes(value.status ?? "")
  );
}

function saveStore(data: StoreData): void {
  const storePath = getStorePath();
  const config = getConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    // An existing store may have been created under a broader umask by an old
    // version. Keep the durable interview inbox private across upgrades.
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, storePath);
    fs.chmodSync(storePath, 0o600);
  } finally {
    // A failed write must not replace the previous store. Best-effort cleanup
    // is safe only for this uniquely named temporary file.
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup failures
    }
  }
}

// Singleton store in memory, flushed to disk on each write
let _store: StoreData | null = null;

export function getStore(): StoreData {
  if (!_store) _store = loadStore();
  return _store;
}

export function flush(): void {
  if (_store) saveStore(_store);
}

export function init(): void {
  _store = loadStore();
  console.log(`[db] Store initialized at ${getStorePath()}`);
}

export function close(): void {
  if (_store) {
    saveStore(_store);
    _store = null;
  }
}