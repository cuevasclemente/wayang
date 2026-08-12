import assert from "node:assert/strict";
import test from "node:test";
import { createProductionMatrixMessaging } from "./wiring.js";

test("disabled production wiring is inert and never resolves fetch", async () => {
  let fetchReads = 0;
  const globalRecord = globalThis as typeof globalThis & { fetch?: typeof globalThis.fetch };
  const original = globalRecord.fetch;
  Object.defineProperty(globalRecord, "fetch", {
    configurable: true,
    get() {
      fetchReads++;
      throw new Error("disabled Matrix wiring touched global fetch");
    },
  });
  try {
    const bootstrap = createProductionMatrixMessaging({ enabled: false });
    assert.equal(fetchReads, 0);
    assert.deepEqual(bootstrap.status(), {
      enabled: false,
      started: false,
      ready: false,
      provisioningAttentionCount: 0,
      delivery: "disabled",
    });
    await bootstrap.start();
    await bootstrap.close();
    await bootstrap.close();
    assert.equal(fetchReads, 0);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalRecord, "fetch");
    else Object.defineProperty(globalRecord, "fetch", { configurable: true, writable: true, value: original });
  }
});
