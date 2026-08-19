#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import {
  historicalAgentActivationStatus,
  provisionHistoricalAgentActivation,
} from "./lib/historical-agent-activation.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage:
  make setup-historical-agent-activation
  make setup-historical-agent-activation-status

Provision the deployment-local compatibility witness for the one explicitly
active historical agent home. This is not normal Wayang setup and must not be
run on secondary deployments. Provisioning requires the existing command-guard
identity PIN through hidden local-terminal input. No PIN is logged, stored in
the witness, or accepted through argv/environment.

--status checks only owner/mode/schema metadata and never reads the PIN.`);
  process.exit(0);
}
const statusOnly = args.length === 1 && args[0] === "--status";
if (args.length > (statusOnly ? 1 : 0)) {
  console.error("Unknown option. Use --help for usage.");
  process.exit(2);
}

async function hiddenPin() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("PIN entry requires an interactive local terminal");
  stdout.write("Existing command-guard identity PIN: ");
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Activation cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}

try {
  if (statusOnly) {
    const status = historicalAgentActivationStatus();
    console.log(status.active
      ? `Historical agent compatibility is active for this deployment (revision ${status.activationRevision}).`
      : `Historical agent compatibility is inactive: ${status.reason}.`);
    process.exit(status.active ? 0 : 1);
  }

  console.log("This command is ONLY for the explicitly active historical agent home.");
  console.log("Do not run it on Tribe-Mac or another secondary Wayang deployment.\n");
  const pin = await hiddenPin();
  const result = provisionHistoricalAgentActivation({ pin });
  console.log(result.created
    ? `Provisioned deployment-local historical agent activation revision ${result.activationRevision}.`
    : `Historical agent activation revision ${result.activationRevision} was already safely provisioned; left unchanged.`);
  console.log("The witness contains only deployment/profile identifiers and timestamps; no PIN, prompt, memory, or provider credential.");
  console.log("Restart Wayang before relying on the startup-immutable activation status.");
} catch (error) {
  console.error(`Historical agent activation refused: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
}
