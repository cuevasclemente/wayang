import type { CdpConnection, ChromeTarget } from "./cdp.js";
import { redactKnownCredentialValues } from "./manager.js";

const MAX_ELEMENTS = 500;
const MAX_TEXT_BYTES = 50_000;

type Guard = () => Promise<void>;
export type GuardedCdpPort = Pick<CdpConnection, "send">;
export type GuardedPageTarget = Pick<ChromeTarget, "id" | "url">;

export interface TopLevelDocumentAttestation {
  targetId: string;
  frameId: string;
  loaderId: string;
  documentIdentity: string;
  topLevelUrl: string;
  title: string;
  readyState: string;
}

export interface GuardedCredentialOperation {
  kind: string;
  mode?: string;
  readonly [key: string]: unknown;
}

export type GuardedDomOperation =
  | { kind: "snapshot" }
  | { kind: "dom_snapshot"; includeText?: boolean; limit?: number }
  | { kind: "links"; limit?: number }
  | { kind: "secrets" }
  | { kind: "query_selector"; selector: string; limit?: number }
  | { kind: "query_visible_selector"; selector: string; limit?: number; documentNonce: string }
  | { kind: "selector_point"; selector: string; index?: number }
  | { kind: "activate_selector"; selector: string; index?: number; expectedAccessibleName: string; documentNonce: string }
  | { kind: "fill_selector"; selector: string; index?: number; text: string }
  | { kind: "public_active_target" };

export type ProtectedCredentialInspectionMode = "none" | "blocked" | "text-allowed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reauthorize immediately before every raw CDP dispatch. */
export async function guardedSend<T>(
  cdp: GuardedCdpPort,
  guard: Guard,
  method: string,
  parameters: Record<string, unknown> = {},
): Promise<T> {
  await guard();
  return cdp.send<T>(method, parameters);
}

async function attestTopLevelDocumentOnce(
  cdp: GuardedCdpPort,
  target: GuardedPageTarget,
  guard: Guard,
): Promise<TopLevelDocumentAttestation> {
  const tree = await guardedSend<any>(cdp, guard, "Page.getFrameTree");
  const frame = tree?.frameTree?.frame;
  const frameId = typeof frame?.id === "string" ? frame.id : "";
  const loaderId = typeof frame?.loaderId === "string" ? frame.loaderId : "";
  if (!frameId || !loaderId) throw new Error("Protected browser top-level document identity is unavailable");
  const evaluated = await guardedSend<any>(cdp, guard, "Runtime.evaluate", {
    expression: "({ url: location.href, title: document.title, readyState: document.readyState })",
    returnByValue: true,
  });
  const value = evaluated?.result?.value ?? {};
  const topLevelUrl = String(value.url ?? target.url ?? "");
  return {
    targetId: target.id,
    frameId,
    loaderId,
    documentIdentity: `${target.id}:${frameId}:${loaderId}`,
    topLevelUrl,
    title: String(value.title ?? ""),
    readyState: String(value.readyState ?? ""),
  };
}

/**
 * Require two consecutive observations of the same main-frame loader and URL,
 * with the latter observation no longer loading. URL-only history changes do
 * not manufacture a fresh document identity.
 */
export async function settledTopLevelDocument(
  cdp: GuardedCdpPort,
  target: GuardedPageTarget,
  guard: Guard,
  timeoutMs: number,
  intervalMs: number,
): Promise<TopLevelDocumentAttestation> {
  const deadline = Date.now() + timeoutMs;
  let prior: TopLevelDocumentAttestation | undefined;
  do {
    const current = await attestTopLevelDocumentOnce(cdp, target, guard);
    if (prior
      && current.documentIdentity === prior.documentIdentity
      && current.topLevelUrl === prior.topLevelUrl
      && current.readyState !== "loading") return current;
    prior = current;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  } while (true);
  throw new Error("Protected browser top-level document did not settle");
}

