import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const codingAgentPackageName = "@earendil-works/pi-coding-agent";
const aiPackageName = "@earendil-works/pi-ai";
const sourceRevision = "fa40ae91ad733a8a0bc369cfbdcaca381fa47a46";
const sdkSha256 = "e4237a2fb91c92c5ae9da3b37bf4ddd35572ca4e36d1dcc61f1aa64e66b4fb43";
const coreSha256 = "9484dba8364ffb89bc881b97011cbfd3194dfc754a5115e1e0db53d3da946d10";
const aiSha256 = "22ca19ede1015ad1247309efbe79f6558dfa278f44056469bd0a8c8c1082490f";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("vendored Pi coding-agent package, lockfile, artifact, and documentation stay aligned", () => {
  const backendRoot = join(root, "backend");
  const packageJson = readJson(join(backendRoot, "package.json"));
  const packageLock = readJson(join(backendRoot, "package-lock.json"));
  const specification = packageJson.dependencies?.[codingAgentPackageName];

  assert.equal(typeof specification, "string");
  const match = /^file:(earendil-works-pi-coding-agent-(0\.85\.0-wayang\.[a-f0-9]{8})\.tgz)$/u.exec(specification);
  assert.ok(match, `unexpected vendored Pi specification: ${specification}`);

  const [, artifactName, version] = match;
  assert.equal(version, `0.85.0-wayang.${sourceRevision.slice(0, 8)}`);
  const artifact = readFileSync(join(backendRoot, artifactName));
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  assert.equal(sha256, sdkSha256);
  assert.equal(packageLock.lockfileVersion, 3);
  const rootLock = packageLock.packages?.[""]?.dependencies?.[codingAgentPackageName];
  const installedLock = packageLock.packages?.[`node_modules/${codingAgentPackageName}`];

  assert.equal(rootLock, specification);
  assert.equal(installedLock?.version, version);
  assert.equal(installedLock?.resolved, specification);
  assert.equal(installedLock?.integrity, `sha512-${createHash("sha512").update(artifact).digest("base64")}`);

  const documentation = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  assert.ok(documentation.includes(`repository-vendored \`${version}\` artifact`));
  assert.ok(documentation.includes(`SHA-256 \`${sha256}\``));
  assert.ok(documentation.includes(`source revision \`${sourceRevision}\``));
  assert.ok(documentation.includes("catalog manifest SHA-256 `e6dd5f432d502e84981ac15c14d9eb0f78bab7baf1aac8dbb805d48b8b3c3655`"));
});

test("vendored Pi core matches the SDK source revision and locked artifact bytes", () => {
  const backendRoot = join(root, "backend");
  const packageJson = readJson(join(backendRoot, "package.json"));
  const packageLock = readJson(join(backendRoot, "package-lock.json"));
  const name = "@earendil-works/pi-agent-core";
  const specification = packageJson.dependencies?.[name];
  const match = /^file:(earendil-works-pi-agent-core-(0\.85\.0)-wayang\.([a-f0-9]{8})\.tgz)$/u.exec(specification);
  assert.ok(match, "an explicit paired core artifact is required");
  const [, artifactName, version, revision] = match;
  assert.equal(revision, sourceRevision.slice(0, 8));
  assert.equal(packageJson.dependencies[codingAgentPackageName], `file:earendil-works-pi-coding-agent-${version}-wayang.${revision}.tgz`);
  const artifact = readFileSync(join(backendRoot, artifactName));
  assert.equal(createHash("sha256").update(artifact).digest("hex"), coreSha256);
  const installedLock = packageLock.packages?.[`node_modules/${name}`];
  assert.equal(packageLock.packages?.[""]?.dependencies?.[name], specification);
  assert.equal(installedLock?.version, version);
  assert.equal(installedLock?.resolved, specification);
  assert.equal(installedLock?.integrity, `sha512-${createHash("sha512").update(artifact).digest("base64")}`);
  const documentation = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  assert.ok(documentation.includes(artifactName));
  assert.ok(documentation.includes(`SHA-256 \`${createHash("sha256").update(artifact).digest("hex")}\``));
});

test("vendored Pi AI package, lockfile, artifact, and documentation stay aligned", () => {
  const backendRoot = join(root, "backend");
  const packageJson = readJson(join(backendRoot, "package.json"));
  const packageLock = readJson(join(backendRoot, "package-lock.json"));
  const specification = packageJson.dependencies?.[aiPackageName];

  assert.equal(typeof specification, "string");
  const match = /^file:(earendil-works-pi-ai-(0\.85\.0)-wayang\.([a-f0-9]{8})\.tgz)$/u.exec(specification);
  assert.ok(match, `unexpected vendored Pi AI specification: ${specification}`);

  const [, artifactName, version, revision] = match;
  assert.ok(packageJson.dependencies[codingAgentPackageName].startsWith(`file:earendil-works-pi-coding-agent-${version}-wayang.`));
  const artifact = readFileSync(join(backendRoot, artifactName));
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  assert.equal(sha256, aiSha256);
  const rootLock = packageLock.packages?.[""]?.dependencies?.[aiPackageName];
  const installedLock = packageLock.packages?.[`node_modules/${aiPackageName}`];

  assert.equal(rootLock, specification);
  assert.equal(installedLock?.version, version);
  assert.equal(installedLock?.resolved, specification);
  assert.equal(installedLock?.integrity, `sha512-${createHash("sha512").update(artifact).digest("base64")}`);
  assert.equal(sha256.slice(0, 8), revision);

  const documentation = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  assert.ok(documentation.includes(`repository-vendored Pi AI \`${version}-wayang.${revision}\` artifact`));
  assert.ok(documentation.includes(`SHA-256 \`${sha256}\``));
});
