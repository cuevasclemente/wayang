import assert from "node:assert/strict";
import test from "node:test";
import { MatrixTypingController, type MatrixTypingTimerPort } from "./typing.js";

const target = { endpointId: "memory", roomId: "!room:example.test", personaUserId: "@u_agent:example.test" };

test("typing is authorized, bounded, and cleared in finally without changing operation failure", async () => {
  const effects: boolean[] = [];
  const timers: Array<() => void> = [];
  const timer: MatrixTypingTimerPort = {
    setTimeout(callback) { timers.push(callback); return callback; },
    clearTimeout(handle) { const index = timers.indexOf(handle as () => void); if (index >= 0) timers.splice(index, 1); },
  };
  const controller = new MatrixTypingController({
    client: { async setTyping(_room, _user, active) { effects.push(active); } },
    authorization: { async authorize() { return true; } },
    timer, typingTimeoutMs: 2_000, refreshMs: 1_000,
  });
  await assert.rejects(controller.run(target, async () => { throw new Error("synthetic operation failure"); }), /synthetic/);
  assert.deepEqual(effects, [true, false]);
  await controller.close();
  await controller.close();
  assert.equal(timers.length, 0);
});

test("typing failures and denied authorization do not affect the durable operation", async () => {
  const controller = new MatrixTypingController({
    client: { async setTyping() { throw new Error("synthetic homeserver outage"); } },
    authorization: { async authorize() { return true; } },
  });
  assert.equal(await controller.run(target, async () => "completed"), "completed");
  await controller.close();
});
