import { SessionManager, type SessionNameState } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  getSessionById,
  normalizeProvisionalSessionTitle,
  reconcileSessionTitleFromPhysicalNameById,
  setAutomaticPiSessionTitle,
  type SessionRow,
} from "./sessions.js";
import { authorizeProjectAction } from "./policy.js";
import {
  acceptedTurnTitleProjection,
  extractCompletedTitleExchanges,
  normalizeGeneratedTitle,
  titleTextBlocks,
  type TitleSourceProjection,
} from "./session-title-policy.js";
import { TerraTitleProvider, type TitleProvider } from "./terra-title-provider.js";
export type { TitleProvider } from "./terra-title-provider.js";
import { fingerprintsEqual, type FileFingerprint } from "./session-metadata.js";
import { isSessionRuntimeMutationLocked } from "./session-runtime-mutation-lock.js";
import {
  resolveBrowserTurnPiUserEntry,
  wayangInteractiveTurnSourceFromEntry,
  type BrowserTurnProvenance,
} from "./interactive-turn-provenance.js";

export type AutoTitleOutcome = "attempt" | "success" | "validation_rejection" | "unavailable" | "timeout" | "cas_lost";
const telemetry = new Map<AutoTitleOutcome, number>();
const attempted = new Set<string>();
const interactionAttempted = new Set<string>();
const MAX_ATTEMPT_KEYS = 4_096;
const inFlight = new Map<string, Promise<void>>();
let provider: TitleProvider = new TerraTitleProvider();

function record(outcome: AutoTitleOutcome): void {
  telemetry.set(outcome, (telemetry.get(outcome) ?? 0) + 1);
}

export function autoTitleTelemetrySnapshot(): Readonly<Record<AutoTitleOutcome, number>> {
  return Object.freeze({
    attempt: telemetry.get("attempt") ?? 0,
    success: telemetry.get("success") ?? 0,
    validation_rejection: telemetry.get("validation_rejection") ?? 0,
    unavailable: telemetry.get("unavailable") ?? 0,
    timeout: telemetry.get("timeout") ?? 0,
    cas_lost: telemetry.get("cas_lost") ?? 0,
  });
}

/** Synthetic provider seam. It cannot enable production disclosure. */
export function setAutoTitleProviderForTests(next: TitleProvider | null): void {
  provider = next ?? new TerraTitleProvider();
  attempted.clear();
  interactionAttempted.clear();
  inFlight.clear();
  telemetry.clear();
}

export function wayangAutoTitleEnabled(): boolean {
  return process.env.WAYANG_AUTO_SESSION_TITLE === "on";
}

export function protectedAutoTitleEnabled(): boolean {
  return process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED === "on";
}

function rowEligible(row: SessionRow): boolean {
  if (!wayangAutoTitleEnabled() || !row.pi_session_file) return false;
  if (row.title_source !== "provisional" && row.title_source !== "legacy_unknown") return false;
  if (
    row.legacy_capability_ineligible !== false
    || row.legacy_private_session_quarantine !== false
    || row.pending_agent_switch !== null
    || row.scheduled_job_id !== null
    || row.scheduled_run_id !== null
    || !row.project_id
    || !row.agent_profile_id
  ) return false;
  const authorization = authorizeProjectAction({ cwd: row.cwd, actor: "interactive", agentProfileId: row.agent_profile_id });
  const project = authorization.project;
  if (
    !authorization.allowed
    || !project
    || project.id !== row.project_id
    || project.cwd !== row.cwd
    || (project.access_policy.privacy_mode === "protected" && !protectedAutoTitleEnabled())
  ) return false;
  return true;
}

function firstUserTranscriptText(entries: readonly any[]): string {
  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "user") {
      return titleTextBlocks(entry.message.content);
    }
  }
  return "";
}

