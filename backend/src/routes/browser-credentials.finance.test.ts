import assert from "node:assert/strict";
import express from "express";
import test, { type TestContext } from "node:test";
import type { AuthService } from "../auth/service.js";
import type { CredentialBroker } from "../browser/credentials.js";
import { createBrowserCredentialsRouter } from "./browser-credentials.js";

async function listen(t: TestContext, denySessionId: string) {
  let brokerStatusCalls = 0;
  const auth = { originIsValid: () => true } as unknown as AuthService;
  const broker = {
    status() { brokerStatusCalls += 1; return { available: true, unlocked: false }; },
  } as unknown as CredentialBroker;
  const app = express();
  app.use(express.json());
  app.use("/api", createBrowserCredentialsRouter(auth, broker, {
    assertGenericTargetAllowed(lookup) {
      if (lookup.sessionId === denySessionId) throw new Error("Finance target");
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/api/browser/credentials/status`,
    get brokerStatusCalls() { return brokerStatusCalls; },
  };
}

test("credential routes reject Finance targets before broker or generic browser context lookup", async (t) => {
  const fixture = await listen(t, "finance-session");
  const response = await fetch(fixture.url, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify({ sessionId: "finance-session" }),
  });
  assert.equal(response.status, 403);
  assert.equal(fixture.brokerStatusCalls, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("credential isolation preserves ordinary target behavior", async (t) => {
  const fixture = await listen(t, "finance-session");
  const response = await fetch(fixture.url, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
    body: JSON.stringify({ sessionId: "ordinary-session" }),
  });
  assert.equal(response.status, 200);
  assert.equal(fixture.brokerStatusCalls, 1);
});
