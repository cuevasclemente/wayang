import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Keeps actionable secrets and personal credentials out of the committed tree.
 *
 * Internal host names and machine nicknames in local planning docs are
 * acceptable; credentials, key material, and credential-bearing files are not.
 * This guard is intentionally high-signal so it needs no allowlist for the
 * synthetic fixtures used by the test suite.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    // Not a git checkout (for example a vendored tarball): nothing to assert.
    return null;
  }
}

/** Credential-bearing file names that must never be tracked. */
function forbiddenName(file) {
  const base = file.split("/").pop() ?? file;
  if (base === ".env.example") return null;
  if (/^\.env(\.|$)/u.test(base)) return "environment file";
  if (/^(auth\.json|credentials(\.(json|ya?ml))?|id_rsa|id_ed25519|\.netrc|cookies\.json)$/u.test(base)) {
    return "credential file";
  }
  if (/\.(pem|key|p12|pfx)$/iu.test(base)) return "key material";
  return null;
}

const SECRET_PATTERNS = [
  { label: "private key block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u },
  { label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u },
  { label: "provider API key", re: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{32,}\b/u },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/u },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { label: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u },
];

test("tracked files contain no actionable credentials or key material", () => {
  const files = trackedFiles();
  if (files === null) return;

  const problems = [];
  for (const file of files) {
    const nameIssue = forbiddenName(file);
    if (nameIssue) problems.push(`${file}: tracked ${nameIssue}`);

    // Generated lockfiles are large and never carry hand-written secrets.
    if (file.endsWith("package-lock.json")) continue;

    let bytes;
    try {
      bytes = readFileSync(resolve(root, file));
    } catch {
      continue;
    }
    if (bytes.includes(0)) continue; // binary asset

    const text = bytes.toString("utf8");
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(text)) problems.push(`${file}: possible ${label}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    `actionable secrets must not be committed:\n${problems.join("\n")}`,
  );
});
