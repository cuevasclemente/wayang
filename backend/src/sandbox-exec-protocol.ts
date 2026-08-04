import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export type SandboxNetworkMode = "allow_all_proxy" | "deny_all";

export interface SandboxExecRequest {
  command: string;
  cwd: string;
  config: SandboxRuntimeConfig;
  networkMode: SandboxNetworkMode;
}
