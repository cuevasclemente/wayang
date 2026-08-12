import type { RunPromptResult } from "../pi-bridge.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import { parseMessagingInput } from "./commands.js";
import {
  authorizeMessagingParticipant,
  compileMessagingEndpointDeclarations,
} from "./endpoint-policy.js";
import type {
  MessagingConversationBinding,
  MessagingEndpointDeclaration,
  MessagingErrorCode,
  MessagingParticipantSnapshot,
  NormalizedMessagingInboundEvent,
} from "./contracts.js";
import type { WayangMessagingSessionPort } from "./session-port.js";
import {
  acceptMessagingEvent,
  activateMessagingSession,
  assertMessagingEventClaimBinding,
  claimNextMessagingEvent,
  compactMessagingHistory,
  completeMessagingEventWithDeliveries,
  getMessagingEndpoint,
  getMessagingEvent,
  getMessagingTransaction,
  hasClaimableMessagingEvents,
  listProcessingMessagingEvents,
  messagingDeclarationSha256,
  admitMessagingTransactionManifest,
  reconcileMessagingEndpointDeclarations,
  recordMessagingEventDispatchSession,
  refreshMessagingEventClaimBinding,
  requeueProcessingMessagingEvent,
} from "./store.js";
import type { MessagingDeliveryPayload, MessagingEndpointRow, MessagingEventRow } from "./store-types.js";
import type { MessagingEventAdmission } from "./store.js";

export interface MessagingConnectorAttestationPort {
  attest(
    declaration: MessagingEndpointDeclaration,
    binding: MessagingConversationBinding,
    event: NormalizedMessagingInboundEvent,
  ): Promise<MessagingParticipantSnapshot>;
}

export interface MessagingGatewayAdmission {
  readonly duplicate: boolean;
  readonly endpointId: string;
  readonly acceptanceSequence: number;
}

export interface MessagingGatewayEphemeralEffectPort {
  runWithTyping<T>(endpointId: string, operation: () => Promise<T>): Promise<T>;
  /** Optional connector-owned bounded attention code for deterministic status projection. */
  getAttentionCode?(endpointId: string): string | null;
}

function binding(row: MessagingEndpointRow): MessagingConversationBinding {
  if (!row.external_conversation_id) throw new WorkspaceStoreError("Messaging endpoint is not bound to a conversation", 409);
  return {
    endpointId: row.endpoint_id,
    connectorId: row.connector_id,
    externalConversationId: row.external_conversation_id,
    activeWayangSessionId: row.active_session_id,
    revision: row.revision,
  };
}

function normalizedEvent(row: MessagingEventRow): NormalizedMessagingInboundEvent {
  return {
    connectorId: row.connector_id,
    connectorEventId: row.connector_event_id,
    externalConversationId: row.external_conversation_id,
    senderSubjectId: row.sender_subject_id,
    body: row.body,
    occurredAt: row.accepted_at,
  };
}

function helpText(): string {
  return [
    "Wayang commands:",
    "!new — create and activate a new session",
    "!sessions — list eligible sessions",
    "!use <session-id> — activate an existing session",
    "!status — show endpoint/session status",
    "!help — show this help",
    "Prefix ordinary text with !! to send a leading !.",
  ].join("\n");
}

class MessagingSettledTurnCommitError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super("Messaging turn settled but its durable final delivery could not be committed", { cause });
  }
}

class MessagingOriginAmbiguousError extends Error {
  constructor(readonly sessionId: string) {
    super(`Messaging turn origin is present but its final response cannot be reconstructed safely`);
  }
}

class MessagingSessionActivationConflictError extends Error {
  constructor(readonly orphanSessionId: string, cause: unknown) {
    super(`Session activation lost its compare-and-set race; orphan session ${orphanSessionId} was retained`, { cause });
  }
}

function safeErrorCode(error: unknown): MessagingErrorCode {
  if (error instanceof WorkspaceStoreError && error.statusCode === 403) return "endpoint_blocked";
  if (error instanceof WorkspaceStoreError && error.statusCode === 409) return "session_unavailable";
  return "turn_failed";
}

export class MessagingGatewayService {
  private readonly declarations: Map<string, MessagingEndpointDeclaration>;
  private readonly drains = new Map<string, Promise<void>>();
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private started = false;
  private closing = false;

