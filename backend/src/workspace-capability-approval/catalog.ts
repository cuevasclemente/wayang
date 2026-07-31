import type { WorkspaceCapabilityId, WorkspacePrivacyMode } from "./types.js";

export interface CompiledWorkspaceCapability {
  id: WorkspaceCapabilityId;
  compatiblePrivacyMode: WorkspacePrivacyMode;
  title: string;
  riskSummary: string;
  consequences: readonly string[];
}

const CAPABILITIES: Readonly<Record<WorkspaceCapabilityId, CompiledWorkspaceCapability>> = Object.freeze({
  "wayang.standard-resources.v1": Object.freeze({
    id: "wayang.standard-resources.v1",
    compatiblePrivacyMode: "standard",
    title: "Standard resources",
    riskSummary: "Loads reviewed global resources for this exact Project-Agent Profile association.",
    consequences: Object.freeze([
      "Global resources may expose authority and data outside the project-only resource set.",
      "The association applies across runtime implementation changes and only to fresh authorized runtime handles.",
    ]),
  }),
  "wayang.host-execution.v1": Object.freeze({
    id: "wayang.host-execution.v1",
    compatiblePrivacyMode: "standard",
    title: "Host execution",
    riskSummary: "Allows eligible fresh interactive runtimes to execute with the Wayang OS user's host authority.",
    consequences: Object.freeze([
      "Host execution bypasses the project filesystem sandbox and can affect same-UID files, processes, credentials, and services.",
      "Scheduling, subagents, Protected projects, and stale runtime handles remain denied independently.",
    ]),
  }),
  "wayang.protected-browser.v1": Object.freeze({
    id: "wayang.protected-browser.v1",
    compatiblePrivacyMode: "protected",
    title: "Protected browser",
    riskSummary: "Allows broad agent-controlled HTTPS browsing in isolated Protected project/profile storage.",
    consequences: Object.freeze([
      "The agent may navigate, click, type public non-secret text, download files, and cause remote mutations or network egress.",
      "Authenticated cookies can enable purchases, deletions, settings changes, exports, logout, or browser-mediated passkey flows.",
      "Passwords, MFA, CAPTCHA, payments, recovery, and other sensitive input remain human-controlled, but later agent actions are not read-only.",
      "Completed published downloads become ordinary untrusted project files governed by normal project/profile policy.",
    ]),
  }),
});

export function isWorkspaceCapabilityId(value: unknown): value is WorkspaceCapabilityId {
  return typeof value === "string" && Object.hasOwn(CAPABILITIES, value);
}

export function compiledCapability(id: WorkspaceCapabilityId): CompiledWorkspaceCapability {
  return CAPABILITIES[id];
}

export function capabilityCatalog(): readonly CompiledWorkspaceCapability[] {
  return Object.values(CAPABILITIES);
}
