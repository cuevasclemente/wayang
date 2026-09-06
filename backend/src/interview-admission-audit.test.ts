import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { InterviewRecord } from "./interviews.js";
import type { InterviewSubmissionDelivery, PiSessionHandle } from "./pi-bridge.js";

type CustomMessageSendArguments = Parameters<PiSessionHandle["session"]["sendCustomMessage"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function observe<T>(promise: Promise<T>) {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const settled = promise.then(
    (value) => { outcome = { ok: true, value }; },
    (error: unknown) => { outcome = { ok: false, error }; },
  );
  return { settled, get outcome() { return outcome; } };
}

/**
 * Regression boundary: real Wayang delivery + real SDK custom steering queue.
 * Provider streaming/time are synthetic. Additional tests gate public extension
 * events or inject exact send/disposal failures; admitted sends still use Pi's
 * real queue, persistence, evidence validation and Wayang deduplication.
 * SDK user-message counters/captures are NOT custom-message discard receipts.
 */
test("interview admission identity survives observation deadlines", async (suite) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-interview-admission-audit-"));
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const overrides = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
    WAYANG_DATA_DIR: path.join(home, ".wayang"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    WAYANG_AUTO_SESSION_TITLE: "off",
    WAYANG_MEMORY_FIRST_ENABLED: "0",
  };
  // Only non-secret path/feature variables are saved. No ambient credential is
  // inspected, unset, or used. Imports follow isolation to cover singleton paths.
  const previous = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  let closeStore: (() => void) | undefined;
  suite.after(() => {
    closeStore?.();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true }); // Only this test's synthetic tree.
  });
  suite.mock.method(globalThis, "fetch", async () => {
    throw new Error("Interview audit must not perform network requests");
  });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "interview-audit-offline": {
        baseUrl: "https://interview-audit.invalid/v1",
        api: "openai-completions",
        apiKey: "synthetic-interview-audit-only",
        models: [{ id: "fixture", reasoning: false, contextWindow: 200_000, maxTokens: 256 }],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false }, packages: [],
  }));

  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { init, close } = await import("./db.js");
  const { createAgentProfile } = await import("./agent-profiles.js");
  const { createProject } = await import("./projects.js");
  const { createSession } = await import("./sessions.js");
  const { createOpenInterview, submitInterview, getInterview, markDelivered, verifyInterviewSubmissionEntry } = await import("./interviews.js");
  const { WAYANG_WEBSOCKET_SUBMISSION_CONTEXT } = await import("./interview-provenance.js");
  const { createPiSession, destroyPiSession, disposePiAgentSession, deliverInterviewSubmission, abortInteractiveTurn, stopIdlePiSessions } = await import("./pi-bridge.js");
  closeStore = close;
  init();

  async function withStreamingFixture(t: TestContext, run: (fixture: {
    handle: PiSessionHandle;
    submit: (name: string) => InterviewRecord;
    deliver: (record: InterviewRecord) => ReturnType<typeof observe<InterviewSubmissionDelivery>>;
    advance: (ms: number) => Promise<void>;
    drain: () => Promise<void>;
    start: () => Promise<void>;
    entries: (record: InterviewRecord) => ReturnType<PiSessionHandle["session"]["sessionManager"]["getEntries"]>;
  }) => Promise<void>) {
    const cwd = fs.mkdtempSync(path.join(home, "project-"));
    const fixtureName = `Synthetic admission audit ${path.basename(cwd)}`;
    const profile = createAgentProfile({ name: fixtureName, memory_access: "none" });
    createProject({
      cwd, name: fixtureName, default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
    });
    const row = createSession(cwd, {
      agentProfileId: profile.id, provider: "interview-audit-offline", model: "fixture",
    });
    let handle: PiSessionHandle | undefined;
    let release = gate();
    let entered = gate();
    let foreground: ReturnType<typeof observe<void>> | undefined;
    const observers: Array<ReturnType<typeof observe<InterviewSubmissionDelivery>>> = [];
    let clock = performance.now();
    let timersEnabled = false;
    async function advance(ms: number) {
      // Node MockTimers does not virtualize node:perf_hooks.performance.now().
      // Keep that production deadline clock aligned with mocked setTimeout.
      await flush();
      clock += ms;
      t.mock.timers.tick(ms);
      await flush();
      assert.equal(Boolean(handle?.capabilityAuthorityDenied), false,
        "advancing observation time must preserve this fixture's runtime authority");
    }
    try {
      handle = await createPiSession(row.id, cwd, row.provider, row.model);
      const live = handle;
      // Keep the production tool catalog intact: removing active host bash
      // correctly trips its permanent registry-identity revocation guard.
      // The offline stream below emits text only, so no tool can be dispatched.
      assert.equal(Boolean(live.capabilityAuthorityDenied), false);
      const activeToolNames = live.session.getActiveToolNames();
      let holdNextStream = true;
      live.session.agent.streamFunction = async (model, _context, options) => {
        if (holdNextStream) {
          holdNextStream = false;
          const unblock = release.resolve;
          options?.signal?.addEventListener("abort", unblock, { once: true });
          entered.resolve();
          try {
            if (!options?.signal?.aborted) await release.promise;
          } finally {
            options?.signal?.removeEventListener("abort", unblock);
          }
        }
        const aborted = options?.signal?.aborted;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: "Synthetic offline completion" }],
          timestamp: Date.now(), stopReason: aborted ? "aborted" : "stop",
          ...(aborted ? { errorMessage: "Synthetic audit abort" } : {}),
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: "stop", message });
        return stream;
      };
      async function start() {
        release = gate();
        entered = gate();
        holdNextStream = true;
        foreground = observe(live.session.prompt("Hold a synthetic streaming turn"));
        // Bounded event-loop pumping, not a real-time sleep or private state edit.
        for (let n = 0; n < 100 && !live.session.agent.signal; n++) await flush();
        await Promise.race([entered.promise, foreground.settled.then(() => {
          assert.fail("Synthetic foreground settled before entering the stream gate");
        })]);
        assert.equal(live.session.isStreaming, true);
        assert.equal(Boolean(live.capabilityAuthorityDenied), false,
          "the streaming fixture must enter with production authority intact");
        assert.deepEqual(live.session.getActiveToolNames(), activeToolNames);
      }
      await start();
      clock = performance.now();
      t.mock.method(performance, "now", () => clock);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      timersEnabled = true;
      function entries(record: InterviewRecord) {
        // Reopen only the fixture's exact physical transcript: no private queue
        // adapter and no inference from pendingMessageCount/getSteeringMessages.
        return SessionManager.open(live.session.sessionManager.getSessionFile()!, undefined, cwd)
          .getEntries().filter((entry) => entry.type === "custom_message"
            && entry.customType === "wayang-interview-submission"
            && isRecord(entry.details)
            && entry.details.request_id === record.request_id
            && entry.details.submission_id === record.submission_id);
      }
      await run({
        handle: live, start, advance, entries,
        submit(name) {
          const open = createOpenInterview({
            sessionId: row.id, toolName: "questionnaire", toolCallId: `synthetic-${name}`,
            piSessionId: live.session.sessionId, piSessionFile: live.session.sessionFile,
            questions: [{ id: "q", label: "Scope", prompt: "Proceed?", options: [{ value: "yes", label: "Yes" }] }],
          });
          const submitted = submitInterview(row.id, open.request_id, [{ id: "q", value: "yes" }], WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
          assert.equal(submitted.ok, true);
          if (!submitted.ok) throw new Error("Synthetic submission was rejected");
          return submitted.record;
        },
        deliver(record) {
          assert.equal(Boolean(live.capabilityAuthorityDenied), false,
            "delivery must exercise admission, not a fixture-induced authority denial");
          const observer = observe(deliverInterviewSubmission(row.id, record));
          observers.push(observer);
          return observer;
        },
        async drain() {
          release.resolve();
          await foreground!.settled;
          assert.equal(foreground!.outcome?.ok, true);
          await advance(50);
        },
      });
    } finally {
      // Red assertions must not leave gated runs, observation timers, or a live
      // runtime behind. Drain accepted work before removing synthetic storage.
      release.resolve();
      try {
        if (foreground) await foreground.settled;
        if (timersEnabled) await advance(60_001);
        await Promise.all(observers.map((observer) => observer.settled));
      } finally {
        t.mock.restoreAll();
        t.mock.timers.reset();
        await destroyPiSession(row.id);
      }
    }
  }

  function timedOut(observer: ReturnType<typeof observe<InterviewSubmissionDelivery>>) {
    assert.equal(observer.outcome?.ok, false, "the bounded observer expires while accepted work stays queued");
    if (observer.outcome && !observer.outcome.ok) {
      assert.match(String(observer.outcome.error), /queued.*not persisted.*timeout/i);
    }
  }

  await suite.test("two deadlines and concurrent retries admit one exact identity, not one answer text", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const first = f.submit("first");
      const separate = f.submit("separate");
      assert.notEqual(first.submission_id, separate.submission_id);
      assert.deepEqual(first.answers, separate.answers);
      const initial = f.deliver(first);
      await f.advance(30_001);
      timedOut(initial);
      assert.equal(f.handle.acceptedTopLevelWorkCount, 1, "the admission, not its expired observer, owns the lease");
      assert.equal(f.handle.session.agent.hasQueuedMessages(), true);
      assert.equal(f.entries(first).length, 0);
      const retry = f.deliver(first);
      await f.advance(30_001);
      timedOut(retry);
      assert.equal(f.entries(first).length, 0, "both deadlines occur before any queue drain");
      assert.equal(getInterview(first.request_id)?.status, "submitted");

      const concurrent = [f.deliver(first), f.deliver(first)];
      const other = f.deliver(separate);
      await f.advance(0);
      await f.drain();
      assert.equal(other.outcome?.ok, true, "equal answers with another exact identity must still deliver");
      assert.equal(f.entries(separate).length, 1);
      assert.equal(f.handle.acceptedTopLevelWorkCount, 0);
      // Baseline 0b8ba93: FOUR persisted custom entries for the first identity.
      assert.equal(f.entries(first).length, 1,
        "observer expiry and concurrent retries must not re-enqueue an accepted exact submission");
      const entry = f.entries(first)[0]!;
      assert.equal(verifyInterviewSubmissionEntry(first.session_id, entry), true);
      for (const observer of concurrent) {
        assert.equal(observer.outcome?.ok, true);
        if (observer.outcome?.ok) assert.equal(observer.outcome.value.entryId, entry.id);
      }
      markDelivered(first.request_id, "custom_message", entry.id);
      const reconciled = f.deliver(first);
      await f.advance(0);
      assert.deepEqual(reconciled.outcome, { ok: true, value: { entryId: entry.id, alreadyPresent: true } });
      assert.equal(f.entries(first).length, 1);
    });
  });

  await suite.test("failed queue clearing retains admission ownership", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const record = f.submit("failed-clear");
      const initial = f.deliver(record);
      await f.advance(30_001);
      timedOut(initial);
      const clear = t.mock.method(f.handle.session, "clearQueue", () => {
        throw new Error("Synthetic clear failure");
      });
      try {
        await assert.rejects(abortInteractiveTurn(f.handle, { clearQueue: true }), /Synthetic clear failure/);
      } finally {
        clear.mock.restore();
      }
      assert.equal(f.handle.session.isStreaming, true);
      assert.equal(f.handle.session.agent.hasQueuedMessages(), true);
      const retry = f.deliver(record);
      await f.advance(0);
      await f.drain();
      assert.equal(retry.outcome?.ok, true);
      // Baseline: two custom entries; a failed clear did not discard the first.
      assert.equal(f.entries(record).length, 1, "failed clearing must not free accepted identity ownership");
    });
  });

  function holdNextSubmissionPersistence(t: TestContext, handle: PiSessionHandle) {
    const entered = gate();
    const release = gate();
    const runner = handle.session.extensionRunner;
    const emit = runner.emitMessageEnd.bind(runner);
    let held = false;
    const mock = t.mock.method(runner, "emitMessageEnd", async (event: MessageEndEvent) => {
      if (!held && event.message.role === "custom"
        && event.message.customType === "wayang-interview-submission") {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return emit(event);
    });
    return { entered, release, restore: () => mock.mock.restore() };
  }

  await suite.test("late persistence releases the lease without an observer retry, after message_end", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const record = f.submit("late-persist");
      let sawPrePersistenceEvent = false;
      const unsubscribe = f.handle.session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "custom"
          || event.message.customType !== "wayang-interview-submission") return;
        sawPrePersistenceEvent = true;
        assert.equal(f.entries(record).length, 0, "SDK listeners run before the durable append");
        assert.equal(f.handle.acceptedTopLevelWorkCount, 1, "message_end itself is not persistence");
      });
      try {
        const initial = f.deliver(record);
        await f.advance(30_001);
        timedOut(initial);
        assert.equal(f.handle.acceptedTopLevelWorkCount, 1);
        await f.drain();
        assert.equal(sawPrePersistenceEvent, true);
        assert.equal(f.entries(record).length, 1);
        assert.equal(f.handle.acceptedTopLevelWorkCount, 0, "no retry is needed to retire durable work");
      } finally { unsubscribe(); }
    });
  });

  await suite.test("clear discards only queued custom objects, not an already claimed submission", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const claimed = f.submit("claimed-gap");
      const queued = f.submit("queued-beside-claimed");
      const initial = f.deliver(claimed);
      await f.advance(30_001);
      timedOut(initial);
      const held = holdNextSubmissionPersistence(t, f.handle);
      const draining = observe(f.drain());
      let interrupt: ReturnType<typeof observe<{ steering: string[]; followUp: string[] }>> | undefined;
      try {
        await held.entered.promise;
        assert.equal(f.handle.session.agent.hasQueuedMessages(), false, "Pi already claimed the first object");
        assert.equal(f.entries(claimed).length, 0);
        const other = f.deliver(queued);
        await f.advance(0);
        assert.equal(f.handle.acceptedTopLevelWorkCount, 2);
        assert.equal(f.handle.session.agent.hasQueuedMessages(), true);
        interrupt = observe(abortInteractiveTurn(f.handle, { clearQueue: true }));
        await f.advance(0);
        assert.equal(other.outcome?.ok, false, "the exact queued object was discarded");
        assert.equal(f.handle.acceptedTopLevelWorkCount, 1, "the claimed object remains owned across clear");
        const retry = f.deliver(claimed);
        await f.advance(30_001);
        timedOut(retry);
        assert.equal(f.handle.session.agent.hasQueuedMessages(), false, "retry did not enqueue a duplicate in the claimed gap");
      } finally {
        held.release.resolve();
        await draining.settled;
        await interrupt?.settled;
        held.restore();
      }
      await f.advance(0);
      assert.equal(f.entries(claimed).length, 1);
      assert.equal(f.entries(queued).length, 0);
      assert.equal(f.handle.acceptedTopLevelWorkCount, 0);
      await f.start();
      const retryDiscarded = f.deliver(queued);
      await f.drain();
      assert.equal(retryDiscarded.outcome?.ok, true);
      assert.equal(f.entries(queued).length, 1);
    });
  });

  await suite.test("idle send observer expires at a gated message_end before persistence", async (t) => {
    // Native sendCustomMessage enters the run synchronously. This proves the
    // observer deadline during a held persistence event, not a native gap
    // between accepting sendCustomMessage and entering the SDK run.
    await withStreamingFixture(t, async (f) => {
      await f.drain();
      assert.equal(f.handle.session.isStreaming, false);
      const record = f.submit("idle-send");
      const held = holdNextSubmissionPersistence(t, f.handle);
      try {
        const initial = f.deliver(record);
        await held.entered.promise;
        await f.advance(30_001);
        timedOut(initial);
        assert.equal(f.entries(record).length, 0);
        assert.equal(f.handle.acceptedTopLevelWorkCount, 1);
      } finally {
        held.release.resolve();
        await f.handle.session.waitForIdle();
        held.restore();
      }
      await f.advance(0);
      assert.equal(f.entries(record).length, 1);
      assert.equal(f.handle.acceptedTopLevelWorkCount, 0);
    });
  });

  await suite.test("reservation precedes a reentrant send observer", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const record = f.submit("reentrant-send");
      const send = f.handle.session.sendCustomMessage.bind(f.handle.session);
      let calls = 0;
      let reentrant: ReturnType<typeof observe<InterviewSubmissionDelivery>> | undefined;
      const dispatch = t.mock.method(f.handle.session, "sendCustomMessage", (...[message, options]: CustomMessageSendArguments) => {
        calls++;
        // Reenter before the real SDK has received or queued the first call.
        if (calls === 1) reentrant = f.deliver(record);
        return send(message, options);
      });
      try {
        const initial = f.deliver(record);
        await f.advance(0);
        assert.equal(calls, 1);
        assert.equal(f.handle.acceptedTopLevelWorkCount, 1);
        await f.drain();
        assert.equal(initial.outcome?.ok, true);
        assert.equal(reentrant?.outcome?.ok, true);
        assert.equal(f.entries(record).length, 1);
      } finally { dispatch.mock.restore(); }
    });
  });

  await suite.test("verified tool-result is reconciled before custom admission", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const record = f.submit("existing-tool-result");
      const entryId = f.handle.session.sessionManager.appendMessage({
        role: "toolResult", toolName: record.origin_tool_name,
        toolCallId: record.origin_tool_call_id!, timestamp: Date.now(),
        content: [{ type: "text", text: "Synthetic canonical questionnaire submission" }],
        isError: false,
        details: {
          status: "submitted", requestId: record.request_id, submissionId: record.submission_id,
          questions: record.questions, answers: record.answers,
        },
      });
      assert.equal(verifyInterviewSubmissionEntry(record.session_id,
        f.handle.session.sessionManager.getEntry(entryId)), true);
      const delivery = f.deliver(record);
      await f.advance(0);
      assert.deepEqual(delivery.outcome, { ok: true, value: { entryId, alreadyPresent: true } });
      assert.equal(f.handle.acceptedTopLevelWorkCount, 0);
      assert.equal(f.handle.session.agent.hasQueuedMessages(), false);
      // Existing outer custom-delivery marking is idempotent and cannot
      // overwrite the verified tool result's authoritative delivery mode.
      markDelivered(record.request_id, "custom_message", entryId);
      assert.equal(getInterview(record.request_id)?.delivery_mode, "tool_result");
      assert.equal(f.entries(record).length, 0);
    });
  });

  await suite.test("send rejection after queue insertion stays owned until eventual persistence", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const record = f.submit("ambiguous-send");
      const send = f.handle.session.sendCustomMessage.bind(f.handle.session);
      const failure = t.mock.method(f.handle.session, "sendCustomMessage", async (...[message, options]: CustomMessageSendArguments) => {
        await send(message, options);
        throw new Error("Synthetic post-admission send failure");
      });
      try {
        const initial = f.deliver(record);
        await f.advance(0);
        assert.equal(initial.outcome?.ok, false);
        assert.equal(f.handle.acceptedTopLevelWorkCount, 1);
      } finally { failure.mock.restore(); }
      const retry = f.deliver(record);
      await f.advance(0);
      assert.equal(retry.outcome?.ok, false, "an ambiguous failed send is not permission to readmit");
      await f.drain();
      assert.equal(f.entries(record).length, 1);
      assert.equal(f.handle.acceptedTopLevelWorkCount, 0);
    });
  });

  await suite.test("failed disposal retains ownership and completed disposal releases it", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const record = f.submit("disposal-failure");
      const initial = f.deliver(record);
      await f.advance(30_001);
      timedOut(initial);
      await assert.rejects(disposePiAgentSession(f.handle), /cleanup is incomplete/);
      assert.equal(f.handle.acceptedTopLevelWorkCount, 1, "listener disposal cannot claim active-run cleanup");
      // Direct SDK control models an out-of-band clear with no Wayang receipt.
      // Empty queues alone cannot free the admission, even once Pi is idle.
      f.handle.session.clearQueue();
      await f.handle.session.abort();
      assert.equal(f.entries(record).length, 0);
      assert.equal(f.handle.acceptedTopLevelWorkCount, 1);
      assert.deepEqual(await stopIdlePiSessions(Date.now() + 600_000), [],
        "idle TTL must not evict unresolved admission ownership");
      const dispose = t.mock.method(f.handle.session, "dispose", () => {
        throw new Error("Synthetic disposal failure");
      });
      try {
        await assert.rejects(disposePiAgentSession(f.handle), /Synthetic disposal failure/);
        assert.equal(f.handle.acceptedTopLevelWorkCount, 1);
      } finally { dispose.mock.restore(); }
      await disposePiAgentSession(f.handle);
      assert.equal(f.handle.acceptedTopLevelWorkCount, 0);
      assert.equal(f.entries(record).length, 0);
    });
  });

  await suite.test("successful SDK queue clear permits one new admission after exact discard", async (t) => {
    await withStreamingFixture(t, async (f) => {
      const record = f.submit("successful-clear");
      const initial = f.deliver(record);
      await f.advance(30_001);
      timedOut(initial);
      assert.equal(f.handle.session.agent.hasQueuedMessages(), true);
      await abortInteractiveTurn(f.handle, { clearQueue: true });
      assert.equal(f.handle.session.agent.hasQueuedMessages(), false,
        "this fixture queued only this custom message; inspect the actual SDK queue's public predicate");
      assert.equal(f.entries(record).length, 0);
      await f.start(); // Retry is deliberately streaming, not the SDK idle custom path.
      const retry = f.deliver(record);
      await f.advance(0);
      await f.drain();
      assert.equal(retry.outcome?.ok, true);
      assert.equal(f.entries(record).length, 1);
      assert.equal(verifyInterviewSubmissionEntry(record.session_id, f.entries(record)[0]), true);
    });
  });
});
