import { WorkspaceStoreError } from "./workspace-types.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,512}$/u;

interface KnownRuntimeStartFailure {
  errorCode: string;
  statusCode: number;
  message: string;
}

function knownFailure(message: string, errorCode: string): [string, KnownRuntimeStartFailure] {
  return [message, { message, errorCode, statusCode: 409 }];
}

const SAFE_RUNTIME_START_FAILURES = new Map<string, KnownRuntimeStartFailure>([
  knownFailure(
    "Interactive browser runtime was revoked before publication",
    "interactive_browser_revoked_before_publication",
  ),
  knownFailure(
    "The trusted host bash definition was replaced during runtime creation",
    "trusted_host_bash_definition_replaced",
  ),
  knownFailure(
    "The trusted host bash executable drifted during guard installation",
    "trusted_host_bash_executable_drifted",
  ),
  knownFailure(
    "The trusted host bash cancellation controller is unavailable",
    "trusted_host_bash_cancellation_unavailable",
  ),
  knownFailure(
    "Host bash trust was revoked during runtime creation",
    "trusted_host_bash_trust_revoked",
  ),
]);

export interface SessionRuntimeStartFailureRecord {
  event: "session_runtime_start_failed";
  source: "websocket" | "scheduler" | "messaging";
  session_id: string;
  error_type: "known_startup" | "internal";
  error_code: string;
  status_code: number;
  message: string;
}

/**
 * Build a journal-safe startup failure record. Declassification uses a closed
 * exact-message table with constant codes/statuses. `instanceof` alone is not
 * trusted: extensions can construct exported error classes, and arbitrary
 * provider/SDK text may contain response bodies or secrets.
 */
export function sessionRuntimeStartFailureRecord(input: {
  source: SessionRuntimeStartFailureRecord["source"];
  sessionId: string;
  error: unknown;
}): SessionRuntimeStartFailureRecord {
  // Read the untrusted property once. A forged stateful getter may influence
  // classification, but the released fields below always come from the frozen
  // canonical table value and never from a second property read.
  const candidateMessage = input.error instanceof WorkspaceStoreError ? input.error.message : null;
  const known = candidateMessage === null ? undefined : SAFE_RUNTIME_START_FAILURES.get(candidateMessage);
  return {
    event: "session_runtime_start_failed",
    source: input.source,
    session_id: SAFE_SESSION_ID.test(input.sessionId) ? input.sessionId : "invalid",
    error_type: known ? "known_startup" : "internal",
    error_code: known?.errorCode ?? "runtime_start_failed",
    status_code: known?.statusCode ?? 500,
    message: known?.message ?? "Session runtime creation failed; inspect the matching internal stage",
  };
}

export function logSessionRuntimeStartFailure(
  input: Parameters<typeof sessionRuntimeStartFailureRecord>[0],
  write: (line: string) => void = (line) => console.error(line),
): SessionRuntimeStartFailureRecord {
  const record = sessionRuntimeStartFailureRecord(input);
  write(`[session-runtime] ${JSON.stringify(record)}`);
  return record;
}
