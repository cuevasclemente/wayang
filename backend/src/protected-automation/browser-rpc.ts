import { randomUUID } from "node:crypto";
import type { CdpConnection, ChromeTarget } from "../browser/cdp.js";
import {
  compileGuardedDomOperation,
  evaluateGuardedPage,
  guardedSend,
  settledTopLevelDocument,
  type GuardedDomOperation,
  type TopLevelDocumentAttestation,
} from "../browser/guarded-page.js";
import {
  PROTECTED_AUTOMATION_ATTENTION_REASONS,
  ProtectedAutomationNeedsUserError,
  type ProtectedAutomationAttentionReason,
} from "./attention.js";
import {
  isProtectedAutomationBrowserRpcMethod,
  type ProtectedAutomationBrowserDownloadListResult,
  type ProtectedAutomationBrowserMaterializedDownloadResult,
  type ProtectedAutomationBrowserRpcMethod,
} from "./browser-protocol.js";
import type { ProtectedAutomationBrowserRealmLease } from "./browser-realm.js";

export {
  PROTECTED_AUTOMATION_BROWSER_RPC_METHODS,
  isProtectedAutomationBrowserRpcMethod,
  type ProtectedAutomationBrowserDownloadListResult,
  type ProtectedAutomationBrowserDownloadResult,
  type ProtectedAutomationBrowserMaterializedDownloadResult,
  type ProtectedAutomationBrowserRpcMethod,
} from "./browser-protocol.js";

export interface ProtectedAutomationBrowserRequestPort {
  request(input: {
    method: string;
    params: unknown;
    allowedHttpsOrigins: readonly string[];
    signal: AbortSignal;
  }): Promise<unknown>;
}

export interface ProtectedAutomationBrowserLeasePort extends ProtectedAutomationBrowserRequestPort {
  close(): Promise<void>;
}

const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_INTERVAL_MS = 50;
const MAX_SELECTOR_BYTES = 4_096;
const MAX_EXPECTED_ELEMENT_NAME_BYTES = 2_048;
const MAX_PUBLIC_TEXT_BYTES = 16 * 1024;
const MAX_SELECTOR_QUERY_RECEIPTS = 32;
const SELECTOR_QUERY_RECEIPT_TTL_MS = 30_000;
const SELECTOR_ISOLATED_WORLD_NAME = "wayang-protected-automation-selector-v1";

function rpcError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw rpcError("Browser RPC parameters are malformed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !descriptors[key]?.enumerable || descriptors[key]?.get || descriptors[key]?.set)) {
    throw rpcError("Browser RPC parameters are malformed");
  }
  const actual = Object.keys(value).sort();
  if (actual.join("\0") !== [...keys].sort().join("\0")) throw rpcError("Browser RPC parameters are not exact");
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximumBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value !== value.normalize("NFC")
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw rpcError(`Browser RPC ${label} is invalid`);
  }
  return value;
}

function optionalBoundedLimit(value: unknown): number | undefined {
  if (value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 500) throw rpcError("Browser RPC limit is invalid");
  return Number(value);
}

function optionalBoundedIndex(value: unknown): number | undefined {
  if (value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 500) throw rpcError("Browser RPC index is invalid");
  return Number(value);
}

function originsEqual(left: readonly string[], right: ReadonlySet<string>): boolean {
  if (left.length !== right.size) return false;
  try {
    const normalized = new Set(left.map((value) => {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error("invalid origin");
      }
      return parsed.origin;
    }));
    return normalized.size === right.size && [...normalized].every((origin) => right.has(origin));
  } catch { return false; }
}

function withoutCoordinates<T>(value: T): T {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item)
        .filter(([key]) => key !== "rect" && key !== "x" && key !== "y")
        .map(([key, child]) => [key, visit(child)]));
    }
    return item;
  };
  return visit(value) as T;
}

function assertAllowedDocument(
  lease: ProtectedAutomationBrowserRealmLease,
  document: TopLevelDocumentAttestation,
  allowInitialBlank = false,
): void {
  if (allowInitialBlank && document.topLevelUrl === "about:blank") return;
  try {
    const parsed = new URL(document.topLevelUrl);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password && lease.allowedOrigins.has(parsed.origin)) return;
  } catch { /* denial below */ }
  lease.deny("document-origin-drift");
  throw rpcError("Browser RPC document origin is outside the exact HTTPS allowlist");
}

