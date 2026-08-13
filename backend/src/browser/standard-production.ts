import * as path from "node:path";
import type { ChromeTarget } from "./cdp.js";
import {
  ManagedChromiumRuntime,
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

export interface StandardManagedChromiumPort {
  readonly running: boolean;
  start(authorize?: () => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  listPageTargets(): Promise<ChromeTarget[]>;
  createPageTarget(url?: string): Promise<ChromeTarget>;
  closePageTarget(targetId: string): Promise<void>;
  attachTargetCdpViewer(targetId: string): Promise<ManagedChromiumPageAttachment>;
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
        const redact = (input: unknown) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(input ?? ""));
        value = { nodes: (Array.isArray(tree?.nodes) ? tree.nodes : []).filter((node: any) => !node.ignored).slice(0, limit).map((node: any) => ({ role: node.role?.value, name: redact(node.name?.value), value: redact(node.value?.value), description: redact(node.description?.value) })) };
        break;
      }
      default:
        throw new Error("Standard browser operation is unavailable");
    }
    const after = await settledTopLevelDocument(cdp, target, authorize, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    if (!isProtectedBrowserAllowedTopLevelUrl(after.topLevelUrl) && after.topLevelUrl !== "about:blank") {
      throw new Error("Standard browser reached a forbidden top-level document");
    }
    await authorize();
    if (operation.kind === "navigate" && value && typeof value === "object") value = { ...value, url: after.topLevelUrl, title: after.title };
    return protection.redact(value);
  } finally { attachment.close(); }
}

export function createStandardBrowserHostBackendFactory(options: {
  dataDir: string;
  managedFactory?: (options: ManagedChromiumRuntimeOptions) => StandardManagedChromiumPort;
}): StandardBrowserHostBackendFactory {
  const managedFactory = options.managedFactory ?? ((runtimeOptions) => new ManagedChromiumRuntime(runtimeOptions));
  return ({ profile, storage, callbacks }): StandardBrowserHostBackend => {
    const protections = new Map<string, ProtectedCredentialProtection>();
    let managed!: StandardManagedChromiumPort;
    managed = managedFactory({
      profileDir: storage.root,
      downloadsDir: path.join(options.dataDir, "browser-profiles", "v1", "download-staging", profile.id),
      downloadBehavior: "allowAndName",
      workingDirectory: options.dataDir,
      onTargetCreated: (target) => callbacks.targetCreated(publicTarget(target)),
      onTargetChanged: (target) => callbacks.targetChanged(publicTarget(target)),
      onTargetDestroyed: (targetId) => { protections.delete(targetId); callbacks.targetDestroyed(targetId); },
      onUnexpectedExit: callbacks.unexpectedExit,
    });
    return {
      get running() { return managed.running; },
      start: (authorize) => managed.start(authorize),
      stop: () => managed.stop(),
      listTargets: async () => (await managed.listPageTargets()).map(publicTarget),
      createTarget: async (url) => publicTarget(await managed.createPageTarget(url)),
      closeTarget: (targetId) => managed.closePageTarget(targetId),
      execute: (targetId, operation, authorize) => {
        let protection = protections.get(targetId);
        if (!protection) { protection = new ProtectedCredentialProtection(); protections.set(targetId, protection); }
        return executeExactTargetOperation(managed, targetId, operation, authorize, protection);
      },
    };
  };
}
