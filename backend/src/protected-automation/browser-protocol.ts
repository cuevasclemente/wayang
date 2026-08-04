/** Child-visible download results deliberately omit browser filename, source URL/origin, profile, and GUID metadata. */
export interface ProtectedAutomationBrowserDownloadResult {
  handle: string;
  sizeBytes: number;
}

export interface ProtectedAutomationBrowserDownloadListResult {
  downloads: ProtectedAutomationBrowserDownloadResult[];
}

export interface ProtectedAutomationBrowserMaterializedDownloadResult {
  name: string;
  sizeBytes: number;
  sha256: string;
}

/** Exact, bounded FD3 method vocabulary. Parameters are validated by browser-rpc.ts. */
export const PROTECTED_AUTOMATION_BROWSER_RPC_METHODS = [
  "browser.status",
  "browser.navigate",
  "browser.snapshot",
  "browser.dom_snapshot",
  "browser.links",
  "browser.query_selector",
  "browser.click_selector",
  "browser.fill_selector",
  "browser.type_public",
  "browser.downloads.list",
  "browser.downloads.materialize",
  "browser.needs_user",
] as const;

export type ProtectedAutomationBrowserRpcMethod = typeof PROTECTED_AUTOMATION_BROWSER_RPC_METHODS[number];

const METHOD_SET = new Set<string>(PROTECTED_AUTOMATION_BROWSER_RPC_METHODS);

export function isProtectedAutomationBrowserRpcMethod(value: string): value is ProtectedAutomationBrowserRpcMethod {
  return METHOD_SET.has(value);
}