  constructor(
    declarations: unknown,
    private readonly attestations: MessagingConnectorAttestationPort,
    private readonly sessions: WayangMessagingSessionPort,
    private readonly ephemeralEffects?: MessagingGatewayEphemeralEffectPort,
  ) {
    const compiled = compileMessagingEndpointDeclarations(declarations);
    this.declarations = new Map(compiled.map((row) => [row.endpointId, row]));
    reconcileMessagingEndpointDeclarations(compiled);
  }

  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = (async () => {
        compactMessagingHistory();
        await this.recover();
        await Promise.all([...this.declarations.keys()].map((endpointId) => this.drain(endpointId)));
        if (!this.closing) this.started = true;
      })();
    }
    return this.startPromise;
  }

  private declaration(endpointId: string): MessagingEndpointDeclaration {
    const declaration = this.declarations.get(endpointId);
    if (!declaration) throw new WorkspaceStoreError("Messaging endpoint is not in the current reviewed declaration set", 403);
    return declaration;
  }

  async admit(endpointId: string, event: NormalizedMessagingInboundEvent): Promise<MessagingGatewayAdmission> {
    if (this.closing) throw new WorkspaceStoreError("Messaging gateway is quiescing", 503);
    if (!this.started) throw new WorkspaceStoreError("Messaging gateway startup recovery has not completed", 503);
    const declaration = this.declaration(endpointId);
    const endpoint = getMessagingEndpoint(endpointId);
    if (!endpoint || endpoint.declaration_sha256 !== messagingDeclarationSha256(declaration)) {
      throw new WorkspaceStoreError("Messaging endpoint declaration is not reconciled", 409);
    }
    const currentBinding = binding(endpoint);
    const snapshot = await this.attestations.attest(declaration, currentBinding, event);
    const decision = authorizeMessagingParticipant(declaration, currentBinding, event, snapshot);
    if (!decision.allowed) throw new WorkspaceStoreError(decision.reason, 403);
    const accepted = acceptMessagingEvent({
      endpointId,
      declarationSha256: endpoint.declaration_sha256,
      declaration,
      participantSnapshot: snapshot,
      event,
    });
    void this.drain(endpointId).catch((error) => {
      console.error(`[messaging] endpoint drain failed for ${endpointId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return {
      duplicate: accepted.duplicate,
      endpointId,
      acceptanceSequence: accepted.row.acceptance_sequence,
    };
  }

  lookupCompletedTransaction(input: {
    connectorId: string;
    transactionId: string;
  }): { canonicalTransactionSha256: string } | null {
    const row = getMessagingTransaction(input.connectorId, input.transactionId);
    return row?.state === "completed"
      ? { canonicalTransactionSha256: row.canonical_transaction_sha256 }
      : null;
  }

  hasDurableEvent(input: { connectorId: string; connectorEventId: string }): boolean {
    return Boolean(getMessagingEvent(input.connectorId, input.connectorEventId));
  }

  admitTransaction(input: {
    connectorId: string;
    transactionId: string;
    canonicalTransactionSha256: string;
    children: readonly MessagingEventAdmission[];
  }): { duplicate: boolean; endpointIds: readonly string[] } {
    if (this.closing) throw new WorkspaceStoreError("Messaging gateway is quiescing", 503);
    if (!this.started) throw new WorkspaceStoreError("Messaging gateway startup recovery has not completed", 503);
    const admitted = admitMessagingTransactionManifest(input);
    const endpointIds = [...new Set(admitted.events.map((event) => event.row.endpoint_id))].sort();
    return Object.freeze({ duplicate: admitted.duplicate, endpointIds: Object.freeze(endpointIds) });
  }

  scheduleEndpointDrain(endpointId: string): void {
    if (this.closing) return;
    void this.drain(endpointId).catch((error) => {
      console.error(`[messaging] endpoint drain failed for ${endpointId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Serialize accepted work by endpoint. Safe to call repeatedly. */
  drain(endpointId: string): Promise<void> {
    const existing = this.drains.get(endpointId);
    if (existing) return existing;
    if (this.closing) return Promise.resolve();
    if (!this.started && !this.startPromise) {
      return Promise.reject(new WorkspaceStoreError("Messaging gateway startup recovery has not begun", 503));
    }
    const running = this.drainLoop(endpointId).finally(() => {
      if (this.drains.get(endpointId) !== running) return;
      this.drains.delete(endpointId);
      // Close the admission-vs-empty-loop lost-wakeup window. If admission
      // raced this finalizer it either sees no drain and starts one, or this
      // exact post-delete check observes its accepted row.
      if (!this.closing && hasClaimableMessagingEvents(endpointId)) {
        void this.drain(endpointId).catch((error) => {
          console.error(`[messaging] endpoint redrain failed for ${endpointId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
    this.drains.set(endpointId, running);
    return running;
  }

  private async drainLoop(endpointId: string): Promise<void> {
    const declaration = this.declaration(endpointId);
    const declarationHash = messagingDeclarationSha256(declaration);
    while (!this.closing) {
      const claimed = claimNextMessagingEvent({ endpointId, declarationSha256: declarationHash });
      if (!claimed) return;
      try {
        const operation = () => this.processClaim(declaration, claimed);
        if (this.ephemeralEffects) await this.ephemeralEffects.runWithTyping(endpointId, operation);
        else await operation();
      } catch (error) {
        // A shutdown-triggered abort must leave the durable processing/origin
        // evidence for startup reconciliation, not fabricate a terminal error.
        if (this.closing) return;
        await this.completeError(claimed, safeErrorCode(error), error);
      }
    }
  }

  /** Stop new claims/admission and await the one active claim per endpoint. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.started = false;
    this.closePromise = (async () => {
      if (this.startPromise) await this.startPromise.catch(() => undefined);
      const drains = Promise.all([...this.drains.values()]);
      if (this.drains.size > 0) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const grace = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 5_000);
        });
        const outcome = await Promise.race([drains.then(() => "drained" as const), grace]);
        if (timer) clearTimeout(timer);
        if (outcome === "timeout" && this.sessions.abortTurn) {
          const endpointIds = new Set(this.declarations.keys());
          const sessionIds = new Set(listProcessingMessagingEvents()
            .filter((row) => endpointIds.has(row.endpoint_id))
            .map((row) => row.wayang_session_id ?? row.claim_session_id)
            .filter((id): id is string => Boolean(id)));
          await Promise.allSettled([...sessionIds].map((id) => this.sessions.abortTurn!(id)));
        }
      }
      await drains;
    })();
    return this.closePromise;
  }

  private async currentAuthorizedBinding(
    declaration: MessagingEndpointDeclaration,
    event: NormalizedMessagingInboundEvent,
    claim: MessagingEventRow,
  ): Promise<MessagingConversationBinding> {
    const endpoint = getMessagingEndpoint(declaration.endpointId);
    if (!endpoint || endpoint.declaration_sha256 !== messagingDeclarationSha256(declaration)) {
      throw new WorkspaceStoreError("Messaging endpoint declaration changed", 409);
    }
    const currentBinding = binding(endpoint);
    if (claim.claim_id === null || claim.claim_endpoint_revision !== currentBinding.revision
      || claim.claim_declaration_sha256 !== endpoint.declaration_sha256
      || claim.claim_session_id !== currentBinding.activeWayangSessionId) {
      throw new WorkspaceStoreError("Messaging event claim binding is stale", 409);
    }
    const snapshot = await this.attestations.attest(declaration, currentBinding, event);
    const afterAttestation = getMessagingEndpoint(declaration.endpointId);
    if (!afterAttestation || afterAttestation.revision !== currentBinding.revision
      || afterAttestation.declaration_sha256 !== endpoint.declaration_sha256
      || afterAttestation.active_session_id !== currentBinding.activeWayangSessionId) {
      throw new WorkspaceStoreError("Messaging endpoint changed during participant attestation", 409);
    }
    const decision = authorizeMessagingParticipant(declaration, currentBinding, event, snapshot);
    if (!decision.allowed) throw new WorkspaceStoreError(decision.reason, 403);
    return currentBinding;
  }

  private async ensureActiveSession(
    declaration: MessagingEndpointDeclaration,
    currentBinding: MessagingConversationBinding,
    claim: MessagingEventRow,
  ): Promise<MessagingConversationBinding> {
    if (currentBinding.activeWayangSessionId) return currentBinding;
    const candidate = await this.sessions.createSessionCandidate(declaration, claim.canonical_event_sha256);
    let activated: MessagingEndpointRow;
    try {
      activated = activateMessagingSession({
        endpointId: declaration.endpointId,
        declarationSha256: messagingDeclarationSha256(declaration),
        expectedRevision: currentBinding.revision,
        sessionId: candidate.id,
      });
    } catch (error) {
      throw new MessagingSessionActivationConflictError(candidate.id, error);
    }
    const activatedBinding = binding(activated);
    refreshMessagingEventClaimBinding({
      connectorId: claim.connector_id,
      connectorEventId: claim.connector_event_id,
      canonicalEventSha256: claim.canonical_event_sha256,
      claimId: claim.claim_id!,
      expectedEndpointRevision: activatedBinding.revision,
    });
    return activatedBinding;
  }

  private async processClaim(declaration: MessagingEndpointDeclaration, row: MessagingEventRow): Promise<void> {
    const event = normalizedEvent(row);
    let currentBinding = await this.currentAuthorizedBinding(declaration, event, row);
    const parsed = parseMessagingInput(row.body);
    if (parsed.kind === "invalid") {
      this.complete(row, currentBinding.activeWayangSessionId, [{ kind: "notice", text: parsed.message }]);
      return;
    }

    if (parsed.kind === "prompt") {
      currentBinding = await this.ensureActiveSession(declaration, currentBinding, row);
      recordMessagingEventDispatchSession({
        connectorId: row.connector_id,
        connectorEventId: row.connector_event_id,
        canonicalEventSha256: row.canonical_event_sha256,
        claimId: row.claim_id!,
        sessionId: currentBinding.activeWayangSessionId!,
      });
      const result = await this.sessions.runTurn(declaration, currentBinding, event, {
        canonicalEventSha256: row.canonical_event_sha256,
        authorizeDispatch: () => assertMessagingEventClaimBinding({
          connectorId: row.connector_id,
          connectorEventId: row.connector_event_id,
          canonicalEventSha256: row.canonical_event_sha256,
          claimId: row.claim_id!,
          endpointRevision: currentBinding.revision,
          declarationSha256: messagingDeclarationSha256(declaration),
          sessionId: currentBinding.activeWayangSessionId,
        }),
      });
      const finalPayload: MessagingDeliveryPayload = {
        kind: "final",
        text: result.resultSummary?.trim() || "The agent completed the turn without a textual final response.",
      };
      try {
        this.complete(row, currentBinding.activeWayangSessionId, [finalPayload]);
      } catch (error) {
        throw new MessagingSettledTurnCommitError(currentBinding.activeWayangSessionId!, error);
      }
      return;
    }

    switch (parsed.command.name) {
      case "new": {
        const candidate = await this.sessions.createSessionCandidate(declaration, row.canonical_event_sha256);
        let activated: MessagingEndpointRow;
        try {
          activated = activateMessagingSession({
            endpointId: declaration.endpointId,
            declarationSha256: messagingDeclarationSha256(declaration),
            expectedRevision: currentBinding.revision,
            sessionId: candidate.id,
          });
        } catch (error) {
          throw new MessagingSessionActivationConflictError(candidate.id, error);
        }
        refreshMessagingEventClaimBinding({
          connectorId: row.connector_id,
          connectorEventId: row.connector_event_id,
          canonicalEventSha256: row.canonical_event_sha256,
          claimId: row.claim_id!,
          expectedEndpointRevision: activated.revision,
        });
        this.complete(row, candidate.id, [{ kind: "notice", text: `Created and activated session ${candidate.id}.` }]);
        return;
      }
      case "sessions": {
        const sessions = await this.sessions.listEligibleSessions(declaration, currentBinding.activeWayangSessionId);
        const text = sessions.length === 0
          ? "No eligible Wayang sessions exist for this endpoint."
          : sessions.map((session) => `${session.active ? "*" : "-"} ${session.id} — ${session.title}`).join("\n");
        this.complete(row, currentBinding.activeWayangSessionId, [{ kind: "notice", text }]);
        return;
      }
      case "use": {
        const candidate = await this.sessions.resolveEligibleSession(declaration, parsed.command.sessionHandle);
        const activated = activateMessagingSession({
          endpointId: declaration.endpointId,
          declarationSha256: messagingDeclarationSha256(declaration),
          expectedRevision: currentBinding.revision,
          sessionId: candidate.id,
        });
        refreshMessagingEventClaimBinding({
          connectorId: row.connector_id,
          connectorEventId: row.connector_event_id,
          canonicalEventSha256: row.canonical_event_sha256,
          claimId: row.claim_id!,
          expectedEndpointRevision: activated.revision,
        });
        this.complete(row, candidate.id, [{ kind: "notice", text: `Activated session ${candidate.id}.` }]);
        return;
      }
      case "status": {
        const status = await this.sessions.getStatus(declaration, currentBinding);
        const text = [
          `Project: ${status.projectName}`,
          `Agent: ${status.agentProfileName}`,
          `Session: ${status.activeSession?.id ?? "none"}`,
          `Runtime: ${status.runtimeStatus}${status.streaming ? " (streaming)" : ""}${status.queued ? " (queued)" : ""}`,
          `Transport policy: ${declaration.transportSecurity}`,
          `Connector attention: ${this.ephemeralEffects?.getAttentionCode?.(declaration.endpointId) ?? "none"}`,
        ].join("\n");
        this.complete(row, currentBinding.activeWayangSessionId, [{ kind: "notice", text }]);
        return;
      }
      case "help":
        this.complete(row, currentBinding.activeWayangSessionId, [{ kind: "notice", text: helpText() }]);
        return;
    }
  }

  private complete(row: MessagingEventRow, sessionId: string | null, payloads: readonly MessagingDeliveryPayload[]): void {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        completeMessagingEventWithDeliveries({
          connectorId: row.connector_id,
          connectorEventId: row.connector_event_id,
          canonicalEventSha256: row.canonical_event_sha256,
          claimId: row.claim_id!,
          sessionId,
          payloads,
        });
        return;
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError;
  }

  private async completeError(
    row: MessagingEventRow,
    code: MessagingErrorCode,
    cause?: unknown,
  ): Promise<void> {
    let failureClaim = row;
    const endpoint = getMessagingEndpoint(row.endpoint_id);
    if (endpoint) {
      try {
        failureClaim = refreshMessagingEventClaimBinding({
          connectorId: row.connector_id,
          connectorEventId: row.connector_event_id,
          canonicalEventSha256: row.canonical_event_sha256,
          claimId: row.claim_id!,
          expectedEndpointRevision: endpoint.revision,
        });
      } catch { /* a superseded claim must not gain completion authority */ }
    }
    const payloads: MessagingDeliveryPayload[] = [{ kind: "error", code }];
    if (cause instanceof MessagingSettledTurnCommitError) {
      payloads.push({
        kind: "continue_in_wayang",
        session_id: cause.sessionId,
        reason_code: "browser_handoff_required",
      });
    } else if (cause instanceof MessagingOriginAmbiguousError) {
      payloads.push({
        kind: "continue_in_wayang",
        session_id: cause.sessionId,
        reason_code: "browser_handoff_required",
      });
    } else if (cause instanceof MessagingSessionActivationConflictError) {
      payloads.push({
        kind: "notice",
        text: `Session activation changed concurrently. Orphan session ${cause.orphanSessionId} was retained and not activated.`,
      });
    }
    try {
      completeMessagingEventWithDeliveries({
        connectorId: row.connector_id,
        connectorEventId: row.connector_event_id,
        canonicalEventSha256: row.canonical_event_sha256,
        claimId: row.claim_id!,
        sessionId: failureClaim.claim_session_id,
        eventState: "failed",
        errorCode: code,
        payloads,
      });
    } catch (error) {
      // Never terminalize a failed/handoff outcome without its durable outbox
      // row. Keeping the exact claim processing blocks later endpoint work and
      // lets startup recovery retry or surface operator attention safely.
      throw error;
    }
  }

  /**
   * Reconcile crash-window processing claims. A durable origin marker is never
   * replayed; absent origins are safely returned to the accepted queue.
   */
  async recover(): Promise<void> {
    if (this.started || this.drains.size > 0) {
      throw new WorkspaceStoreError("Messaging recovery is only allowed before worker startup", 409);
    }
    for (const row of listProcessingMessagingEvents()) {
      const declaration = this.declarations.get(row.endpoint_id);
      const endpoint = getMessagingEndpoint(row.endpoint_id);
      const sessionId = row.wayang_session_id ?? row.claim_session_id;
      if (!declaration || !endpoint || endpoint.declaration_sha256 !== messagingDeclarationSha256(declaration)) {
        await this.completeError(row, "endpoint_blocked");
        continue;
      }
      if (sessionId) {
        const origin = {
          connectorId: row.connector_id,
          connectorEventId: row.connector_event_id,
          endpointId: row.endpoint_id,
          canonicalEventSha256: row.canonical_event_sha256,
        };
        if (await this.sessions.inspectOrigin(sessionId, origin) === "present") {
          await this.completeError(row, "turn_failed", new MessagingOriginAmbiguousError(sessionId));
          continue;
        }
      }
      requeueProcessingMessagingEvent({
        connectorId: row.connector_id,
        connectorEventId: row.connector_event_id,
        canonicalEventSha256: row.canonical_event_sha256,
        claimId: row.claim_id!,
      });
    }
  }
}
