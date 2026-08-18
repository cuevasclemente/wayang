const lockedSessionIds = new Set<string>();

/** Process-local exclusion shared by runtime, transcript, title, and command writers. */
export function acquireSessionRuntimeMutationLock(sessionId: string): boolean {
  if (lockedSessionIds.has(sessionId)) return false;
  lockedSessionIds.add(sessionId);
  return true;
}

export function releaseSessionRuntimeMutationLock(sessionId: string): void {
  lockedSessionIds.delete(sessionId);
}

export function isSessionRuntimeMutationLocked(sessionId: string): boolean {
  return lockedSessionIds.has(sessionId);
}
