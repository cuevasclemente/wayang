import type { WorkspaceCapabilityId, WorkspacePrivacyMode } from "./types.js";

export interface CompiledWorkspaceCapability {
  id: WorkspaceCapabilityId;
  compatiblePrivacyMode: WorkspacePrivacyMode;
  activationAvailable: boolean;
  title: string;
  riskSummary: string;
  consequences: readonly string[];
}

const CAPABILITIES: Readonly<Record<WorkspaceCapabilityId, CompiledWorkspaceCapability>> = Object.freeze({
  "wayang.standard-resources.v1": Object.freeze({
    id: "wayang.standard-resources.v1",
    compatiblePrivacyMode: "standard",
    activationAvailable: true,
    title: "Standard resources",
    riskSummary: "Loads reviewed global resources for this exact Project-Agent Profile association.",
    consequences: Object.freeze([
      "Global resources may expose authority and data outside the project-only resource set.",
      "The association applies across runtime implementation changes and only to fresh authorized runtime handles.",
    ]),
  }),
  "wayang.standard-browser.v1": Object.freeze({
    id: "wayang.standard-browser.v1",
    compatiblePrivacyMode: "standard",
    activationAvailable: true,
    title: "Standard browser",
    riskSummary: "Allows broad agent-controlled browsing in a managed browser for this exact Standard Project-Agent association.",
    consequences: Object.freeze([
      "The agent may navigate, inspect pages, click, type public non-secret text, download files, and cause remote mutations or network egress.",
      "Authenticated cookies can enable purchases, deletions, settings changes, exports, logout, or browser-mediated passkey flows.",
      "Passwords, MFA, CAPTCHA, payments, recovery, and other sensitive input remain human-controlled, but later agent actions are not read-only.",
      "Completed bounded downloads become ordinary untrusted project files governed by normal project/profile policy.",
    ]),
  }),
  "wayang.host-execution.v1": Object.freeze({
    id: "wayang.host-execution.v1",
    compatiblePrivacyMode: "standard",
    activationAvailable: true,
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
    activationAvailable: true,
    title: "Protected browser",
    riskSummary: "Allows broad agent-controlled HTTPS browsing in isolated Protected project/profile storage.",
    consequences: Object.freeze([
      "The agent may navigate, click, type public non-secret text, download files, and cause remote mutations or network egress.",
      "Authenticated cookies can enable purchases, deletions, settings changes, exports, logout, or browser-mediated passkey flows.",
      "Passwords, MFA, CAPTCHA, payments, recovery, and other sensitive input remain human-controlled, but later agent actions are not read-only.",
      "Completed published downloads become ordinary untrusted project files governed by normal project/profile policy.",
    ]),
  }),
  "wayang.protected-automation.v1": Object.freeze({
    id: "wayang.protected-automation.v1",
    compatiblePrivacyMode: "protected",
    activationAvailable: true,
    title: "Protected automation",
    riskSummary: "Allows persistent deterministic jobs to write throughout the exact Protected project and act through an authenticated browser at configured HTTPS origins.",
    consequences: Object.freeze([
      "Scheduled Node code runs without a shell and may read or persist writes throughout the exact Protected project; completed or racing project writes cannot be rolled back by revocation.",
      "The child has no generic TCP, UDP, or Unix-socket network access; website effects pass only through backend-owned browser RPC at configured HTTPS origins.",
      "Authenticated browser state can disclose page or job data and cause consequential remote account changes at those configured origins.",
      "Passwords, MFA, CAPTCHA, payments, recovery, and other secret-bearing steps remain human-only and must never enter job arguments, chat, or tool input.",
      "This cooperative boundary does not isolate the automation from other same-UID processes or trusted in-process code.",
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
  return Object.values(CAPABILITIES).filter((capability) => capability.activationAvailable);
}