function projectionEligibleForRow(row: SessionRow, entries: readonly any[], projection: TitleSourceProjection): boolean {
  if (projection.completedExchangeCount < 1) return false;
  const firstPhysicalUser = entries.find((entry: any) => entry?.type === "message" && entry.message?.role === "user");
  if (!firstPhysicalUser || projection.firstThree[0]?.userEntryId !== firstPhysicalUser.id) return false;
  if (row.title_source === "provisional") return !projection.legacySourceUsed;
  const fallback = normalizeProvisionalSessionTitle(firstUserTranscriptText(entries));
  return Boolean(fallback) && row.title === fallback;
}

interface PhysicalCandidate {
  row: SessionRow;
  manager: SessionManager;
  entries: readonly any[];
  projection: TitleSourceProjection;
}

function readPhysicalCandidate(
  sessionId: string,
  options: { repairPhysicalName?: boolean } = {},
): PhysicalCandidate | null {
  if (isSessionRuntimeMutationLocked(sessionId)) return null;
  const row = getSessionById(sessionId);
  if (!row || !rowEligible(row) || !row.pi_session_file) return null;
  try {
    const manager = SessionManager.open(row.pi_session_file, undefined, row.cwd);
    if (manager.getSessionId() !== row.id || manager.getHeader()?.cwd !== row.cwd) return null;
    const nameState = manager.getSessionNameState();
    // Any session_info, including a deliberate human clear, permanently
    // suppresses automatic naming. Only a never-named session is provisional.
    if (nameState.name !== undefined || nameState.entryId !== undefined) {
      if (options.repairPhysicalName && nameState.entryId !== undefined) {
        reconcileSessionTitleFromPhysicalNameById(sessionId, {
          piName: nameState.name,
          firstMessage: firstUserTranscriptText(manager.getEntries()),
        });
      }
      return null;
    }
    const branch = manager.getBranch();
    const entries = branch.length > 0 ? branch : manager.getEntries();
    const projection = extractCompletedTitleExchanges(entries, {
      allowSafeLegacyUserText: row.title_source === "legacy_unknown",
    });
    if (!projection || !projectionEligibleForRow(row, entries, projection)) return null;
    return { row, manager, entries, projection };
  } catch {
    return null;
  }
}

interface AcceptedPhysicalCandidate {
  row: SessionRow;
  manager: SessionManager;
}

function acceptedTurnBindsRow(row: SessionRow, turn: BrowserTurnProvenance): boolean {
  return turn.sourceKind === "browser_send_message"
    && turn.sourceMarkerEligible
    && Boolean(turn.piUserEntryId)
    && Boolean(turn.rawUserText.trim())
    && turn.sourceSessionId === row.id
    && turn.projectId === row.project_id
    && turn.projectCwd === row.cwd
    && turn.agentProfileId === row.agent_profile_id;
}

function readAcceptedPhysicalCandidate(
  sessionId: string,
  turn: BrowserTurnProvenance,
  options: { repairPhysicalName?: boolean; requireFirstUser?: boolean } = {},
): AcceptedPhysicalCandidate | null {
  if (isSessionRuntimeMutationLocked(sessionId)) return null;
  const row = getSessionById(sessionId);
  if (!row || !rowEligible(row) || !row.pi_session_file || !acceptedTurnBindsRow(row, turn)) return null;
  try {
    const manager = SessionManager.open(row.pi_session_file, undefined, row.cwd);
    if (manager.getSessionId() !== row.id || manager.getHeader()?.cwd !== row.cwd) return null;
    const branch = manager.getBranch();
    const branchIds = new Set(branch.map((entry: any) => entry?.id)
      .filter((id: unknown): id is string => typeof id === "string"));
    if (!resolveBrowserTurnPiUserEntry(turn, manager.getEntries(), branchIds)) return null;
    const userIndex = branch.findIndex((entry: any) => entry?.id === turn.piUserEntryId);
    if (userIndex < 0 || (options.requireFirstUser !== false && branch.slice(0, userIndex).some((entry: any) => (
      entry?.type === "message" && entry.message?.role === "user"
    )))) return null;
    const nameState = manager.getSessionNameState();
    if (nameState.name !== undefined || nameState.entryId !== undefined) {
      if (options.repairPhysicalName && nameState.entryId !== undefined) {
        reconcileSessionTitleFromPhysicalNameById(sessionId, {
          piName: nameState.name,
          firstMessage: firstUserTranscriptText(manager.getEntries()),
        });
      }
      return null;
    }
    return { row, manager };
  } catch {
    return null;
  }
}

