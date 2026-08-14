const MAX_PATHS = 10_000;
const MAX_PATH_BYTES = 4096;

const CRITICAL_RULES = [
  [/(^|\/)(?:\.gitattributes|\.gitmodules|\.gitconfig)$/, "git_execution_configuration"],
  [/(^|\/)package\.json$/, "package_manifest"],
  [/(^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|pnpm-workspace\.yaml|lerna\.json)$/, "package_manager_configuration"],
  [/(^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/, "dependency_lock"],
  [/(?:^\.github\/workflows\/|^\.gitlab-ci\.yml$|^azure-pipelines\.yml$|^\.buildkite\/)/, "hosted_ci_policy"],
  [/(^|\/)(?:makefile|dockerfile|binding\.gyp)$/, "build_or_native_configuration"],
  [/(^|\/)(?:maintenance|deploy|deployment|promoter|release)(?:\/|$)/, "maintenance_or_deployment"],
  [/(^|\/)scripts\/(?:[^/]*(?:build|release|deploy|publish|install|bootstrap)[^/]*)(?:\/|$)/, "lifecycle_script"],
  [/(^|\/)(?:preinstall|install|postinstall)\.(?:js|mjs|cjs|sh)$/, "lifecycle_script"],
  [/\.(?:node|gyp|c|cc|cpp|cxx|h|hpp|rs|wasm|so|dylib|dll)$/, "native_code"],
  [/(^|\/)(?:security\.md|security)(?:\/|$)/, "security_control"],
  [/(^|\/)(?:credential|credentials|auth-broker|secret-broker)(?:[./_-]|$)/, "credential_integration"],
];

export function normalizeRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_PATH_BYTES) throw new Error("invalid repository path length");
  if (value.includes("\\") || value.startsWith("/") || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("unsafe repository path controls");
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("repository path is not normalized");
  if (parts.some((part) => /[. ]$/.test(part))) throw new Error("repository path component has a trailing dot or space");
  return value;
}

function normalizedPaths(paths) {
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) throw new Error("repository path list is invalid or too large");
  return [...new Set(paths.map(normalizeRepositoryPath))].sort();
}

export function evaluatePathSafety(paths) {
  const normalized = normalizedPaths(paths);
  const violations = [];
  const foldedPrefixes = new Map();
  for (const path of normalized) {
    const normalizedForm = path.normalize("NFKC");
    if (normalizedForm !== path) violations.push(Object.freeze({ path, reason: "path_normalization" }));
    const originalParts = path.split("/");
    const normalizedParts = normalizedForm.split("/");
    for (let index = 0; index < originalParts.length; index += 1) {
      const originalPrefix = originalParts.slice(0, index + 1).join("/");
      const collisionKey = normalizedParts.slice(0, index + 1).join("/").toLowerCase();
      const previous = foldedPrefixes.get(collisionKey);
      if (previous !== undefined && previous !== originalPrefix) {
        violations.push(Object.freeze({ path, reason: "path_case_or_normalization_collision" }));
        break;
      }
      foldedPrefixes.set(collisionKey, originalPrefix);
    }
  }
  return Object.freeze({ allowed: violations.length === 0, checkedPaths: normalized.length, violations: Object.freeze(violations) });
}

export function evaluateDiffPolicy(changedPaths) {
  const normalized = normalizedPaths(changedPaths);
  const pathSafety = evaluatePathSafety(normalized);
  const violations = [...pathSafety.violations];
  for (const path of normalized) {
    const comparable = path.toLowerCase();
    for (const [pattern, reason] of CRITICAL_RULES) {
      if (pattern.test(comparable)) {
        violations.push(Object.freeze({ path, reason }));
        break;
      }
    }
  }
  violations.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.reason < right.reason ? -1 : 1);
  return Object.freeze({
    allowed: violations.length === 0,
    checkedPaths: normalized.length,
    violations: Object.freeze(violations),
  });
}
