import assert from "node:assert/strict";
import test from "node:test";
import { reloadWebSocketRuntime } from "./ws.js";

test("websocket reload reports success only after Wayang runtime overrides are restored", async () => {
  const order: string[] = [];
  await reloadWebSocketRuntime({
    async reloadResources() { order.push("reload_and_reapply"); },
  }, () => { order.push("success_notice"); });
  assert.deepEqual(order, ["reload_and_reapply", "success_notice"]);

  let successReported = false;
  await assert.rejects(() => reloadWebSocketRuntime({
    async reloadResources() { throw new Error("synthetic fail-closed reload"); },
  }, () => { successReported = true; }), /synthetic fail-closed reload/);
  assert.equal(successReported, false);
});
