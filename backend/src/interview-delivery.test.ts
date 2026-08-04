import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmInterviewToolResultDelivery,
  deliverSubmittedInterview,
  retrySubmittedInterviewDelivery,
  type InterviewDeliveryDependencies,
} from "./interview-delivery.js";
import type { InterviewRecord } from "./interviews.js";

function record(id: string): InterviewRecord {
  return {
    request_id: id,
    submission_id: `submission-${id}`,
    session_id: `session-${id}`,
    pi_session_id: null,
    pi_session_file: null,
    origin_tool_name: "questionnaire",
    origin_tool_call_id: `call-${id}`,
    questions: [{ id: "q", label: "Scope", prompt: "Proceed?", options: [{ value: "yes", label: "Yes" }], allowOther: true }],
    answers: [{ id: "q", value: "yes", label: "Yes", wasCustom: false, index: 0 }],
    status: "submitted",
    created_at: 1,
    submitted_at: 2,
    submission_channel: "WAYANG_WEBSOCKET",
    authenticated_principal: "WAYANG_SINGLE_USER",
  };
}

function dependencies(overrides: Partial<InterviewDeliveryDependencies> = {}): InterviewDeliveryDependencies {
  return {
    getBridge: () => ({ hasToolResultHandoff: () => false, completeToolResultHandoff: () => {} }),
    findToolResultEntry: async () => undefined,
    markDelivered: (requestId, mode, entryId) => ({
      ...record(requestId),
      status: "delivered",
      delivery_mode: mode,
      delivery_entry_id: entryId,
      delivered_at: 3,
    }),
    deliverSubmission: async () => ({ entryId: "custom-entry", alreadyPresent: false }),
    sleep: async () => {},
    ...overrides,
  };
}

test("tool-result confirmation waits for the exact entry, marks it, and releases the handoff", async () => {
  const target = record("confirm");
  let probes = 0;
  let completed = 0;
  const marked: Array<[string, string, string | undefined]> = [];
  const deps = dependencies({
    getBridge: () => ({
      hasToolResultHandoff: () => true,
      completeToolResultHandoff: () => { completed++; },
    }),
    findToolResultEntry: async () => ++probes === 2 ? "tool-entry" : undefined,
    markDelivered: (requestId, mode, entryId) => {
      marked.push([requestId, mode, entryId]);
      return { ...target, status: "delivered", delivery_mode: mode, delivery_entry_id: entryId, delivered_at: 3 };
    },
  });

  assert.equal(await confirmInterviewToolResultDelivery(target, { timeoutMs: 1_000, pollMs: 1 }, deps), true);
  assert.equal(probes, 2);
  assert.deepEqual(marked, [[target.request_id, "tool_result", "tool-entry"]]);
  assert.equal(completed, 1);
});

test("delivery suppresses an active handoff and otherwise reconciles tool-result before custom delivery", async () => {
  const held = record("held");
  let probes = 0;
  let customDeliveries = 0;
  await deliverSubmittedInterview(held, dependencies({
    getBridge: () => ({ hasToolResultHandoff: () => true, completeToolResultHandoff: () => {} }),
    findToolResultEntry: async () => { probes++; return undefined; },
    deliverSubmission: async () => { customDeliveries++; return { entryId: "unexpected", alreadyPresent: false }; },
  }));
  assert.equal(probes, 0);
  assert.equal(customDeliveries, 0);

  const reconciled = record("reconciled");
  const modes: string[] = [];
  await deliverSubmittedInterview(reconciled, dependencies({
    findToolResultEntry: async () => "persisted-tool-entry",
    markDelivered: (_requestId, mode) => { modes.push(mode); return { ...reconciled, status: "delivered", delivery_mode: mode, delivered_at: 3 }; },
    deliverSubmission: async () => { customDeliveries++; return { entryId: "unexpected", alreadyPresent: false }; },
  }));
  assert.deepEqual(modes, ["tool_result"]);
  assert.equal(customDeliveries, 0);
});

test("bounded retry falls back to custom delivery and succeeds after transient failures", async () => {
  const target = record("retry");
  let attempts = 0;
  const delays: number[] = [];
  const modes: string[] = [];
  const deps = dependencies({
    deliverSubmission: async () => {
      attempts++;
      if (attempts < 3) throw new Error("synthetic transient delivery failure");
      return { entryId: "custom-entry", alreadyPresent: false };
    },
    markDelivered: (_requestId, mode) => { modes.push(mode); return { ...target, status: "delivered", delivery_mode: mode, delivered_at: 3 }; },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  await retrySubmittedInterviewDelivery(target, { attempts: 3, initialDelayMs: 5 }, deps);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5, 10]);
  assert.deepEqual(modes, ["custom_message"]);
});