async function withAttestedPage<T>(
  lease: ProtectedAutomationBrowserRealmLease,
  operation: (cdp: CdpConnection, target: ChromeTarget, before: TopLevelDocumentAttestation) => Promise<T>,
  allowInitialBlank = false,
): Promise<{ value: T; before: TopLevelDocumentAttestation; document: TopLevelDocumentAttestation }> {
  await lease.assertNavigationGateReady();
  return lease.runtime.withPageCdp(async (cdp, target) => {
    const guard = () => lease.assertAuthorized();
    const attest = async (allowBlank = false) => {
      try {
        const document = await settledTopLevelDocument(cdp, target, guard, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
        assertAllowedDocument(lease, document, allowBlank);
        return document;
      } catch (error) {
        lease.deny("unattested-document");
        throw error;
      }
    };
    const before = await attest(allowInitialBlank);
    const value = await operation(cdp, target, before);
    const document = await attest();
    return { value, before, document };
  });
}

async function guardedDom<T>(
  cdp: CdpConnection,
  lease: ProtectedAutomationBrowserRealmLease,
  operation: GuardedDomOperation,
  contextId?: number,
): Promise<T> {
  return evaluateGuardedPage<T>(cdp, () => lease.assertAuthorized(), compileGuardedDomOperation(operation), contextId);
}

async function selectorIsolatedWorld(
  cdp: CdpConnection,
  lease: ProtectedAutomationBrowserRealmLease,
  document: TopLevelDocumentAttestation,
): Promise<number> {
  const result = await guardedSend<any>(cdp, () => lease.assertAuthorized(), "Page.createIsolatedWorld", {
    frameId: document.frameId,
    worldName: SELECTOR_ISOLATED_WORLD_NAME,
    grantUniveralAccess: false,
  });
  const contextId = result?.executionContextId;
  if (!Number.isSafeInteger(contextId) || contextId < 1) throw rpcError("Browser RPC selector world is unavailable");
  return contextId;
}

interface SelectorQueryElementReceipt {
  index: number;
  name: string;
  visible: true;
  disabled: boolean;
}

interface SelectorQueryReceipt {
  documentIdentity: string;
  documentNonce: string;
  selector: string;
  issuedAt: number;
  elements: SelectorQueryElementReceipt[];
}

function selectorQueryElements(value: unknown): SelectorQueryElementReceipt[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw rpcError("Browser RPC query result is malformed");
  const elements = (value as { elements?: unknown }).elements;
  if (!Array.isArray(elements) || elements.length > 500) throw rpcError("Browser RPC query result is malformed");
  return elements.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw rpcError("Browser RPC query result is malformed");
    const element = item as Record<string, unknown>;
    if (element.index !== index || typeof element.name !== "string" || element.name.length > 500
      || element.visible !== true || typeof element.disabled !== "boolean") {
      throw rpcError("Browser RPC query result is malformed");
    }
    return { index, name: element.name, visible: true, disabled: element.disabled };
  });
}

export class ProtectedAutomationBrowserRpc implements ProtectedAutomationBrowserLeasePort {
  private readonly selectorQueryReceipts = new Map<string, SelectorQueryReceipt>();

  constructor(private readonly lease: ProtectedAutomationBrowserRealmLease) {}

  private issueSelectorQueryReceipt(receipt: Omit<SelectorQueryReceipt, "issuedAt">): string {
    while (this.selectorQueryReceipts.size >= MAX_SELECTOR_QUERY_RECEIPTS) {
      const oldest = this.selectorQueryReceipts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.selectorQueryReceipts.delete(oldest);
    }
    const token = randomUUID();
    this.selectorQueryReceipts.set(token, { ...receipt, issuedAt: Date.now() });
    return token;
  }

  private consumeSelectorQueryReceipt(token: string): SelectorQueryReceipt {
    const receipt = this.selectorQueryReceipts.get(token);
    this.selectorQueryReceipts.delete(token);
    const now = Date.now();
    if (!receipt || now < receipt.issuedAt || now - receipt.issuedAt > SELECTOR_QUERY_RECEIPT_TTL_MS) {
      throw rpcError("Browser RPC selector query receipt is unavailable");
    }
    return receipt;
  }

