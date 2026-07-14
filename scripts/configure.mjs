#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPasswordHash, isLoopbackHost, normalizePublicOrigin, parseEnv, updateEnv, writePrivateAtomic } from "./lib/config.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const envPath = resolve(root, ".env");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

if (args.has("--help") || args.has("-h")) {
  console.log("Usage: node scripts/configure.mjs [--dry-run]\n\nInteractive Wayang configuration. --dry-run uses safe defaults and writes nothing.");
  process.exit(0);
}
if ([...args].some((arg) => !["--dry-run"].includes(arg))) {
  console.error("Unknown option. Use --help for usage.");
  process.exit(2);
}

async function ask(label, fallback) {
  const suffix = fallback === undefined ? "" : ` [${fallback}]`;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

async function confirm(label, fallback = true) {
  const answer = (await ask(`${label} (${fallback ? "Y/n" : "y/N"})`)).toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

async function hidden(label) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Secret entry requires an interactive local terminal");
  stdout.write(`${label}: `);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolvePromise(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Configuration cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}

function selectApiProvider(choice) {
  const providers = [
    ["1", "Anthropic", "ANTHROPIC_API_KEY"],
    ["2", "OpenAI", "OPENAI_API_KEY"],
    ["3", "OpenRouter", "OPENROUTER_API_KEY"],
    ["4", "Google Gemini", "GEMINI_API_KEY"],
    ["5", "DeepSeek", "DEEPSEEK_API_KEY"],
    ["6", "Mistral", "MISTRAL_API_KEY"],
    ["7", "Groq", "GROQ_API_KEY"],
    ["8", "Cerebras", "CEREBRAS_API_KEY"],
    ["9", "xAI", "XAI_API_KEY"],
    ["10", "Fireworks", "FIREWORKS_API_KEY"],
  ];
  return providers.find(([number]) => number === choice);
}

async function main() {
  console.log("Wayang configuration");
  console.log("Secrets are accepted only through hidden terminal input and are never printed.\n");

  if (dryRun) {
    console.log(`[dry-run] Would update ${envPath} atomically with mode 0600.`);
    console.log("[dry-run] Defaults: configure pi later; built-in auth disabled; 127.0.0.1:8787.");
    console.log("[dry-run] Existing files and secret stores are not read or changed.");
    return;
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Interactive configuration requires a local terminal; use --dry-run for automation");

  const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "# Wayang local configuration (private; do not commit)\n";
  const existing = parseEnv(original, envPath).values;
  const updates = {};
  let launchOAuth = false;

  console.log("Pi authentication:");
  console.log("  1) OAuth subscription via pi /login");
  console.log("  2) Provider API key stored in this checkout's private .env");
  console.log("  3) Configure later");
  const authChoice = await ask("Choose", "3");
  if (authChoice === "1") {
    launchOAuth = true;
  } else if (authChoice === "2") {
    console.log("\nAPI key providers:");
    console.log("  1 Anthropic   2 OpenAI      3 OpenRouter  4 Google Gemini  5 DeepSeek");
    console.log("  6 Mistral     7 Groq        8 Cerebras    9 xAI            10 Fireworks");
    const provider = selectApiProvider(await ask("Provider", "1"));
    if (!provider) throw new Error("Unsupported provider selection");
    const [, providerName, variable] = provider;
    if (existing.has(variable) && !(await confirm(`${variable} is already present. Replace it?`, false))) {
      console.log(`Keeping existing ${variable}; its value was not displayed.`);
    } else {
      const key = await hidden(`Enter ${providerName} API key`);
      if (!key) throw new Error("API key cannot be empty");
      updates[variable] = key;
    }
  } else if (authChoice !== "3") {
    throw new Error("Unsupported authentication selection");
  }

  const enableAuth = await confirm("Enable Wayang's shared-password login?", existing.get("WAYANG_AUTH_ENABLED") === "1");
  updates.WAYANG_AUTH_ENABLED = enableAuth ? "1" : "0";
  updates.WAYANG_TRUST_PROXY = existing.get("WAYANG_TRUST_PROXY") || "loopback";
  updates.WAYANG_AUTH_COOKIE_SECURE = existing.get("WAYANG_AUTH_COOKIE_SECURE") || "auto";

  if (enableAuth) {
    updates.WAYANG_AUTH_SESSION_DAYS = await ask("Login session lifetime in days", existing.get("WAYANG_AUTH_SESSION_DAYS") || "30");
    const days = Number(updates.WAYANG_AUTH_SESSION_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Session lifetime must be an integer from 1 to 365 days");

    const canKeep = existing.has("WAYANG_AUTH_PASSWORD_HASH") && existing.has("WAYANG_AUTH_SESSION_SECRET");
    if (!canKeep || !(await confirm("Keep the existing shared password?", true))) {
      let password;
      while (true) {
        password = await hidden("New shared password (at least 12 characters)");
        if (password.length < 12) {
          console.log("Password is too short. Use at least 12 characters; a longer passphrase is recommended.");
          continue;
        }
        const confirmation = await hidden("Confirm shared password");
        if (password !== confirmation) {
          console.log("Passwords did not match. Try again.");
          continue;
        }
        break;
      }
      updates.WAYANG_AUTH_PASSWORD_HASH = await createPasswordHash(password);
      updates.WAYANG_AUTH_SESSION_SECRET = randomBytes(32).toString("base64url");
      password = "";
    }
  }

  const host = await ask("Bind host", existing.get("WAYANG_HOST") || "127.0.0.1");
  const port = await ask("Port", existing.get("WAYANG_PORT") || "8787");
  const portNumber = Number(port);
  if (!host || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error("Host and port must be valid (port 1-65535)");
  updates.WAYANG_HOST = host;
  updates.WAYANG_PORT = String(portNumber);

  const currentPublicOrigin = existing.get("WAYANG_PUBLIC_ORIGIN") || "";
  if (isLoopbackHost(host)) {
    const configurePublicOrigin = await confirm(
      "Configure an exact public browser origin for an HTTPS reverse proxy?",
      Boolean(currentPublicOrigin),
    );
    updates.WAYANG_PUBLIC_ORIGIN = configurePublicOrigin
      ? normalizePublicOrigin(await ask("Public browser origin", currentPublicOrigin || undefined))
      : undefined;
  } else {
    console.log("\nAn exposed bind requires the exact browser-facing origin (for example, https://wayang.example).");
    updates.WAYANG_PUBLIC_ORIGIN = normalizePublicOrigin(await ask("Public browser origin", currentPublicOrigin || undefined));
  }

  if (!isLoopbackHost(host) && !enableAuth) {
    console.log("\nWARNING: This exposes a privileged agent control surface without built-in authentication.");
    console.log("Protect every HTTP and WebSocket path with a VPN and/or authenticated reverse proxy.");
    const acknowledgement = await ask('Type "I UNDERSTAND" to continue');
    if (acknowledgement !== "I UNDERSTAND") throw new Error("Non-loopback configuration was not acknowledged");
  }

  if (existsSync(envPath)) {
    writePrivateAtomic(`${envPath}.backup`, original);
    console.log(`\nSaved the prior configuration as ${envPath}.backup (mode 0600; values hidden).`);
  }
  writePrivateAtomic(envPath, updateEnv(original, updates));
  console.log(`Updated ${envPath} atomically (mode 0600).`);
  console.log(`Configured keys: ${Object.keys(updates).sort().join(", ")}`);
  console.log("No secret values were printed.");

  if (launchOAuth) {
    const pi = resolve(root, "backend", "node_modules", ".bin", "pi");
    if (!existsSync(pi)) throw new Error("The local pi CLI is not installed; run make install, then make pi-login");
    console.log("\nStarting the checkout's pi CLI. Run /login, choose a provider, then /quit.");
    const result = spawnSync(pi, ["--no-session"], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pi exited with status ${result.status}`);
  }

  let displayHost = isLoopbackHost(host) || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  if (displayHost.includes(":") && !displayHost.startsWith("[")) displayHost = `[${displayHost}]`;
  console.log("\nNext: make start");
  console.log(`Open http://${displayHost}:${portNumber}`);
}

main().catch((error) => {
  console.error(`Configuration failed: ${error.message}`);
  process.exitCode = 1;
});
