import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession, getSessionById, listSessions } from "../sessions.js";
import type { RunPromptResult, MessagingPromptOrigin } from "../pi-bridge.js";
import type {
  MessagingConversationBinding,
  MessagingEndpointDeclaration,
  MessagingParticipantSnapshot,
  NormalizedMessagingInboundEvent,
} from "./contracts.js";
import {
  MessagingGatewayService,
  type MessagingConnectorAttestationPort,
} from "./gateway-service.js";
import type {
  MessagingEndpointStatus,
  MessagingSessionSummary,
  WayangMessagingSessionPort,
} from "./session-port.js";
import {
  acceptMessagingEvent,
  activateMessagingSession,
  bindMessagingConversation,
  claimNextMessagingEvent,
  getMessagingEndpoint,
  messagingDeclarationSha256,
} from "./store.js";

function withStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-messaging-gateway-"));
  const prior = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  close();
  init();
  return fn(dir).finally(() => {
    close();
    if (prior === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function inbound(id: string, body: string): NormalizedMessagingInboundEvent {
  return {
    connectorId: "matrix",
    connectorEventId: id,
    externalConversationId: "!room:example.test",
    senderSubjectId: "@alice:example.test",
    body,
    occurredAt: Date.now(),
  };
}

function snapshot(event: NormalizedMessagingInboundEvent): MessagingParticipantSnapshot {
  return {
    connectorId: event.connectorId,
    externalConversationId: event.externalConversationId,
    senderSubjectId: event.senderSubjectId,
    joinedHumanSubjectIds: [event.senderSubjectId],
    complete: true,
    observedAt: Date.now(),
    revision: `membership-${event.connectorEventId}`,
    confidentiality: "server_visible",
  };
}

class FakeAttestations implements MessagingConnectorAttestationPort {
  calls = 0;
  unexpected = false;

  async attest(
    declaration: MessagingEndpointDeclaration,
    binding: MessagingConversationBinding,
    event: NormalizedMessagingInboundEvent,
  ): Promise<MessagingParticipantSnapshot> {
    this.calls++;
    return {
      connectorId: declaration.connectorId,
      externalConversationId: binding.externalConversationId,
      senderSubjectId: event.senderSubjectId,
      joinedHumanSubjectIds: this.unexpected
        ? [event.senderSubjectId, "@mallory:example.test"]
        : [event.senderSubjectId],
      complete: true,
      observedAt: Date.now(),
      revision: `membership-${this.calls}`,
      confidentiality: "server_visible",
    };
  }
}

class FakeSessions implements WayangMessagingSessionPort {
  runs: Array<{ sessionId: string; eventId: string; body: string; timeoutMs?: number }> = [];
  origins = new Set<string>();

  constructor(
    private readonly projectRoot: string,
    private readonly profileId: string,
    private readonly projectId: string,
  ) {}

  private makeSummary(id: string, active = false): MessagingSessionSummary {
    const row = getSessionById(id)!;
    return { id, title: row.title || "Untitled session", createdAt: row.created_at, lastActive: row.last_active, active };
  }

  async createSessionCandidate(
    declaration: MessagingEndpointDeclaration,
    idempotencyKey: string,
  ): Promise<MessagingSessionSummary> {
    assert.equal(declaration.projectId, this.projectId);
    const row = createSession(this.projectRoot, {
      agentProfileId: this.profileId,
      title: "External candidate",
      idempotencyKey: `fake:${declaration.endpointId}:${idempotencyKey}`,
    });
    return this.makeSummary(row.id);
  }

  async listEligibleSessions(
    _declaration: MessagingEndpointDeclaration,
    activeSessionId: string | null,
  ): Promise<MessagingSessionSummary[]> {
    return listSessions(false).filter((row) => row.cwd === this.projectRoot && row.agent_profile_id === this.profileId)
      .map((row) => this.makeSummary(row.id, row.id === activeSessionId));
  }

  async resolveEligibleSession(
    _declaration: MessagingEndpointDeclaration,
    sessionId: string,
  ): Promise<MessagingSessionSummary> {
    const row = getSessionById(sessionId);
    if (!row || row.cwd !== this.projectRoot || row.agent_profile_id !== this.profileId) throw new Error("ineligible");
    return this.makeSummary(sessionId);
  }

  async getStatus(
    _declaration: MessagingEndpointDeclaration,
    binding: MessagingConversationBinding,
  ): Promise<MessagingEndpointStatus> {
    return {
      projectId: this.projectId,
      projectName: "Synthetic project",
      agentProfileId: this.profileId,
      agentProfileName: "Synthetic profile",
      activeSession: binding.activeWayangSessionId ? this.makeSummary(binding.activeWayangSessionId, true) : null,
      runtimeStatus: "stopped",
      streaming: false,
      queued: false,
    };
  }

  async inspectOrigin(_sessionId: string, origin: MessagingPromptOrigin): Promise<"absent" | "present"> {
    return this.origins.has(origin.connectorEventId) ? "present" : "absent";
  }

  async runTurn(
    _declaration: MessagingEndpointDeclaration,
    binding: MessagingConversationBinding,
    event: NormalizedMessagingInboundEvent,
    options: { canonicalEventSha256: string; timeoutMs?: number; authorizeDispatch: () => void },
  ): Promise<RunPromptResult> {
    options.authorizeDispatch();
    assert.match(options.canonicalEventSha256, /^[a-f0-9]{64}$/u);
    assert.ok(binding.activeWayangSessionId);
    this.runs.push({ sessionId: binding.activeWayangSessionId!, eventId: event.connectorEventId, body: event.body, timeoutMs: options.timeoutMs });
    this.origins.add(event.connectorEventId);
    return { resultSummary: `answer for ${event.body}`, finalAssistantText: `answer for ${event.body}`, messages: [] };
  }
}

function setup(dir: string) {
  const projectRoot = path.join(dir, "project");
  fs.mkdirSync(projectRoot);
  const profile = createAgentProfile({ name: "Gateway profile" });
  const project = createProject({ cwd: projectRoot, default_agent_profile_id: profile.id });
  const declaration: MessagingEndpointDeclaration = {
    endpointId: "gateway-endpoint",
    connectorId: "matrix",
    provisioningKey: "gateway-endpoint",
    projectId: project.id,
    agentProfileId: profile.id,
    displayName: "Gateway Agent",
    conversationMode: "shared",
    allowedSubjectIds: ["@alice:example.test"],
    transportSecurity: "unencrypted_accepted",
  };
  const attestations = new FakeAttestations();
  const sessions = new FakeSessions(projectRoot, profile.id, project.id);
  const gateway = new MessagingGatewayService([declaration], attestations, sessions);
  const endpoint = getMessagingEndpoint(declaration.endpointId)!;
  bindMessagingConversation({
    endpointId: declaration.endpointId,
    declarationSha256: messagingDeclarationSha256(declaration),
    expectedRevision: endpoint.revision,
    externalConversationId: "!room:example.test",
  });
  return { projectRoot, profile, project, declaration, attestations, sessions, gateway };
}

test("prompt admission re-attests at execution, creates one active session, and stores one final delivery", () => withStore(async (dir) => {
  const f = setup(dir);
  await f.gateway.start();
  const admitted = await f.gateway.admit(f.declaration.endpointId, inbound("$one", "hello"));
  assert.equal(admitted.duplicate, false);
  await f.gateway.drain(f.declaration.endpointId);
  assert.equal(f.attestations.calls, 2, "admission and execution each require fresh attestation");
  assert.equal(f.sessions.runs.length, 1);
  assert.equal(f.sessions.runs[0]?.timeoutMs, 10 * 60 * 1000);
  const endpoint = getMessagingEndpoint(f.declaration.endpointId)!;
  assert.ok(endpoint.active_session_id);
  assert.equal(getStore().messagingEvents[0]?.state, "completed");
  assert.deepEqual(getStore().messagingDeliveries[0]?.payload, { kind: "final", text: "answer for hello" });
}));

test("escaped commands dispatch the parsed prompt and deliver full final assistant text", () => withStore(async (dir) => {
  const f = setup(dir);
  const fullReply = `First paragraph.\n\n${"x".repeat(700)}`;
  f.sessions.runTurn = async (_declaration, binding, event, options) => {
    options.authorizeDispatch();
    f.sessions.runs.push({ sessionId: binding.activeWayangSessionId!, eventId: event.connectorEventId, body: event.body, timeoutMs: options.timeoutMs });
    return { resultSummary: fullReply.replace(/\s+/gu, " ").slice(0, 500), finalAssistantText: fullReply, messages: [] };
  };
  await f.gateway.start();
  await f.gateway.admit(f.declaration.endpointId, inbound("$escaped", "!!status"));
  await f.gateway.drain(f.declaration.endpointId);
  assert.equal(f.sessions.runs[0]?.body, "!status");
  assert.equal(f.sessions.runs[0]?.timeoutMs, 10 * 60 * 1000);
  assert.deepEqual(getStore().messagingDeliveries[0]?.payload, { kind: "final", text: fullReply });
}));

test("full replies are split on UTF-8 boundaries instead of truncated or retried ambiguously", () => withStore(async (dir) => {
  const f = setup(dir);
  const fullReply = `${"a".repeat(65_530)}🙂${"b".repeat(100)}`;
  f.sessions.runTurn = async (_declaration, binding, event, options) => {
    options.authorizeDispatch();
    f.sessions.runs.push({ sessionId: binding.activeWayangSessionId!, eventId: event.connectorEventId, body: event.body, timeoutMs: options.timeoutMs });
    return { resultSummary: fullReply.slice(0, 500), finalAssistantText: fullReply, messages: [] };
  };
  await f.gateway.start();
  await f.gateway.admit(f.declaration.endpointId, inbound("$large", "hello"));
  await f.gateway.drain(f.declaration.endpointId);
  const payloads = getStore().messagingDeliveries.map((row) => row.payload);
  assert.equal(payloads.length, 2);
  assert.equal(payloads.map((payload) => payload.kind === "final" ? payload.text : "").join(""), fullReply);
  assert.equal(payloads.every((payload) => payload.kind !== "final" || Buffer.byteLength(payload.text, "utf8") <= 64 * 1024), true);
}));

test("duplicate ingress never creates a second turn and accepted commands preserve sequence", () => withStore(async (dir) => {
  const f = setup(dir);
  await f.gateway.start();
  assert.equal((await f.gateway.admit(f.declaration.endpointId, inbound("$same", "hello"))).duplicate, false);
  assert.equal((await f.gateway.admit(f.declaration.endpointId, inbound("$same", "hello"))).duplicate, true);
  await f.gateway.admit(f.declaration.endpointId, inbound("$status", "!status"));
  await f.gateway.drain(f.declaration.endpointId);
  assert.equal(f.sessions.runs.length, 1);
  assert.deepEqual(getStore().messagingEvents.map((row) => row.acceptance_sequence), [1, 2]);
  assert.equal(getStore().messagingEvents.every((row) => row.state === "completed"), true);
}));

test("unexpected membership fails admission before durable event creation", () => withStore(async (dir) => {
  const f = setup(dir);
  await f.gateway.start();
  f.attestations.unexpected = true;
  await assert.rejects(f.gateway.admit(f.declaration.endpointId, inbound("$blocked", "hello")), /unexpected human/);
  assert.equal(getStore().messagingEvents.length, 0);
}));

test("close quiesces new claims and awaits the one active endpoint turn", () => withStore(async (dir) => {
  const f = setup(dir);
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  f.sessions.runTurn = async (_declaration, binding, event, options) => {
    options.authorizeDispatch();
    assert.ok(binding.activeWayangSessionId);
    enteredResolve();
    await release;
    f.sessions.origins.add(event.connectorEventId);
    return { resultSummary: "finished during close", finalAssistantText: "finished during close", messages: [] };
  };
  await f.gateway.start();
  await f.gateway.admit(f.declaration.endpointId, inbound("$closing-active", "first"));
  await entered;
  await f.gateway.admit(f.declaration.endpointId, inbound("$closing-pending", "second"));
  let closed = false;
  const closing = f.gateway.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, false, "shutdown must await the active connector turn");
  releaseResolve();
  await closing;
  assert.equal(getStore().messagingEvents.find((row) => row.connector_event_id === "$closing-active")?.state, "completed");
  assert.equal(getStore().messagingEvents.find((row) => row.connector_event_id === "$closing-pending")?.state, "accepted");
  await assert.rejects(f.gateway.admit(f.declaration.endpointId, inbound("$after-close", "third")), /quiescing/);
}));

test("recovery requeues absent origins and never replays a present origin", () => withStore(async (dir) => {
  const f = setup(dir);
  const endpoint = getMessagingEndpoint(f.declaration.endpointId)!;
  const candidate = createSession(f.projectRoot, { agentProfileId: f.profile.id });
  activateMessagingSession({
    endpointId: f.declaration.endpointId,
    declarationSha256: messagingDeclarationSha256(f.declaration),
    expectedRevision: endpoint.revision,
    sessionId: candidate.id,
  });

  const absentEvent = inbound("$absent", "hello");
  const absent = acceptMessagingEvent({
    endpointId: f.declaration.endpointId,
    declarationSha256: messagingDeclarationSha256(f.declaration),
    declaration: f.declaration,
    participantSnapshot: snapshot(absentEvent),
    event: absentEvent,
  }).row;
  claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: messagingDeclarationSha256(f.declaration) });
  await f.gateway.recover();
  assert.equal(getStore().messagingEvents.find((row) => row.connector_event_id === "$absent")?.state, "accepted");

  // Startup drains the requeued item, then a fresh gateway instance simulates
  // the next restart for a separate crash-window marker.
  await f.gateway.start();
  const presentEvent = inbound("$present", "hello again");
  const present = acceptMessagingEvent({
    endpointId: f.declaration.endpointId,
    declarationSha256: messagingDeclarationSha256(f.declaration),
    declaration: f.declaration,
    participantSnapshot: snapshot(presentEvent),
    event: presentEvent,
  }).row;
  claimNextMessagingEvent({ endpointId: f.declaration.endpointId, declarationSha256: messagingDeclarationSha256(f.declaration) });
  f.sessions.origins.add("$present");
  const restarted = new MessagingGatewayService([f.declaration], f.attestations, f.sessions);
  await restarted.recover();
  const recovered = getStore().messagingEvents.find((row) => row.connector_event_id === "$present");
  assert.equal(recovered?.state, "failed");
  assert.equal(recovered?.error_code, "turn_failed");
  assert.equal(f.sessions.runs.filter((run) => run.eventId === "$present").length, 0);
  assert.ok(absent.canonical_event_sha256);
  assert.ok(present.canonical_event_sha256);
}));
