import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Request } from "express";
import type { CdpConnection, ChromeTarget } from "./cdp.js";
import {
  ManagedChromiumRuntime,
  type BrowserCredentialContext,
  type ManagedChromiumRuntimeOptions,
} from "./manager.js";
import type { CredentialBroker } from "./credentials.js";
import { InteractiveBrowserDownloadPublisher } from "./interactive-downloads.js";
import {
  boundedElementLimit,
  compileGuardedDomOperation,
  evaluateGuardedPage as evaluate,
  guardedSend,
  ProtectedCredentialProtection,
  settledTopLevelDocument as settledDocument,
} from "./guarded-page.js";
export {
  ProtectedCredentialProtection,
  type ProtectedCredentialInspectionMode,
} from "./guarded-page.js";
import {
  CapabilityBoundProtectedBrowser,
  assertProtectedBrowserBinding,
  ensureProtectedBrowserStorage,
  exactProtectedBrowserBindingEqual,
  isProtectedBrowserAllowedTopLevelUrl,
  type ProtectedBrowserAuthorityPort,
  type ProtectedBrowserBackendContext,
  type ProtectedBrowserBackendPort,
  type ProtectedBrowserCredentialPort,
} from "./protected-browser.js";
import { createProtectedBrowserToolRuntime, type ProtectedBrowserToolRuntime } from "./protected-tools.js";
import {
  STANDARD_BROWSER_CAPABILITY_ID,
  type ProtectedBrowserBinding,
  ProtectedBrowserDispatchResult,
  ProtectedBrowserOperation,
} from "./types.js";
import type {
  ProtectedBrowserCredentialControls,
  ProtectedBrowserIntegration,
  ProtectedBrowserOwnerControls,
  ProtectedBrowserPublicState,
  ProtectedBrowserRouteSelection,
  ProtectedBrowserSelectionInput,
  ProtectedBrowserViewerTransport,
} from "../routes/protected-browser.js";
import {
  getLiveProtectedBrowserRuntime,
  installProductionProtectedBrowserFactory,
  resolveProtectedBrowserAuthority,
  resolveProtectedBrowserPairAuthority,
  type ProtectedBrowserFactory,
} from "../pi-bridge.js";
import { onPolicyChanged } from "../policy-generation.js";

const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_INTERVAL_MS = 50;

type MaybePromise<T> = T | Promise<T>;
type CdpPort = Pick<CdpConnection, "send" | "on" | "close">;

function agentVisibleBrowserUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export interface ProtectedManagedChromiumPort {
  readonly running: boolean;
  start(assertAuthorizedBeforeBrowserCdp?: () => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  cancelDownload(guid: string, assertAuthorizedBeforeBrowserCdp?: () => Promise<void>): Promise<void>;
  attachPageCdpViewer(): Promise<{ cdp: CdpPort; target: ChromeTarget; close(): void }>;
}

export interface ProtectedBrowserOwnerPort {
  /** Exact authenticated web-session owner, not an IP/header/display identity. */
  resolve(request: Request): MaybePromise<string | null>;
}

export interface ProtectedBrowserProductionOptions {
  dataDir: string;
  owner: ProtectedBrowserOwnerPort;
  /** Shared opaque broker. Missing support is projected and fails closed. */
  credentialBroker?: CredentialBroker;
  /** CDP is the production default. VNC is deliberately unavailable here. */
  viewerTransport?: "cdp";
  authorityResolver?: typeof resolveProtectedBrowserAuthority;
  pairAuthorityResolver?: typeof resolveProtectedBrowserPairAuthority;
  managedChromiumFactory?: (options: ManagedChromiumRuntimeOptions) => ProtectedManagedChromiumPort;
  installFactory?: (factory: ProtectedBrowserFactory) => () => void;
  liveRuntimeResolver?: typeof getLiveProtectedBrowserRuntime;
  subscribePolicy?: typeof onPolicyChanged;
  settleTimeoutMs?: number;
  settleIntervalMs?: number;
}

export interface ProtectedBrowserProductionBootstrap {
  readonly integration: ProtectedBrowserIntegration;
  readonly factory: ProtectedBrowserFactory;
  close(): Promise<void>;
}

function sameProtectedBrowserLeaseIdentity(
  left: Readonly<ProtectedBrowserBinding>,
  right: Readonly<ProtectedBrowserBinding>,
): boolean {
  return left.capabilityId === right.capabilityId
    && left.sourceSessionId === right.sourceSessionId
    && left.projectId === right.projectId
    && left.projectCwd === right.projectCwd
    && left.agentProfileId === right.agentProfileId
    && left.associationRevision === right.associationRevision
    && left.runtimeGeneration === right.runtimeGeneration
    && left.processBootNonce === right.processBootNonce;
}

function createAuthorityPort(
  initial: Readonly<ProtectedBrowserBinding>,
  resolveAuthority: typeof resolveProtectedBrowserAuthority,
): ProtectedBrowserAuthorityPort {
  let controlGeneration = initial.controlGeneration;
  return {
    resolve(binding) {
      if (binding.controlGeneration !== controlGeneration) return null;
      return resolveAuthority(binding);
    },
    transitionControl(binding) {
      if (binding.controlGeneration !== controlGeneration || controlGeneration >= Number.MAX_SAFE_INTEGER) return null;
      if (!resolveAuthority(binding)) return null;
      controlGeneration += 1;
      const next = { ...binding, controlGeneration };
      return resolveAuthority(next);
    },
  };
}

async function executePageOperation(
  operation: Readonly<ProtectedBrowserOperation>,
  context: ProtectedBrowserBackendContext,
  managed: ProtectedManagedChromiumPort,
  settleTimeoutMs: number,
  settleIntervalMs: number,
  credentialProtection: ProtectedCredentialProtection,
): Promise<ProtectedBrowserDispatchResult> {
  const guard = () => context.assertAuthorized("pre-cdp");
  await guard();
  await managed.start(guard);
  if (context.signal.aborted) throw new Error("Protected browser operation was revoked");
  const attachment = await managed.attachPageCdpViewer();
  const { cdp, target } = attachment;
  try {
    await guardedSend(cdp, guard, "Page.enable");
    await guardedSend(cdp, guard, "Runtime.enable");
    const before = await settledDocument(cdp, target, guard, settleTimeoutMs, settleIntervalMs);
    credentialProtection.assertOperation(operation, before.documentIdentity);
    let value: unknown;
    switch (operation.kind) {
      case "navigate": {
        const navigation = await guardedSend<any>(cdp, guard, "Page.navigate", { url: operation.url });
        if (navigation?.errorText) throw new Error("Protected browser navigation failed");
        value = { navigated: true };
        break;
      }
      case "snapshot": {
        const page = await evaluate<{ url: string; title: string; text: string }>(
          cdp,
          guard,
          compileGuardedDomOperation({ kind: "snapshot" }),
        );
        if (operation.mode === "screenshot") {
          const shot = await guardedSend<any>(cdp, guard, "Page.captureScreenshot", { format: "jpeg", quality: 80, fromSurface: true });
          value = { url: page.url, title: page.title, screenshot: shot?.data ? `data:image/jpeg;base64,${shot.data}` : undefined };
        } else value = page;
        break;
      }
      case "dom_snapshot": {
        value = await evaluate(cdp, guard, compileGuardedDomOperation({
          kind: "dom_snapshot",
          includeText: operation.includeText,
          limit: operation.limit,
        }));
        break;
      }
      case "links": {
        value = await evaluate(cdp, guard, compileGuardedDomOperation({ kind: "links", limit: operation.limit }));
        break;
      }
      case "accessibility": {
        const limit = boundedElementLimit(operation.limit, 120);
        const secrets = await evaluate<string[]>(cdp, guard, compileGuardedDomOperation({ kind: "secrets" }));
        await guardedSend(cdp, guard, "Accessibility.enable");
        const tree = await guardedSend<any>(cdp, guard, "Accessibility.getFullAXTree");
        const redact = (input: unknown) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(input ?? ""));
        value = { nodes: (Array.isArray(tree?.nodes) ? tree.nodes : []).filter((node: any) => !node.ignored).slice(0, limit).map((node: any) => ({ role: node.role?.value, name: redact(node.name?.value), value: redact(node.value?.value), description: redact(node.description?.value) })) };
        break;
      }
      case "query_selector": {
        value = await evaluate(cdp, guard, compileGuardedDomOperation({
          kind: "query_selector",
          selector: operation.selector,
          limit: operation.limit,
        }));
        break;
      }
      case "click":
        await guardedSend(cdp, guard, "Input.dispatchMouseEvent", { type: "mousePressed", x: operation.x, y: operation.y, button: "left", clickCount: 1 });
        await guardedSend(cdp, guard, "Input.dispatchMouseEvent", { type: "mouseReleased", x: operation.x, y: operation.y, button: "left", clickCount: 1 });
        value = { clicked: true };
        break;
      case "click_selector": {
        const point = await evaluate<{ x: number; y: number }>(cdp, guard, compileGuardedDomOperation({
          kind: "selector_point",
          selector: operation.selector,
          index: operation.index,
        }));
        await guardedSend(cdp, guard, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await guardedSend(cdp, guard, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        value = { clicked: true };
        break;
      }
      case "fill_selector":
        value = await evaluate(cdp, guard, compileGuardedDomOperation({
          kind: "fill_selector",
          selector: operation.selector,
          index: operation.index,
          text: operation.text,
        }));
        break;
      case "type_public":
        value = await evaluate(cdp, guard, compileGuardedDomOperation({ kind: "type_public", text: operation.text }));
        break;
      default:
        throw new Error("Protected browser page operation is unavailable");
    }
    const document = await settledDocument(cdp, target, guard, settleTimeoutMs, settleIntervalMs);
    if (operation.kind === "navigate" && value && typeof value === "object") value = { ...value, url: agentVisibleBrowserUrl(document.topLevelUrl), title: document.title };
    if (operation.kind === "accessibility" && value && typeof value === "object") value = { url: agentVisibleBrowserUrl(document.topLevelUrl), title: document.title, ...value };
    return { value: credentialProtection.redact(value), topLevelUrl: credentialProtection.redact(document.topLevelUrl) };
  } finally {
    attachment.close();
  }
}

async function protectedCredentialContext(
  managed: ProtectedManagedChromiumPort,
  browser: CapabilityBoundProtectedBrowser,
  guard: () => Promise<void>,
  settleTimeoutMs: number,
  settleIntervalMs: number,
): Promise<BrowserCredentialContext> {
  await guard();
  if (!managed.running) throw Object.assign(new Error("Protected browser is not running"), { statusCode: 409 });
  const attachment = await managed.attachPageCdpViewer();
  try {
    const document = await settledDocument(attachment.cdp, attachment.target, guard, settleTimeoutMs, settleIntervalMs);
    const parsed = new URL(document.topLevelUrl);
    if (parsed.protocol !== "https:" || parsed.origin === "null") throw Object.assign(new Error("Current page does not have a credential-safe HTTPS origin"), { statusCode: 409 });
    const exact = browser.currentBinding;
    return {
      runtimeKey: `protected:${exact.projectId}:${exact.agentProfileId}`,
      targetId: document.targetId,
      documentIdentity: document.documentIdentity,
      url: document.topLevelUrl,
      origin: parsed.origin,
      capabilityBinding: { ...exact },
    };
  } finally { attachment.close(); }
}

function exactCredentialContext(left: BrowserCredentialContext, right: BrowserCredentialContext): boolean {
  return left.runtimeKey === right.runtimeKey
    && left.targetId === right.targetId
    && left.documentIdentity === right.documentIdentity
    && left.origin === right.origin
    && Boolean(left.capabilityBinding && right.capabilityBinding)
    && exactProtectedBrowserBindingEqual(left.capabilityBinding!, right.capabilityBinding!);
}

async function fillProtectedCredentialDocument(
  managed: ProtectedManagedChromiumPort,
  browser: CapabilityBoundProtectedBrowser,
  guard: () => Promise<void>,
  expected: BrowserCredentialContext,
  values: { username?: string; password?: string; totp?: string },
  protection: ProtectedCredentialProtection,
  settleTimeoutMs: number,
  settleIntervalMs: number,
): Promise<Array<"username" | "password" | "totp">> {
  await guard();
  if (!expected.capabilityBinding || !exactProtectedBrowserBindingEqual(browser.currentBinding, expected.capabilityBinding)) {
    throw new Error("Credential choice is no longer valid for this protected runtime");
  }
  const attachment = await managed.attachPageCdpViewer();
  try {
    const currentDocument = await settledDocument(attachment.cdp, attachment.target, guard, settleTimeoutMs, settleIntervalMs);
    const current: BrowserCredentialContext = {
      ...expected,
      targetId: currentDocument.targetId,
      documentIdentity: currentDocument.documentIdentity,
      url: currentDocument.topLevelUrl,
      origin: new URL(currentDocument.topLevelUrl).origin,
      capabilityBinding: { ...browser.currentBinding },
    };
    if (!exactCredentialContext(expected, current)) throw new Error("Credential choice is no longer valid for this page");

    // Record before the first secret-bearing CDP dispatch. If page script reacts
    // synchronously or the dispatch fails, later agent-visible results remain protected.
    protection.recordFill(expected.documentIdentity, values);
    const documentResult = await guardedSend<any>(attachment.cdp, guard, "Runtime.evaluate", { expression: "document", returnByValue: false });
    const objectId = documentResult?.result?.objectId;
    if (!objectId) throw new Error("Credential fill could not access the page");
    const result = await guardedSend<any>(attachment.cdp, guard, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(values) {
        const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return !el.disabled && !el.readOnly && el.type !== "hidden" && r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0; };
        const identity = (el) => [el.id, el.name, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].filter(Boolean).join(" ");
        const setValue = (el, value) => { el.focus({ preventScroll: true }); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set; if (setter) setter.call(el, value); else el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
        const inputs = Array.from(document.querySelectorAll("input,textarea")).filter(visible);
        const passwords = inputs.filter((el) => el instanceof HTMLInputElement && el.type === "password");
        const totps = inputs.filter((el) => /one-time-code/i.test(el.autocomplete || "") || /(?:otp|totp|verification|auth(?:entication)?[ _-]?code)/i.test(identity(el)));
        if (typeof values.password === "string" && passwords.length !== 1) return { error: "required-password-field", filled: [] };
        if (typeof values.totp === "string" && totps.length !== 1) return { error: "required-totp-field", filled: [] };
        const excluded = new Set([passwords[0], totps[0]].filter(Boolean));
        const usernames = inputs.filter((el) => !excluded.has(el) && (!(el instanceof HTMLInputElement) || ["text", "email", "tel", ""].includes(el.type)) && (/(?:user|email|login)/i.test(identity(el)) || /username|email/i.test(el.autocomplete || "")));
        const filled = [];
        if (typeof values.username === "string" && usernames.length === 1) { setValue(usernames[0], values.username); filled.push("username"); }
        if (typeof values.password === "string") { setValue(passwords[0], values.password); filled.push("password"); }
        if (typeof values.totp === "string") { setValue(totps[0], values.totp); filled.push("totp"); }
        return { filled };
      }`,
      arguments: [{ value: values }],
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) throw new Error("Credential fill failed in the page");
    const value = result?.result?.value ?? {};
    if (value.error === "required-password-field") throw new Error("Credential fill requires exactly one eligible password field");
    if (value.error === "required-totp-field") throw new Error("Credential fill requires exactly one eligible verification-code field");
    const after = await settledDocument(attachment.cdp, attachment.target, guard, settleTimeoutMs, settleIntervalMs);
    if (after.documentIdentity !== expected.documentIdentity) throw new Error("Credential document changed during fill");
    return (Array.isArray(value.filled) ? value.filled : []).filter((field: unknown): field is "username" | "password" | "totp" => field === "username" || field === "password" || field === "totp");
  } finally { attachment.close(); }
}

interface ProtectedProductionLifecycle {
  state(): ProtectedBrowserPublicState;
  start(guard: () => Promise<void>): Promise<ProtectedBrowserPublicState>;
  stop(): Promise<ProtectedBrowserPublicState>;
  recordPage(result: ProtectedBrowserDispatchResult): void;
}

function createBackend(
  managed: ProtectedManagedChromiumPort,
  lifecycle: ProtectedProductionLifecycle,
  settleTimeoutMs: number,
  settleIntervalMs: number,
  credentialProtection: ProtectedCredentialProtection,
  onStopped: () => MaybePromise<void>,
  finalStop: () => Promise<void>,
): ProtectedBrowserBackendPort {
  return {
    async execute(operation, context) {
      if (operation.kind === "status") return { value: lifecycle.state() };
      if (operation.kind === "start") {
        credentialProtection.assertLifecycleMutation();
        return { value: await lifecycle.start(() => context.assertAuthorized("pre-cdp")) };
      }
      if (operation.kind === "stop") {
        credentialProtection.assertLifecycleMutation();
        return { value: await lifecycle.stop() };
      }
      const result = await executePageOperation(operation, context, managed, settleTimeoutMs, settleIntervalMs, credentialProtection);
      lifecycle.recordPage(result);
      return result;
    },
    async stop() {
      // Registry/download teardown must never delay or bypass process teardown.
      // finalStop is one-shot, so coordinator revoke and later runtime close
      // converge on the same ManagedChromium stop operation.
      await Promise.allSettled([
        Promise.resolve().then(onStopped),
        Promise.resolve().then(finalStop),
      ]);
    },
  };
}

function keyCodeFor(key: string): number | undefined {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return ({ Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 } as Record<string, number>)[key];
}

async function openCdpViewer(options: {
  managed: ProtectedManagedChromiumPort;
  authorize: () => Promise<void>;
  revoke: () => Promise<void>;
  settleTimeoutMs: number;
  settleIntervalMs: number;
  redact<T>(value: T): T;
}): Promise<ProtectedBrowserViewerTransport> {
  await options.managed.start(options.authorize);
  const attachment = await options.managed.attachPageCdpViewer();
  const { cdp, target } = attachment;
  const listeners = new Set<(message: Buffer, isBinary: boolean) => void>();
  let closed = false;
  const emit = (message: unknown) => {
    const bytes = Buffer.from(JSON.stringify(message));
    for (const listener of listeners) listener(bytes, false);
  };
  try {
    await guardedSend(cdp, options.authorize, "Page.enable");
    await guardedSend(cdp, options.authorize, "Runtime.enable");
    await guardedSend(cdp, options.authorize, "Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  } catch (error) {
    attachment.close();
    throw error;
  }
  const offFrame = cdp.on("Page.screencastFrame", (params: any) => {
    emit({ type: "frame", dataUrl: `data:image/jpeg;base64,${params.data}`, metadata: params.metadata, sessionId: params.sessionId });
  });
  const attestAfterInput = async () => {
    const document = await settledDocument(cdp, target, options.authorize, options.settleTimeoutMs, options.settleIntervalMs);
    if (!isProtectedBrowserAllowedTopLevelUrl(document.topLevelUrl)) {
      // This runs inside lease-tracked viewer work. Latch denial now, but do
      // not await cleanup that includes this same dispatch.
      void options.revoke().catch(() => undefined);
      throw new Error("Protected browser viewer reached a forbidden top-level document");
    }
    emit(options.redact({ type: "page", url: document.topLevelUrl, title: document.title }));
  };
  return {
    async dispatch(raw, isBinary) {
      if (closed || isBinary) throw new Error("Protected browser viewer message is invalid");
      let message: any;
      try { message = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Protected browser viewer message is invalid"); }
      if (message.type === "frame-ack") {
        const sessionId = Number(message.sessionId);
        if (!Number.isSafeInteger(sessionId) || sessionId < 0) throw new Error("Protected browser frame acknowledgement is invalid");
        await guardedSend(cdp, options.authorize, "Page.screencastFrameAck", { sessionId });
        return;
      }
      if (message.type === "mouse") {
        const x = Number(message.x); const y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Protected browser mouse input is invalid");
        const type = message.event === "down" ? "mousePressed" : message.event === "up" ? "mouseReleased" : message.event === "wheel" ? "mouseWheel" : "mouseMoved";
        await guardedSend(cdp, options.authorize, "Input.dispatchMouseEvent", { type, x, y, button: message.button === "right" ? "right" : message.button === "middle" ? "middle" : "left", clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0, deltaX: Number(message.deltaX) || 0, deltaY: Number(message.deltaY) || 0 });
        await attestAfterInput();
        return;
      }
      if (message.type === "key") {
        const key = typeof message.key === "string" ? message.key : "";
        if (!key) throw new Error("Protected browser key input is invalid");
        if (message.event === "down" && key.length === 1 && !message.ctrlKey && !message.metaKey && !message.altKey) {
          await guardedSend(cdp, options.authorize, "Input.insertText", { text: key });
        } else {
          await guardedSend(cdp, options.authorize, "Input.dispatchKeyEvent", { type: message.event === "up" ? "keyUp" : "rawKeyDown", key, code: message.code || key, windowsVirtualKeyCode: keyCodeFor(key), nativeVirtualKeyCode: keyCodeFor(key), modifiers: (message.altKey ? 1 : 0) | (message.ctrlKey ? 2 : 0) | (message.metaKey ? 4 : 0) | (message.shiftKey ? 8 : 0) });
        }
        await attestAfterInput();
        return;
      }
      throw new Error("Protected browser viewer message is unsupported");
    },
    async close() {
      if (closed) return;
      closed = true;
      offFrame();
      try { await guardedSend(cdp, options.authorize, "Page.stopScreencast"); } catch {}
      listeners.clear();
      attachment.close();
    },
    onMessage(listener) {
      if (closed) throw new Error("Protected browser viewer is closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Bootstrap the concrete production protected-browser composition.
 *
 * Construction is inert: it installs a factory and integration only. Chromium,
 * CDP, profiles, and download directories are touched only when an exact
 * eligible interactive Pi runtime invokes the installed factory.
 */
export function bootstrapProtectedBrowserProduction(options: ProtectedBrowserProductionOptions): ProtectedBrowserProductionBootstrap {
  if (!options || typeof options.dataDir !== "string" || !options.dataDir || !options.owner) {
    throw new Error("Protected browser production bootstrap options are incomplete");
  }
  if (options.viewerTransport !== undefined && options.viewerTransport !== "cdp") {
    throw new Error("Protected browser production supports only CDP viewer transport");
  }
  const authorityResolver = options.authorityResolver ?? resolveProtectedBrowserAuthority;
  const pairAuthorityResolver = options.pairAuthorityResolver ?? resolveProtectedBrowserPairAuthority;
  const pairAuthorized = (binding: Readonly<ProtectedBrowserBinding>): boolean => {
    try {
      return pairAuthorityResolver(binding.projectId, binding.agentProfileId, binding.associationRevision, binding.capabilityId);
    } catch {
      return false;
    }
  };
  const liveRuntimeResolver = options.liveRuntimeResolver ?? getLiveProtectedBrowserRuntime;
  const subscribePolicy = options.subscribePolicy ?? onPolicyChanged;
  const managedFactory = options.managedChromiumFactory ?? ((runtimeOptions) => new ManagedChromiumRuntime(runtimeOptions));
  const settleTimeoutMs = Math.max(1, options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS);
  const settleIntervalMs = Math.max(0, options.settleIntervalMs ?? SETTLE_INTERVAL_MS);
  const created = new Set<ProtectedBrowserToolRuntime>();
  const leaseCleanupTasks = new Set<Promise<void>>();
  const realmAttachers = new Map<string, (binding: ProtectedBrowserBinding) => Promise<ProtectedBrowserToolRuntime>>();
  const realmTeardowns = new Map<string, () => Promise<void>>();
  const realmKey = (binding: Readonly<ProtectedBrowserBinding>) => `${binding.capabilityId.length}:${binding.capabilityId}${binding.projectId.length}:${binding.projectId}${binding.agentProfileId.length}:${binding.agentProfileId}`;
  const productionPorts = new WeakMap<ProtectedBrowserToolRuntime, {
    managed: ProtectedManagedChromiumPort;
    ownerControls: ProtectedBrowserOwnerControls;
    credentialProtection: ProtectedCredentialProtection;
    credentialControls?: ProtectedBrowserCredentialControls;
  }>();
  let closed = false;

  const factory: ProtectedBrowserFactory = async (binding) => {
    if (closed) throw new Error("Protected browser production bootstrap is closed");
    assertProtectedBrowserBinding(binding);
    if (!pairAuthorized(binding)) {
      throw new Error("Protected browser pair authority is unavailable");
    }
    const key = realmKey(binding);
    let existingAttacher = realmAttachers.get(key);
    if (existingAttacher) return existingAttacher(binding);
    const retirement = realmTeardowns.get(key);
    if (retirement) {
      await retirement();
      if (realmTeardowns.get(key) === retirement) realmTeardowns.delete(key);
      existingAttacher = realmAttachers.get(key);
      if (existingAttacher) return existingAttacher(binding);
    }
    fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(options.dataDir, 0o700);
    const storage = ensureProtectedBrowserStorage(options.dataDir, binding.projectId, binding.agentProfileId, binding.projectCwd, binding.capabilityId);
    const downloadsDir = path.join(storage.runtimeDir, "downloads");
    const downloadPublisher = new InteractiveBrowserDownloadPublisher(downloadsDir, binding.projectCwd);
    let activeBinding: ProtectedBrowserBinding = { ...binding };
    let browser!: CapabilityBoundProtectedBrowser;
    const invalidatePairPublication = () => { realmAttachers.delete(realmKey(activeBinding)); };
    let managed!: ProtectedManagedChromiumPort;
    let runtime!: ProtectedBrowserToolRuntime;
    let unsubscribeRealmPolicy: () => void = () => undefined;
    const credentialProtection = new ProtectedCredentialProtection();
    let resetCredentialRealm: () => MaybePromise<void> | undefined = () => { credentialProtection.reset(); };
    let latestDownload: ProtectedBrowserPublicState["download"];
    let updatedAt = Date.now();
    const currentAuthorization = async () => {
      if (browser.isRevoked) throw new Error("Protected browser authority is revoked");
      const current = browser.currentBinding;
      const snapshot = authorityResolver(current);
      if (!snapshot || !exactProtectedBrowserBindingEqual(snapshot, current)) throw new Error("Protected browser authority is unavailable");
    };
    managed = managedFactory({
      profileDir: storage.profileDir,
      downloadsDir,
      downloadBehavior: "allowAndName",
      workingDirectory: binding.projectCwd,
      onDownloadWillBegin(event) {
        const decision = downloadPublisher.begin(event);
        latestDownload = downloadPublisher.latest;
        updatedAt = latestDownload?.updatedAt ?? Date.now();
        if (!decision.accepted) {
          void managed.cancelDownload(event.guid, currentAuthorization).catch(() => browser.revokeRealm());
        }
      },
      onDownloadProgress(event) {
        void downloadPublisher.progress(event, currentAuthorization).then(async (result) => {
          latestDownload = result.state;
          updatedAt = latestDownload?.updatedAt ?? Date.now();
          if (result.cancel) await managed.cancelDownload(event.guid, currentAuthorization);
        }).catch(async () => {
          latestDownload = downloadPublisher.latest;
          updatedAt = latestDownload?.updatedAt ?? Date.now();
          await managed.cancelDownload(event.guid).catch(() => undefined);
        });
      },
      onTopLevelNavigation(url) {
        // This callback is delivered by the browser-lifetime Target observer,
        // independently of operation settlement or viewer input dispatch.
        if (!isProtectedBrowserAllowedTopLevelUrl(url)) void browser.revokeRealm();
      },
      onUnexpectedExit() { void browser.revokeRealm(); },
    });
    let startedAt: number | undefined;
    let lastResumeAt: number | undefined;
    let activeUrl: string | undefined;
    let activeTitle: string | undefined;
    let realmControlMode: "agent" | "user" | "paused" = "agent";
    let observedMode: "agent" | "user" | "paused" = "agent";
    let observedRunning = false;
    const synchronizeState = () => {
      const running = managed.running;
      const mode = browser?.mode ?? observedMode;
      if (running !== observedRunning || mode !== observedMode) {
        updatedAt = Date.now();
        if (running && !observedRunning) startedAt = updatedAt;
        if (mode === "agent" && observedMode !== "agent") lastResumeAt = updatedAt;
        observedRunning = running;
        observedMode = mode;
      }
    };
    const publicState = (): ProtectedBrowserPublicState => {
      synchronizeState();
      const params = new URLSearchParams({ session_id: activeBinding.sourceSessionId });
      const credentialInspection = credentialProtection.mode;
      return {
        sessionId: activeBinding.sourceSessionId,
        projectCwd: activeBinding.projectCwd,
        status: managed.running ? "running" : "stopped",
        controlMode: browser?.mode ?? "agent",
        secretTainted: false,
        localOnlyRecommended: true,
        needsUser: (browser?.mode ?? "agent") !== "agent",
        ...((browser?.mode ?? "agent") !== "agent"
          ? { needsUserReason: "Human control is active for a protected browser step" }
          : {}),
        ...(lastResumeAt === undefined ? {} : { lastResumeAt }),
        ...((browser?.mode ?? "agent") === "agent" && activeUrl !== undefined ? { activeUrl: credentialProtection.redact(agentVisibleBrowserUrl(activeUrl)) } : {}),
        ...((browser?.mode ?? "agent") === "agent" && activeTitle !== undefined ? { activeTitle: credentialProtection.redact(activeTitle) } : {}),
        cdpReady: managed.running,
        viewerTransport: "cdp-screencast",
        cdpScreencastWsPath: `/ws/browser?${params.toString()}`,
        vncReady: false,
        profile: { persistence: "protected" },
        credentialBroker: { supported: Boolean(options.credentialBroker), guarded: true },
        ...(credentialInspection === "none" ? {} : { credentialInspection }),
        ...(startedAt === undefined ? {} : { startedAt }),
        updatedAt,
        ...(latestDownload === undefined ? {} : { download: { ...latestDownload } }),
      };
    };
    const lifecycle: ProtectedProductionLifecycle = {
      state: publicState,
      async start(guard) {
        await guard();
        await managed.start(guard);
        synchronizeState();
        return publicState();
      },
      async stop() {
        // Keep taint/redaction live until Chromium and in-flight CDP work are
        // drained; clearing it first would briefly expose the last document.
        await managed.stop();
        await resetCredentialRealm();
        synchronizeState();
        return publicState();
      },
      recordPage(result) {
        if (result.topLevelUrl) activeUrl = result.topLevelUrl;
        const value = result.value;
        if (value && typeof value === "object" && "title" in value && typeof (value as { title?: unknown }).title === "string") {
          activeTitle = (value as { title: string }).title;
        }
        updatedAt = Date.now();
      },
    };
    let finalStopPromise: Promise<void> | undefined;
    const finalStop = (): Promise<void> => {
      finalStopPromise ??= Promise.resolve().then(() => managed.stop());
      return finalStopPromise;
    };
    let stopped = false;
    const backend = createBackend(managed, lifecycle, settleTimeoutMs, settleIntervalMs, credentialProtection, async () => {
      if (stopped) return;
      stopped = true;
      unsubscribeRealmPolicy();
      unsubscribeRealmPolicy = () => undefined;
      invalidatePairPublication();
      if (runtime) created.delete(runtime);
      downloadPublisher.revoke();
      await resetCredentialRealm();
    }, finalStop);
    let handoffDocument: string | undefined;
    const credentials: ProtectedBrowserCredentialPort = {
      async beginHandoff() {
        if (!managed.running) { handoffDocument = undefined; return; }
        const attachment = await managed.attachPageCdpViewer();
        try { handoffDocument = (await settledDocument(attachment.cdp, attachment.target, currentAuthorization, settleTimeoutMs, settleIntervalMs)).documentIdentity; }
        finally { attachment.close(); }
      },
      async assertInspectionAllowed() {
        if (!managed.running) throw new Error("Protected browser is not running");
        const attachment = await managed.attachPageCdpViewer();
        try {
          const current = await settledDocument(attachment.cdp, attachment.target, currentAuthorization, settleTimeoutMs, settleIntervalMs);
          credentialProtection.allowInspection(current.documentIdentity);
        } finally { attachment.close(); }
      },
      async assertSafeResume() {
        if (!managed.running || !handoffDocument) throw new Error("Protected browser credential handoff has no fresh document");
        const attachment = await managed.attachPageCdpViewer();
        try {
          const current = await settledDocument(attachment.cdp, attachment.target, currentAuthorization, settleTimeoutMs, settleIntervalMs);
          if (current.documentIdentity === handoffDocument || !isProtectedBrowserAllowedTopLevelUrl(current.topLevelUrl)) {
            throw new Error("Protected browser credential handoff requires a fresh allowed top-level document");
          }
          credentialProtection.reconcile(current.documentIdentity);
          activeUrl = current.topLevelUrl;
          activeTitle = current.title;
          updatedAt = Date.now();
        } finally { attachment.close(); }
      },
      revokeLease(revokedBinding) {
        // One-use choices belong to the exclusive runtime lease. Credential
        // taint and the handoff document remain in the persistent pair realm.
        options.credentialBroker?.revokeChoicesForProtectedBinding(revokedBinding);
      },
      revokeRealm(revokedBinding) {
        handoffDocument = undefined;
        credentialProtection.reset();
        options.credentialBroker?.revokeChoicesForProtectedBinding(revokedBinding);
      },
    };
    resetCredentialRealm = () => credentials.revokeRealm?.(browser?.currentBinding ?? activeBinding);
    const authority = createAuthorityPort(activeBinding, authorityResolver);
    browser = new CapabilityBoundProtectedBrowser({
      dataDir: options.dataDir,
      binding: activeBinding,
      authority,
      backend,
      credentials,
      initialControlMode: realmControlMode,
      onControlModeChanged(mode) { realmControlMode = mode; },
      onRealmRevoked: invalidatePairPublication,
    });
    unsubscribeRealmPolicy = subscribePolicy(() => {
      if (!pairAuthorized(activeBinding)) {
        // Pair invalidation remains observed even while no Pi runtime lease is
        // attached (for example, between model stop and lazy rebuild).
        invalidatePairPublication();
        void browser.revokeRealm();
      }
    });

    const credentialControls: ProtectedBrowserCredentialControls | undefined = options.credentialBroker ? {
      async status() {
        await currentAuthorization();
        const status = options.credentialBroker!.status();
        let origin: string | null = null;
        if (managed.running) {
          try { origin = (await protectedCredentialContext(managed, browser, currentAuthorization, settleTimeoutMs, settleIntervalMs)).origin; }
          catch { origin = null; }
        }
        return { ...status, origin };
      },
      async matches() {
        if (browser.mode === "agent") throw Object.assign(new Error("Protected credentials require human control"), { statusCode: 409 });
        await currentAuthorization();
        const context = await protectedCredentialContext(managed, browser, currentAuthorization, settleTimeoutMs, settleIntervalMs);
        return options.credentialBroker!.matches(context);
      },
      async fill(choiceToken, operation) {
        if (browser.mode === "agent") throw Object.assign(new Error("Protected credentials require human control"), { statusCode: 409 });
        await currentAuthorization();
        const context = await protectedCredentialContext(managed, browser, currentAuthorization, settleTimeoutMs, settleIntervalMs);
        const result = await options.credentialBroker!.fill(choiceToken, operation, context, (values) =>
          fillProtectedCredentialDocument(managed, browser, currentAuthorization, context, values, credentialProtection, settleTimeoutMs, settleIntervalMs));
        updatedAt = Date.now();
        return result;
      },
      async allowAgentInspection() {
        await currentAuthorization();
        await browser.allowAgentInspectionAfterCredentialFill();
        updatedAt = Date.now();
        return publicState();
      },
      async lock() {
        await currentAuthorization();
        await options.credentialBroker!.lock();
      },
    } : undefined;
    const ownerControls: ProtectedBrowserOwnerControls = {
      state: publicState,
      async start() {
        await currentAuthorization();
        return lifecycle.start(currentAuthorization);
      },
      async stop() {
        await currentAuthorization();
        return lifecycle.stop();
      },
      async pasteText(text) {
        if (typeof text !== "string" || !text) throw Object.assign(new Error("Protected browser paste text is required"), { statusCode: 400 });
        if (browser.mode === "agent") throw Object.assign(new Error("Protected browser direct paste requires human control"), { statusCode: 409 });
        await currentAuthorization();
        if (!managed.running) throw Object.assign(new Error("Protected browser is not running"), { statusCode: 409 });
        const attachment = await managed.attachPageCdpViewer();
        try {
          await guardedSend(attachment.cdp, currentAuthorization, "Runtime.enable");
          const focused = await guardedSend<any>(attachment.cdp, currentAuthorization, "Runtime.evaluate", {
            expression: "(() => { const __wayangOwnerPasteTarget = document.activeElement; return Boolean(__wayangOwnerPasteTarget && !__wayangOwnerPasteTarget.disabled && !__wayangOwnerPasteTarget.readOnly && (__wayangOwnerPasteTarget.isContentEditable || 'value' in __wayangOwnerPasteTarget)); })()",
            returnByValue: true,
          });
          if (focused?.result?.value !== true) throw Object.assign(new Error("Protected browser focused element cannot receive pasted text"), { statusCode: 409 });
          await guardedSend(attachment.cdp, currentAuthorization, "Input.insertText", { text });
          const document = await settledDocument(attachment.cdp, attachment.target, currentAuthorization, settleTimeoutMs, settleIntervalMs);
          if (!isProtectedBrowserAllowedTopLevelUrl(document.topLevelUrl)) {
            await browser.revokeRealm();
            throw new Error("Protected browser direct paste reached a forbidden top-level document");
          }
          activeUrl = document.topLevelUrl;
          activeTitle = document.title;
          updatedAt = Date.now();
          return publicState();
        } finally { attachment.close(); }
      },
      async resetProfile() {
        await currentAuthorization();
        await lifecycle.stop();
        await currentAuthorization();
        const recoveryDir = path.join(storage.rootDir, "profile-recovery");
        fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
        fs.chmodSync(recoveryDir, 0o700);
        if (fs.existsSync(storage.profileDir)) {
          const recoveryPath = path.join(recoveryDir, `profile-${Date.now()}-${createHash("sha256").update(`${activeBinding.runtimeGeneration}:${process.hrtime.bigint()}`).digest("hex").slice(0, 16)}`);
          fs.renameSync(storage.profileDir, recoveryPath);
        }
        fs.mkdirSync(storage.profileDir, { recursive: true, mode: 0o700 });
        fs.chmodSync(storage.profileDir, 0o700);
        activeUrl = undefined;
        activeTitle = undefined;
        startedAt = undefined;
        updatedAt = Date.now();
        return publicState();
      },
    };
    const createToolLease = (
      leaseBinding: ProtectedBrowserBinding,
      leaseBrowser: CapabilityBoundProtectedBrowser,
    ): ProtectedBrowserToolRuntime => {
      const authorizeLease = async () => {
        const current = leaseBrowser.currentBinding;
        if (leaseBrowser.isRevoked || !sameProtectedBrowserLeaseIdentity(current, leaseBinding)) {
          throw new Error("Protected browser runtime lease is revoked");
        }
        const snapshot = authorityResolver(current);
        if (!snapshot || !exactProtectedBrowserBindingEqual(snapshot, current)) {
          throw new Error("Protected browser runtime lease is unavailable");
        }
      };
      const baseRuntime = createProtectedBrowserToolRuntime({ browser: leaseBrowser });
      let leaseRuntime!: ProtectedBrowserToolRuntime;
      const retire = (operation: () => Promise<void>): Promise<void> => {
        created.delete(leaseRuntime);
        const cleanup = operation();
        leaseCleanupTasks.add(cleanup);
        void cleanup.then(
          () => leaseCleanupTasks.delete(cleanup),
          () => leaseCleanupTasks.delete(cleanup),
        );
        return cleanup;
      };
      leaseRuntime = {
        kind: leaseBinding.capabilityId === STANDARD_BROWSER_CAPABILITY_ID ? "standard" : "protected",
        get binding() { return baseRuntime.binding; },
        tools: baseRuntime.tools,
        browser: baseRuntime.browser,
        toolForName: (name) => baseRuntime.toolForName(name),
        preflight: () => baseRuntime.preflight(),
        detachAgentLease: (reason) => retire(() => baseRuntime.detachAgentLease(reason)),
        closeSessionWorkspaces: (reason) => retire(() => baseRuntime.closeSessionWorkspaces(reason)),
        revokeAuthority: (reason) => retire(() => baseRuntime.revokeAuthority(reason)),
        close: () => retire(() => baseRuntime.close()),
      };
      const assertLeaseCurrent = () => {
        const current = leaseBrowser.currentBinding;
        const sameLeaseIdentity = sameProtectedBrowserLeaseIdentity(current, leaseBinding);
        // controlGeneration legitimately advances during handoff/resume inside
        // one exclusive lease. Browser queue/control checks fence each action;
        // the lease identity itself is every other immutable field above.
        if (leaseBrowser.isRevoked || browser !== leaseBrowser || !sameLeaseIdentity) {
          throw Object.assign(new Error("Protected browser runtime lease is revoked"), { statusCode: 403 });
        }
      };
      const leaseOwnerControls: ProtectedBrowserOwnerControls = {
        state() { assertLeaseCurrent(); return ownerControls.state(); },
        start() { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return ownerControls.start(); }); },
        stop() { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return ownerControls.stop(); }); },
        pasteText(text) { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return ownerControls.pasteText(text); }); },
        resetProfile() { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return ownerControls.resetProfile(); }); },
      };
      const leaseCredentialControls: ProtectedBrowserCredentialControls | undefined = credentialControls ? {
        status() { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return credentialControls.status(); }); },
        matches() { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return credentialControls.matches(); }); },
        fill(token, operation) { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return credentialControls.fill(token, operation); }); },
        allowAgentInspection() { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return credentialControls.allowAgentInspection(); }); },
        lock() { return leaseBrowser.runLeaseWork(async () => { assertLeaseCurrent(); await authorizeLease(); return credentialControls.lock(); }); },
      } : undefined;
      created.add(leaseRuntime);
      productionPorts.set(leaseRuntime, {
        managed,
        ownerControls: leaseOwnerControls,
        credentialProtection,
        ...(leaseCredentialControls ? { credentialControls: leaseCredentialControls } : {}),
      });
      return leaseRuntime;
    };

    runtime = createToolLease(activeBinding, browser);

    const performReplacement = async (requested: ProtectedBrowserBinding): Promise<ProtectedBrowserToolRuntime> => {
      if (requested.projectId !== activeBinding.projectId
        || requested.agentProfileId !== activeBinding.agentProfileId
        || requested.projectCwd !== activeBinding.projectCwd
        || requested.associationRevision !== activeBinding.associationRevision
        || requested.processBootNonce !== activeBinding.processBootNonce) {
        throw new Error("Protected browser replacement does not match the persistent pair realm");
      }
      const priorBrowser = browser;
      // revoke() latches synchronously. No download await may leave the old
      // source lease authorized after replacement has begun.
      const priorRevocation = priorBrowser.revoke();
      const pendingDownloads = downloadPublisher.pendingGuids();
      await Promise.allSettled(pendingDownloads.map((guid) => managed.cancelDownload(guid, currentAuthorization)));
      downloadPublisher.cancelPending();
      const cleanup = await Promise.allSettled([priorRevocation]);
      if (cleanup.some((result) => result.status === "rejected")) {
        void priorBrowser.revokeRealm();
        throw new Error("Protected browser lease cleanup failed before replacement publication");
      }

      if (closed || !pairAuthorized(requested)) {
        throw new Error("Protected browser pair authority changed during replacement");
      }
      latestDownload = undefined;
      const nextBinding: ProtectedBrowserBinding = { ...requested };
      activeBinding = nextBinding;
      const nextAuthority = createAuthorityPort(nextBinding, authorityResolver);
      const nextBrowser = new CapabilityBoundProtectedBrowser({
        dataDir: options.dataDir,
        binding: nextBinding,
        authority: nextAuthority,
        backend,
        credentials,
        initialControlMode: realmControlMode,
        onControlModeChanged(mode) { realmControlMode = mode; },
        onRealmRevoked: invalidatePairPublication,
      });
      browser = nextBrowser;
      updatedAt = Date.now();
      runtime = createToolLease(nextBinding, nextBrowser);
      return runtime;
    };
    let transferTail: Promise<void> = Promise.resolve();
    let pendingTransfers = 0;
    const attachReplacement = (requested: ProtectedBrowserBinding): Promise<ProtectedBrowserToolRuntime> => {
      // The uncontended path revokes the old browser lease before publishing
      // its replacement in this same factory turn.
      const operation = pendingTransfers === 0
        ? performReplacement(requested)
        : transferTail.then(() => performReplacement(requested));
      pendingTransfers += 1;
      transferTail = operation.then(() => undefined, () => undefined).finally(() => { pendingTransfers -= 1; });
      return operation;
    };
    realmAttachers.set(realmKey(activeBinding), attachReplacement);
    realmTeardowns.set(realmKey(activeBinding), () => browser.revokeRealm());
    return runtime;
  };

  const integration: ProtectedBrowserIntegration = {
    async select(input: Readonly<ProtectedBrowserSelectionInput>): Promise<ProtectedBrowserRouteSelection | null> {
      if (!input.targetSessionId || input.requestedPersistence !== undefined || input.requestedScope !== undefined) return null;
      const runtime = liveRuntimeResolver(input.targetSessionId);
      if (!runtime) return null;
      const binding = runtime.browser.currentBinding;
      if (input.sourceSessionId && input.sourceSessionId !== binding.sourceSessionId) return null;
      if (input.projectCwd && input.projectCwd !== binding.projectCwd) return null;
      const snapshot = authorityResolver(binding);
      if (!snapshot || !exactProtectedBrowserBindingEqual(snapshot, binding)) return null;
      return { binding: { ...binding } };
    },
    resolve(selection) {
      const runtime = liveRuntimeResolver(selection.binding.sourceSessionId, selection.binding);
      if (!runtime) return null;
      const current = runtime.browser.currentBinding;
      const snapshot = authorityResolver(current);
      if (!snapshot || !exactProtectedBrowserBindingEqual(snapshot, current)) return null;
      const ports = productionPorts.get(runtime);
      return ports ? {
        browser: runtime.browser,
        ownerControls: ports.ownerControls,
        ...(ports.credentialControls ? { credentialControls: ports.credentialControls } : {}),
      } : null;
    },
    async openViewer(selection, kind) {
      if (kind !== "cdp") return null;
      const runtime = liveRuntimeResolver(selection.binding.sourceSessionId, selection.binding);
      if (!runtime) return null;
      const current = runtime.browser.currentBinding;
      const snapshot = authorityResolver(current);
      if (!snapshot || !exactProtectedBrowserBindingEqual(snapshot, current)) return null;
      const ports = productionPorts.get(runtime);
      const managed = ports?.managed;
      if (!managed || !ports) return null;
      return runtime.browser.runLeaseWork(() => openCdpViewer({
        managed,
        authorize: async () => {
          const current = runtime.browser.currentBinding;
          const snapshot = authorityResolver(current);
          if (!snapshot || !exactProtectedBrowserBindingEqual(snapshot, current)) throw new Error("Protected browser viewer authority is unavailable");
        },
        revoke: () => runtime.browser.revokeRealm(),
        settleTimeoutMs,
        settleIntervalMs,
        redact: (value) => ports.credentialProtection.redact(value),
      }));
    },
    resolveOwner(request) { return options.owner.resolve(request); },
  };

  const uninstall = (options.installFactory ?? installProductionProtectedBrowserFactory)(factory);
  return {
    integration,
    factory,
    async close() {
      if (closed) return;
      closed = true;
      uninstall();
      const teardowns = [...realmTeardowns.values()].map((teardown) => teardown());
      const leaseClosures = [...created].map((runtime) => runtime.close());
      await Promise.allSettled([...teardowns, ...leaseClosures, ...leaseCleanupTasks]);
      realmAttachers.clear();
      realmTeardowns.clear();
      created.clear();
    },
  };
}
