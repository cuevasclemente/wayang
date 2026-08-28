import { randomUUID } from "node:crypto";
import { SessionManager, type SessionNameState } from "@earendil-works/pi-coding-agent";
import {
  getSessionById,
  setPiSessionTitle,
  type SessionRow,
} from "./sessions.js";
import {
  extractCompletedTitleExchanges,
  normalizeGeneratedTitle,
  type TitleSourceProjection,
} from "./session-title-policy.js";
import { TerraTitleProvider, type TitleProvider } from "./terra-title-provider.js";
import { isSessionRuntimeMutationLocked } from "./session-runtime-mutation-lock.js";
import { authorizeProjectAction } from "./policy.js";
import { protectedAutoTitleEnabled, wayangAutoTitleEnabled } from "./session-title-service.js";
import type { SessionTitleSource } from "./workspace-types.js";

export type ManualTitleGenerationState =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "conflict"
  | "cancelled";

export interface ManualTitleGenerationProjection {
  session_id: string;
  request_id: string | null;
  state: ManualTitleGenerationState;
  title?: string;
  code?: string;
  message?: string;
  created_at?: number;
  updated_at?: number;
}

interface TitleWitness {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  title: string;
  titleSource: SessionTitleSource;
  nameState: SessionNameState | null;
}

interface ManualTitleGenerationJob {
  requestId: string;
  witness: TitleWitness;
  state: Exclude<ManualTitleGenerationState, "idle">;
  createdAt: number;
  updatedAt: number;
  title?: string;
  code?: string;
  message?: string;
  timer?: NodeJS.Timeout;
  dependencies: ManualTitleGenerationDependencies;
}

export interface ManualTitleGenerationDependencies {
  isBusy(sessionId: string): boolean;
  onCommitted?(sessionFile: string): void;
}

export interface EnqueueManualTitleGenerationInput {
  expectedTitle: string;
}

export class ManualTitleGenerationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const jobs = new Map<string, ManualTitleGenerationJob>();
const POLL_DELAY_MS = 250;
const TERMINAL_TTL_MS = 5 * 60 * 1_000;
let provider: TitleProvider = new TerraTitleProvider();

function nameStateEqual(left: SessionNameState, right: SessionNameState): boolean {
  return left.name === right.name && left.entryId === right.entryId;
}

function capturePhysicalNameState(row: SessionRow): SessionNameState | null {
  if (!row.pi_session_file || isSessionRuntimeMutationLocked(row.id)) return null;
  try {
    const manager = SessionManager.open(row.pi_session_file, undefined, row.cwd);
    if (manager.getSessionId() !== row.id || manager.getHeader()?.cwd !== row.cwd) return null;
    return manager.getSessionNameState();
  } catch {
    return null;
  }
}

function physicalNameMatchesWitness(witness: TitleWitness, state: SessionNameState): boolean {
  if (witness.nameState) return nameStateEqual(witness.nameState, state);
  if (witness.titleSource === "pi") {
    return state.entryId !== undefined && (state.name ?? "") === witness.title;
  }
  if (witness.titleSource === "explicit") {
    return state.entryId === undefined || state.name === witness.title;
  }
  return state.entryId === undefined;
}

function explicitTitleDisclosureAllowed(row: SessionRow): boolean {
  if (!wayangAutoTitleEnabled()
    || row.legacy_capability_ineligible !== false
    || row.legacy_private_session_quarantine !== false
    || row.pending_agent_switch !== null
    || row.scheduled_job_id !== null
    || row.scheduled_run_id !== null
    || !row.project_id
    || !row.agent_profile_id) return false;
  const authorization = authorizeProjectAction({
    cwd: row.cwd,
    actor: "interactive",
    agentProfileId: row.agent_profile_id,
  });
  return Boolean(
    authorization.allowed
    && authorization.project
    && authorization.project.id === row.project_id
    && authorization.project.cwd === row.cwd
    && (authorization.project.access_policy.privacy_mode !== "protected" || protectedAutoTitleEnabled()),
  );
}

function titleWitnessStillCurrent(witness: TitleWitness): SessionRow | null {
  const row = getSessionById(witness.sessionId);
  if (!row
    || row.cwd !== witness.cwd
    || row.pi_session_file !== witness.sessionFile
    || row.title !== witness.title
    || row.title_source !== witness.titleSource
    || row.archived !== 0
    || !explicitTitleDisclosureAllowed(row)) return null;
  return row;
}

interface PhysicalTitleCandidate {
  row: SessionRow;
  manager: SessionManager;
  nameState: SessionNameState;
  projection: TitleSourceProjection;
}

