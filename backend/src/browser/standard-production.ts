import * as fs from "node:fs";
import * as path from "node:path";
import type { ChromeTarget } from "./cdp.js";
import {
  ManagedChromiumRuntime,
  type BrowserCredentialContext,
  type ManagedChromiumPageAttachment,
  type ManagedChromiumRuntimeOptions,
} from "./manager.js";
import {
  ProtectedCredentialProtection,
  boundedElementLimit,
  compileGuardedDomOperation,
  evaluateGuardedPage,
  guardedSend,
  settledTopLevelDocument,
} from "./guarded-page.js";
import { isProtectedBrowserAllowedTopLevelUrl } from "./protected-browser.js";
import type { ProtectedBrowserOperation } from "./types.js";
import type {
  StandardBrowserBackendTarget,
  StandardBrowserHostBackend,
  StandardBrowserHostBackendFactory,
} from "./standard-host.js";

const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_INTERVAL_MS = 50;
const MAX_STANDARD_OBSERVATION_BYTES = 2 * 1024 * 1024;
const MAX_STANDARD_AX_STRING_BYTES = 2_048;

function boundedUtf8(value: unknown, maxBytes = MAX_STANDARD_AX_STRING_BYTES): string {
  const input = String(value ?? "");
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let output = "";
  for (const scalar of input) {
    if (Buffer.byteLength(output + scalar, "utf8") > maxBytes) break;
    output += scalar;
  }
  return `${output}…`;
}

function assertBoundedObservation(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STANDARD_OBSERVATION_BYTES) {
    throw new Error("Standard browser observation exceeded its bounded result size");
  }
}

