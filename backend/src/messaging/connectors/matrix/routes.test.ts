import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import express from "express";
import { createMatrixCredentialAuthority } from "./auth.js";
import { createMatrixApplicationServiceRouter } from "./routes.js";
import type { MatrixApplicationService } from "./service.js";

async function withServer(router: express.Router, operation: (origin: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(router);
  app.use((_request, response) => response.status(200).send("SPA"));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try { await operation(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("AS routes authenticate before parsing and return Matrix-shaped 404/405 without SPA fallback", async () => {
  const credentials = createMatrixCredentialAuthority("synthetic-hs-token-123", "synthetic-as-token-123");
  let transactionCalls = 0;
  const service = {
    async ingestTransaction() { transactionCalls++; }, async queryUser() {}, async queryAlias() {},
  } as unknown as MatrixApplicationService;
  await withServer(createMatrixApplicationServiceRouter({ verifier: credentials.hsTokenVerifier, service }), async (origin) => {
    const transactionUrl = `${origin}/_matrix/app/v1/transactions/synthetic-txn`;
    const unauthorized = await fetch(transactionUrl, {
      method: "PUT", headers: { "content-type": "application/json" }, body: "not-json",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json() as { errcode: string }).errcode, "M_MISSING_TOKEN");
    assert.equal(transactionCalls, 0);

    const forbidden = await fetch(transactionUrl, {
      method: "PUT",
      headers: { authorization: "Bearer wrong-synthetic-token", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json() as { errcode: string }).errcode, "M_FORBIDDEN");

    const headers = { authorization: "Bearer synthetic-hs-token-123", "content-type": "application/json" };
    const accepted = await fetch(transactionUrl, { method: "PUT", headers, body: "{\"events\":[]}" });
    assert.equal(accepted.status, 200);
    assert.equal(transactionCalls, 1);

    const wrongMethod = await fetch(transactionUrl, { method: "POST", headers, body: "{}" });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json() as { errcode: string }).errcode, "M_UNRECOGNIZED");

    const unknown = await fetch(`${origin}/_matrix/app/v1/unknown`, { headers: { authorization: headers.authorization } });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json() as { errcode: string }).errcode, "M_UNRECOGNIZED");
  });
});

test("query routes ensure exact entities before returning 200", async () => {
  const credentials = createMatrixCredentialAuthority("synthetic-hs-token-123", "synthetic-as-token-123");
  const seen: string[] = [];
  const service = {
    async ingestTransaction() {},
    async queryUser(value: string) { seen.push(value); },
    async queryAlias(value: string) { seen.push(value); },
  } as unknown as MatrixApplicationService;
  await withServer(createMatrixApplicationServiceRouter({ verifier: credentials.hsTokenVerifier, service }), async (origin) => {
    const headers = { authorization: "Bearer synthetic-hs-token-123" };
    assert.equal((await fetch(`${origin}/_matrix/app/v1/users/${encodeURIComponent("@u_agent:example.test")}`, { headers })).status, 200);
    assert.equal((await fetch(`${origin}/_matrix/app/v1/rooms/${encodeURIComponent("#r_agent:example.test")}`, { headers })).status, 200);
  });
  assert.deepEqual(seen, ["@u_agent:example.test", "#r_agent:example.test"]);
});
