import assert from "node:assert/strict";
import test from "node:test";
import { createMatrixCredentialAuthority } from "./auth.js";
import type { MatrixDeliveryWorker } from "./delivery-worker.js";
import { createMatrixProductionBootstrap } from "./production.js";
import type { MatrixProvisioningService } from "./provisioning.js";
import type { MatrixApplicationService } from "./service.js";
import type { MatrixTypingController } from "./typing.js";

test("disabled production bootstrap is inert and idempotent", async () => {
  const bootstrap = createMatrixProductionBootstrap({ enabled: false });
  await bootstrap.start();
  await bootstrap.close();
  await bootstrap.close();
  assert.deepEqual(bootstrap.status(), {
    enabled: false, started: false, ready: false, provisioningAttentionCount: 0, delivery: "disabled",
  });
});

test("enabled startup completes recovery while provisioning outage remains nonfatal and retrying", async () => {
  const calls: string[] = [];
  const timers: Array<() => void> = [];
  let ready = false;
  const service = {
    async start() { calls.push("gateway-recovery"); ready = true; },
    stopAdmission() { calls.push("stop-admission"); ready = false; },
    async close() { calls.push("gateway-close"); ready = false; },
    status() { return { ready, accepting: ready }; },
    async ingestTransaction() {}, async queryUser() {}, async queryAlias() {},
  } as unknown as MatrixApplicationService;
  const provisioning = {
    async ensureEndpoint() { calls.push("provision"); throw new Error("synthetic homeserver outage"); },
    getStatus() { return { endpointId: "memory", code: "homeserver_unavailable", retrying: true, updatedAt: 1 }; },
    listStatuses() { return [{ endpointId: "memory", code: "homeserver_unavailable", retrying: true, updatedAt: 1 }]; },
  } as unknown as MatrixProvisioningService;
  const worker = {
    start() { calls.push("worker-start"); }, async close() { calls.push("worker-close"); },
    status() { return { code: "idle", updatedAt: 1 }; },
  } as unknown as MatrixDeliveryWorker;
  const typing = { async close() { calls.push("typing-close"); } } as unknown as MatrixTypingController;
  const credentials = createMatrixCredentialAuthority("synthetic-hs-token-123", "synthetic-as-token-123");
  const bootstrap = createMatrixProductionBootstrap({
    enabled: true, verifier: credentials.hsTokenVerifier, service, provisioning,
    deliveryWorker: worker, typing, endpointIds: ["memory"],
    timer: { setTimeout(callback) { timers.push(callback); return callback; }, clearTimeout() {} },
  });
  await bootstrap.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 3), ["gateway-recovery", "worker-start", "provision"]);
  assert.equal(bootstrap.status().ready, true);
  assert.equal(bootstrap.status().provisioningAttentionCount, 1);
  assert.equal(timers.length, 1);
  await bootstrap.close();
  await bootstrap.close();
  assert.ok(calls.indexOf("stop-admission") < calls.indexOf("worker-close"));
});
