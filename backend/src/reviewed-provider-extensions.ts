import * as fs from "node:fs";
import * as path from "node:path";

export interface ReviewedExternalModelEntry {
  /** Path relative to `<agentDir>/extensions`; must not traverse out of that root. */
  extensionPath: string;
  /** Lowercase hex sha256 of the exact artifact bytes the runtime may execute. */
  sha256: string;
  /** Path relative to the service user's home directory; presence is checked, contents are never read. */
  credentialRelativeToHome?: string;
  /**
   * Whether a verified, projected model is offered by listModels(). Defaults to
   * false: review makes a provider resolvable, not discoverable.
   */
  catalogVisible?: boolean;
  model: {
    provider: string;
    id: string;
    name: string;
    api: string;
    reasoning: boolean;
    input: readonly string[];
    contextWindow: number;
  };
}

export interface ReviewedProviderManifestResult {
  entries: readonly ReviewedExternalModelEntry[];
  errors: string[];
}

/** Deployment-supplied reviewed providers; empty when the manifest path is unset. */
export interface ReviewedProvidersConfig {
  filePath: string;
  entries: readonly ReviewedExternalModelEntry[];
  errors: string[];
}

/** The schema a deployment plugin ships alongside its extension artifact. */
export const REVIEWED_PROVIDER_MANIFEST_VERSION = 1;

const MANIFEST_VERSION = REVIEWED_PROVIDER_MANIFEST_VERSION;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFEST_ERRORS = 20;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const API_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORTED_INPUTS = new Set(["text", "image"]);

let cachedManifest: { filePath: string; result: ReviewedProviderManifestResult } | undefined;

/**
 * Deployment-owned manifest of externally provided models.
 *
 * Wayang mainline ships no provider literals: a deployment declares its reviewed
 * providers through `WAYANG_REVIEWED_PROVIDERS_FILE`, and the manifest is the
 * trust root for which external bytes the runtime may execute. The manifest is
 * read once per process (no hot reload) and is validated as a whole — any schema
 * defect contributes **zero** entries so a typo can never silently downgrade a
 * trust declaration to partial trust.
 *
 * Model listing must never execute an installed extension. The backend verifies
 * the exact regular-file hash and credential-file metadata, then projects only
 * these manifest descriptors. Runtime model contexts separately execute a
 * private copy of the exact verified bytes and retain only provider
 * registration; Project/Profile resource authority is not an input to provider
 * availability.
 */
export function loadReviewedProviderManifest(filePath: string): ReviewedProviderManifestResult {
  if (cachedManifest?.filePath === filePath) return cachedManifest.result;
  const result = readReviewedProviderManifest(filePath);
  cachedManifest = { filePath, result };
  return result;
}

/** @internal Test seam; the manifest is deliberately read once per process. */
export function resetReviewedProviderManifestCache(): void {
  cachedManifest = undefined;
}

export function resolveReviewedProvidersConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReviewedProvidersConfig {
  const filePath = (env.WAYANG_REVIEWED_PROVIDERS_FILE ?? "").trim();
  if (filePath.length === 0) return { filePath: "", entries: [], errors: [] };
  const loaded = loadReviewedProviderManifest(filePath);
  return { filePath, entries: loaded.entries, errors: loaded.errors };
}