function readPhysicalCandidate(
  witness: TitleWitness,
  expected?: Pick<PhysicalTitleCandidate, "nameState" | "projection">,
): PhysicalTitleCandidate | null {
  if (isSessionRuntimeMutationLocked(witness.sessionId)) return null;
  const row = titleWitnessStillCurrent(witness);
  if (!row) return null;
  try {
    const manager = SessionManager.open(witness.sessionFile, undefined, witness.cwd);
    if (manager.getSessionId() !== witness.sessionId || manager.getHeader()?.cwd !== witness.cwd) return null;
    const branch = manager.getBranch();
    const entries = branch.length > 0 ? branch : manager.getEntries();
    const firstPhysicalUser = entries.find((entry: any) => entry?.type === "message" && entry.message?.role === "user");
    const projection = extractCompletedTitleExchanges(entries, { allowSafeLegacyUserText: true });
    if (!projection || !firstPhysicalUser || projection.firstThree[0]?.userEntryId !== firstPhysicalUser.id) return null;
    const nameState = manager.getSessionNameState();
    if (!physicalNameMatchesWitness(witness, nameState)) return null;
    if (expected && (
      !nameStateEqual(nameState, expected.nameState)
      || projection.digest !== expected.projection.digest
      || projection.completedExchangeCount !== expected.projection.completedExchangeCount
    )) return null;
    return { row, manager, nameState, projection };
  } catch {
    return null;
  }
}

