#!/usr/bin/env node
import { provisionCapabilityApprovalState } from "./lib/capability-approval.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: make setup-capability-approval

Optional manual preflight for the private workspace capability approval cooldown
state. Normal service startup initializes missing state automatically beside the
existing command-guard identity PIN authority. This command checks PIN metadata
only and never reads it. No PIN, capability grant, activation, service, or runtime
is created or changed.`);
  process.exit(0);
}
if (args.length > 0) {
  console.error("Unknown option. Use --help for usage.");
  process.exit(2);
}

try {
  const result = provisionCapabilityApprovalState();
  console.log(result.created
    ? "Provisioned private workspace capability approval cooldown state."
    : "Workspace capability approval cooldown state is already safely provisioned; left unchanged.");
  console.log("The existing command-guard identity PIN passed metadata checks; its contents were not read.");
  console.log("No PIN, capability grant, activation, service, or runtime was created or changed.");
} catch (error) {
  console.error(`Capability approval setup refused: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
}