function readReviewedProviderManifest(filePath: string): ReviewedProviderManifestResult {
  const errors: string[] = [];
  // Error text references the declared file path and field names only; manifest
  // field values are never echoed, so a hostile manifest cannot leak content.
  const label = `Reviewed provider manifest "${filePath}"`;
  const empty = (): ReviewedProviderManifestResult => ({ entries: [], errors });

  let raw: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      errors.push(`${label} is not a regular file; ignoring it`);
      return empty();
    }
    if (stat.size > MAX_MANIFEST_BYTES) {
      errors.push(`${label} exceeds ${MAX_MANIFEST_BYTES} bytes; ignoring it`);
      return empty();
    }
    raw = fs.readFileSync(fd, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    errors.push(code === "ELOOP"
      ? `${label} is a symlink; refusing to read it`
      : `${label} could not be read`);
    return empty();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push(`${label} is not valid JSON`);
    return empty();
  }
  if (!isRecord(parsed)) {
    errors.push(`${label} must be a JSON object`);
    return empty();
  }
  if (parsed.version !== MANIFEST_VERSION) {
    errors.push(`${label} declares an unsupported "version"; expected ${MANIFEST_VERSION}`);
    return empty();
  }
  if (!Array.isArray(parsed.providers)) {
    errors.push(`${label} must contain a "providers" array`);
    return empty();
  }

  const entries: ReviewedExternalModelEntry[] = [];
  const seenModelKeys = new Set<string>();
  for (let index = 0; index < parsed.providers.length; index += 1) {
    const entry = validateManifestEntry(parsed.providers[index], index, label, errors);
    if (!entry) continue;
    const key = `${entry.model.provider}\u0000${entry.model.id}`;
    if (seenModelKeys.has(key)) {
      errors.push(`${label} entry ${index} repeats provider "${entry.model.provider}" model "${entry.model.id}"`);
      continue;
    }
    seenModelKeys.add(key);
    entries.push(entry);
  }

  if (errors.length > 0) {
    if (errors.length > MAX_MANIFEST_ERRORS) {
      errors.length = MAX_MANIFEST_ERRORS;
      errors.push(`${label} has further errors that were not reported`);
    }
    return empty();
  }
  return { entries, errors: [] };
}

function validateManifestEntry(
  candidate: unknown,
  index: number,
  label: string,
  errors: string[],
): ReviewedExternalModelEntry | undefined {
  const reject = (field: string, expectation: string): undefined => {
    errors.push(`${label} entry ${index} has an invalid "${field}"; ${expectation}`);
    return undefined;
  };
  if (!isRecord(candidate)) return reject("entry", "expected a JSON object");

  if (typeof candidate.extensionPath !== "string" || !isSafeRelativePath(candidate.extensionPath)) {
    return reject("extensionPath", "expected a normalized relative path with no parent-directory segments");
  }
  if (typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256)) {
    return reject("sha256", "expected 64 lowercase hex characters");
  }
  if (candidate.credentialRelativeToHome !== undefined
    && (typeof candidate.credentialRelativeToHome !== "string" || !isSafeRelativePath(candidate.credentialRelativeToHome))) {
    return reject("credentialRelativeToHome", "expected a normalized relative path with no parent-directory segments");
  }
  if (candidate.catalogVisible !== undefined && typeof candidate.catalogVisible !== "boolean") {
    return reject("catalogVisible", "expected a boolean");
  }

  const model = candidate.model;
  if (!isRecord(model)) return reject("model", "expected a JSON object");
  if (typeof model.provider !== "string" || !PROVIDER_ID_PATTERN.test(model.provider)) {
    return reject("model.provider", "expected a bounded provider identifier");
  }
  if (typeof model.id !== "string" || !PROVIDER_ID_PATTERN.test(model.id)) {
    return reject("model.id", "expected a bounded model identifier");
  }
  if (typeof model.name !== "string" || !isSafeDisplayName(model.name)) {
    return reject("model.name", "expected a single-line display name of at most 200 characters");
  }
  if (typeof model.api !== "string" || !API_PATTERN.test(model.api)) {
    return reject("model.api", "expected a pi API identifier such as \"openai-completions\"");
  }
  if (typeof model.reasoning !== "boolean") {
    return reject("model.reasoning", "expected a boolean");
  }
  if (!Array.isArray(model.input)
    || model.input.length === 0
    || model.input.some((value) => typeof value !== "string" || !SUPPORTED_INPUTS.has(value))) {
    return reject("model.input", "expected a non-empty subset of [\"text\", \"image\"]");
  }
  if (typeof model.contextWindow !== "number"
    || !Number.isInteger(model.contextWindow)
    || model.contextWindow <= 0) {
    return reject("model.contextWindow", "expected a positive integer");
  }

  return {
    extensionPath: candidate.extensionPath,
    sha256: candidate.sha256,
    ...(candidate.credentialRelativeToHome === undefined
      ? {}
      : { credentialRelativeToHome: candidate.credentialRelativeToHome }),
    ...(candidate.catalogVisible === undefined ? {} : { catalogVisible: candidate.catalogVisible }),
    model: {
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: [...model.input] as readonly string[],
      contextWindow: model.contextWindow,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  if (normalized !== value) return false;
  return !normalized.split(path.sep).includes("..");
}

function isSafeDisplayName(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}