function physicalAcceptedMarkerExists(sessionId: string, turn: BrowserTurnProvenance): boolean {
  const candidate = readAcceptedPhysicalCandidate(sessionId, turn, { requireFirstUser: false });
  if (!candidate) return false;
  return candidate.manager.getEntries().some((entry: unknown) => {
    const marker = wayangInteractiveTurnSourceFromEntry(entry);
    return marker?.client_message_id === turn.clientMessageId
      && marker.user_entry_id === turn.piUserEntryId
      && marker.raw_user_text === turn.rawUserText;
  });
}

function attemptKey(sessionId: string, projection: TitleSourceProjection): string {
  return `${sessionId}:${projection.digest}:${projection.completedExchangeCount}`;
}

function inFlightKey(sessionId: string): string {
  return sessionId;
}

function interactionAttemptKey(sessionId: string, interactionId: string): string {
  return `${sessionId}:${createHash("sha256").update(interactionId).digest("hex")}`;
}

function rememberBounded(set: Set<string>, key: string): void {
  set.add(key);
  while (set.size > MAX_ATTEMPT_KEYS) set.delete(set.values().next().value!);
}

function commitAutomaticTitle(
  sessionId: string,
  candidate: Pick<PhysicalCandidate, "row" | "manager">,
  title: string,
  onCommitted?: (sessionFile: string) => void,
): boolean {
  const expectedState = candidate.manager.getSessionNameState();
  const result = candidate.manager.appendSessionInfoIfCurrent(title, expectedState, { origin: "automatic" });
  if (!result.written) {
    record("cas_lost");
    return false;
  }
  try {
    setAutomaticPiSessionTitle(sessionId, title);
  } catch {
    // Pi is canonical. A later targeted catalog reconciliation repairs the
    // Wayang mirror; never retry the provider request after durable success.
  } finally {
    // The physical Pi file changed even if Wayang's mirror write failed or a
    // concurrent explicit human title correctly made it non-replaceable.
    onCommitted?.(candidate.row.pi_session_file!);
  }
  record("success");
  return true;
}

async function performAttempt(
  sessionId: string,
  expected: TitleSourceProjection,
  finalDisclosureGate: () => TitleSourceProjection | null,
  onCommitted?: (sessionFile: string) => void,
  commitGate: () => boolean = () => true,
): Promise<void> {
  record("attempt");
  let prepared;
  try {
    prepared = await provider.prepare();
  } catch {
    record("unavailable");
    return;
  }

  // Final synchronous disclosure gate. Do not insert an await between this
  // physical re-read and dispatch(): auth/model discovery has already settled.
  const dispatchProjection = finalDisclosureGate();
  if (
    !dispatchProjection
    || dispatchProjection.digest !== expected.digest
  ) return;
  let rawTitle: string;
  try {
    const response = prepared.dispatch(dispatchProjection.boundedInput);
    rawTitle = await response;
  } catch (error: any) {
    record(error?.name === "AbortError" ? "timeout" : "unavailable");
    return;
  }

  const title = normalizeGeneratedTitle(rawTitle);
  if (!title) {
    record("validation_rejection");
    return;
  }

  // Commit-time physical revalidation and the shared Pi lock/CAS are separate
  // from the request-time disclosure gate.
  const commitCandidate = commitGate() ? readPhysicalCandidate(sessionId) : null;
  if (!commitCandidate || commitCandidate.projection.digest !== expected.digest) {
    record("cas_lost");
    return;
  }
  commitAutomaticTitle(sessionId, commitCandidate, title, onCommitted);
}

