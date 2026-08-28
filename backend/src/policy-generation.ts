import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { getStore } from "./db.js";

const policyEvents = new EventEmitter();
let policyGeneration = 1;
let policyFingerprint = "";

function currentPolicyFingerprint(): string {
  const store = getStore();
  const projects = store.projects
    .map((project) => ({
      id: project.id,
      cwd: project.cwd,
      default_agent_profile_id: project.default_agent_profile_id,
      default_provider: project.default_provider,
      default_model: project.default_model,
      access_policy: {
        privacy_mode: project.access_policy.privacy_mode,
        allowed_agent_profile_ids: project.access_policy.allowed_agent_profile_ids
          ? [...project.access_policy.allowed_agent_profile_ids].sort()
          : null,
      },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const profiles = store.agentProfiles
    .map((profile) => ({
      id: profile.id,
      enabled: profile.enabled,
      resource_mode: profile.resource_mode,
      instructions: profile.instructions,
      memory_access: profile.memory_access,
      default_provider: profile.default_provider,
      default_model: profile.default_model,
      allowed_tools: profile.allowed_tools ? [...profile.allowed_tools].sort() : null,
      allowed_extensions: profile.allowed_extensions ? [...profile.allowed_extensions].sort() : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  // Legacy capability associations and PIN events are inert migration data.
  // Project privacy plus enabled/allowed profile state are the complete live
  // authority inputs.
  return createHash("sha256").update(JSON.stringify({ projects, profiles })).digest("hex");
}

function reportPolicyListenerFailure(): void {
  console.warn("[policy] policy-change listener failed after durable state publication");
}

function emitPolicyChangeSafely(generation: number): void {
  // Policy observers are post-commit projections/refreshers. One faulty
  // listener must neither prevent later listeners nor turn an already-durable
  // workspace transaction into an apparent failure.
  for (const listener of policyEvents.rawListeners("change")) {
    try {
      const result = listener.call(policyEvents, generation) as unknown;
      if (result && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(reportPolicyListenerFailure);
      }
    } catch {
      reportPolicyListenerFailure();
    }
  }
}

function refreshPolicyGeneration(): number {
  const next = currentPolicyFingerprint();
  if (!policyFingerprint) policyFingerprint = next;
  else if (next !== policyFingerprint) {
    policyFingerprint = next;
    policyGeneration++;
    emitPolicyChangeSafely(policyGeneration);
  }
  return policyGeneration;
}

/** Monotonic within this backend process and scoped to workspace capability policy. */
export function getPolicyGeneration(): number {
  return refreshPolicyGeneration();
}

/** Call after a successful policy-bearing transaction to refresh watchers immediately. */
export function notifyPolicyChanged(): number {
  policyFingerprint = currentPolicyFingerprint();
  policyGeneration++;
  emitPolicyChangeSafely(policyGeneration);
  return policyGeneration;
}

export function onPolicyChanged(listener: (generation: number) => void): () => void {
  policyEvents.on("change", listener);
  return () => policyEvents.off("change", listener);
}
