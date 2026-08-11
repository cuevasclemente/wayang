import { Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { CapabilityBoundProtectedBrowser } from "./protected-browser.js";
import type { ProtectedBrowserOperation } from "./types.js";

/** Historical single-tool name retained only so stale registries can be removed. */
export const PROTECTED_BROWSER_TOOL_NAME = "protected_browser";

export const INTERACTIVE_BROWSER_TOOL_NAMES = Object.freeze([
  "browser_status",
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_dom_snapshot",
  "browser_query_selector",
  "browser_click_selector",
  "browser_fill_selector",
  "browser_extract_links",
  "browser_accessibility_snapshot",
  "browser_click",
  "browser_type_public",
  "browser_wait_for_user",
  "browser_resume_status",
  "browser_close",
] as const);

export type InteractiveBrowserToolName = typeof INTERACTIVE_BROWSER_TOOL_NAMES[number];

export interface ProtectedBrowserToolRuntime {
  readonly tools: readonly ToolDefinition[];
  readonly browser: CapabilityBoundProtectedBrowser;
  toolForName(name: string): ToolDefinition | undefined;
  preflight(): { allowed: true } | { allowed: false; reason: string };
  close(): Promise<void>;
}

const EmptyParameters = Type.Object({}, { additionalProperties: false });

function textResult(value: unknown) {
  const serialized = JSON.stringify(value);
  const truncated = truncateHead(serialized, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const suffix = truncated.truncated
    ? `\n\n[Browser tool output truncated to ${DEFAULT_MAX_BYTES} bytes / ${DEFAULT_MAX_LINES} lines.]`
    : "";
  return {
    content: [{ type: "text" as const, text: `${truncated.content}${suffix}` }],
    details: { truncated: truncated.truncated },
  };
}

function operationTool(options: {
  name: InteractiveBrowserToolName;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: any;
  operation(params: Record<string, unknown>): ProtectedBrowserOperation;
  execute(operation: ProtectedBrowserOperation): Promise<unknown>;
}): ToolDefinition {
  return defineTool({
    name: options.name,
    label: options.label,
    description: options.description,
    promptSnippet: options.promptSnippet,
    promptGuidelines: options.promptGuidelines,
    parameters: options.parameters,
    async execute(_toolCallId, raw) {
      return textResult(await options.execute(options.operation(raw as Record<string, unknown>)));
    },
  });
}

/** Backend-owned actual-usecase composition. Every explicit browser tool closes
 * over one exact capability-bound runtime; no extension, provider, model, cwd,
 * or caller-selected target participates in authority. */
export function createProtectedBrowserToolRuntime(options: {
  browser: CapabilityBoundProtectedBrowser;
}): ProtectedBrowserToolRuntime {
  let revoked = false;
  const deny = async (error: unknown): Promise<never> => {
    revoked = true;
    await Promise.allSettled([options.browser.revoke()]);
    throw error instanceof Error ? error : new Error("Interactive browser operation failed");
  };
  const preflight = () => revoked || options.browser.isRevoked
    ? { allowed: false as const, reason: "Interactive browser runtime is revoked" }
    : { allowed: true as const };
  const execute = async (operation: ProtectedBrowserOperation): Promise<unknown> => {
    if (!preflight().allowed) throw new Error("Interactive browser runtime is revoked");
    try {
      return await options.browser.execute(operation);
    } catch (error) {
      return deny(error);
    }
  };

  const tools: ToolDefinition[] = [
    operationTool({
      name: "browser_status",
      label: "Browser Status",
      description: "Return bounded public state for the exact capability-authorized managed browser.",
      promptSnippet: "Inspect the managed browser state",
      promptGuidelines: ["Use browser_status before browser automation when browser process or human-control state is uncertain."],
      parameters: EmptyParameters,
      operation: () => ({ kind: "status" }),
      execute,
    }),
    defineTool({
      name: "browser_open",
      label: "Open Browser",
      description: "Start the exact capability-authorized managed browser and optionally navigate to an absolute HTTPS URL.",
      promptSnippet: "Start the managed browser",
      promptGuidelines: ["Use browser_open for public or user-authorized browser workflows; login and other secret-bearing preparation remain human-only."],
      parameters: Type.Object({ url: Type.Optional(Type.String()) }, { additionalProperties: false }),
      async execute(_toolCallId, raw) {
        const url = (raw as { url?: unknown }).url;
        const started = await execute({ kind: "start" });
        return textResult(typeof url === "string" && url ? await execute({ kind: "navigate", url }) : started);
      },
    }),
    operationTool({
      name: "browser_navigate",
      label: "Navigate Browser",
      description: "Navigate the exact managed browser to an absolute HTTPS URL without embedded credentials.",
      promptSnippet: "Navigate the managed browser",
      parameters: Type.Object({ url: Type.String() }, { additionalProperties: false }),
      operation: (params) => ({ kind: "navigate", url: String(params.url ?? "") }),
      execute,
    }),
    operationTool({
      name: "browser_snapshot",
      label: "Browser Snapshot",
      description: "Read a bounded text or screenshot snapshot from the exact managed browser.",
      promptSnippet: "Inspect the current browser page",
      promptGuidelines: ["Before browser_snapshot, consider whether authenticated page content is appropriate for the active model/provider."],
      parameters: Type.Object({
        mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("screenshot")])),
      }, { additionalProperties: false }),
      operation: (params) => ({ kind: "snapshot", ...(params.mode ? { mode: params.mode as "text" | "screenshot" } : {}) }),
      execute,
    }),
    operationTool({
      name: "browser_dom_snapshot",
      label: "Browser DOM Snapshot",
      description: "Inspect bounded visible controls and optional page text without arbitrary JavaScript.",
      promptSnippet: "Inspect visible browser controls",
      parameters: Type.Object({ includeText: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      operation: (params) => ({ kind: "dom_snapshot", includeText: Boolean(params.includeText), ...(params.limit === undefined ? {} : { limit: Number(params.limit) }) }),
      execute,
    }),
    operationTool({
      name: "browser_query_selector",
      label: "Query Browser Selector",
      description: "Query a bounded number of visible elements using a CSS selector.",
      promptSnippet: "Query browser elements by CSS selector",
      parameters: Type.Object({ selector: Type.String(), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      operation: (params) => ({ kind: "query_selector", selector: String(params.selector ?? ""), ...(params.limit === undefined ? {} : { limit: Number(params.limit) }) }),
      execute,
    }),
    operationTool({
      name: "browser_click_selector",
      label: "Click Browser Selector",
      description: "Click one CSS-selected visible browser element.",
      promptSnippet: "Click a browser element selected by CSS",
      parameters: Type.Object({ selector: Type.String(), index: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      operation: (params) => ({ kind: "click_selector", selector: String(params.selector ?? ""), ...(params.index === undefined ? {} : { index: Number(params.index) }) }),
      execute,
    }),
    operationTool({
      name: "browser_fill_selector",
      label: "Fill Browser Selector",
      description: "Fill one non-sensitive field with public text. Password, MFA, CAPTCHA, payment, recovery, and other secret-bearing fields are rejected.",
      promptSnippet: "Fill a non-sensitive browser field",
      promptGuidelines: ["Never use browser_fill_selector for passwords, TOTP, passkeys, CAPTCHA answers, payment details, recovery codes, or other secrets; use browser_wait_for_user."],
      parameters: Type.Object({ selector: Type.String(), text: Type.String(), index: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      operation: (params) => ({ kind: "fill_selector", selector: String(params.selector ?? ""), text: String(params.text ?? ""), ...(params.index === undefined ? {} : { index: Number(params.index) }) }),
      execute,
    }),
    operationTool({
      name: "browser_extract_links",
      label: "Extract Browser Links",
      description: "Return a bounded list of visible links and generated selectors from the current page.",
      promptSnippet: "Extract visible browser links",
      parameters: Type.Object({ limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      operation: (params) => ({ kind: "links", ...(params.limit === undefined ? {} : { limit: Number(params.limit) }) }),
      execute,
    }),
    operationTool({
      name: "browser_accessibility_snapshot",
      label: "Browser Accessibility Snapshot",
      description: "Read a bounded simplified accessibility tree from the current page.",
      promptSnippet: "Inspect the browser accessibility tree",
      parameters: Type.Object({ limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      operation: (params) => ({ kind: "accessibility", ...(params.limit === undefined ? {} : { limit: Number(params.limit) }) }),
      execute,
    }),
    operationTool({
      name: "browser_click",
      label: "Click Browser Coordinates",
      description: "Click absolute viewport coordinates in the exact managed browser.",
      promptSnippet: "Click browser viewport coordinates",
      promptGuidelines: ["Prefer browser_click_selector over browser_click when a stable visible selector is available."],
      parameters: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
      operation: (params) => ({ kind: "click", x: Number(params.x), y: Number(params.y) }),
      execute,
    }),
    operationTool({
      name: "browser_type_public",
      label: "Type Public Browser Text",
      description: "Type non-secret public text into the currently focused non-sensitive browser field.",
      promptSnippet: "Type non-secret public text into the browser",
      promptGuidelines: ["Never use browser_type_public for passwords, TOTP, passkeys, CAPTCHA answers, payment details, recovery codes, or other secrets; use browser_wait_for_user."],
      parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      operation: (params) => ({ kind: "type_public", text: String(params.text ?? "") }),
      execute,
    }),
    defineTool({
      name: "browser_wait_for_user",
      label: "Wait For Browser User",
      description: "Pause agent browser control so the authenticated owner can handle login, MFA, CAPTCHA, payment, booking, account changes, deletion, or another sensitive/manual step.",
      promptSnippet: "Hand browser control to the user",
      promptGuidelines: ["Use browser_wait_for_user for login, MFA, CAPTCHA, passkeys, payments, bookings, account changes, deletion, and uncertain sensitive steps."],
      parameters: Type.Object({ reason: Type.String() }, { additionalProperties: false }),
      async execute(_toolCallId, raw) {
        if (!preflight().allowed) throw new Error("Interactive browser runtime is revoked");
        const reason = String((raw as { reason?: unknown }).reason ?? "");
        if (!reason || Buffer.byteLength(reason, "utf8") > 2048) throw new Error("Browser handoff reason is required and must be at most 2048 bytes");
        try {
          await options.browser.handoffToUser("paused");
          return textResult({ controlMode: options.browser.mode, needsUser: true, reason });
        } catch (error) {
          return deny(error);
        }
      },
    }),
    defineTool({
      name: "browser_resume_status",
      label: "Browser Resume Status",
      description: "Check whether the authenticated owner has returned browser control to the agent. This tool never resumes control itself.",
      promptSnippet: "Check browser handoff status",
      parameters: EmptyParameters,
      async execute() {
        if (!preflight().allowed) throw new Error("Interactive browser runtime is revoked");
        return textResult({ controlMode: options.browser.mode, resumed: options.browser.mode === "agent" });
      },
    }),
    operationTool({
      name: "browser_close",
      label: "Close Browser",
      description: "Stop the managed browser process without deleting its persistent private profile.",
      promptSnippet: "Stop the managed browser",
      parameters: EmptyParameters,
      operation: () => ({ kind: "stop" }),
      execute,
    }),
  ];

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: Object.freeze([...tools]),
    browser: options.browser,
    toolForName(name) { return byName.get(name); },
    preflight,
    async close() {
      revoked = true;
      await Promise.allSettled([options.browser.close()]);
    },
  };
}
