import test from "node:test";
import * as assert from "node:assert/strict";
import {
  buildRevisionExactLiveWindow,
  captureModernTodoAuthorization,
  captureTranscriptWindowStreamingBoundary,
  parseTranscriptNegotiation,
  revalidateModernTodoAuthorization,
  resolveOwningTranscriptNegotiation,
  sendUiAuthorizedTranscriptWindow,
  serializeInvalidTranscriptPageRequest,
  serializeTranscriptPageError,
  serializeTranscriptPageGateFailure,
  serializeTranscriptProtocolConfirmation,
  transcriptPageRequestCorrelation,
} from "./ws.js";

test("modern TODO projection denies before read when fresh authorization fails", () => {
  const row = {
    cwd: "/synthetic",
    project_id: "project",
    agent_profile_id: "profile",
    pi_session_file: "/synthetic/session.jsonl",
    legacy_private_session_quarantine: false,
  };
  let calls = 0;
  const witness = captureModernTodoAuthorization(row, row.pi_session_file, () => {
    calls++;
    return { allowed: false };
  });
  assert.equal(witness, null);
  assert.equal(calls, 1);
});

test("modern TODO authorization preserves null raw attribution while binding resolved default", () => {
  const row = {
    cwd: "/synthetic",
    project_id: "project",
    agent_profile_id: null,
    pi_session_file: "/synthetic/session.jsonl",
    legacy_private_session_quarantine: false,
  };
  const allowed = () => ({
    allowed: true,
    project: { id: "project" },
    agentProfile: { id: "resolved-default" },
  });
  const witness = captureModernTodoAuthorization(row, row.pi_session_file, allowed);
  assert.ok(witness);
  assert.equal(witness.rawAgentProfileId, null);
  assert.equal(witness.resolvedAgentProfileId, "resolved-default");
  assert.equal(revalidateModernTodoAuthorization(row, witness, allowed), true);
  assert.equal(revalidateModernTodoAuthorization({ ...row, agent_profile_id: "resolved-default" }, witness, allowed), false,
    "raw durable null attribution must remain null");
  assert.equal(revalidateModernTodoAuthorization(row, witness, () => ({
    allowed: true,
    project: { id: "project" },
    agentProfile: { id: "different-default" },
  })), false);
  assert.equal(revalidateModernTodoAuthorization(row, witness, () => ({
    allowed: true,
    project: { id: "different-project" },
    agentProfile: { id: "resolved-default" },
  })), false);
});

test("live transcript send reauthorizes synchronously after an immediate policy change", () => {
  let policyAllowed = true;
  let sends = 0;
  const sent = sendUiAuthorizedTranscriptWindow({
    window: { type: "transcript_window" } as any,
    witness: {} as any,
    isCurrent: () => true,
    beforeAuthorizationForTests() { policyAllowed = false; },
    reauthorize: () => policyAllowed,
    send: () => { sends++; },
  });
  assert.equal(sent, false);
  assert.equal(sends, 0);
});

test("live transcript send reauthorizes synchronously after an immediate path change", () => {
  let exactPathCurrent = true;
  let sends = 0;
  const sent = sendUiAuthorizedTranscriptWindow({
    window: { type: "transcript_window" } as any,
    witness: {} as any,
    isCurrent: () => true,
    beforeAuthorizationForTests() { exactPathCurrent = false; },
    reauthorize: () => exactPathCurrent,
    send: () => { sends++; },
  });
  assert.equal(sent, false);
  assert.equal(sends, 0);
});

test("streaming snapshot boundary freezes overlay and retains only later buffered events", () => {
  const streaming = { role: "assistant", content: [{ type: "text", text: "snapshot" }], timestamp: 1 };
  const buffered = [{ type: "text_delta", delta: "already represented" }];
  const frozen = captureTranscriptWindowStreamingBoundary(streaming, buffered);
  streaming.content[0].text = "mutated later";
  buffered.push({ type: "text_delta", delta: "later" });
  assert.equal(((frozen?.message as any)?.content as any[])[0].text, "snapshot");
  assert.deepEqual(buffered, [{ type: "text_delta", delta: "later" }]);
});

