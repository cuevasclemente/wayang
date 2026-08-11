import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
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
  assert.match(expression, /function __wayangSafeUrl/);
  assert.match(expression, /function __wayangVisible/);
  assert.match(expression, /!el\.isConnected/);
  assert.match(expression, /getClientRects/);
  assert.match(expression, /style\.display === "none"/);
  assert.match(expression, /style\.visibility === "hidden"/);
  assert.match(expression, /style\.contentVisibility === "hidden"/);
  assert.match(expression, /Number\.parseFloat\(style\.opacity\) === 0/);
  assert.match(expression, /function __wayangDisabled/);
  assert.match(expression, /el\.matches\(":disabled"\)/);
  assert.match(expression, /current\.hasAttribute\("inert"\)/);
  assert.match(expression, /getAttribute\("aria-disabled"\)/);
  assert.match(expression, /function __wayangActionable/);
  assert.match(expression, /document\.elementFromPoint/);
  assert.match(expression, /hit === el \|\| el\.contains\(hit\)/);
  assert.match(expression, /disabled: __wayangDisabled\(el\)/);
  assert.match(expression, /visible: __wayangVisible\(el\)/);
  assert.match(expression, /function __wayangInfo/);
  assert.ok(expression.includes(body));
  assert.equal(expression.includes("SYNTHETIC_SECRET_VALUE"), false);
  const links = compileGuardedPageExpression(compileGuardedDomOperation({ kind: "links" }));
  assert.match(links, /href: __wayangSafeUrl\(el\.href\)/);
  assert.doesNotMatch(links, /href: __wayangRedact\(el\.href\)/);
  const visibleQuery = compileGuardedDomOperation({
    kind: "query_visible_selector", selector: "button", documentNonce: "synthetic-document-nonce",
  });
  assert.match(visibleQuery, /url: __wayangSafeUrl\(location\.href\)/);
  assert.doesNotMatch(visibleQuery, /url: __wayangRedact\(location\.href\)/);
  const typed = compileGuardedDomOperation({ kind: "type_public", text: publicText });
  assert.ok(typed.includes(`const text = ${JSON.stringify(publicText)};`));
  assert.match(typed, /const el = document\.activeElement/);
  assert.match(typed, /__wayangDisabled\(el\)/);

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

  const selectorPoint = compileGuardedDomOperation({ kind: "selector_point", selector: "button", index: 2 });
  assert.match(selectorPoint, /!__wayangActionable\(el\)/);
  const activateSelector = compileGuardedDomOperation({
    kind: "activate_selector", selector: "button", index: 2, expectedName: "Download Transactions",
    documentNonce: "synthetic-document-nonce",
  });
  assert.match(activateSelector, /globalThis\[__wayangSelectorNonceKey\]/);
  assert.match(activateSelector, /__wayangName\(el\) !== expectedName/);
  assert.match(activateSelector, /matches\.length !== 1 \|\| matches\[0\] !== el/);
  assert.match(activateSelector, /el\.click\(\); return \{ clicked: true \}/);
  assert.equal(activateSelector.includes("Input.dispatchMouseEvent"), false);
  assert.match(compileGuardedDomOperation({ kind: "fill_selector", selector: "input", text: "public" }), /__wayangDisabled\(el\)/);
  assert.match(compileGuardedDomOperation({ kind: "public_active_target" }), /__wayangDisabled\(el\)/);

  assert.equal(boundedElementLimit(undefined, 80), 80);
  assert.equal(boundedElementLimit(Number.NaN, 80), 80);
  assert.equal(boundedElementLimit(0, 80), 1);
  assert.equal(boundedElementLimit(19.9, 80), 19);
  assert.equal(boundedElementLimit(50_000, 80), 500);
});