  request(input: {
    method: string;
    params: unknown;
    allowedHttpsOrigins: readonly string[];
    signal: AbortSignal;
  }): Promise<unknown> {
    if (!isProtectedAutomationBrowserRpcMethod(input.method)) return Promise.reject(rpcError("Browser RPC method is not allowed"));
    if (input.signal.aborted || this.lease.signal.aborted) return Promise.reject(rpcError("Browser RPC lease is cancelled"));
    if (!originsEqual(input.allowedHttpsOrigins, this.lease.allowedOrigins)) {
      this.lease.deny("rpc-origin-binding-drift");
      return Promise.reject(rpcError("Browser RPC origin binding changed"));
    }
    return this.lease.runExclusive(() => this.dispatch(input.method as ProtectedAutomationBrowserRpcMethod, input.params));
  }

  private async dispatch(method: ProtectedAutomationBrowserRpcMethod, rawParams: unknown): Promise<unknown> {
    switch (method) {
      case "browser.status": {
        exactObject(rawParams, []);
        return { running: this.lease.runtime.running, generation: this.lease.binding.generation };
      }
      case "browser.navigate": {
        const params = exactObject(rawParams, ["url"]);
        const requested = boundedString(params.url, "URL", 2_048);
        this.selectorQueryReceipts.clear();
        let parsed: URL;
        try { parsed = new URL(requested); } catch { throw rpcError("Browser RPC navigation requires an absolute HTTPS URL"); }
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || !this.lease.allowedOrigins.has(parsed.origin)) {
          throw rpcError("Browser RPC navigation origin is not allowed");
        }
        const result = await withAttestedPage(this.lease, async (cdp) => {
          await this.lease.assertNavigationGateReady();
          const navigation = await guardedSend<any>(cdp, () => this.lease.assertAuthorized(), "Page.navigate", { url: parsed.toString() });
          if (navigation?.errorText || !navigation?.loaderId) {
            this.lease.deny("navigation-did-not-commit");
            throw rpcError("Browser RPC navigation did not commit an attested document");
          }
          return null;
        }, true);
        if (result.document.documentIdentity === result.before.documentIdentity) {
          this.lease.deny("navigation-did-not-commit");
          throw rpcError("Browser RPC navigation did not commit an attested document");
        }
        return { url: result.document.topLevelUrl, title: result.document.title, document: result.document.documentIdentity };
      }
      case "browser.snapshot": {
        exactObject(rawParams, []);
        return (await withAttestedPage(this.lease, (cdp) => guardedDom(cdp, this.lease, { kind: "snapshot" }))).value;
      }
      case "browser.dom_snapshot": {
        const params = exactObject(rawParams, ["includeText", "limit"]);
        if (typeof params.includeText !== "boolean") throw rpcError("Browser RPC includeText is invalid");
        const includeText = params.includeText;
        const limit = optionalBoundedLimit(params.limit);
        return withoutCoordinates((await withAttestedPage(this.lease, (cdp) => guardedDom(cdp, this.lease, {
          kind: "dom_snapshot", includeText, limit,
        }))).value);
      }
      case "browser.links": {
        const params = exactObject(rawParams, ["limit"]);
        const limit = optionalBoundedLimit(params.limit);
        return (await withAttestedPage(this.lease, (cdp) => guardedDom(cdp, this.lease, { kind: "links", limit }))).value;
      }
      case "browser.query_selector": {
        const params = exactObject(rawParams, ["selector", "limit"]);
        const selector = boundedString(params.selector, "selector", MAX_SELECTOR_BYTES);
        const limit = optionalBoundedLimit(params.limit);
        this.selectorQueryReceipts.clear();
        const documentNonce = randomUUID();
        const result = await withAttestedPage(this.lease, async (cdp, _target, before) => {
          const contextId = await selectorIsolatedWorld(cdp, this.lease, before);
          return guardedDom(cdp, this.lease, {
            kind: "query_visible_selector", selector, limit, documentNonce,
          }, contextId);
        });
        if (result.before.documentIdentity !== result.document.documentIdentity) {
          throw rpcError("Browser RPC query crossed a document boundary");
        }
        const value = withoutCoordinates(result.value) as Record<string, unknown>;
        const queryToken = this.issueSelectorQueryReceipt({
          documentIdentity: result.document.documentIdentity,
          documentNonce,
          selector,
          elements: selectorQueryElements(value),
        });
        return { ...value, queryToken };
      }
      case "browser.click_selector": {
        const params = exactObject(rawParams, ["selector", "index", "expectedName", "queryToken"]);
        const selector = boundedString(params.selector, "selector", MAX_SELECTOR_BYTES);
        const index = optionalBoundedIndex(params.index) ?? 0;
        const expectedName = boundedString(params.expectedName, "expected element name", MAX_EXPECTED_ELEMENT_NAME_BYTES);
        const queryToken = boundedString(params.queryToken, "selector query receipt", 128);
        const receipt = this.consumeSelectorQueryReceipt(queryToken);
        this.selectorQueryReceipts.clear();
        const observed = receipt.elements[index];
        const eligible = receipt.elements.filter((element) => element.name === expectedName && element.visible && !element.disabled);
        if (receipt.selector !== selector || !observed || observed.name !== expectedName || observed.disabled
          || eligible.length !== 1 || eligible[0] !== observed) {
          throw rpcError("Browser RPC selector query receipt does not authorize this action");
        }
        return (await withAttestedPage(this.lease, async (cdp, _target, before) => {
          if (before.documentIdentity !== receipt.documentIdentity) {
            throw rpcError("Browser RPC selector query receipt is stale");
          }
          const contextId = await selectorIsolatedWorld(cdp, this.lease, before);
          return guardedDom(cdp, this.lease, {
            kind: "activate_selector", selector, index, expectedName, documentNonce: receipt.documentNonce,
          }, contextId);
        })).value;
      }
      case "browser.fill_selector": {
        const params = exactObject(rawParams, ["selector", "text", "index"]);
        const selector = boundedString(params.selector, "selector", MAX_SELECTOR_BYTES);
        this.selectorQueryReceipts.clear();
        const text = boundedString(params.text, "public text", MAX_PUBLIC_TEXT_BYTES, true);
        const index = optionalBoundedIndex(params.index) ?? 0;
        return (await withAttestedPage(this.lease, (cdp) => guardedDom(cdp, this.lease, {
          kind: "fill_selector", selector, text, index,
        }))).value;
      }
      case "browser.type_public": {
        const params = exactObject(rawParams, ["text"]);
        const text = boundedString(params.text, "public text", MAX_PUBLIC_TEXT_BYTES, true);
        this.selectorQueryReceipts.clear();
        return (await withAttestedPage(this.lease, async (cdp) => {
          await guardedDom(cdp, this.lease, { kind: "public_active_target" });
          await guardedSend(cdp, () => this.lease.assertAuthorized(), "Input.insertText", { text });
          return { typed: true };
        })).value;
      }
      case "browser.downloads.list": {
        exactObject(rawParams, []);
        await this.lease.assertAuthorized();
        const result: ProtectedAutomationBrowserDownloadListResult = {
          downloads: this.lease.downloads.listCompleted().map(({ handle, sizeBytes }) => ({ handle, sizeBytes })),
        };
        return result;
      }
      case "browser.downloads.materialize": {
        const params = exactObject(rawParams, ["handle", "name"]);
        const handle = boundedString(params.handle, "download handle", 256);
        const name = boundedString(params.name, "download name", 255);
        if (!this.lease.runRoot) throw rpcError("Browser RPC run incoming directory is unavailable");
        const result: ProtectedAutomationBrowserMaterializedDownloadResult = this.lease.downloads.materialize(
          handle, name, this.lease.runRoot,
        );
        await this.lease.assertAuthorized();
        return result;
      }
      case "browser.needs_user": {
        const params = exactObject(rawParams, ["reason"]);
        const reason = boundedString(params.reason, "attention reason", 128) as ProtectedAutomationAttentionReason;
        if (!(PROTECTED_AUTOMATION_ATTENTION_REASONS as readonly string[]).includes(reason)) {
          throw rpcError("Browser RPC attention reason is invalid");
        }
        throw new ProtectedAutomationNeedsUserError(reason);
      }
    }
  }

  close(): Promise<void> {
    this.selectorQueryReceipts.clear();
    return this.lease.close();
  }
}