async function performAcceptedAttempt(
  sessionId: string,
  turn: BrowserTurnProvenance,
  expected: TitleSourceProjection,
  stillAccepted: () => boolean,
  onCommitted?: (sessionFile: string) => void,
): Promise<void> {
  const admissionRemainsValid = () => stillAccepted() || physicalAcceptedMarkerExists(sessionId, turn);
  record("attempt");
  let prepared;
  try {
    prepared = await provider.prepare();
  } catch {
    record("unavailable");
    return;
  }

  // Final synchronous disclosure gate over the exact accepted browser witness.
  // Do not insert an await between this physical re-read and dispatch().
  if (!admissionRemainsValid() || !readAcceptedPhysicalCandidate(sessionId, turn)) return;
  let rawTitle: string;
  try {
    rawTitle = await prepared.dispatch(expected.boundedInput);
  } catch (error: any) {
    record(error?.name === "AbortError" ? "timeout" : "unavailable");
    return;
  }

  const title = normalizeGeneratedTitle(rawTitle);
  if (!title) {
    record("validation_rejection");
    return;
  }
  const commitCandidate = admissionRemainsValid() ? readAcceptedPhysicalCandidate(sessionId, turn) : null;
  if (!commitCandidate) {
    record("cas_lost");
    return;
  }
  commitAutomaticTitle(sessionId, commitCandidate, title, onCommitted);
}

/**
 * Start standard title creation from one exact browser message after Pi accepts
 * prompt/steer admission, without waiting for assistant settlement.
 */
export function scheduleWayangAutoTitleOnAcceptedTurn(
  sessionId: string,
  turn: BrowserTurnProvenance,
  options: { stillAccepted: () => boolean; onCommitted?: (sessionFile: string) => void },
): Promise<void> | null {
  const flightKey = inFlightKey(sessionId);
  const interactionKey = interactionAttemptKey(sessionId, turn.clientMessageId);
  if (interactionAttempted.has(interactionKey)) return inFlight.get(flightKey) ?? null;
  const admissionRemainsValid = () => options.stillAccepted() || physicalAcceptedMarkerExists(sessionId, turn);
  const projection = acceptedTurnTitleProjection(turn.clientMessageId, turn.rawUserText);
  if (!admissionRemainsValid() || !projection
    || !readAcceptedPhysicalCandidate(sessionId, turn, { repairPhysicalName: true })) return null;
  rememberBounded(interactionAttempted, interactionKey);
  const existing = inFlight.get(flightKey);
  if (existing) return existing;
  const work = performAcceptedAttempt(sessionId, turn, projection, options.stillAccepted, options.onCommitted)
    .catch(() => undefined)
    .finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, work);
  return work;
}

/**
 * Schedule one bounded attempt without delaying the source turn or activation.
 * Same-count reconnect/settlement triggers coalesce for this process lifetime.
 */
export function scheduleWayangAutoTitle(
  sessionId: string,
  options: { stillSelected?: () => boolean; onCommitted?: (sessionFile: string) => void } = {},
): Promise<void> | null {
  const candidate = readPhysicalCandidate(sessionId);
  if (!candidate) return null;
  const key = attemptKey(sessionId, candidate.projection);
  const flightKey = inFlightKey(sessionId);
  const existing = inFlight.get(flightKey);
  if (existing) return existing;
  if (attempted.has(key)) return null;
  rememberBounded(attempted, key);
  const work = performAttempt(sessionId, candidate.projection, () => {
    if (options.stillSelected && !options.stillSelected()) return null;
    return readPhysicalCandidate(sessionId)?.projection ?? null;
  }, options.onCommitted)
    .catch(() => undefined)
    .finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, work);
  return work;
}

