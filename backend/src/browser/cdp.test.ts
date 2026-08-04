import assert from "node:assert/strict";
import test from "node:test";
import { browserCdpWebSocketUrl } from "./cdp.js";

test("browser CDP discovery uses /json/version and requires a websocket URL", async () => {
  let requested = "";
  const fetchImpl = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/synthetic" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  assert.equal(await browserCdpWebSocketUrl(9222, fetchImpl), "ws://127.0.0.1:9222/devtools/browser/synthetic");
  assert.equal(requested, "http://127.0.0.1:9222/json/version");
  await assert.rejects(browserCdpWebSocketUrl(0, fetchImpl), /Invalid Chromium CDP port/);
});