test("delayed around retry atomically replaces persisted overlay and pre-boundary deltas", async () => {
  let revision = 1;
  let persisted = false;
  let overlay: any = { role: "assistant", content: [{ type: "text", text: "partial" }] };
  const buffered: any[] = [{ type: "text_delta", delta: "partial" }];
  let builds = 0;
  let discards = 0;
  const fingerprint = (size: number) => ({
    device: 1, inode: 1, size, mtimeMs: size, ctimeMs: size,
    headerDigest: "header", mutationEpoch: "epoch",
  });
  const result = await buildRevisionExactLiveWindow({
    capture: () => ({
      sessionFile: "/synthetic/session.jsonl",
      revision: fingerprint(revision),
      streamingMessage: captureTranscriptWindowStreamingBoundary(overlay, buffered),
    }),
    async build(boundary) {
      builds++;
      if (builds === 1) {
        persisted = true;
        overlay = null;
        revision = 2;
        buffered.push({ type: "message_end", message: { role: "assistant" } });
      } else {
        buffered.push({ type: "text_delta", delta: "later" });
      }
      return {
        messages: persisted ? ["persisted-assistant"] : [],
        streamingMessage: boundary.streamingMessage,
      };
    },
    isCurrent: (boundary) => boundary.revision?.size === revision,
    discard: () => { discards++; },
  });
  assert.deepEqual(result, { messages: ["persisted-assistant"], streamingMessage: null });
  assert.equal(builds, 2);
  assert.equal(discards, 1);
  assert.deepEqual(buffered, [{ type: "text_delta", delta: "later" }]);
});

test("continuously changing around attach falls back to fresh usable latest pending window", async () => {
  let revision = 0;
  const buffered: any[] = [];
  let attempts = 0;
  let fallbackCaptures = 0;
  const fingerprint = (size: number) => ({
    device: 1, inode: 1, size, mtimeMs: size, ctimeMs: size,
    headerDigest: "header", mutationEpoch: "epoch",
  });
  const result = await buildRevisionExactLiveWindow({
    maxAttempts: 3,
    capture: () => ({
      sessionFile: "/synthetic/session.jsonl",
      revision: fingerprint(revision),
      streamingMessage: captureTranscriptWindowStreamingBoundary(null, buffered),
    }),
    async build() {
      attempts++;
      revision++;
      buffered.push({ type: "message_end", message: { role: "assistant" } });
      return { messages: [`stale-${attempts}`] };
    },
    isCurrent: (boundary) => boundary.revision?.size === revision,
    discard: () => undefined,
    fallback: (boundary) => {
      fallbackCaptures++;
      buffered.push({ type: "text_delta", delta: "post-fallback" });
      return {
        messages: ["latest-persisted"],
        streamingMessage: boundary.streamingMessage,
        anchor: { requested_id: "old-match", resolved_id: null, status: "pending" as const },
      };
    },
  });
  assert.equal(attempts, 3);
  assert.equal(fallbackCaptures, 1);
  assert.deepEqual(result, {
    messages: ["latest-persisted"],
    streamingMessage: null,
    anchor: { requested_id: "old-match", resolved_id: null, status: "pending" },
  });
  assert.deepEqual(buffered, [{ type: "text_delta", delta: "post-fallback" }]);
});

test("quarantined owning reads retain the legacy owner-visible transcript projection", () => {
  const requested = parseTranscriptNegotiation(new URLSearchParams({
    transcript_protocol: "window-v1",
    transcript_intent: "around",
    transcript_anchor_id: "message-7",
  }), "selection");
  assert.deepEqual(resolveOwningTranscriptNegotiation(requested, true), {
    protocol: null,
    intent: "latest",
  });
  assert.deepEqual(resolveOwningTranscriptNegotiation(requested, false), requested);
});

