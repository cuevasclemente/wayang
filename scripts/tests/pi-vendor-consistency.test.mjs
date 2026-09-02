import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageName = "@earendil-works/pi-coding-agent";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("vendored Pi package, lockfile, artifact, and documentation stay aligned", () => {
  const backendRoot = join(root, "backend");
  const packageJson = readJson(join(backendRoot, "package.json"));
  const packageLock = readJson(join(backendRoot, "package-lock.json"));
  const specification = packageJson.dependencies?.[packageName];

  assert.equal(typeof specification, "string");
  const match = /^file:(earendil-works-pi-coding-agent-(0\.84\.1-wayang\.[a-f0-9]{8})\.tgz)$/u.exec(specification);
  assert.ok(match, `unexpected vendored Pi specification: ${specification}`);

  const [, artifactName, version] = match;
  const artifact = readFileSync(join(backendRoot, artifactName));
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const rootLock = packageLock.packages?.[""]?.dependencies?.[packageName];
  const installedLock = packageLock.packages?.[`node_modules/${packageName}`];

  assert.equal(rootLock, specification);
  assert.equal(installedLock?.version, version);
  assert.equal(installedLock?.resolved, specification);

  const documentation = readFileSync(join(root, "docs", "configuration.md"), "utf8");
  assert.ok(documentation.includes(`repository-vendored \`${version}\` artifact`));
  assert.ok(documentation.includes(`SHA-256 \`${sha256}\``));
});
