import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  commitStoreMutation,
  getStore,
  type StoreData,
  type TranscriptRecoveryJournalRow,
} from "./db.js";

function canonicalExistingTranscript(filePath: string): string {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new Error("Canonical transcript path is invalid");
  }
  const canonical = fs.realpathSync.native(filePath);
  const stat = fs.lstatSync(canonical);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid) {
    throw new Error("Canonical transcript must be an owner-controlled single-link regular file");
  }
  return canonical;
}

export function appendTranscriptRecoveryMarkerDraft(
  draft: StoreData,
  input: {
    kind: TranscriptRecoveryJournalRow["kind"];
    sessionId: string;
    piSessionFile: string;
    createdAt?: number;
  },
): TranscriptRecoveryJournalRow {
  if (draft.transcriptRecoveryJournal.some((row) => row.session_id === input.sessionId)) {
    throw new Error("A transcript recovery operation is already pending for this session");
  }
  const row: TranscriptRecoveryJournalRow = {
    id: randomUUID(),
    kind: input.kind,
    session_id: input.sessionId,
    pi_session_file: input.piSessionFile,
    created_at: input.createdAt ?? Date.now(),
  };
  draft.transcriptRecoveryJournal.push(row);
  return structuredClone(row);
}

export function createEventReconcileMarker(
  sessionId: string,
  piSessionFile: string,
): TranscriptRecoveryJournalRow {
  const canonical = canonicalExistingTranscript(piSessionFile);
  return commitStoreMutation((draft) => {
    const session = draft.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || !session.pi_session_file) throw new Error("Session transcript is unavailable for recovery journaling");
    if (fs.realpathSync.native(session.pi_session_file) !== canonical) {
      throw new Error("Session transcript changed before recovery journaling");
    }
    return appendTranscriptRecoveryMarkerDraft(draft, {
      kind: "event_reconcile",
      sessionId,
      piSessionFile: canonical,
    });
  });
}

export function clearTranscriptRecoveryMarker(markerId: string): boolean {
  const existing = getStore().transcriptRecoveryJournal.some((row) => row.id === markerId);
  if (!existing) return false;
  return commitStoreMutation((draft) => {
    const index = draft.transcriptRecoveryJournal.findIndex((row) => row.id === markerId);
    if (index < 0) return false;
    draft.transcriptRecoveryJournal.splice(index, 1);
    return true;
  });
}

export function listTranscriptRecoveryMarkers(): TranscriptRecoveryJournalRow[] {
  return getStore().transcriptRecoveryJournal.map((row) => ({ ...row }));
}

export function eventRecoveryMarkerForSession(sessionId: string): TranscriptRecoveryJournalRow | undefined {
  const row = getStore().transcriptRecoveryJournal.find((candidate) => (
    candidate.kind === "event_reconcile" && candidate.session_id === sessionId
  ));
  return row ? { ...row } : undefined;
}

export function sessionDeleteRecoveryMarkerMatches(sessionId: string, filePath: string): boolean {
  return getStore().transcriptRecoveryJournal.some((row) => (
    row.kind === "session_delete" && (row.session_id === sessionId || row.pi_session_file === filePath)
  ));
}

let recoveryUnlinkFailureForTests: Error | null = null;

/** @internal One-shot fault before any unlink side effect. */
export function failNextRecoveryUnlinkForTests(
  error = new Error("Synthetic transcript recovery unlink failure"),
): void {
  recoveryUnlinkFailureForTests = error;
}

/** No-follow, owner-only, single-link unlink for durable startup/delete recovery. */
export function unlinkRecoveryTranscriptIfPresent(filePath: string): "unlinked" | "absent" {
  const injectedFailure = recoveryUnlinkFailureForTests;
  recoveryUnlinkFailureForTests = null;
  if (injectedFailure) throw injectedFailure;
  let before: fs.Stats;
  try { before = fs.lstatSync(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : before.uid;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== uid
    || fs.realpathSync.native(filePath) !== filePath) {
    throw new Error("Recovery transcript path is not a safe canonical single-link file");
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("No-follow transcript recovery is unavailable");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new Error("Recovery transcript changed before unlink");
    }
  } finally {
    fs.closeSync(fd);
  }
  const after = fs.lstatSync(filePath);
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
    throw new Error("Recovery transcript changed before unlink");
  }
  fs.unlinkSync(filePath);
  return "unlinked";
}
