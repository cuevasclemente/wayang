import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverAndLoadExtensions,
  type LoadExtensionsResult,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ReviewedExternalModelEntry } from "./reviewed-provider-extensions.js";

type LegacyProviderRegistration = LoadExtensionsResult["runtime"]["pendingProviderRegistrations"][number];
type NativeProviderRegistration = LoadExtensionsResult["runtime"]["pendingNativeProviderRegistrations"][number];

export interface ReviewedProviderRegistrationSnapshot {
  legacy: LegacyProviderRegistration[];
  native: NativeProviderRegistration[];
  errors: string[];
}

const snapshotPromises = new Map<string, Promise<ReviewedProviderRegistrationSnapshot>>();

function snapshotKey(agentDir: string, entries: readonly ReviewedExternalModelEntry[]): string {
  const manifest = entries
    .map((entry) => `${entry.extensionPath}\0${entry.sha256}\0${entry.model.provider}\0${entry.model.id}`)
    .sort()
    .join("\n");
  return `${path.resolve(agentDir)}\0${createHash("sha256").update(manifest).digest("hex")}`;
}

function verifiedExtensionBytes(
  agentDir: string,
  extensionPath: string,
  expectedSha256: string,
): { bytes?: Buffer; error?: string } {
  const candidate = path.join(agentDir, "extensions", extensionPath);
  let fd: number | undefined;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      return { error: `Reviewed provider artifact "${extensionPath}" is unsafe; refusing to load it` };
    }
    const bytes = fs.readFileSync(fd);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedSha256) {
      return { error: `Reviewed provider artifact "${extensionPath}" hash mismatch; refusing to load it` };
    }
    return { bytes };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code === "ENOENT") return {};
    if (code === "ELOOP") {
      return { error: `Reviewed provider artifact "${extensionPath}" is unsafe; refusing to load it` };
    }
    return { error: `Reviewed provider artifact "${extensionPath}" could not be verified` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function loadReviewedProviderRegistrations(
  agentDir: string,
  entries: readonly ReviewedExternalModelEntry[],
): Promise<ReviewedProviderRegistrationSnapshot> {
  const legacy: LegacyProviderRegistration[] = [];
  const native: NativeProviderRegistration[] = [];
  const errors: string[] = [];
  const grouped = new Map<string, ReviewedExternalModelEntry[]>();

  for (const entry of entries) {
    const current = grouped.get(entry.extensionPath) ?? [];
    current.push(entry);
    grouped.set(entry.extensionPath, current);
  }

  for (const [extensionPath, extensionEntries] of grouped) {
    const hashes = new Set(extensionEntries.map((entry) => entry.sha256));
    if (hashes.size !== 1) {
      errors.push(`Reviewed provider artifact "${extensionPath}" has conflicting hashes; refusing to load it`);
      continue;
    }
    const verified = verifiedExtensionBytes(agentDir, extensionPath, extensionEntries[0]!.sha256);
    if (!verified.bytes) {
      if (verified.error) errors.push(verified.error);
      continue;
    }

    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-reviewed-provider-load-"));
    const isolatedCwd = path.join(isolatedRoot, "project");
    const isolatedAgentDir = path.join(isolatedRoot, "agent");
    const isolatedExtensionPath = path.join(isolatedRoot, "reviewed-provider.ts");
    let result!: LoadExtensionsResult;
    try {
      fs.mkdirSync(isolatedCwd, { recursive: true });
      fs.mkdirSync(isolatedAgentDir, { recursive: true });
      // Execute a private copy made from the exact no-follow descriptor bytes that
      // passed the frozen hash check. The original path is never reopened by the
      // TypeScript loader, closing the verification-to-execution pathname race.
      fs.writeFileSync(isolatedExtensionPath, verified.bytes, { mode: 0o600, flag: "wx" });
      result = await discoverAndLoadExtensions(
        [isolatedExtensionPath],
        isolatedCwd,
        isolatedAgentDir,
      );
    } finally {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
    for (const error of result.errors) {
      errors.push(`Reviewed provider extension "${extensionPath}" failed to load: ${error.error}`);
    }
    if (result.errors.length > 0) continue;

    const allowedProviders = new Set(extensionEntries.map((entry) => entry.model.provider));
    const unexpected = [
      ...result.runtime.pendingProviderRegistrations.map((registration) => registration.name),
      ...result.runtime.pendingNativeProviderRegistrations.map((registration) => registration.provider.id),
    ].filter((provider) => !allowedProviders.has(provider));
    if (unexpected.length > 0) {
      errors.push(
        `Reviewed provider extension "${extensionPath}" registered an unreviewed provider; refusing all registrations from it`,
      );
      continue;
    }

    legacy.push(...result.runtime.pendingProviderRegistrations);
    native.push(...result.runtime.pendingNativeProviderRegistrations);
  }

  return { legacy, native, errors };
}

export async function getReviewedProviderRegistrations(
  agentDir: string,
  entries: readonly ReviewedExternalModelEntry[],
): Promise<ReviewedProviderRegistrationSnapshot> {
  const key = snapshotKey(agentDir, entries);
  let pending = snapshotPromises.get(key);
  if (!pending) {
    pending = loadReviewedProviderRegistrations(agentDir, entries);
    snapshotPromises.set(key, pending);
  }
  return pending;
}

export async function registerReviewedProviders(
  context: { runtime: ModelRuntime; registry: ModelRegistry },
  agentDir: string,
  entries: readonly ReviewedExternalModelEntry[],
): Promise<string[]> {
  const snapshot = await getReviewedProviderRegistrations(agentDir, entries);
  const errors = [...snapshot.errors];

  for (const registration of snapshot.legacy) {
    try {
      context.registry.registerProvider(registration.name, registration.config);
    } catch (error) {
      errors.push(
        `Reviewed provider "${registration.name}" failed to register: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const registration of snapshot.native) {
    try {
      context.runtime.registerNativeProvider(registration.provider);
    } catch (error) {
      errors.push(
        `Reviewed provider "${registration.provider.id}" failed to register: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const entry of entries) {
    if (!context.registry.find(entry.model.provider, entry.model.id)) {
      errors.push(`Reviewed model "${entry.model.provider}/${entry.model.id}" was not registered`);
    }
  }
  return errors;
}

/** @internal Test-only cache reset. */
export function clearReviewedProviderRegistrationCacheForTests(): void {
  snapshotPromises.clear();
}
