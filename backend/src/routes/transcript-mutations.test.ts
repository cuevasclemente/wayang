import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { TranscriptMutationError, type TranscriptMutationKind } from "../transcript-mutations.js";
import {
  createTranscriptMutationRouter,
  type TranscriptMutationRouteService,
} from "./transcript-mutations.js";

async function withServer(
  service: TranscriptMutationRouteService,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", createTranscriptMutationRouter(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

class FakeRouteService implements TranscriptMutationRouteService {
  calls: unknown[][] = [];
  error: Error | null = null;

  listEvents(sessionId: string, options?: {
    offset?: number;
    limit?: number;
    branchOffset?: number;
    branchLimit?: number;
  }): unknown {
    this.calls.push(["list", sessionId, options]);
    if (this.error) throw this.error;
    return { session_id: sessionId, total_events: 0, events: [] };
  }

  async mutateEvent(
    sessionId: string,
    eventId: string,
    kind: TranscriptMutationKind,
    input: { pin: unknown; expectedEntry: unknown; replacementEntry?: unknown },
  ): Promise<unknown> {
    this.calls.push(["mutate", sessionId, eventId, kind, input]);
    if (this.error) throw this.error;
    return { session_id: sessionId, event_id: eventId, mutation: kind, revision_retained: false };
  }
}

test("event listing route forwards strict pagination and disables caching", async () => {
  const service = new FakeRouteService();
  await withServer(service, async (origin) => {
    const response = await fetch(`${origin}/api/sessions/session-1/events?offset=2&limit=25`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { session_id: "session-1", total_events: 0, events: [] });
  });
  assert.deepEqual(service.calls, [["list", "session-1", {
    offset: 2,
    limit: 25,
    branchOffset: 0,
    branchLimit: 100,
  }]]);
});

test("event listing route rejects ambiguous or out-of-range pagination", async () => {
  const service = new FakeRouteService();
  await withServer(service, async (origin) => {
    for (const query of [
      "offset=-1",
      "limit=0",
      "limit=501",
      "offset=1.5",
      "limit=1&limit=2",
      "branch_offset=-1",
      "branch_limit=501",
    ]) {
      const response = await fetch(`${origin}/api/sessions/session-1/events?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal((await response.json() as any).code, "invalid_bounds");
    }
  });
  assert.deepEqual(service.calls, []);
});

test("edit and delete routes forward only their exact mutation fields", async () => {
  const service = new FakeRouteService();
  const expected = { type: "message", id: "event-1", parentId: null, message: { role: "user", content: "old" } };
  const replacement = { ...expected, message: { role: "user", content: "new" } };
  await withServer(service, async (origin) => {
    const edit = await fetch(`${origin}/api/sessions/session-1/events/event-1/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "opaque", expected_entry: expected, replacement_entry: replacement }),
    });
    assert.equal(edit.status, 200);
    assert.equal((await edit.json() as any).revision_retained, false);

    const deletion = await fetch(`${origin}/api/sessions/session-1/events/event-1/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "opaque", expected_entry: expected, replacement_entry: { ignored: true } }),
    });
    assert.equal(deletion.status, 200);
  });
  assert.deepEqual(service.calls, [
    ["mutate", "session-1", "event-1", "edit", { pin: "opaque", expectedEntry: expected, replacementEntry: replacement }],
    ["mutate", "session-1", "event-1", "delete", { pin: "opaque", expectedEntry: expected }],
  ]);
});

test("PIN rejection route response never echoes submitted PIN or transcript content", async () => {
  const service = new FakeRouteService();
  service.error = new TranscriptMutationError(
    "Incorrect command guard identity PIN.",
    403,
    "pin_rejected",
    { pinConfigured: true },
  );
  await withServer(service, async (origin) => {
    const secretPin = "12345678";
    const oldContent = "private old transcript canary";
    const response = await fetch(`${origin}/api/sessions/session-1/events/event-1/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pin: secretPin,
        expected_entry: { type: "message", id: "event-1", parentId: null, message: { role: "user", content: oldContent } },
      }),
    });
    assert.equal(response.status, 403);
    const raw = await response.text();
    assert.equal(raw.includes(secretPin), false);
    assert.equal(raw.includes(oldContent), false);
    assert.deepEqual(JSON.parse(raw), {
      error: "Incorrect command guard identity PIN.",
      code: "pin_rejected",
      pinRequired: true,
      pinConfigured: true,
    });
  });
});

test("reindex failures expose only the fixed public error", async () => {
  const service = new FakeRouteService();
  service.error = new TranscriptMutationError(
    "Search reindex failed after transcript mutation.",
    500,
    "reindex_failed",
  );
  await withServer(service, async (origin) => {
    const response = await fetch(`${origin}/api/sessions/session-1/events`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Search reindex failed after transcript mutation.",
      code: "reindex_failed",
    });
  });
});

test("unexpected service errors are sanitized", async () => {
  const service = new FakeRouteService();
  service.error = new Error("private implementation detail");
  await withServer(service, async (origin) => {
    const response = await fetch(`${origin}/api/sessions/session-1/events`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Transcript mutation failed", code: "internal_error" });
  });
});