test("compiled visibility and activation helpers fail closed on hidden, disabled, inert, and occluded controls", () => {
  const style = { display: "block", visibility: "visible", contentVisibility: "visible", opacity: "1" };
  let clicked = 0;
  let hit: any;
  const element: any = {
    localName: "button",
    isConnected: true,
    hidden: false,
    parentElement: null,
    textContent: "Download Transactions",
    innerText: "Download Transactions",
    getClientRects: () => [{ width: 20, height: 10 }],
    getBoundingClientRect: () => ({ x: 5, y: 5, left: 5, top: 5, width: 20, height: 10 }),
    getAttribute: (name: string) => name === "aria-label" ? "Download Transactions" : null,
    hasAttribute: () => false,
    matches: () => false,
    contains: (candidate: unknown) => candidate === element,
    scrollIntoView: () => undefined,
    click: () => { clicked += 1; },
  };
  hit = element;
  let candidates: any[] = [element];
  const sandbox = vm.createContext({
    location: { href: "https://synthetic.invalid/" },
    getComputedStyle: (node: any) => node.style ?? style,
    document: {
      title: "Synthetic",
      body: { innerText: "" },
      activeElement: null,
      querySelectorAll: (selector: string) => selector === "button" ? candidates : [],
      elementFromPoint: (x: number, y: number) => typeof hit === "function" ? hit(x, y) : hit,
    },
  });
  const evaluate = (operation: Parameters<typeof compileGuardedDomOperation>[0], nextCandidates: any[] = [element]) => {
    candidates = nextCandidates;
    return vm.runInContext(compileGuardedPageExpression(compileGuardedDomOperation(operation)), sandbox);
  };

  const activate = (expectedName = "Download Transactions", documentNonce = "synthetic-document-nonce") => evaluate({
    kind: "activate_selector", selector: "button", index: 0, expectedName, documentNonce,
  });
  const query = evaluate({
    kind: "query_visible_selector", selector: "button", limit: 5, documentNonce: "synthetic-document-nonce",
  });
  assert.equal(query.elements[0].visible, true);
  assert.equal(query.elements[0].disabled, false);
  assert.equal(activate().clicked, true);
  assert.equal(clicked, 1);
  assert.throws(() => activate("Different Action"), /not actionable/);
  assert.throws(() => activate("Download Transactions", "forged-document-nonce"), /document is stale/);
  assert.equal(clicked, 1, "a changed identity or document nonce is never activated");

  const hiddenAncestor: any = {
    parentElement: null,
    hidden: false,
    style: { ...style, display: "none" },
    getAttribute: () => null,
    hasAttribute: () => false,
  };
  element.parentElement = hiddenAncestor;
  element.textContent = "HIDDEN_QUERY_CANARY";
  element.innerText = "HIDDEN_QUERY_CANARY";
  assert.equal(evaluate({ kind: "query_selector", selector: "button", limit: 5 }).elements[0].visible, false);
  const filteredHidden = evaluate({
    kind: "query_visible_selector", selector: "button", limit: 5, documentNonce: "synthetic-document-nonce",
  });
  assert.equal(filteredHidden.elements.length, 0);
  assert.equal(JSON.stringify(filteredHidden).includes("HIDDEN_QUERY_CANARY"), false);
  assert.throws(() => activate(), /not actionable/);

  element.parentElement = null;
  element.textContent = "Download Transactions";
  element.innerText = "Download Transactions";
  element.getClientRects = () => [{ width: 0, height: 10 }];
  assert.equal(evaluate({ kind: "query_selector", selector: "button", limit: 5 }).elements[0].visible, false);
  element.getClientRects = () => [{ width: 20, height: 10 }];

  element.matches = (selector: string) => selector === ":disabled";
  assert.equal(evaluate({ kind: "query_selector", selector: "button", limit: 5 }).elements[0].disabled, true);
  assert.throws(() => activate(), /not actionable/);
  element.matches = () => false;

  const inertAncestor = { ...hiddenAncestor, style, hasAttribute: (name: string) => name === "inert" };
  element.parentElement = inertAncestor;
  assert.equal(evaluate({ kind: "query_selector", selector: "button", limit: 5 }).elements[0].disabled, true);
  element.parentElement = null;

  const ariaDisabledAncestor = {
    ...hiddenAncestor,
    style,
    getAttribute: (name: string) => name === "aria-disabled" ? " TRUE " : null,
  };
  element.parentElement = ariaDisabledAncestor;
  assert.equal(evaluate({ kind: "query_selector", selector: "button", limit: 5 }).elements[0].disabled, true);
  element.parentElement = null;

  hit = {};
  assert.throws(() => activate(), /not actionable/);
  assert.equal(clicked, 1, "an occluded control is never activated");

  let duplicateClicks = 0;
  const duplicate = {
    ...element,
    getBoundingClientRect: () => ({ x: 50, y: 5, left: 50, top: 5, width: 20, height: 10 }),
    contains: (candidate: unknown) => candidate === duplicate,
    click: () => { duplicateClicks += 1; },
  };
  hit = (x: number) => x < 40 ? element : duplicate;
  assert.throws(() => evaluate({
    kind: "activate_selector", selector: "button", index: 0, expectedName: "Download Transactions",
    documentNonce: "synthetic-document-nonce",
  }, [element, duplicate]), /not actionable/);
  assert.equal(clicked, 1);
  assert.equal(duplicateClicks, 0, "duplicate actionable semantic matches fail closed");
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
