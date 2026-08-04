import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedElementLimit,
  compileGuardedDomOperation,
  compileGuardedPageExpression,
  evaluateGuardedPage,
  guardedSend,
  ProtectedCredentialProtection,
  settledTopLevelDocument,
} from "./guarded-page.js";

class ScriptedCdp {
  readonly calls: Array<{ method: string; parameters: Record<string, unknown> }> = [];
  observations = [
    { loaderId: "loader-a", url: "https://synthetic.invalid/start", readyState: "loading" },
    { loaderId: "loader-a", url: "https://synthetic.invalid/start", readyState: "complete" },
  ];
  private observationIndex = 0;

  async send<T>(method: string, parameters: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, parameters });
    const observation = this.observations[Math.min(this.observationIndex, this.observations.length - 1)]!;
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame", loaderId: observation.loaderId } } } as T;
    }
    if (method === "Runtime.evaluate") {
      this.observationIndex += 1;
      return { result: { value: { url: observation.url, title: "Synthetic", readyState: observation.readyState } } } as T;
    }
    return { ok: true } as T;
  }
}

test("guardedSend fails closed before dispatch and reauthorizes each CDP command", async () => {
  const cdp = new ScriptedCdp();
  let checks = 0;
  await assert.rejects(
    () => guardedSend(cdp, async () => { checks += 1; throw new Error("revoked"); }, "Page.enable"),
    /revoked/,
  );
  assert.equal(checks, 1);
  assert.equal(cdp.calls.length, 0);

  const result = await guardedSend<{ ok: boolean }>(cdp, async () => { checks += 1; }, "Page.enable");
  assert.deepEqual(result, { ok: true });
  assert.equal(checks, 2);
  assert.deepEqual(cdp.calls.map((call) => call.method), ["Page.enable"]);
});

test("settledTopLevelDocument requires a stable main-frame loader and URL", async () => {
  const cdp = new ScriptedCdp();
  let checks = 0;
  const result = await settledTopLevelDocument(
    cdp,
    { id: "target-a", url: "https://synthetic.invalid/fallback" },
    async () => { checks += 1; },
    100,
    0,
  );
  assert.deepEqual(result, {
    targetId: "target-a",
    frameId: "main-frame",
    loaderId: "loader-a",
    documentIdentity: "target-a:main-frame:loader-a",
    topLevelUrl: "https://synthetic.invalid/start",
    title: "Synthetic",
    readyState: "complete",
  });
  assert.equal(checks, 4, "both CDP reads in both observations are independently guarded");
  assert.deepEqual(cdp.calls.map((call) => call.method), [
    "Page.getFrameTree", "Runtime.evaluate", "Page.getFrameTree", "Runtime.evaluate",
  ]);
});

test("settledTopLevelDocument rejects missing loader identity and unstable URL observations", async () => {
  const missing = new ScriptedCdp();
  missing.observations = [{ loaderId: "", url: "https://synthetic.invalid/", readyState: "complete" }];
  await assert.rejects(
    () => settledTopLevelDocument(missing, { id: "target" }, async () => undefined, 20, 0),
    /identity is unavailable/,
  );

  let urlRevision = 0;
  const unstable = {
    async send<T>(method: string): Promise<T> {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main-frame", loaderId: "loader-a" } } } as T;
      }
      urlRevision += 1;
      return { result: { value: { url: `https://synthetic.invalid/${urlRevision}`, title: "Synthetic", readyState: "complete" } } } as T;
    },
  };
  await assert.rejects(
    () => settledTopLevelDocument(unstable, { id: "target" }, async () => undefined, 2, 0),
    /did not settle/,
  );
});

test("compiled DOM evaluation preserves sensitive-field redaction helpers and by-value bounds", async () => {
  const selector = `input[data-value="synthetic"]`;
  const body = compileGuardedDomOperation({ kind: "query_selector", selector, limit: 7 });
  assert.ok(body.includes(JSON.stringify(selector)), "selector is serialized as a source literal");
  assert.match(body, /slice\(0, 7\)/);
  assert.match(compileGuardedDomOperation({ kind: "snapshot" }), /slice\(0, 50000\)/);
  assert.match(compileGuardedDomOperation({ kind: "links", limit: 50_000 }), /slice\(0, 500\)/);
  const publicText = `synthetic"; throw new Error("injection")`;
  assert.ok(compileGuardedDomOperation({
    kind: "fill_selector",
    selector,
    text: publicText,
  }).includes(`const text = ${JSON.stringify(publicText)};`));
  const expression = compileGuardedPageExpression(body);
  assert.match(expression, /function __wayangSensitive/);
  assert.match(expression, /function __wayangRedact/);
  assert.match(expression, /function __wayangInfo/);
  assert.ok(expression.includes(body));
  assert.equal(expression.includes("SYNTHETIC_SECRET_VALUE"), false);

  let guardChecks = 0;
  let sent: Record<string, unknown> | undefined;
  const cdp = {
    async send<T>(method: string, parameters: Record<string, unknown> = {}): Promise<T> {
      assert.equal(method, "Runtime.evaluate");
      sent = parameters;
      return { result: { value: { elements: [] } } } as T;
    },
  };
  assert.deepEqual(await evaluateGuardedPage(cdp, async () => { guardChecks += 1; }, body), { elements: [] });
  assert.equal(guardChecks, 1);
  const parameters = sent as Record<string, unknown> | undefined;
  assert.equal(parameters?.expression, expression);
  assert.equal(parameters?.returnByValue, true);
  assert.equal(parameters?.awaitPromise, true);

  assert.equal(boundedElementLimit(undefined, 80), 80);
  assert.equal(boundedElementLimit(Number.NaN, 80), 80);
  assert.equal(boundedElementLimit(0, 80), 1);
  assert.equal(boundedElementLimit(19.9, 80), 19);
  assert.equal(boundedElementLimit(50_000, 80), 500);
});

test("credential protection remains document-bound, one-use, mutation-safe, and redacting", () => {
  const protection = new ProtectedCredentialProtection();
  const password = "SYNTHETIC_GUARDED_PASSWORD_62c1";
  protection.recordFill("target:frame:loader-a", { password });
  assert.throws(
    () => protection.assertOperation({ kind: "snapshot", mode: "text" }, "target:frame:loader-a"),
    /explicit UI authorization/,
  );
  assert.throws(() => protection.assertLifecycleMutation(), /lifecycle mutations remain blocked/);

  protection.allowInspection("target:frame:loader-a");
  protection.assertOperation({ kind: "query_selector" }, "target:frame:loader-a");
  assert.throws(
    () => protection.assertOperation({ kind: "snapshot", mode: "screenshot" }, "target:frame:loader-a"),
    /screenshots remain blocked/,
  );
  assert.throws(
    () => protection.assertOperation({ kind: "fill_selector" }, "target:frame:loader-a"),
    /mutations remain blocked/,
  );
  assert.equal(JSON.stringify(protection.redact({ raw: password, encoded: Buffer.from(password).toString("base64url") })).includes(password), false);

  protection.reconcile("target:frame:loader-b");
  assert.equal(protection.mode, "none");
  protection.assertLifecycleMutation();
});

test("guarded-page has a strict runtime export surface", async () => {
  const runtime = await import("./guarded-page.js");
  assert.deepEqual(Object.keys(runtime).sort(), [
    "ProtectedCredentialProtection",
    "boundedElementLimit",
    "compileGuardedDomOperation",
    "compileGuardedPageExpression",
    "evaluateGuardedPage",
    "guardedSend",
    "settledTopLevelDocument",
  ]);
});