export interface StandardManagedChromiumPort {
  readonly running: boolean;
  readonly vncReady?: boolean;
  readonly vncPort?: number | null;
  start(authorize?: () => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  listPageTargets(): Promise<ChromeTarget[]>;
  createPageTarget(url?: string): Promise<ChromeTarget>;
  closePageTarget(targetId: string): Promise<void>;
  cancelDownload(guid: string): Promise<void>;
  attachTargetCdpViewer(targetId: string): Promise<ManagedChromiumPageAttachment>;
}

function redactNavigationTitle(title: string, rawUrl: string): string {
  let output = title;
  try {
    const parsed = new URL(rawUrl);
    const visible = new URL(rawUrl);
    visible.username = ""; visible.password = ""; visible.search = ""; visible.hash = "";
    output = output.split(rawUrl).join(visible.toString());
    for (const secret of [parsed.username, parsed.password, parsed.hash.slice(1), ...parsed.searchParams.values()]
      .filter((value) => value.length >= 3).sort((a, b) => b.length - a.length)) {
      output = output.split(secret).join("[REDACTED]");
    }
  } catch { return ""; }
  return output.slice(0, 512);
}

function publicTarget(target: ChromeTarget): StandardBrowserBackendTarget {
  return {
    id: target.id,
    ...(target.openerId ? { openerId: target.openerId } : {}),
    ...(target.url ? { url: target.url } : {}),
    ...(target.title ? { title: target.title } : {}),
  };
}

async function executeExactTargetOperation(
  managed: StandardManagedChromiumPort,
  targetId: string,
  operation: ProtectedBrowserOperation,
  authorize: () => Promise<void>,
  protection: ProtectedCredentialProtection,
  hostRedactor: ProtectedCredentialProtection,
): Promise<unknown> {
  if (operation.kind === "status" || operation.kind === "start" || operation.kind === "stop") {
    throw new Error("Standard host lifecycle operation reached page backend");
  }
  await authorize();
  if (operation.kind === "navigate" && !isProtectedBrowserAllowedTopLevelUrl(operation.url)) {
    throw new Error("Standard browser navigation requires an absolute HTTPS URL without credentials");
  }
  const attachment = await managed.attachTargetCdpViewer(targetId);
  const { cdp, target } = attachment;
  try {
    await guardedSend(cdp, authorize, "Page.enable");
    await guardedSend(cdp, authorize, "Runtime.enable");
    const before = await settledTopLevelDocument(cdp, target, authorize, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    if (!isProtectedBrowserAllowedTopLevelUrl(before.topLevelUrl) && before.topLevelUrl !== "about:blank") {
      await managed.closePageTarget(targetId).catch(() => undefined);
      throw new Error("Standard browser target has a forbidden top-level document");
    }
    protection.assertOperation(operation, before.documentIdentity);
    let value: unknown;
    switch (operation.kind) {
      case "navigate": {
        const navigation = await guardedSend<any>(cdp, authorize, "Page.navigate", { url: operation.url });
        if (navigation?.errorText) throw new Error("Standard browser navigation failed");
        value = { navigated: true };
        break;
      }
      case "snapshot": {
        const page = await evaluateGuardedPage<{ url: string; title: string; text: string }>(cdp, authorize, compileGuardedDomOperation({ kind: "snapshot" }));
        page.title = redactNavigationTitle(page.title, page.url);
        if (operation.mode === "screenshot") {
          const shot = await guardedSend<any>(cdp, authorize, "Page.captureScreenshot", { format: "jpeg", quality: 80, fromSurface: true });
          value = { url: page.url, title: page.title, screenshot: shot?.data ? `data:image/jpeg;base64,${shot.data}` : undefined };
        } else value = page;
        break;
      }
      case "dom_snapshot":
        value = await evaluateGuardedPage(cdp, authorize, compileGuardedDomOperation({ kind: "dom_snapshot", includeText: operation.includeText, limit: operation.limit }));
        break;
      case "links":
        value = await evaluateGuardedPage(cdp, authorize, compileGuardedDomOperation({ kind: "links", limit: operation.limit }));
        break;
      case "query_selector":
        value = await evaluateGuardedPage(cdp, authorize, compileGuardedDomOperation({ kind: "query_selector", selector: operation.selector, limit: operation.limit }));
        break;
      case "click":
        await guardedSend(cdp, authorize, "Input.dispatchMouseEvent", { type: "mousePressed", x: operation.x, y: operation.y, button: "left", clickCount: 1 });
        await guardedSend(cdp, authorize, "Input.dispatchMouseEvent", { type: "mouseReleased", x: operation.x, y: operation.y, button: "left", clickCount: 1 });
        value = { clicked: true };
        break;
      case "click_selector": {
        const point = await evaluateGuardedPage<{ x: number; y: number }>(cdp, authorize, compileGuardedDomOperation({ kind: "selector_point", selector: operation.selector, index: operation.index }));
        await guardedSend(cdp, authorize, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await guardedSend(cdp, authorize, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        value = { clicked: true };
        break;
      }
      case "fill_selector":
        value = await evaluateGuardedPage(cdp, authorize, compileGuardedDomOperation({ kind: "fill_selector", selector: operation.selector, index: operation.index, text: operation.text }));
        break;
      case "type_public":
        value = await evaluateGuardedPage(cdp, authorize, compileGuardedDomOperation({ kind: "type_public", text: operation.text }));
        break;
      case "accessibility": {
        const limit = boundedElementLimit(operation.limit, 120);
        const secrets = await evaluateGuardedPage<string[]>(cdp, authorize, compileGuardedDomOperation({ kind: "secrets" }));
        await guardedSend(cdp, authorize, "Accessibility.enable");
        const tree = await guardedSend<any>(cdp, authorize, "Accessibility.getFullAXTree");
        const rawNodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
        if (rawNodes.length > 20_000) throw new Error("Standard browser accessibility tree exceeded its node bound");
        const redact = (input: unknown) => boundedUtf8(secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(input ?? "")));
        value = { nodes: rawNodes.filter((node: any) => !node.ignored).slice(0, limit).map((node: any) => ({ role: redact(node.role?.value), name: redact(node.name?.value), value: redact(node.value?.value), description: redact(node.description?.value) })) };
        break;
      }
      default:
        throw new Error("Standard browser operation is unavailable");
    }
    const after = await settledTopLevelDocument(cdp, target, authorize, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    if (!isProtectedBrowserAllowedTopLevelUrl(after.topLevelUrl) && after.topLevelUrl !== "about:blank") {
      await managed.closePageTarget(targetId).catch(() => undefined);
      throw new Error("Standard browser reached a forbidden top-level document");
    }
    await authorize();
    if (value && typeof value === "object" && "title" in value && typeof (value as { title?: unknown }).title === "string") {
      (value as { title: string }).title = redactNavigationTitle((value as { title: string }).title, after.topLevelUrl);
    }
    if (operation.kind === "navigate" && value && typeof value === "object") {
      const visible = new URL(after.topLevelUrl);
      visible.username = ""; visible.password = ""; visible.search = ""; visible.hash = "";
      value = { ...value, url: visible.toString(), title: redactNavigationTitle(after.title, after.topLevelUrl) };
    }
    const redacted = hostRedactor.redact(protection.redact(value));
    assertBoundedObservation(redacted);
    return redacted;
  } finally { attachment.close(); }
}

async function standardCredentialContext(
  managed: StandardManagedChromiumPort,
  targetId: string,
  runtimeKey: string,
  authorize: () => Promise<void>,
): Promise<BrowserCredentialContext> {
  await authorize();
  const attachment = await managed.attachTargetCdpViewer(targetId);
  try {
    await guardedSend(attachment.cdp, authorize, "Page.enable");
    await guardedSend(attachment.cdp, authorize, "Runtime.enable");
    const document = await settledTopLevelDocument(attachment.cdp, attachment.target, authorize, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    if (!isProtectedBrowserAllowedTopLevelUrl(document.topLevelUrl)) throw new Error("Current page does not have a credential-safe HTTPS origin");
    const origin = new URL(document.topLevelUrl).origin;
    if (origin === "null") throw new Error("Current page does not have a credential-safe HTTPS origin");
    return { runtimeKey, targetId, documentIdentity: document.documentIdentity, url: document.topLevelUrl, origin };
  } finally { attachment.close(); }
}

function sameCredentialContext(left: BrowserCredentialContext, right: BrowserCredentialContext): boolean {
  return left.runtimeKey === right.runtimeKey && left.targetId === right.targetId
    && left.documentIdentity === right.documentIdentity && left.origin === right.origin;
}

async function fillStandardCredentialDocument(
  managed: StandardManagedChromiumPort,
  targetId: string,
  expected: BrowserCredentialContext,
  values: { username?: string; password?: string; totp?: string },
  protection: ProtectedCredentialProtection,
  hostRedactor: ProtectedCredentialProtection,
  authorize: () => Promise<void>,
): Promise<Array<"username" | "password" | "totp">> {
  const current = await standardCredentialContext(managed, targetId, expected.runtimeKey, authorize);
  if (!sameCredentialContext(expected, current)) throw new Error("Credential choice is no longer valid for this page");
  const attachment = await managed.attachTargetCdpViewer(targetId);
  try {
    protection.recordFill(expected.documentIdentity, values);
    hostRedactor.recordFill(expected.documentIdentity, values);
    const documentResult = await guardedSend<any>(attachment.cdp, authorize, "Runtime.evaluate", { expression: "document", returnByValue: false });
    const objectId = documentResult?.result?.objectId;
    if (!objectId) throw new Error("Credential fill could not access the page");
    const result = await guardedSend<any>(attachment.cdp, authorize, "Runtime.callFunctionOn", {
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
    const after = await standardCredentialContext(managed, targetId, expected.runtimeKey, authorize);
    if (!sameCredentialContext(expected, after)) throw new Error("Credential document changed during fill");
    return (Array.isArray(value.filled) ? value.filled : []).filter((field: unknown): field is "username" | "password" | "totp" => field === "username" || field === "password" || field === "totp");
  } finally { attachment.close(); }
}

export function createStandardBrowserHostBackendFactory(options: {
  dataDir: string;
  managedFactory?: (options: ManagedChromiumRuntimeOptions) => StandardManagedChromiumPort;
}): StandardBrowserHostBackendFactory {
  const managedFactory = options.managedFactory ?? ((runtimeOptions) => new ManagedChromiumRuntime(runtimeOptions));
  return ({ profile, storage, callbacks }): StandardBrowserHostBackend => {
    const protections = new Map<string, ProtectedCredentialProtection>();
    const hostRedactor = new ProtectedCredentialProtection();
    const protectionFor = (targetId: string) => {
      let protection = protections.get(targetId);
      if (!protection) { protection = new ProtectedCredentialProtection(); protections.set(targetId, protection); }
      return protection;
    };
    let managed!: StandardManagedChromiumPort;
    const downloadStagingDir = path.join(options.dataDir, "browser-profiles", "v1", "download-staging", profile.id);
    let stagingCleaned = false;
    const cleanStaging = () => {
      if (stagingCleaned) return;
      fs.mkdirSync(downloadStagingDir, { recursive: true, mode: 0o700 });
      const directory = fs.lstatSync(downloadStagingDir);
      if (!directory.isDirectory() || directory.isSymbolicLink()
        || (typeof process.getuid === "function" && directory.uid !== process.getuid())) {
        throw new Error("Standard browser download staging directory is unsafe");
      }
      fs.chmodSync(downloadStagingDir, 0o700);
      for (const name of fs.readdirSync(downloadStagingDir)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name)) throw new Error("Standard browser download staging entry is unsafe");
        const candidate = path.join(downloadStagingDir, name);
        const metadata = fs.lstatSync(candidate);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
          throw new Error("Standard browser download staging entry is unsafe");
        }
        fs.unlinkSync(candidate);
      }
      stagingCleaned = true;
    };
    managed = managedFactory({
      profileDir: storage.root,
      downloadsDir: downloadStagingDir,
      downloadBehavior: "allowAndName",
      downloadAttribution: "exact-frame-page-target",
      enableVnc: true,
      workingDirectory: options.dataDir,
      onTargetCreated: (target) => { if (target.type === "page") callbacks.targetCreated(publicTarget(target)); },
      onTargetChanged: (target) => { if (target.type === "page") callbacks.targetChanged(publicTarget(target)); },
      onTargetDestroyed: (targetId) => { protections.delete(targetId); callbacks.targetDestroyed(targetId); },
      onDownloadWillBegin(event, targetId) {
        callbacks.downloadWillBegin(event, targetId ?? null);
        if (!targetId) void managed.cancelDownload(event.guid).catch(() => undefined);
      },
      onDownloadProgress: callbacks.downloadProgress,
      onUnexpectedExit: callbacks.unexpectedExit,
    });
    return {
      get running() { return managed.running; },
      get vncReady() { return managed.vncReady === true; },
      get vncPort() { return managed.vncPort ?? null; },
      downloadStagingDir,
      start: async (authorize) => { cleanStaging(); await managed.start(authorize); },
      stop: () => managed.stop(),
      listTargets: async () => (await managed.listPageTargets()).map(publicTarget),
      createTarget: async (url) => publicTarget(await managed.createPageTarget(url)),
      closeTarget: (targetId) => managed.closePageTarget(targetId),
      cancelDownload: (guid) => managed.cancelDownload(guid),
      attachViewer: (targetId) => managed.attachTargetCdpViewer(targetId),
      execute: (targetId, operation, authorize) => executeExactTargetOperation(
        managed, targetId, operation, authorize, protectionFor(targetId), hostRedactor,
      ),
      credentialContext: (targetId, runtimeKey, authorize) => standardCredentialContext(managed, targetId, runtimeKey, authorize),
      fillCredential: (targetId, expected, values, authorize) => fillStandardCredentialDocument(
        managed, targetId, expected, values, protectionFor(targetId), hostRedactor, authorize,
      ),
      async allowCredentialInspection(targetId, expected, authorize) {
        const current = await standardCredentialContext(managed, targetId, expected.runtimeKey, authorize);
        if (!sameCredentialContext(expected, current)) throw new Error("Credential choice is no longer valid for this page");
        protectionFor(targetId).allowInspection(current.documentIdentity);
      },
      async assertSafeCredentialResume(targetId, authorize) {
        const protection = protectionFor(targetId);
        if (protection.mode === "none") return;
        const current = await standardCredentialContext(managed, targetId, "resume", authorize);
        protection.reconcile(current.documentIdentity);
        if ((protection.mode as string) !== "none") throw new Error("Standard browser credential inspection requires a fresh top-level document");
      },
      credentialInspection: (targetId) => protections.get(targetId)?.mode ?? "none",
      redactCredentialMetadata: (value) => hostRedactor.redact(value),
    };
  };
}
