import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const codingAgentPackageName = "@earendil-works/pi-coding-agent";
const aiPackageName = "@earendil-works/pi-ai";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("vendored Pi coding-agent package, lockfile, artifact, and documentation stay aligned", () => {
  const backendRoot = join(root, "backend");
  const packageJson = readJson(join(backendRoot, "package.json"));
  const packageLock = readJson(join(backendRoot, "package-lock.json"));
  const specification = packageJson.dependencies?.[codingAgentPackageName];

  assert.equal(typeof specification, "string");
  const match = /^file:(earendil-works-pi-coding-agent-(0\.84\.1-wayang\.[a-f0-9]{8})\.tgz)$/u.exec(specification);
  assert.ok(match, `unexpected vendored Pi specification: ${specification}`);

  const [, artifactName, version] = match;
  const artifact = readFileSync(join(backendRoot, artifactName));
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const rootLock = packageLock.packages?.[""]?.dependencies?.[codingAgentPackageName];
  const installedLock = packageLock.packages?.[`node_modules/${codingAgentPackageName}`];

  assert.equal(rootLock, specification);
  assert.equal(installedLock?.version, version);
  assert.equal(installedLock?.resolved, specification);

  const documentation = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  assert.ok(documentation.includes(`repository-vendored \`${version}\` artifact`));
  assert.ok(documentation.includes(`SHA-256 \`${sha256}\``));
});

test("vendored Pi AI package, lockfile, artifact, and documentation stay aligned", () => {
  const backendRoot = join(root, "backend");
  const packageJson = readJson(join(backendRoot, "package.json"));
  const packageLock = readJson(join(backendRoot, "package-lock.json"));
  const specification = packageJson.dependencies?.[aiPackageName];

  assert.equal(typeof specification, "string");
  const match = /^file:(earendil-works-pi-ai-0\.84\.1-wayang\.([a-f0-9]{8})\.tgz)$/u.exec(specification);
  assert.ok(match, `unexpected vendored Pi AI specification: ${specification}`);

  const [, artifactName, revision] = match;
  const artifact = readFileSync(join(backendRoot, artifactName));
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const rootLock = packageLock.packages?.[""]?.dependencies?.[aiPackageName];
  const installedLock = packageLock.packages?.[`node_modules/${aiPackageName}`];

  assert.equal(rootLock, specification);
  assert.equal(installedLock?.version, "0.84.1");
  assert.equal(installedLock?.resolved, specification);
  assert.equal(sha256.slice(0, 8), revision);

  const documentation = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  assert.ok(documentation.includes(`repository-vendored Pi AI \`0.84.1-wayang.${revision}\` artifact`));
  assert.ok(documentation.includes(`SHA-256 \`${sha256}\``));
});
