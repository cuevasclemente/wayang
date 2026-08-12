import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import { closeWayangServer, createApp } from "./app.js";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("missing Matrix integration installs an explicit JSON route and never falls through to the SPA", async () => {
  const { server } = createApp({ config: { messaging: { enabled: false, configPath: "" } } });
  const origin = await listen(server);
  try {
    const known = await fetch(`${origin}/_matrix/app/v1/transactions/synthetic-txn`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(known.status, 503);
    assert.match(known.headers.get("content-type") ?? "", /application\/json/u);
    assert.equal((await known.json() as { errcode: string }).errcode, "M_UNAVAILABLE");

    const unknown = await fetch(`${origin}/_matrix/app/v1/not-a-route`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get("content-type") ?? "", /application\/json/u);
    assert.equal((await unknown.json() as { errcode: string }).errcode, "M_UNRECOGNIZED");
  } finally {
    await closeWayangServer(server);
  }
});
