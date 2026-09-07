import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const codingAgentPackageName = "@earendil-works/pi-coding-agent";
const aiPackageName = "@earendil-works/pi-ai";
const sourceRevision = "904e4012047428abeaa5f47f4b6fa759069eb987";
const sdkSha256 = "22027c0b21f7ba9b246bf1a326514fe4dfcd27e57fb3b65af9d319d6bc1c015e";
const coreSha256 = "0f8609a3e31c714a0e412378a7acaee7957717771f9cb2422f84493374cf2579";
const aiSha256 = "3483e2cd07ebe8add88fd2bb2c1dcf8afec8da200dcbdb67e3fc715f307d0802";

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
  assert.ok(documentation.includes("catalog provenance SHA-256 `e414296b8ce7c62bfd5df7bd9cb4ece7b4bac1fb001fb546fc39dca7c09a7ba6`"));
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