function project(job: ManualTitleGenerationJob): ManualTitleGenerationProjection {
  return {
    session_id: job.witness.sessionId,
    request_id: job.requestId,
    state: job.state,
    ...(job.title ? { title: job.title } : {}),
    ...(job.code ? { code: job.code } : {}),
    ...(job.message ? { message: job.message } : {}),
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

function clearJobTimer(job: ManualTitleGenerationJob): void {
  if (!job.timer) return;
  clearTimeout(job.timer);
  job.timer = undefined;
}

function terminal(
  job: ManualTitleGenerationJob,
  state: Extract<ManualTitleGenerationState, "completed" | "failed" | "conflict" | "cancelled">,
  options: { title?: string; code?: string; message?: string } = {},
): void {
  clearJobTimer(job);
  job.state = state;
  job.updatedAt = Date.now();
  job.title = options.title;
  job.code = options.code;
  job.message = options.message;
  const requestId = job.requestId;
  const timer = setTimeout(() => {
    const current = jobs.get(job.witness.sessionId);
    if (current?.requestId === requestId && !["queued", "running"].includes(current.state)) {
      jobs.delete(job.witness.sessionId);
    }
  }, TERMINAL_TTL_MS);
  timer.unref?.();
}

async function execute(job: ManualTitleGenerationJob): Promise<void> {
  if (jobs.get(job.witness.sessionId) !== job || job.state !== "queued") return;
  if (!titleWitnessStillCurrent(job.witness)) {
    terminal(job, "conflict", { code: "title_changed", message: "The session title changed after confirmation." });
    return;
  }
  if (job.dependencies.isBusy(job.witness.sessionId) || isSessionRuntimeMutationLocked(job.witness.sessionId)) {
    job.timer = setTimeout(() => { void execute(job); }, POLL_DELAY_MS);
    job.timer.unref?.();
    return;
  }

  const initial = readPhysicalCandidate(job.witness);
  if (!initial) {
    const row = titleWitnessStillCurrent(job.witness);
    const physicalState = row ? capturePhysicalNameState(row) : null;
    if (!row || (physicalState && !physicalNameMatchesWitness(job.witness, physicalState))) {
      terminal(job, "conflict", { code: "title_changed", message: "The session title changed after confirmation." });
    } else {
      terminal(job, "failed", { code: "title_input_unavailable", message: "No eligible completed session turns are available." });
    }
    return;
  }
  job.state = "running";
  job.updatedAt = Date.now();

  let prepared;
  try {
    prepared = await provider.prepare();
  } catch {
    terminal(job, "failed", { code: "title_model_unavailable", message: "The title model is unavailable." });
    return;
  }

  // Final synchronous disclosure gate. Do not insert an await between this
  // exact physical re-read and dispatch().
  if (job.dependencies.isBusy(job.witness.sessionId)) {
    terminal(job, "conflict", { code: "session_became_busy", message: "The session became busy before title generation started." });
    return;
  }
  const dispatchCandidate = readPhysicalCandidate(job.witness, initial);
  if (!dispatchCandidate) {
    terminal(job, "conflict", { code: "session_changed", message: "The session changed before title generation started." });
    return;
  }

  let rawTitle: string;
  try {
    rawTitle = await prepared.dispatch(dispatchCandidate.projection.boundedInput);
  } catch (error: any) {
    terminal(job, "failed", {
      code: error?.name === "AbortError" ? "title_timeout" : "title_provider_failed",
      message: error?.name === "AbortError" ? "Title generation timed out." : "Title generation failed.",
    });
    return;
  }
  const title = normalizeGeneratedTitle(rawTitle);
  if (!title) {
    terminal(job, "failed", { code: "title_invalid", message: "The title model returned an invalid title." });
    return;
  }

  if (job.dependencies.isBusy(job.witness.sessionId)) {
    terminal(job, "conflict", { code: "session_became_busy", message: "The session became busy before the title could be saved." });
    return;
  }
  const commitCandidate = readPhysicalCandidate(job.witness, initial);
  if (!commitCandidate) {
    terminal(job, "conflict", { code: "session_changed", message: "The session changed before the title could be saved." });
    return;
  }
  const result = commitCandidate.manager.appendSessionInfoIfCurrent(title, initial.nameState, { origin: "automatic" });
  if (!result.written) {
    terminal(job, "conflict", { code: "title_changed", message: "The session title changed before the generated title could be saved." });
    return;
  }
  try {
    setPiSessionTitle(job.witness.sessionId, title);
  } catch {
    // Pi is canonical. Catalog reconciliation will repair the Wayang mirror.
  } finally {
    job.dependencies.onCommitted?.(job.witness.sessionFile);
  }
  terminal(job, "completed", { title });
}

function enqueueTick(job: ManualTitleGenerationJob): void {
  job.timer = setTimeout(() => { void execute(job); }, 0);
  job.timer.unref?.();
}

export function enqueueManualTitleGeneration(
  sessionId: string,
  input: EnqueueManualTitleGenerationInput,
  dependencies: ManualTitleGenerationDependencies,
): ManualTitleGenerationProjection {
  const existing = jobs.get(sessionId);
  if (existing && (existing.state === "queued" || existing.state === "running")) return project(existing);
  const row = getSessionById(sessionId);
  if (!row) throw new ManualTitleGenerationError("Session not found", 404, "session_not_found");
  if (!explicitTitleDisclosureAllowed(row)) {
    throw new ManualTitleGenerationError(
      "Terra title disclosure is not enabled for this session",
      403,
      "title_generation_disabled",
    );
  }
  if (!row.pi_session_file) {
    throw new ManualTitleGenerationError("Session has no transcript", 409, "title_input_unavailable");
  }
  if (row.archived !== 0) throw new ManualTitleGenerationError("Archived sessions cannot be renamed", 409, "session_archived");
  if (typeof input.expectedTitle !== "string" || input.expectedTitle !== row.title) {
    throw new ManualTitleGenerationError("The session title changed before confirmation", 409, "title_changed");
  }
  const now = Date.now();
  const job: ManualTitleGenerationJob = {
    requestId: randomUUID(),
    witness: {
      sessionId: row.id,
      cwd: row.cwd,
      sessionFile: row.pi_session_file,
      title: row.title,
      titleSource: row.title_source,
      nameState: capturePhysicalNameState(row),
    },
    state: "queued",
    createdAt: now,
    updatedAt: now,
    dependencies,
  };
  jobs.set(sessionId, job);
  enqueueTick(job);
  return project(job);
}

export function getManualTitleGeneration(sessionId: string): ManualTitleGenerationProjection {
  const job = jobs.get(sessionId);
  return job ? project(job) : { session_id: sessionId, request_id: null, state: "idle" };
}

export function cancelManualTitleGeneration(sessionId: string, code = "session_removed"): void {
  const job = jobs.get(sessionId);
  if (!job || !["queued", "running"].includes(job.state)) return;
  terminal(job, "cancelled", { code, message: "Title generation was cancelled." });
}

/** Synthetic provider seam. It cannot enable production disclosure. */
export function setManualTitleProviderForTests(next: TitleProvider | null): void {
  provider = next ?? new TerraTitleProvider();
}

/** Reset process-local queue state; models a Wayang restart in tests. */
export function resetManualTitleGenerationForTests(): void {
  for (const job of jobs.values()) clearJobTimer(job);
  jobs.clear();
  provider = new TerraTitleProvider();
}

/** Run one queued job without waiting for its polling timer. */
export async function runManualTitleGenerationNowForTests(sessionId: string): Promise<void> {
  const job = jobs.get(sessionId);
  if (!job) return;
  clearJobTimer(job);
  await execute(job);
}
