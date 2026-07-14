import test from "node:test";
import assert from "node:assert/strict";
import { PiSudoBridge } from "./sudo-bridge.js";

test("sudo bridge resolves a pending password request", async () => {
  const bridge = new PiSudoBridge();
  let requestId = "";

  const unsubscribe = bridge.onRequest((req) => {
    requestId = req.requestId;
    assert.equal(req.sessionId, "session-1");
    assert.equal(req.prompt, "Password please");
    assert.equal(req.kind, "password");
    assert.equal(req.command, "sudo whoami");
  });

  const pending = bridge.requestPassword("session-1", "Password please", 1000, { command: "sudo whoami" });
  assert.ok(requestId);
  assert.equal(bridge.getPendingCount("session-1"), 1);

  assert.equal(bridge.resolveForSession("wrong-session", requestId, "secret"), false);
  assert.equal(bridge.resolveForSession("session-1", requestId, "secret"), true);
  assert.equal(await pending, "secret");
  assert.equal(bridge.getPendingCount("session-1"), 0);

  unsubscribe();
});

test("sudo bridge resolves a structured privileged-exec approval request", async () => {
  const bridge = new PiSudoBridge();
  let requestId = "";

  bridge.onRequest((req) => {
    requestId = req.requestId;
    assert.equal(req.sessionId, "session-1");
    assert.equal(req.kind, "approval");
    assert.equal(req.executable, "/usr/bin/systemctl");
    assert.deepEqual(req.argv, ["restart", "demo.service"]);
    assert.equal(req.cwd, "/home/example");
    assert.equal(req.timeoutMs, 30_000);
    assert.deepEqual(req.origin, { mode: "long-lived", lineage: ["reviewer"] });
    assert.equal(req.command, undefined);
  });

  const pending = bridge.requestApproval("session-1", "Approve privileged execution?", 1000, {
    executable: "/usr/bin/systemctl",
    argv: ["restart", "demo.service"],
    cwd: "/home/example",
    timeoutMs: 30_000,
    origin: { mode: "long-lived", lineage: ["reviewer"] },
  });
  assert.equal(bridge.approveForSession("other-session", requestId, true), false);
  assert.equal(bridge.approveForSession("session-1", requestId, true), true);
  assert.equal(await pending, true);
});

test("sudo bridge exposes pending request metadata without secrets", async () => {
  const bridge = new PiSudoBridge();
  const pending = bridge.requestPassword("session-1", "Password please", 1000, { command: "sudo id" });

  const requests = bridge.getPendingRequests("session-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].sessionId, "session-1");
  assert.equal(requests[0].kind, "password");
  assert.equal(requests[0].command, "sudo id");
  assert.equal(bridge.getPendingRequests("other-session").length, 0);

  bridge.cancel(requests[0].requestId);
  assert.equal(await pending, null);
});

test("sudo bridge cancellation resolves with null", async () => {
  const bridge = new PiSudoBridge();
  let requestId = "";
  bridge.onRequest((req) => {
    requestId = req.requestId;
  });

  const pending = bridge.requestPassword("session-1", "Password please", 1000);
  assert.equal(bridge.cancel(requestId), true);
  assert.equal(await pending, null);
});

test("sudo bridge session cleanup cancels matching pending requests", async () => {
  const bridge = new PiSudoBridge();
  const seen: string[] = [];
  bridge.onRequest((req) => {
    seen.push(req.requestId);
  });

  const first = bridge.requestPassword("session-1", "one", 1000);
  const second = bridge.requestPassword("session-2", "two", 1000);

  bridge.cancelSession("session-1");
  assert.equal(await first, null);
  assert.equal(bridge.getPendingCount("session-1"), 0);
  assert.equal(bridge.getPendingCount("session-2"), 1);

  assert.equal(bridge.resolve(seen[1], "ok"), true);
  assert.equal(await second, "ok");
});