test("window-v1 negotiation is explicit and selection-bound", () => {
  assert.deepEqual(parseTranscriptNegotiation(new URLSearchParams(), "selection"), {
    protocol: null,
    intent: "latest",
  });
  assert.deepEqual(parseTranscriptNegotiation(new URLSearchParams({ transcript_protocol: "window-v1" }), null), {
    protocol: null,
    intent: "latest",
  });
  assert.deepEqual(parseTranscriptNegotiation(new URLSearchParams({
    transcript_protocol: "window-v1",
    transcript_intent: "around",
    transcript_anchor_id: "message-7",
  }), "selection"), {
    protocol: "window-v1",
    intent: "around",
    anchorId: "message-7",
  });
});

test("switch_session uses the optional transcript envelope", () => {
  assert.deepEqual(parseTranscriptNegotiation({
    type: "switch_session",
    session_id: "session",
    transcript: { protocol: "window-v1", intent: "around", anchor_id: "message-9" },
  }, "selection"), {
    protocol: "window-v1",
    intent: "around",
    anchorId: "message-9",
  });
});

test("server confirms the exact negotiated projection", () => {
  assert.deepEqual(serializeTranscriptProtocolConfirmation("session", "selection", {
    protocol: "window-v1",
    intent: "around",
    anchorId: "message-9",
  }), {
    type: "transcript_protocol",
    session_id: "session",
    selection_id: "selection",
    protocol: "window-v1",
    intent: "around",
    anchor_id: "message-9",
  });
});

test("correlated transcript page failures preserve the exact edge identity", () => {
  const message = { type: "transcript_page_request", request_id: "page.before-7", direction: "before", cursor: "" };
  assert.deepEqual(transcriptPageRequestCorrelation(message, "selection"), {
    requestId: "page.before-7",
    direction: "before",
    selectionId: "selection",
  });
  assert.deepEqual(serializeInvalidTranscriptPageRequest({
    sessionId: "session",
    selectionId: "selection",
    message,
  }), {
    type: "transcript_page_error",
    session_id: "session",
    selection_id: "selection",
    request_id: "page.before-7",
    direction: "before",
    code: "invalid_transcript_page_request",
    error: "Transcript page request is invalid",
  });
});

test("correlated paging gates terminate the exact in-flight edge", () => {
  assert.deepEqual(serializeTranscriptPageGateFailure({
    sessionId: "session",
    selectionId: "selection",
    message: { type: "transcript_page_request", request_id: "page-2", direction: "after" },
    code: "transcript_page_not_ready",
    error: "Session is not ready for transcript paging",
  }), {
    type: "transcript_page_error",
    session_id: "session",
    selection_id: "selection",
    request_id: "page-2",
    direction: "after",
    code: "transcript_page_not_ready",
    error: "Session is not ready for transcript paging",
  });
});

test("uncorrelatable transcript page failures remain generic", () => {
  const failure = serializeInvalidTranscriptPageRequest({
    sessionId: "session",
    selectionId: "selection",
    message: { type: "transcript_page_request", request_id: "bad id", direction: "sideways" },
  });
  assert.equal(failure.type, "error");
  assert.equal("request_id" in failure, false);
  assert.equal("direction" in failure, false);
});

test("transcript page error code and text are bounded", () => {
  const failure = serializeTranscriptPageError({
    sessionId: "session",
    selectionId: "selection",
    requestId: "page-1",
    direction: "after",
    code: "X".repeat(100),
    error: `failure\u202e${"λ".repeat(1_000)}`,
  });
  assert.equal(failure.code, "transcript_page_failed");
  assert.equal(failure.direction, "after");
  assert.ok(Buffer.byteLength(failure.error, "utf8") <= 512);
  assert.equal(failure.error.includes("\u202e"), false);
});

test("invalid or missing around anchors safely negotiate latest", () => {
  assert.deepEqual(parseTranscriptNegotiation({
    transcript: {
      protocol: "window-v1",
      intent: "around",
      anchor_id: "bad\u0000anchor",
    },
  }, "selection"), {
    protocol: "window-v1",
    intent: "latest",
  });
});