const PAGE_HELPERS = String.raw`
const __wayangSelectorNonceKey = "__wayangProtectedAutomationSelectorNonceV1";
function __wayangSensitive(el) {
  const type = String(el?.getAttribute?.("type") || "").toLowerCase();
  const autocomplete = String(el?.getAttribute?.("autocomplete") || "");
  const identity = [el?.id, el?.getAttribute?.("name"), el?.getAttribute?.("placeholder"), el?.getAttribute?.("aria-label")].filter(Boolean).join(" ");
  return type === "password" || /(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i.test(autocomplete)
    || /(?:pass(?:word|code)?|otp|totp|verification|recovery|secret|card(?:[ _-]?(?:number|no))?|cvc|cvv|security[ _-]?code|pin)/i.test(identity);
}
function __wayangSecrets() {
  return Array.from(document.querySelectorAll("input,textarea,select,[contenteditable='true']"))
    .filter(__wayangSensitive).map((el) => String(el.value || el.textContent || "")).filter(Boolean);
}
function __wayangRedact(value) {
  let text = String(value == null ? "" : value).normalize("NFC");
  for (const secret of __wayangSecrets()) {
    const normalized = String(secret).normalize("NFC");
    if (normalized) text = text.split(normalized).join("[REDACTED]");
  }
  return text;
}
function __wayangVisible(el) {
  if (!el || !el.isConnected || el.hidden) return false;
  const rects = Array.from(el.getClientRects());
  if (!rects.some((rect) => rect.width > 0 && rect.height > 0)) return false;
  for (let current = el; current; current = current.parentElement) {
    if (current.hidden) return false;
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
      || style.contentVisibility === "hidden" || Number.parseFloat(style.opacity) === 0) return false;
  }
  return true;
}
function __wayangDisabled(el) {
  if (!el) return true;
  if (typeof el.matches === "function" && el.matches(":disabled")) return true;
  for (let current = el; current; current = current.parentElement) {
    if (current.hasAttribute("inert") || String(current.getAttribute("aria-disabled") || "").trim().toLowerCase() === "true") return true;
  }
  return false;
}
function __wayangActionable(el) {
  if (!__wayangVisible(el) || __wayangDisabled(el)) return false;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  return Boolean(hit && (hit === el || el.contains(hit)));
}
function __wayangName(el) {
  return __wayangRedact(el.getAttribute("aria-label") || el.getAttribute("name") || el.textContent || "").slice(0, 500);
}
function __wayangAccessibleText(el, includeHidden = false) {
  if (!el || __wayangSensitive(el)) return el ? "[REDACTED]" : "";
  const raw = includeHidden ? el.textContent : ("innerText" in el ? el.innerText : el.textContent);
  return __wayangRedact(raw || "").replace(/\s+/g, " ").trim().slice(0, 500);
}
function __wayangBoundedReferences(raw) {
  const ids = String(raw || "").trim().split(/\s+/).filter(Boolean);
  if (ids.length > 16 || new Set(ids).size !== ids.length) return [];
  return ids;
}
function __wayangAccessibleName(el) {
  const clean = (value) => __wayangRedact(value).normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 500);
  const referencedIds = __wayangBoundedReferences(el.getAttribute("aria-labelledby"));
  if (referencedIds.length) {
    const referenced = referencedIds.map((id) => document.getElementById(id)).filter((candidate) => candidate && candidate !== el);
    if (referenced.length === referencedIds.length) {
      const value = clean(referenced.map((candidate) => __wayangAccessibleText(candidate, true)).filter(Boolean).join(" "));
      if (value) return value;
    }
  }
  const direct = clean(el.getAttribute("aria-label") || "");
  if (direct) return direct;
  const labels = "labels" in el && el.labels ? Array.from(el.labels) : [];
  if (labels.length > 16) return "";
  const labelled = clean(labels.map((candidate) => __wayangAccessibleText(candidate, true)).filter(Boolean).join(" "));
  if (labelled) return labelled;
  const alt = clean(el.getAttribute("alt") || "");
  if (alt) return alt;
  const content = __wayangAccessibleText(el);
  if (content) return content;
  const title = clean(el.getAttribute("title") || "");
  if (title) return title;
  const nested = Array.from(el.querySelectorAll?.("svg title,[role='img'][aria-label],img[alt]") || []);
  if (nested.length > 16) return "";
  return clean(nested.map((candidate) => candidate.getAttribute("aria-label") || candidate.getAttribute("alt") || __wayangAccessibleText(candidate, true)).filter(Boolean).join(" "));
}
function __wayangInfo(el, index) {
  const rect = el.getBoundingClientRect();
  return { index, tag: el.localName, role: el.getAttribute("role") || undefined,
    type: el.getAttribute("type") || undefined, name: __wayangName(el), accessibleName: __wayangAccessibleName(el),
    text: __wayangSensitive(el) ? "[REDACTED]" : __wayangRedact(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
    value: "value" in el ? (__wayangSensitive(el) && el.value ? "[REDACTED]" : __wayangRedact(el.value).slice(0, 500)) : undefined,
    href: el.href ? __wayangRedact(el.href) : undefined,
    disabled: __wayangDisabled(el),
    visible: __wayangVisible(el),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
}
`;

