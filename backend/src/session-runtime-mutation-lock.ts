import { EventEmitter } from "node:events";

const lockedSessionIds = new Set<string>();
const events = new EventEmitter();
events.setMaxListeners(0);

/** Process-local exclusion shared by runtime, transcript, title, and command writers. */
export function acquireSessionRuntimeMutationLock(sessionId: string): boolean {
  if (lockedSessionIds.has(sessionId)) return false;
  lockedSessionIds.add(sessionId);
  events.emit("changed", sessionId, true);
  return true;
}

export function releaseSessionRuntimeMutationLock(sessionId: string): void {
  if (!lockedSessionIds.delete(sessionId)) return;
  events.emit("changed", sessionId, false);
}

export function isSessionRuntimeMutationLocked(sessionId: string): boolean {
  return lockedSessionIds.has(sessionId);
}

export function onSessionRuntimeMutationLockChanged(
  listener: (sessionId: string, locked: boolean) => void,
): () => void {
  events.on("changed", listener);
  return () => events.off("changed", listener);
}
