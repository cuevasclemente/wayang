import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineTool, truncateHead, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentLeaseDetachReason,
  BrowserAuthorityRevokeReason,
  CapabilityBoundInteractiveBrowserToolRuntime,
  SessionWorkspaceCloseReason,
} from "./interactive-runtime.js";
import type { ProtectedBrowserBinding, ProtectedBrowserOperation } from "./types.js";
import type { SessionBrowserStateRow } from "./profile-catalog-store.js";
import type { StandardBrowserProfileHostService, StandardBrowserRuntimeWorkspace } from "./standard-service.js";

export interface StandardBrowserSessionRuntime extends CapabilityBoundInteractiveBrowserToolRuntime {
  readonly kind: "standard";
  latchRevoked(): void;
}

function textResult(value: unknown) {
  const serialized = JSON.stringify(value);
  const truncated = truncateHead(serialized, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return {
    content: [{ type: "text" as const, text: truncated.content + (truncated.truncated ? "\n\n[Browser tool output truncated.]" : "") }],
    details: { truncated: truncated.truncated },
  };
}

const Empty = Type.Object({}, { additionalProperties: false });

export function createStandardBrowserSessionRuntime(options: {
  service: StandardBrowserProfileHostService;
  binding: Readonly<ProtectedBrowserBinding>;
  initialState: SessionBrowserStateRow;
}): StandardBrowserSessionRuntime {
  let revoked = false;
  let state = structuredClone(options.initialState);
  let workspace = options.service.attachWorkspace(options.binding, state);
  let profileChoices = new Map<string, { profileId: string; catalogGeneration: number }>();

  const assertLive = () => {
    if (revoked) throw new Error("Standard Browser Profile runtime is revoked");
  };
  const ensureWorkspace = (): StandardBrowserRuntimeWorkspace => {
    assertLive();
    if (!workspace) workspace = options.service.attachWorkspace(options.binding, state);
    if (!workspace) throw new Error("This session has no active Browser Profile; list and switch profiles first");
    return options.service.resolveWorkspace(options.binding, workspace);
  };
  const execute = async (operation: ProtectedBrowserOperation): Promise<unknown> => {
    assertLive();
    if (operation.kind === "status" && !workspace) {
      return { configured: false, activeProfile: null, sourceSessionId: options.binding.sourceSessionId };
    }
    const exact = ensureWorkspace();
    return exact.host.execute(options.binding, exact.workspaceGeneration, operation);
  };
  const operationTool = (input: {
    name: string;
    label: string;
    description: string;
    parameters: any;
    operation(raw: Record<string, unknown>): ProtectedBrowserOperation;
  }): ToolDefinition => defineTool({
    name: input.name,
    label: input.label,
    description: input.description,
    parameters: input.parameters,
    async execute(_id, raw) { return textResult(await execute(input.operation(raw as Record<string, unknown>))); },
  });

  const tools: ToolDefinition[] = [
    operationTool({ name: "browser_status", label: "Browser Status", description: "Return bounded state for this session's active Browser Profile workspace.", parameters: Empty, operation: () => ({ kind: "status" }) }),
    defineTool({
      name: "browser_open", label: "Open Browser", description: "Start this session's active Browser Profile workspace and optionally navigate to an absolute HTTPS URL.",
      parameters: Type.Object({ url: Type.Optional(Type.String()) }, { additionalProperties: false }),
      async execute(_id, raw) {
        const opened = await execute({ kind: "start" });
        const url = (raw as { url?: unknown }).url;
        return textResult(typeof url === "string" && url ? await execute({ kind: "navigate", url }) : opened);
      },
    }),
    operationTool({ name: "browser_navigate", label: "Navigate Browser", description: "Navigate the active owned tab to an absolute HTTPS URL.", parameters: Type.Object({ url: Type.String() }, { additionalProperties: false }), operation: (raw) => ({ kind: "navigate", url: String(raw.url ?? "") }) }),
    operationTool({ name: "browser_snapshot", label: "Browser Snapshot", description: "Read a bounded text or screenshot snapshot from the active owned tab.", parameters: Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("screenshot")])) }, { additionalProperties: false }), operation: (raw) => ({ kind: "snapshot", ...(raw.mode ? { mode: raw.mode as "text" | "screenshot" } : {}) }) }),
    operationTool({ name: "browser_dom_snapshot", label: "Browser DOM Snapshot", description: "Inspect bounded visible controls and optional text in the active owned tab.", parameters: Type.Object({ includeText: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }), operation: (raw) => ({ kind: "dom_snapshot", includeText: Boolean(raw.includeText), ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) }) }),
    operationTool({ name: "browser_query_selector", label: "Query Browser Selector", description: "Query visible elements in the active owned tab.", parameters: Type.Object({ selector: Type.String(), limit: Type.Optional(Type.Number()) }, { additionalProperties: false }), operation: (raw) => ({ kind: "query_selector", selector: String(raw.selector ?? ""), ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) }) }),
    operationTool({ name: "browser_click_selector", label: "Click Browser Selector", description: "Click one visible CSS-selected element in the active owned tab.", parameters: Type.Object({ selector: Type.String(), index: Type.Optional(Type.Number()) }, { additionalProperties: false }), operation: (raw) => ({ kind: "click_selector", selector: String(raw.selector ?? ""), ...(raw.index === undefined ? {} : { index: Number(raw.index) }) }) }),
    operationTool({ name: "browser_fill_selector", label: "Fill Browser Selector", description: "Fill one non-sensitive field with public text; secrets remain human-only.", parameters: Type.Object({ selector: Type.String(), text: Type.String(), index: Type.Optional(Type.Number()) }, { additionalProperties: false }), operation: (raw) => ({ kind: "fill_selector", selector: String(raw.selector ?? ""), text: String(raw.text ?? ""), ...(raw.index === undefined ? {} : { index: Number(raw.index) }) }) }),
    operationTool({ name: "browser_extract_links", label: "Extract Browser Links", description: "Return bounded visible links from the active owned tab.", parameters: Type.Object({ limit: Type.Optional(Type.Number()) }, { additionalProperties: false }), operation: (raw) => ({ kind: "links", ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) }) }),
    operationTool({ name: "browser_accessibility_snapshot", label: "Browser Accessibility Snapshot", description: "Read a bounded accessibility tree from the active owned tab.", parameters: Type.Object({ limit: Type.Optional(Type.Number()) }, { additionalProperties: false }), operation: (raw) => ({ kind: "accessibility", ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) }) }),
    operationTool({ name: "browser_click", label: "Click Browser Coordinates", description: "Click absolute viewport coordinates in the active owned tab.", parameters: Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false }), operation: (raw) => ({ kind: "click", x: Number(raw.x), y: Number(raw.y) }) }),
    operationTool({ name: "browser_type_public", label: "Type Public Browser Text", description: "Type non-secret public text in the active owned tab; never use for passwords, MFA, CAPTCHA, payment, or recovery.", parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }), operation: (raw) => ({ kind: "type_public", text: String(raw.text ?? "") }) }),
    defineTool({
      name: "browser_wait_for_user", label: "Wait For Browser User", description: "Pause only this session workspace for human login, MFA, CAPTCHA, payment, booking, account changes, deletion, or another sensitive step.",
      parameters: Type.Object({ reason: Type.String() }, { additionalProperties: false }),
      async execute(_id, raw) {
        const reason = String((raw as { reason?: unknown }).reason ?? "");
        if (!reason || Buffer.byteLength(reason, "utf8") > 2048) throw new Error("Browser handoff reason is invalid");
        const exact = ensureWorkspace();
        await exact.host.ownerSetControlMode(options.binding.sourceSessionId, exact.workspaceGeneration, "paused");
        return textResult({ needsUser: true, reason, controlMode: "paused" });
      },
    }),
    defineTool({
      name: "browser_resume_status", label: "Browser Resume Status", description: "Check whether the authenticated owner returned this workspace to agent control.", parameters: Empty,
      async execute() {
        const exact = ensureWorkspace();
        const publicState = exact.host.publicState(options.binding, exact.workspaceGeneration);
        return textResult({ controlMode: publicState.controlMode, resumed: publicState.controlMode === "agent" });
      },
    }),
    defineTool({
      name: "browser_list_tabs", label: "List Browser Tabs", description: "List only this session workspace's owned tabs using opaque choices.", parameters: Empty,
      async execute() { const exact = ensureWorkspace(); return textResult(await exact.host.listTabs(options.binding, exact.workspaceGeneration)); },
    }),
    defineTool({
      name: "browser_open_tab", label: "Open Browser Tab", description: "Open a new owned tab in this session workspace.", parameters: Type.Object({ url: Type.Optional(Type.String()) }, { additionalProperties: false }),
      async execute(_id, raw) { const exact = ensureWorkspace(); return textResult(await exact.host.openTab(options.binding, exact.workspaceGeneration, String((raw as any).url ?? "about:blank"))); },
    }),
    defineTool({
      name: "browser_select_tab", label: "Select Browser Tab", description: "Select one opaque tab choice owned by this session workspace.", parameters: Type.Object({ tab: Type.String() }, { additionalProperties: false }),
      async execute(_id, raw) { const exact = ensureWorkspace(); return textResult(exact.host.selectTab(options.binding, exact.workspaceGeneration, String((raw as any).tab ?? ""))); },
    }),
    defineTool({
      name: "browser_close_tab", label: "Close Browser Tab", description: "Close one opaque tab choice owned by this session workspace.", parameters: Type.Object({ tab: Type.String() }, { additionalProperties: false }),
      async execute(_id, raw) { const exact = ensureWorkspace(); const result = await exact.host.closeTab(options.binding, exact.workspaceGeneration, String((raw as any).tab ?? "")); if (!result) workspace = null; return textResult(result ?? { closed: true }); },
    }),
    defineTool({
      name: "browser_list_profiles", label: "List Browser Profiles", description: "List every active named Standard Browser Profile available under this capability using runtime-bound opaque choices.", parameters: Empty,
      async execute() {
        assertLive();
        const snapshot = options.service.listProfiles(options.binding);
        profileChoices = new Map();
        const profiles = snapshot.profiles.map((profile) => {
          const choice = randomUUID();
          profileChoices.set(choice, { profileId: profile.id, catalogGeneration: snapshot.generation });
          return { profile: choice, name: profile.name };
        });
        return textResult({ profiles, sharedAuthenticatedState: true, catalogGeneration: snapshot.generation });
      },
    }),
    defineTool({
      name: "browser_switch_profile", label: "Switch Browser Profile", description: "Switch only this durable session's active Browser Profile; retained workspaces in other profiles remain bounded and session-owned.", parameters: Type.Object({ profile: Type.String() }, { additionalProperties: false }),
      async execute(_id, raw) {
        assertLive();
        const choice = profileChoices.get(String((raw as any).profile ?? ""));
        const currentCatalog = options.service.listProfiles(options.binding);
        if (!choice || choice.catalogGeneration !== currentCatalog.generation
          || !currentCatalog.profiles.some((profile) => profile.id === choice.profileId)) throw new Error("Browser Profile choice is stale");
        const switched = options.service.switchProfile(options.binding, workspace, choice.profileId, state.revision);
        state = switched.state;
        workspace = switched.workspace;
        profileChoices.clear();
        return textResult(options.service.workspaceState(options.binding, workspace));
      },
    }),
    defineTool({
      name: "browser_set_project_default_profile", label: "Set Project Browser Default", description: "Set this exact current Project's default Browser Profile for future or unassigned sessions only.",
      parameters: Type.Object({ profile: Type.String(), expectedRevision: Type.Optional(Type.Number()) }, { additionalProperties: false }),
      async execute(_id, raw) {
        assertLive();
        const choice = profileChoices.get(String((raw as any).profile ?? ""));
        const currentCatalog = options.service.listProfiles(options.binding);
        if (!choice || choice.catalogGeneration !== currentCatalog.generation
          || !currentCatalog.profiles.some((profile) => profile.id === choice.profileId)) throw new Error("Browser Profile choice is stale");
        const supplied = (raw as any).expectedRevision;
        const current = options.service.projectDefault(options.binding.projectId);
        const expected = supplied === undefined ? current?.revision ?? null : Number(supplied);
        return textResult(options.service.setProjectDefault(options.binding, choice.profileId, expected));
      },
    }),
    defineTool({
      name: "browser_close_workspace", label: "Close Browser Workspace", description: "Close every owned tab in this session's active Browser Profile workspace without deleting shared profile state.", parameters: Empty,
      async execute() { const exact = ensureWorkspace(); await exact.host.closeWorkspace(options.binding.sourceSessionId, "tool"); workspace = null; return textResult({ closed: true }); },
    }),
    defineTool({
      name: "browser_close_all_workspaces", label: "Close All Browser Workspaces", description: "Close this source session's workspaces across every Browser Profile without affecting another session or deleting profile state.", parameters: Empty,
      async execute() { await options.service.closeSessionWorkspaces(options.binding.sourceSessionId, "owner_close_all"); workspace = null; return textResult({ closed: true, allProfiles: true }); },
    }),
    defineTool({
      name: "browser_close", label: "Close Browser Workspace", description: "Compatibility alias that closes this session's active Browser Profile workspace only.", parameters: Empty,
      async execute() { const exact = ensureWorkspace(); await exact.host.closeWorkspace(options.binding.sourceSessionId, "tool"); workspace = null; return textResult({ closed: true }); },
    }),
  ];

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let teardown: Promise<void> | null = null;
  const latchRevoked = () => { revoked = true; };
  const runtime: StandardBrowserSessionRuntime = {
    kind: "standard",
    binding: options.binding,
    tools: Object.freeze([...tools]),
    toolForName: (name) => byName.get(name),
    preflight: () => {
      if (revoked) return { allowed: false, reason: "Standard Browser Profile runtime is revoked" };
      try {
        options.service.listProfiles(options.binding);
        if (workspace) options.service.resolveWorkspace(options.binding, workspace);
        return { allowed: true };
      } catch { return { allowed: false, reason: "Standard Browser Profile authority is unavailable" }; }
    },
    latchRevoked,
    async detachAgentLease(_reason: AgentLeaseDetachReason) {
      latchRevoked();
      if (workspace) await workspace.host.detachAgentLease(options.binding.sourceSessionId, options.binding.runtimeGeneration);
      options.service.runtimeDetached(runtime);
    },
    closeSessionWorkspaces(reason: SessionWorkspaceCloseReason) {
      latchRevoked();
      teardown ??= options.service.closeSessionWorkspaces(options.binding.sourceSessionId, reason);
      options.service.runtimeDetached(runtime);
      return teardown;
    },
    revokeAuthority(_reason: BrowserAuthorityRevokeReason) {
      latchRevoked();
      teardown ??= options.service.closeSessionWorkspaces(options.binding.sourceSessionId, "owner_close_all");
      options.service.runtimeDetached(runtime);
      return teardown;
    },
  };
  return runtime;
}