/** Compile trusted backend DOM logic with the common sensitive-field helpers. */
export function compileGuardedPageExpression(body: string): string {
  return `(() => { ${PAGE_HELPERS}\n${body}\n})()`;
}

/** Evaluate trusted, compiled backend DOM logic and return only by-value data. */
export async function evaluateGuardedPage<T>(
  cdp: GuardedCdpPort,
  guard: Guard,
  body: string,
  contextId?: number,
): Promise<T> {
  const result = await guardedSend<any>(cdp, guard, "Runtime.evaluate", {
    expression: compileGuardedPageExpression(body),
    returnByValue: true,
    awaitPromise: true,
    ...(contextId === undefined ? {} : { contextId }),
  });
  if (result?.exceptionDetails) throw new Error("Protected browser page evaluation failed");
  return result?.result?.value as T;
}

/** Preserve the shared positive, finite, hard-capped DOM result bound. */
export function boundedElementLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_ELEMENTS, Math.floor(Number(value))));
}

/**
 * Compile one reviewed, bounded DOM operation. Selectors and public text are
 * serialized as JavaScript literals rather than interpolated as source.
 */
export function compileGuardedDomOperation(operation: Readonly<GuardedDomOperation>): string {
  switch (operation.kind) {
    case "snapshot":
      return `return { url: __wayangRedact(location.href), title: __wayangRedact(document.title), text: document.body ? __wayangRedact(document.body.innerText || "").slice(0, ${MAX_TEXT_BYTES}) : "" };`;
    case "dom_snapshot": {
      const limit = boundedElementLimit(operation.limit, 80);
      return `const nodes = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[contenteditable='true'],summary,label,h1,h2,h3,h4,h5,h6")).slice(0, ${limit}); return { url: __wayangRedact(location.href), title: __wayangRedact(document.title), text: ${Boolean(operation.includeText)} && document.body ? __wayangRedact(document.body.innerText || "").slice(0, ${MAX_TEXT_BYTES}) : undefined, elements: nodes.map(__wayangInfo) };`;
    }
    case "links": {
      const limit = boundedElementLimit(operation.limit, 100);
      return `return { url: __wayangRedact(location.href), title: __wayangRedact(document.title), links: Array.from(document.querySelectorAll("a[href]")).slice(0, ${limit}).map((el, index) => ({ index, text: __wayangRedact(el.innerText || el.textContent || "").slice(0, 500), href: __wayangRedact(el.href), selector: el.id ? "#" + CSS.escape(el.id) : el.localName, visible: __wayangVisible(el) })) };`;
    }
    case "secrets":
      return "return __wayangSecrets();";
    case "query_selector": {
      const limit = boundedElementLimit(operation.limit, 25);
      return `const selector = ${JSON.stringify(operation.selector)}; return { url: __wayangRedact(location.href), title: __wayangRedact(document.title), selector, elements: Array.from(document.querySelectorAll(selector)).slice(0, ${limit}).map(__wayangInfo) };`;
    }
    case "query_visible_selector": {
      const limit = boundedElementLimit(operation.limit, 25);
      return `const selector = ${JSON.stringify(operation.selector)}; globalThis[__wayangSelectorNonceKey] = ${JSON.stringify(operation.documentNonce)}; const visible = Array.from(document.querySelectorAll(selector)).filter(__wayangVisible).slice(0, ${limit}); return { url: __wayangRedact(location.href), title: __wayangRedact(document.title), selector, elements: visible.map(__wayangInfo) };`;
    }
    case "selector_point":
      return `const el = Array.from(document.querySelectorAll(${JSON.stringify(operation.selector)}))[${Math.floor(operation.index ?? 0)}]; if (!el) throw new Error("selector is not actionable"); el.scrollIntoView({ block: "center", inline: "center" }); if (!__wayangActionable(el)) throw new Error("selector is not actionable"); const rect = el.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`;
    case "activate_selector":
      return `if (globalThis[__wayangSelectorNonceKey] !== ${JSON.stringify(operation.documentNonce)}) throw new Error("selector query document is stale"); const candidates = Array.from(document.querySelectorAll(${JSON.stringify(operation.selector)})).filter(__wayangVisible); const el = candidates[${Math.floor(operation.index ?? 0)}]; const expectedAccessibleName = ${JSON.stringify(operation.expectedAccessibleName)}; if (!el || __wayangAccessibleName(el) !== expectedAccessibleName) throw new Error("selector is not actionable"); el.scrollIntoView({ block: "center", inline: "center" }); const matches = candidates.filter((candidate) => __wayangAccessibleName(candidate) === expectedAccessibleName && __wayangActionable(candidate)); if (matches.length !== 1 || matches[0] !== el) throw new Error("selector is not actionable"); el.click(); return { clicked: true };`;
    case "fill_selector":
      return `const el = Array.from(document.querySelectorAll(${JSON.stringify(operation.selector)}))[${Math.floor(operation.index ?? 0)}]; if (!el || __wayangSensitive(el) || __wayangDisabled(el) || el.readOnly || !(el.isContentEditable || "value" in el)) throw new Error("unsafe public fill target"); const text = ${JSON.stringify(operation.text)}; if (el.isContentEditable) el.textContent = text; else el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { filled: true };`;
    case "public_active_target":
      return "const el = document.activeElement; if (!el || __wayangSensitive(el) || __wayangDisabled(el) || el.readOnly || !(el.isContentEditable || 'value' in el)) throw new Error('unsafe public type target'); return true;";
  }
}

