import assert from "node:assert/strict";
import test from "node:test";
import { BrowserInputCoalescer, protectedGenericBrowserWsTargetDenied, proxyBufferAction } from "./ws.js";

test("Protected WS targets are classified from URL metadata before browser/auth lookup", () => {
  const seen: unknown[] = [];
  const protectedTarget = new URL("http://localhost/ws/browser?session_id=protected-session&persistence=session");
  assert.equal(protectedGenericBrowserWsTargetDenied(protectedTarget, (lookup) => {
    seen.push(lookup);
    return lookup.sessionId === "protected-session";
  }), true);
  assert.deepEqual(seen, [{ sessionId: "protected-session", projectCwd: null, persistence: "session" }]);
  const ordinary = new URL("http://localhost/ws/browser-vnc?project_cwd=%2Fsynthetic%2Fresearch&persistence=project");
  assert.equal(protectedGenericBrowserWsTargetDenied(ordinary, (lookup) => lookup.projectCwd === "/protected"), false);
});

test("VNC proxy backpressure has bounded pause and close thresholds", () => {
  assert.equal(proxyBufferAction(0), "continue");
  assert.equal(proxyBufferAction(3 * 1024 * 1024), "pause");
  assert.equal(proxyBufferAction(5 * 1024 * 1024), "close");
});

test("CDP pointer moves keep only the latest event and wheel deltas coalesce", async () => {
  const dispatched: any[] = [];
  const coalescer = new BrowserInputCoalescer((message) => dispatched.push(message), 5);
  coalescer.push({ type: "mouse", event: "move", x: 1, y: 1 });
  coalescer.push({ type: "mouse", event: "move", x: 2, y: 3 });
  coalescer.push({ type: "mouse", event: "wheel", x: 2, y: 3, deltaY: 4 });
  coalescer.push({ type: "mouse", event: "wheel", x: 2, y: 3, deltaY: 7 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(dispatched.length, 2);
  assert.deepEqual(dispatched[0], { type: "mouse", event: "move", x: 2, y: 3 });
  assert.equal(dispatched[1].deltaY, 11);

  coalescer.push({ type: "mouse", event: "down", x: 2, y: 3 });
  assert.equal(dispatched.at(-1).event, "down");
  coalescer.stop();
});
