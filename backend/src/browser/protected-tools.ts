import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CapabilityBoundProtectedBrowser } from "./protected-browser.js";
import type { ProtectedBrowserOperation } from "./types.js";

export const PROTECTED_BROWSER_TOOL_NAME = "protected_browser";

export interface ProtectedBrowserToolRuntime {
  readonly tool: ToolDefinition;
  readonly browser: CapabilityBoundProtectedBrowser;
  preflight(): { allowed: true } | { allowed: false; reason: string };
  close(): Promise<void>;
}

const Parameters = Type.Union([
  Type.Object({ operation: Type.Literal("status") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("start") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("stop") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("navigate"), url: Type.String() }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("snapshot"), mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("screenshot")])) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("dom_snapshot"), includeText: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("links"), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("accessibility"), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("query_selector"), selector: Type.String(), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("click"), x: Type.Number(), y: Type.Number() }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("click_selector"), selector: Type.String(), index: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("fill_selector"), selector: Type.String(), text: Type.String(), index: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("type_public"), text: Type.String() }, { additionalProperties: false }),
]);

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

function browserOperation(value: Record<string, unknown>): ProtectedBrowserOperation {
  const { operation, ...parameters } = value;
  return { kind: operation, ...parameters } as ProtectedBrowserOperation;
}

/** Backend-owned actual-usecase composition: one exact protected browser plus
 * its exact download publication service. No global registry or provider/name
 * predicate participates in authority. */
export function createProtectedBrowserToolRuntime(options: {
  browser: CapabilityBoundProtectedBrowser;
}): ProtectedBrowserToolRuntime {
  let revoked = false;
  const deny = async (error: unknown): Promise<never> => {
    revoked = true;
    await Promise.allSettled([options.browser.revoke()]);
    throw error instanceof Error ? error : new Error("Protected browser operation failed");
  };
  const preflight = () => revoked || options.browser.isRevoked
    ? { allowed: false as const, reason: "Protected browser runtime is revoked" }
    : { allowed: true as const };

  const tool = defineTool({
    name: PROTECTED_BROWSER_TOOL_NAME,
    label: "Protected Browser",
    description: "Operate the exact capability-authorized Protected browser. Browser downloads are ordinary project files; authentication and secret entry remain human-only.",
    promptSnippet: "Use the exact Protected browser runtime",
    promptGuidelines: [
      "Use ordinary browser operations only; no private API or provider-specific semantics are available.",
      "Browser downloads save directly under the current project at .wayang/browser-downloads/ and may be managed as ordinary files.",
      "Never request credentials in chat or tool parameters; hand secret-bearing steps to the human viewer.",
    ],
    parameters: Parameters,
    async execute(_toolCallId, raw) {
      if (!preflight().allowed) throw new Error("Protected browser runtime is revoked");
      const value = raw as Record<string, unknown> & { operation: string };
      try {
        return textResult(await options.browser.execute(browserOperation(value)));
      } catch (error) {
        return deny(error);
      }
    },
  });

  return {
    tool,
    browser: options.browser,
    preflight,
    async close() {
      revoked = true;
      await Promise.allSettled([options.browser.close()]);
    },
  };
}
