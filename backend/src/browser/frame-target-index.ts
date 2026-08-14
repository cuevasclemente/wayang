const MAX_FRAME_INDEX_SESSIONS = 256;
const MAX_FRAME_INDEX_FRAMES = 4096;

interface SessionClaim {
  epoch: number;
  rootTargetId: string;
  frames: Set<string>;
}

/**
 * Browser-epoch-scoped synchronous frame → root page target attribution.
 * Missing, ambiguous, degraded, unready, or stale claims always resolve null.
 */
export class ManagedChromiumFrameTargetIndex {
  private epoch = 0;
  private readonly sessions = new Map<string, SessionClaim>();
  private readonly frameClaims = new Map<string, Map<string, string>>();
  private readonly livePageTargets = new Set<string>();
  private readonly readyPageTargets = new Set<string>();
  private readonly degradedPageTargets = new Set<string>();

  reset(): number {
    this.epoch += 1;
    this.sessions.clear();
    this.frameClaims.clear();
    this.livePageTargets.clear();
    this.readyPageTargets.clear();
    this.degradedPageTargets.clear();
    return this.epoch;
  }

  currentEpoch(): number { return this.epoch; }

  addPageTarget(targetId: string, epoch = this.epoch): void {
    if (epoch !== this.epoch || !targetId) return;
    this.livePageTargets.add(targetId);
  }

  attachSession(sessionId: string, rootTargetId: string, epoch = this.epoch): boolean {
    if (epoch !== this.epoch || !sessionId || !rootTargetId || !this.livePageTargets.has(rootTargetId)) return false;
    if (!this.sessions.has(sessionId) && this.sessions.size >= MAX_FRAME_INDEX_SESSIONS) {
      this.degradedPageTargets.add(rootTargetId);
      return false;
    }
    this.removeSession(sessionId);
    this.sessions.set(sessionId, { epoch, rootTargetId, frames: new Set() });
    return true;
  }

  addFrame(sessionId: string, frameId: string, epoch = this.epoch): void {
    const session = this.sessions.get(sessionId);
    if (epoch !== this.epoch || !session || session.epoch !== epoch || !frameId) return;
    if (!this.frameClaims.has(frameId) && this.frameClaims.size >= MAX_FRAME_INDEX_FRAMES) {
      this.degradedPageTargets.add(session.rootTargetId);
      return;
    }
    session.frames.add(frameId);
    const claims = this.frameClaims.get(frameId) ?? new Map<string, string>();
    claims.set(sessionId, session.rootTargetId);
    this.frameClaims.set(frameId, claims);
  }

  markReady(rootTargetId: string, epoch = this.epoch): void {
    if (epoch === this.epoch && this.livePageTargets.has(rootTargetId) && !this.degradedPageTargets.has(rootTargetId)) {
      this.readyPageTargets.add(rootTargetId);
    }
  }

  degrade(rootTargetId: string, epoch = this.epoch): void {
    if (epoch !== this.epoch || !rootTargetId) return;
    this.degradedPageTargets.add(rootTargetId);
    this.readyPageTargets.delete(rootTargetId);
  }

  removeFrame(sessionId: string, frameId: string): void {
    this.sessions.get(sessionId)?.frames.delete(frameId);
    const claims = this.frameClaims.get(frameId);
    claims?.delete(sessionId);
    if (claims?.size === 0) this.frameClaims.delete(frameId);
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const frameId of session.frames) this.removeFrame(sessionId, frameId);
    this.sessions.delete(sessionId);
  }

  removePageTarget(targetId: string): void {
    this.livePageTargets.delete(targetId);
    this.readyPageTargets.delete(targetId);
    this.degradedPageTargets.delete(targetId);
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.rootTargetId === targetId) this.removeSession(sessionId);
    }
  }

  rootTargetForSession(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    const claim = this.sessions.get(sessionId);
    return claim?.epoch === this.epoch ? claim.rootTargetId : null;
  }

  resolve(frameId: string): string | null {
    const claims = this.frameClaims.get(frameId);
    if (!claims || claims.size === 0) return null;
    const targets = new Set(claims.values());
    if (targets.size !== 1) return null;
    const targetId = targets.values().next().value as string | undefined;
    if (!targetId || !this.livePageTargets.has(targetId) || !this.readyPageTargets.has(targetId)
      || this.degradedPageTargets.has(targetId)) return null;
    return targetId;
  }
}