const CREDENTIAL_MUTATIONS = new Set([
  "navigate", "click", "click_selector", "fill_selector", "type_public",
]);

/** Process-memory-only protection for values filled into one exact CDP document. */
export class ProtectedCredentialProtection {
  private modeValue: ProtectedCredentialInspectionMode = "none";
  private documentIdentity?: string;
  private values: string[] = [];
  private allowUsed = false;

  get mode(): ProtectedCredentialInspectionMode { return this.modeValue; }

  recordFill(documentIdentity: string, values: { username?: string; password?: string; totp?: string }): void {
    const sameDocument = this.documentIdentity === documentIdentity;
    const next = [values.username, values.password, values.totp]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    this.values = [...new Set([...(sameDocument ? this.values : []), ...next])];
    this.documentIdentity = documentIdentity;
    this.modeValue = "blocked";
    this.allowUsed = false;
  }

  reconcile(currentDocumentIdentity: string): void {
    if (this.modeValue !== "none" && this.documentIdentity !== currentDocumentIdentity) this.reset();
  }

  allowInspection(currentDocumentIdentity: string): void {
    this.reconcile(currentDocumentIdentity);
    if (this.modeValue !== "blocked" || this.allowUsed) throw Object.assign(new Error("Credential inspection authorization is unavailable or already used"), { statusCode: 409 });
    this.modeValue = "text-allowed";
    this.allowUsed = true;
  }

  assertOperation(operation: Readonly<GuardedCredentialOperation>, currentDocumentIdentity: string): void {
    this.reconcile(currentDocumentIdentity);
    if (this.modeValue === "blocked") throw Object.assign(new Error("Credential inspection requires explicit UI authorization"), { statusCode: 409 });
    if (this.modeValue === "text-allowed" && operation.kind === "snapshot" && operation.mode === "screenshot") {
      throw Object.assign(new Error("Agent screenshots remain blocked after credential fill"), { statusCode: 409 });
    }
    if (this.modeValue === "text-allowed" && CREDENTIAL_MUTATIONS.has(operation.kind)) {
      throw Object.assign(new Error("Agent mutations remain blocked after credential fill until document replacement"), { statusCode: 409 });
    }
  }

  assertLifecycleMutation(): void {
    if (this.modeValue !== "none") throw Object.assign(new Error("Agent lifecycle mutations remain blocked after credential fill until document replacement"), { statusCode: 409 });
  }

  redact<T>(value: T): T { return redactKnownCredentialValues(value, this.values); }

  reset(): void {
    this.modeValue = "none";
    this.documentIdentity = undefined;
    this.values = [];
    this.allowUsed = false;
  }
}
