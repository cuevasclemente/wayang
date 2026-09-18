import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadReviewedProviderManifest,
  resetReviewedProviderManifestCache,
  resolveReviewedProvidersConfig,
} from "./reviewed-provider-extensions.js";

function withManifest(
  contents: unknown,
  run: (filePath: string, dir: string) => void,
  options: { symlink?: boolean } = {},
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-reviewed-manifest-"));
  const filePath = path.join(dir, "reviewed-providers.json");
  fs.writeFileSync(filePath, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
  if (options.symlink) {
    const linkPath = path.join(dir, "linked-providers.json");
    fs.symlinkSync(filePath, linkPath);
    resetReviewedProviderManifestCache();
    try {
      run(linkPath, dir);
    } finally {
      resetReviewedProviderManifestCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return;
  }
  resetReviewedProviderManifestCache();
  try {
    run(filePath, dir);
  } finally {
    resetReviewedProviderManifestCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    extensionPath: "local-inference/index.ts",
    sha256: "a".repeat(64),
    credentialRelativeToHome: "secrets/local-inference-key",
    catalogVisible: true,
    model: {
      provider: "local-inference",
      id: "local-model",
      name: "Local model",
      api: "openai-completions",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
    },
    ...overrides,
  };
}

function manifest(...providers: unknown[]) {
  return { version: 1, providers };
}

test("loads a valid manifest and preserves its declarations", () => {
  withManifest(manifest(entry()), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.deepEqual(result.errors, []);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.extensionPath, "local-inference/index.ts");
    assert.equal(result.entries[0]?.catalogVisible, true);
    assert.equal(result.entries[0]?.credentialRelativeToHome, "secrets/local-inference-key");
    assert.equal(result.entries[0]?.model.contextWindow, 262144);
  });
});

test("omitting catalogVisible leaves picker visibility undeclared", () => {
  withManifest(manifest(entry({ catalogVisible: undefined })), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.deepEqual(result.errors, []);
    assert.equal(result.entries[0]?.catalogVisible, undefined);
  });
});

test("an entry without a credential path is accepted", () => {
  withManifest(manifest(entry({ credentialRelativeToHome: undefined })), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.deepEqual(result.errors, []);
    assert.equal(result.entries[0]?.credentialRelativeToHome, undefined);
  });
});

test("rejects malformed JSON", () => {
  withManifest("{ not json", (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /is not valid JSON/);
  });
});

test("rejects an unsupported manifest version", () => {
  withManifest({ version: 2, providers: [entry()] }, (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /unsupported "version"/);
  });
});

test("rejects parent-directory traversal in extensionPath", () => {
  withManifest(manifest(entry({ extensionPath: "../../evil.ts" })), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /"extensionPath"/);
  });
});

test("rejects a non-normalized relative extensionPath", () => {
  withManifest(manifest(entry({ extensionPath: "./local-inference/index.ts" })), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /"extensionPath"/);
  });
});

test("rejects an absolute extensionPath", () => {
  withManifest(manifest(entry({ extensionPath: "/etc/evil.ts" })), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /"extensionPath"/);
  });
});

test("rejects traversal in credentialRelativeToHome", () => {
  withManifest(manifest(entry({ credentialRelativeToHome: "../../id_rsa" })), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /"credentialRelativeToHome"/);
  });
});

test("rejects a malformed sha256", () => {
  for (const sha256 of ["abc", "A".repeat(64), "a".repeat(63), "z".repeat(64)]) {
    withManifest(manifest(entry({ sha256 })), (filePath) => {
      const result = loadReviewedProviderManifest(filePath);
      assert.equal(result.entries.length, 0, `sha256 ${sha256} must be rejected`);
      assert.match(result.errors[0] ?? "", /"sha256"/);
    });
  }
});

test("rejects an unsupported model.input value", () => {
  withManifest(manifest(entry({ model: { ...entry().model, input: ["text", "audio"] } })), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /"model.input"/);
  });
});

test("rejects a non-positive contextWindow", () => {
  for (const contextWindow of [0, -1, 1.5]) {
    withManifest(manifest(entry({ model: { ...entry().model, contextWindow } })), (filePath) => {
      const result = loadReviewedProviderManifest(filePath);
      assert.equal(result.entries.length, 0, `contextWindow ${contextWindow} must be rejected`);
      assert.match(result.errors[0] ?? "", /"model.contextWindow"/);
    });
  }
});

test("rejects duplicate provider and model pairs", () => {
  withManifest(manifest(entry(), entry()), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /repeats provider/);
  });
});

test("one invalid entry contributes no entries at all", () => {
  withManifest(
    manifest(entry(), entry({ sha256: "nope", model: { ...entry().model, id: "second-model" } })),
    (filePath) => {
      const result = loadReviewedProviderManifest(filePath);
      assert.equal(result.entries.length, 0, "a trust manifest is valid as a whole or contributes nothing");
      assert.ok(result.errors.length > 0);
    },
  );
});

test("reports an unreadable manifest without throwing", () => {
  const missing = path.join(os.tmpdir(), "wayang-reviewed-manifest-absent", "reviewed-providers.json");
  resetReviewedProviderManifestCache();
  try {
    const result = loadReviewedProviderManifest(missing);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /could not be read/);
  } finally {
    resetReviewedProviderManifestCache();
  }
});

test("refuses a symlinked manifest", () => {
  withManifest(manifest(entry()), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.match(result.errors[0] ?? "", /is a symlink/);
  }, { symlink: true });
});

test("error text never echoes manifest field values", () => {
  const marker = "MARKER-SHOULD-NOT-BE-ECHOED";
  withManifest(manifest(entry({ sha256: "nope", model: { ...entry().model, name: marker } })), (filePath) => {
    const result = loadReviewedProviderManifest(filePath);
    assert.equal(result.entries.length, 0);
    assert.ok(result.errors.length > 0);
    assert.ok(
      !result.errors.join("\n").includes(marker),
      "manifest errors must reference field names, never field values",
    );
  });
});

test("reads the manifest once per process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-reviewed-manifest-cache-"));
  const filePath = path.join(dir, "reviewed-providers.json");
  fs.writeFileSync(filePath, JSON.stringify(manifest(entry())));
  resetReviewedProviderManifestCache();
  try {
    assert.equal(loadReviewedProviderManifest(filePath).entries.length, 1);
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, providers: [] }));
    assert.equal(loadReviewedProviderManifest(filePath).entries.length, 1, "no hot reload");
    resetReviewedProviderManifestCache();
    assert.equal(loadReviewedProviderManifest(filePath).entries.length, 0, "re-read after cache reset");
  } finally {
    resetReviewedProviderManifestCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unset manifest path yields no reviewed providers", () => {
  const config = resolveReviewedProvidersConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.filePath, "");
  assert.deepEqual(config.entries, []);
  assert.deepEqual(config.errors, []);
});

test("a configured manifest path is loaded through the environment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-reviewed-manifest-env-"));
  const filePath = path.join(dir, "reviewed-providers.json");
  fs.writeFileSync(filePath, JSON.stringify(manifest(entry())));
  resetReviewedProviderManifestCache();
  try {
    const config = resolveReviewedProvidersConfig({ WAYANG_REVIEWED_PROVIDERS_FILE: filePath } as NodeJS.ProcessEnv);
    assert.equal(config.filePath, filePath);
    assert.equal(config.entries.length, 1);
    assert.deepEqual(config.errors, []);
  } finally {
    resetReviewedProviderManifestCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
