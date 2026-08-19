import * as fs from "node:fs";
import * as path from "node:path";
import { legacyAgentActivationPaths, resetLegacyAgentActivationCacheForTests } from "./legacy-agent-activation.js";
import { WREN_AGENT_PROFILE_ID } from "./workspace-types.js";

const SYNTHETIC_DEPLOYMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Synthetic test helper; never targets the operator's real configuration. */
export function installSyntheticLegacyAgentActivation(configHome: string): () => void {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.resolve(configHome);
  resetLegacyAgentActivationCacheForTests();
  const paths = legacyAgentActivationPaths();
  fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.deploymentIdPath, `${SYNTHETIC_DEPLOYMENT_ID}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.activationPath, `${JSON.stringify({
    schema_version: 1,
    deployment_id: SYNTHETIC_DEPLOYMENT_ID,
    agent_profile_id: WREN_AGENT_PROFILE_ID,
    activation_revision: 1,
    activated_at: 1_000,
  })}\n`, { mode: 0o600 });
  resetLegacyAgentActivationCacheForTests();
  return () => {
    resetLegacyAgentActivationCacheForTests();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  };
}