/**
 * Reconsider an older unnamed session after an ordinary browser interaction
 * settles. Each distinct interaction may retry a failed same-history attempt,
 * while concurrent interactions still coalesce on the bounded first-three
 * projection. Title work never changes the source-turn outcome.
 */
export function scheduleWayangAutoTitleOnInteraction(
  sessionId: string,
  interactionId: string,
  options: {
    stillAccepted?: () => boolean;
    acceptedTurn?: BrowserTurnProvenance;
    onCommitted?: (sessionFile: string) => void;
  } = {},
): Promise<void> | null {
  const flightKey = inFlightKey(sessionId);
  const interactionKey = interactionAttemptKey(sessionId, interactionId);
  if (interactionAttempted.has(interactionKey)) return inFlight.get(flightKey) ?? null;
  const interactionRemainsValid = () => options.acceptedTurn
    ? Boolean(options.stillAccepted?.()) || physicalAcceptedMarkerExists(sessionId, options.acceptedTurn)
    : options.stillAccepted?.() ?? true;
  if (!interactionRemainsValid()) return null;
  const candidate = readPhysicalCandidate(sessionId, { repairPhysicalName: true });
  if (!candidate) return null;
  rememberBounded(interactionAttempted, interactionKey);
  const existing = inFlight.get(flightKey);
  if (existing) return existing;
  const work = performAttempt(
    sessionId,
    candidate.projection,
    () => interactionRemainsValid()
      ? readPhysicalCandidate(sessionId)?.projection ?? null
      : null,
    options.onCommitted,
    interactionRemainsValid,
  ).catch(() => undefined).finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, work);
  return work;
}

export interface AutoTitleActivationSnapshot {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  fingerprint: FileFingerprint;
  nameState: SessionNameState;
  markedProjection: TitleSourceProjection | null;
  legacyProjection: TitleSourceProjection | null;
  normalizedFirstUserFallback: string;
}

function currentFingerprint(sessionFile: string): FileFingerprint | null {
  try {
    const stat = fs.statSync(sessionFile);
    return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: Number(stat.ino) || 0 };
  } catch {
    return null;
  }
}

function activationProjection(sessionId: string, snapshot: AutoTitleActivationSnapshot): TitleSourceProjection | null {
  const row = getSessionById(sessionId);
  if (
    !row
    || row.id !== snapshot.sessionId
    || row.cwd !== snapshot.cwd
    || row.pi_session_file !== snapshot.sessionFile
    || !rowEligible(row)
    || snapshot.nameState.name !== undefined
    || snapshot.nameState.entryId !== undefined
  ) return null;
  const fingerprint = currentFingerprint(snapshot.sessionFile);
  if (!fingerprint || !fingerprintsEqual(fingerprint, snapshot.fingerprint)) return null;
  if (row.title_source === "provisional") return snapshot.markedProjection;
  if (row.title !== snapshot.normalizedFirstUserFallback) return null;
  return snapshot.legacyProjection;
}

/** Stopped-session catch-up reuses the one history parse and only stats before disclosure. */
export function scheduleWayangAutoTitleFromActivation(
  sessionId: string,
  snapshot: AutoTitleActivationSnapshot,
  options: { stillSelected?: () => boolean; onCommitted?: (sessionFile: string) => void } = {},
): Promise<void> | null {
  const projection = activationProjection(sessionId, snapshot);
  if (!projection) return null;
  const key = attemptKey(sessionId, projection);
  const flightKey = inFlightKey(sessionId);
  const existing = inFlight.get(flightKey);
  if (existing) return existing;
  if (attempted.has(key)) return null;
  rememberBounded(attempted, key);
  const work = performAttempt(sessionId, projection, () => {
    if (options.stillSelected && !options.stillSelected()) return null;
    return activationProjection(sessionId, snapshot);
  }, options.onCommitted).catch(() => undefined).finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, work);
  return work;
}
