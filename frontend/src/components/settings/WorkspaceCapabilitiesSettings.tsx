import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Loader2, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import {
  ApiError,
  cancelWorkspaceCapabilityActivation,
  commitWorkspaceCapabilityActivation,
  fetchWorkspaceCapabilities,
  requestWorkspaceCapabilityActivation,
  revokeWorkspaceCapabilityAssociation,
  type AgentProfileSummary,
  type WorkspaceCapabilityApprovalEvent,
  type WorkspaceCapabilityAssociation,
  type WorkspaceCapabilityCatalogItem,
  type WorkspaceCapabilityCatalogStatus,
  type WorkspaceCapabilityChallenge,
  type WorkspaceCapabilityId,
  type WorkspaceProject,
} from "../../api/client";
import { ErrorBox, Field, inputClass, primaryButtonClass, secondaryButtonClass } from "./ProjectSettingsForm";

interface WorkspaceCapabilitiesSettingsProps {
  projects: WorkspaceProject[];
  profiles: AgentProfileSummary[];
  onChanged?: () => void;
}

const CAPABILITY_RISK_DETAILS: Record<WorkspaceCapabilityId, string> = {
  "wayang.standard-resources.v1":
    "Reviewed global resources may reach data and authority outside the project-only resource set. Labels do not grant this access.",
  "wayang.standard-browser.v1":
    "The agent may navigate, inspect pages, click, type non-secret text, download bounded files, and cause remote mutations through a managed browser. Existing authenticated cookies may permit purchases, deletion, exports, account-setting changes, logout, or browser-mediated passkey flows; human login handoff does not make later actions read-only.",
  "wayang.host-execution.v1":
    "Host execution runs as the Wayang OS user outside the filesystem sandbox. It can affect same-UID files, processes, credentials, network services, and existing privilege mechanisms. A person authenticated to a remotely exposed Wayang instance can trigger those host effects.",
  "wayang.protected-browser.v1":
    "The agent may navigate, click, type non-secret text, download, and cause remote mutations. Existing authenticated cookies may permit purchases, deletion, exports, account-setting changes, logout, or browser-mediated passkey flows; human login handoff does not make later actions read-only.",
  "wayang.protected-automation.v1":
    "Deterministic scheduled Node code runs without a shell and can read or persist writes throughout its exact Protected project; completed or racing writes cannot be rolled back. The child has no generic TCP, UDP, or Unix-socket network access, but backend-owned browser RPC can use authenticated state at agent-configured HTTPS origins to disclose data or cause consequential account changes. Passwords, MFA, CAPTCHA, payments, recovery, and other secret-bearing steps remain human-only. This is not isolation from same-UID processes or trusted in-process code.",
};

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Capability Settings could not reach the backend. Check Wayang health and retry.";
  if (error.status === 401) {
    return "Capability Settings requires an authenticated Wayang session. Remote passwordless access cannot approve capabilities; enable the shared password or use a loopback browser origin.";
  }
  if (error.status === 403) return "Capability Settings denied this owner, Origin, or exact Project-Agent operation.";
  if (error.status === 409) return "Capability state changed. Refresh Settings before retrying.";
  if (error.status === 429) return "Capability approval is temporarily cooling down. Wait before retrying.";
  if (error.status >= 500) return "Capability Settings is unavailable. Check Wayang health and local service diagnostics.";
  return `Capability Settings rejected the request (HTTP ${error.status}).`;
}

function capabilityErrorCode(error: ApiError): string | null {
  if (!error.body || typeof error.body !== "object" || Array.isArray(error.body)) return null;
  const code = (error.body as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function activationRequestErrorMessage(error: unknown, timedOut: boolean): string {
  if (timedOut || (error instanceof DOMException && error.name === "AbortError")) {
    return "Capability review timed out before the backend responded. Check Wayang health, then retry; no PIN was requested or submitted.";
  }
  if (!(error instanceof ApiError)) {
    return "Capability review could not reach the backend. Check the connection and Wayang health, then retry; no PIN was requested or submitted.";
  }
  const code = capabilityErrorCode(error);
  if (error.status === 401) {
    return "Capability review needs an authenticated owner identity. Sign in again; for remote access, verify the authenticated proxy identity bridge or use the loopback administration origin.";
  }
  if (error.status === 403 && code === "invalid_origin") {
    return "Capability review rejected this browser Origin. Use the configured exact Wayang origin or the loopback administration origin.";
  }
  if (error.status === 403) {
    return "Capability review was denied for this exact Project, Agent Profile, or privacy policy. Refresh Settings and verify that the profile is enabled and allowed by the Project.";
  }
  if (error.status === 429 && code === "cooldown") {
    return "Capability review is temporarily cooling down after prior PIN attempts. Wait for the retry period, then create a fresh review.";
  }
  if (error.status === 409) {
    return code === "realm_busy"
      ? "Another capability review is already pending. Finish or cancel it, or wait for it to expire before retrying."
      : "Capability state changed while creating the review. Refresh Settings and retry the exact association.";
  }
  if (error.status === 503 && code === "pin_unavailable") {
    return "Capability PIN approval is unavailable on this Wayang deployment. Run make doctor locally and repair only the reported PIN/cooldown metadata before retrying.";
  }
  if (error.status >= 500) {
    return "Wayang could not create the capability review. Check service diagnostics and retry; no PIN was requested or submitted.";
  }
  return "Capability review was rejected. Refresh Settings and verify the exact Project, Agent Profile, and capability before retrying.";
}

function capabilityCommitErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Capability submission could not reach the backend. Create a fresh review before trying again.";
  const code = capabilityErrorCode(error);
  if (error.status === 401) return "The authenticated owner session expired before submission. Sign in and create a fresh review.";
  if (error.status === 403 && code === "wrong_pin") return "The identity PIN was not accepted. The attempt was consumed; create a fresh review before retrying.";
  if (error.status === 403) return "Capability submission was denied for this owner or exact association. Create a fresh review.";
  if (error.status === 409) return "Capability state changed or the review was already consumed. Create a fresh review.";
  if (error.status === 410) return "The capability review expired. Create a fresh review.";
  if (error.status === 429) return "Capability approval is cooling down. Wait for the retry period, then create a fresh review.";
  if (error.status === 503) return "Capability PIN approval is unavailable on this Wayang deployment. Run make doctor locally before retrying.";
  return "Wayang could not commit the capability review. Its one-use attempt is no longer reusable; create a fresh review.";
}

const ACTIVATION_PREVIEW_TIMEOUT_MS = 12_000;

function associationKey(association: WorkspaceCapabilityAssociation): string {
  return `${association.projectId}\u0000${association.agentProfileId}\u0000${association.capabilityId}\u0000${association.revision}`;
}

export function WorkspaceCapabilitiesSettings({
  projects,
  profiles,
  onChanged,
}: WorkspaceCapabilitiesSettingsProps) {
  const [status, setStatus] = useState<WorkspaceCapabilityCatalogStatus | null>(null);
  const [capabilityId, setCapabilityId] = useState<WorkspaceCapabilityId | "">("");
  const [projectId, setProjectId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [challenge, setChallenge] = useState<WorkspaceCapabilityChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activationError, setActivationError] = useState("");
  const pinRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const activationErrorRef = useRef<HTMLDivElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const activationRequestRef = useRef<AbortController | null>(null);
  const activationRequestInFlightRef = useRef(false);
  const challengeRef = useRef<WorkspaceCapabilityChallenge | null>(null);
  const challengeWasOpenRef = useRef(false);
  const commitInFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchWorkspaceCapabilities();
      setStatus(next);
      setCapabilityId((current) => current || next.capabilities[0]?.id || "");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { challengeRef.current = challenge; }, [challenge]);
  useEffect(() => {
    if (!challenge) return;
    const settingsDialog = contentRef.current?.closest<HTMLElement>("[role='dialog'][aria-labelledby='workspace-settings-title']");
    if (!settingsDialog) return;
    const alreadyInert = settingsDialog.hasAttribute("inert");
    settingsDialog.setAttribute("inert", "");
    return () => { if (!alreadyInert) settingsDialog.removeAttribute("inert"); };
  }, [challenge]);
  useEffect(() => () => {
    activationRequestRef.current?.abort();
    activationRequestInFlightRef.current = false;
    const pending = challengeRef.current;
    if (pending) void cancelWorkspaceCapabilityActivation(pending.requestId).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (challenge) { challengeWasOpenRef.current = true; return; }
    if (!challengeWasOpenRef.current) return;
    challengeWasOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => reviewButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [challenge]);
  useEffect(() => {
    if (!activationError) return;
    const frame = window.requestAnimationFrame(() => {
      activationErrorRef.current?.focus();
      activationErrorRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activationError]);

  const selectedCapability = status?.capabilities.find((item) => item.id === capabilityId) ?? null;
  const compatibleProjects = useMemo(
    () => selectedCapability
      ? projects.filter((project) => project.access_policy.privacy_mode === selectedCapability.compatiblePrivacyMode)
      : [],
    [projects, selectedCapability],
  );
  const selectedProject = compatibleProjects.find((project) => project.id === projectId) ?? null;
  const compatibleProfiles = useMemo(() => {
    if (!selectedProject) return [];
    const allowed = selectedProject.access_policy.allowed_agent_profile_ids;
    return profiles.filter((profile) => profile.enabled && (!allowed || allowed.includes(profile.id)));
  }, [profiles, selectedProject]);

  useEffect(() => {
    if (compatibleProjects.some((project) => project.id === projectId)) return;
    setProjectId(compatibleProjects[0]?.id ?? "");
  }, [compatibleProjects, projectId]);

  useEffect(() => {
    if (compatibleProfiles.some((profile) => profile.id === profileId)) return;
    setProfileId(selectedProject?.default_agent_profile_id && compatibleProfiles.some((profile) => profile.id === selectedProject.default_agent_profile_id)
      ? selectedProject.default_agent_profile_id
      : compatibleProfiles[0]?.id ?? "");
  }, [compatibleProfiles, profileId, selectedProject]);

  const requestActivation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (activationRequestInFlightRef.current) {
      setActivationError("A capability review request is already in progress. Wait for it to finish or time out before retrying.");
      return;
    }
    if (!capabilityId || !projectId || !profileId) {
      setActivationError("Choose a capability, compatible Project, and allowed Agent Profile before requesting review.");
      return;
    }
    const controller = new AbortController();
    activationRequestInFlightRef.current = true;
    activationRequestRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, ACTIVATION_PREVIEW_TIMEOUT_MS);
    setRequesting(true);
    setActivationError("");
    setError("");
    setNotice("");
    try {
      const next = await requestWorkspaceCapabilityActivation({
        capabilityId,
        projectId,
        agentProfileId: profileId,
      }, controller.signal);
      challengeRef.current = next;
      setChallenge(next);
    } catch (caught) {
      setActivationError(activationRequestErrorMessage(caught, timedOut));
    } finally {
      window.clearTimeout(timeout);
      if (activationRequestRef.current === controller) {
        activationRequestRef.current = null;
        activationRequestInFlightRef.current = false;
        setRequesting(false);
      }
    }
  };

  const cancelChallenge = useCallback(async () => {
    const current = challenge;
    if (pinRef.current) pinRef.current.value = "";
    challengeRef.current = null;
    setChallenge(null);
    commitInFlightRef.current = false;
    if (!current) return;
    await cancelWorkspaceCapabilityActivation(current.requestId).catch(() => undefined);
  }, [challenge]);

  const commitChallenge = async (event: React.FormEvent) => {
    event.preventDefault();
    const current = challenge;
    const input = pinRef.current;
    if (!current || !input || commitInFlightRef.current) return;
    const pin = input.value;
    input.value = "";
    if (Date.now() >= current.expiresAt) {
      setChallenge(null);
      setError("This activation preview expired. Create a fresh preview before entering the PIN again.");
      return;
    }
    if (!/^\d{8}$/.test(pin)) {
      setError("Enter the complete 8-digit identity PIN.");
      return;
    }
    commitInFlightRef.current = true;
    setCommitting(true);
    setError("");
    setNotice("");
    challengeRef.current = null;
    setChallenge(null);
    try {
      await commitWorkspaceCapabilityActivation(current.requestId, pin);
      setNotice("Capability associated with the displayed Project-Agent pair. A fresh runtime can use it with any model selected for that agent.");
      await refresh();
      onChanged?.();
    } catch (caught) {
      setActivationError(capabilityCommitErrorMessage(caught));
    } finally {
      commitInFlightRef.current = false;
      setCommitting(false);
    }
  };

  const revoke = async (association: WorkspaceCapabilityAssociation) => {
    if (!window.confirm("Revoke this exact Project-Agent capability association? New operations are denied immediately, but completed host or remote browser effects cannot be undone.")) return;
    const key = associationKey(association);
    setRevokingKey(key);
    setError("");
    setNotice("");
    try {
      await revokeWorkspaceCapabilityAssociation(association);
      setNotice("Capability association revoked. Prior filesystem, process, credential, network, download, or remote-account effects remain and may require separate remediation.");
      await refresh();
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRevokingKey(null);
    }
  };

  if (loading && !status) {
    return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-neutral-500"><Loader2 size={15} className="animate-spin" /> Loading capability catalog…</div>;
  }

  const associations = status?.associations ?? [];
  const approvalEvents = status?.approvalEvents ?? [];
  return (
    <>
    <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto pb-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-neutral-100">Backend-issued capability catalog</h3>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500">Authority belongs to the stable Project-Agent association and capability ID. Names are labels only; provider and model are fluid runtime choices, not authority.</p>
            </div>
            <button type="button" onClick={() => void refresh()} disabled={loading} className={secondaryButtonClass}><RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh</button>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {(status?.capabilities ?? []).map((capability) => (
              <CapabilityCard key={capability.id} capability={capability} selected={capability.id === capabilityId} disabled={requesting} onSelect={() => { setActivationError(""); setCapabilityId(capability.id); }} />
            ))}
          </div>
        </section>

        <form onSubmit={requestActivation} aria-busy={requesting} className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/35 p-4">
          <div><h3 className="text-sm font-semibold text-neutral-100">Associate capability</h3><p className="mt-1 text-xs leading-relaxed text-neutral-500">The backend will render a fresh review of this exact Project, Agent Profile, and capability before accepting a one-use PIN submission.</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project"><select value={projectId} onChange={(event) => { setActivationError(""); setProjectId(event.target.value); }} disabled={requesting} className={inputClass}><option value="">Select compatible project</option>{compatibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.id}</option>)}</select></Field>
            <Field label="Agent profile"><select value={profileId} onChange={(event) => { setActivationError(""); setProfileId(event.target.value); }} disabled={requesting} className={inputClass}><option value="">Select allowed profile</option>{compatibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} — {profile.id}</option>)}</select></Field>
          </div>
          <div className="rounded border border-blue-900/60 bg-blue-950/20 px-3 py-2 text-xs leading-relaxed text-blue-100">
            This grants broad authority to any model currently used by this Agent Profile in this Project. Model switches invalidate old runtime actions and rebuild lazily, but do not require another PIN. The association also survives profile instruction, tool, resource, memory, and default edits, plus disable/re-enable of the same stable profile ID; a disabled profile cannot run.
          </div>
          <p className="text-xs leading-relaxed text-neutral-500">Only explicit revocation, excluding this exact profile from the project allowlist, an incompatible privacy change, or deleting the Project or Agent Profile ends the association. Restoring an excluded/deleted relationship requires a new activation.</p>
          {selectedCapability && <div className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100"><AlertTriangle size={14} className="mr-2 inline text-amber-400" />{CAPABILITY_RISK_DETAILS[selectedCapability.id]}</div>}
          {activationError && <div ref={activationErrorRef} id="capability-review-error" role="alert" tabIndex={-1} className="flex items-start gap-2 rounded border border-red-900/70 bg-red-950/30 px-3 py-2 text-xs leading-relaxed text-red-200 outline-none focus:ring-2 focus:ring-red-500"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{activationError}</div>}
          <div className="flex justify-end"><button ref={reviewButtonRef} type="submit" aria-describedby={activationError ? "capability-review-error" : undefined} disabled={requesting || !capabilityId || !projectId || !profileId} className={primaryButtonClass}>{requesting ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Review association</button></div>
        </form>

        <section className="space-y-3" aria-labelledby="current-capability-associations">
          <div><h3 id="current-capability-associations" className="text-sm font-semibold text-neutral-100">Current associations</h3><p className="mt-1 text-xs text-neutral-500">These rows are current authority state. Revocation uses the exact triple and expected revision so a stale page cannot revoke a newer reactivation.</p></div>
          {associations.length === 0 ? <div className="rounded border border-neutral-800 p-4 text-sm text-neutral-500">No current capability associations.</div> : (
            <div className="space-y-2">{associations.map((association) => <AssociationRow key={associationKey(association)} association={association} projects={projects} profiles={profiles} revoking={revokingKey === associationKey(association)} onRevoke={() => void revoke(association)} />)}</div>
          )}
        </section>

        <section className="space-y-3" aria-labelledby="capability-approval-history">
          <div><h3 id="capability-approval-history" className="text-sm font-semibold text-neutral-100">Approval history</h3><p className="mt-1 text-xs text-neutral-500">Bounded audit history is displayed separately and is never consulted as live authority. Deleted subjects remain identified by their stable IDs.</p></div>
          {approvalEvents.length === 0 ? <div className="rounded border border-neutral-800 p-4 text-sm text-neutral-500">No capability approval history.</div> : (
            <div className="space-y-2">{approvalEvents.map((event) => <ApprovalEventRow key={event.id} event={event} projects={projects} profiles={profiles} />)}</div>
          )}
          {status?.history.hasMore && <p className="text-xs text-neutral-500">Older approval history exists but was not returned by the bounded status response.</p>}
        </section>

        {notice && <div role="status" className="flex items-start gap-2 rounded border border-emerald-900/60 bg-emerald-950/25 px-3 py-2 text-xs text-emerald-200"><Check size={14} className="mt-0.5 shrink-0" />{notice}</div>}
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
    </div>
    {challenge && createPortal(<ActivationChallenge challenge={challenge} committing={committing} pinRef={pinRef} onSubmit={commitChallenge} onCancel={() => void cancelChallenge()} />, document.body)}
    </>
  );
}

function CapabilityCard({ capability, selected, disabled, onSelect }: { capability: WorkspaceCapabilityCatalogItem; selected: boolean; disabled: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} disabled={disabled} className={`rounded-lg border p-3 text-left disabled:opacity-60 ${selected ? "border-blue-600 bg-blue-950/35" : "border-neutral-800 bg-neutral-950/60 hover:border-neutral-700"}`}><div className="text-sm font-semibold text-neutral-100">{capability.title}</div><div className="mt-1 break-all font-mono text-[10px] text-blue-300">{capability.id}</div><div className="mt-2 text-xs leading-relaxed text-neutral-400">{capability.riskSummary}</div><div className="mt-2 text-[10px] uppercase text-neutral-600">{capability.compatiblePrivacyMode} projects</div></button>;
}

function subjectLabel(label: string | undefined, kind: "project" | "profile", id: string): React.ReactNode {
  return <>{label ?? `Deleted ${kind}`} <code className="text-neutral-600">{id}</code></>;
}

function AssociationRow({ association, projects, profiles, revoking, onRevoke }: { association: WorkspaceCapabilityAssociation; projects: WorkspaceProject[]; profiles: AgentProfileSummary[]; revoking: boolean; onRevoke: () => void }) {
  const project = projects.find((candidate) => candidate.id === association.projectId);
  const profile = profiles.find((candidate) => candidate.id === association.agentProfileId);
  return <article className={`rounded border px-3 py-3 ${association.active ? "border-emerald-900/60 bg-emerald-950/15" : "border-neutral-800 bg-neutral-900/30"}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2 text-xs"><span className={association.active ? "font-semibold text-emerald-300" : "text-neutral-500"}>{association.active ? "ACTIVE" : "INACTIVE"}</span><code className="break-all text-neutral-300">{association.capabilityId}</code></div><div className="mt-2 text-xs text-neutral-400">{subjectLabel(project?.name, "project", association.projectId)}</div><div className="text-xs text-neutral-400">{subjectLabel(profile?.name, "profile", association.agentProfileId)}</div><div className="mt-1 font-mono text-[10px] text-neutral-600">Association revision {association.revision}</div><div className="mt-1 text-[10px] text-neutral-600">Approved {new Date(association.approvedAt).toLocaleString()}{association.revokedAt !== null ? ` · revoked ${new Date(association.revokedAt).toLocaleString()}` : ""}</div></div>{association.active && <button type="button" onClick={onRevoke} disabled={revoking} className="inline-flex items-center gap-2 rounded border border-red-900/70 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-950/40 disabled:opacity-50">{revoking ? <Loader2 size={13} className="animate-spin" /> : <ShieldOff size={13} />} Revoke</button>}</div></article>;
}

function ApprovalEventRow({ event, projects, profiles }: { event: WorkspaceCapabilityApprovalEvent; projects: WorkspaceProject[]; profiles: AgentProfileSummary[] }) {
  const project = projects.find((candidate) => candidate.id === event.projectId);
  const profile = profiles.find((candidate) => candidate.id === event.agentProfileId);
  return <article className="rounded border border-neutral-800 bg-neutral-900/30 px-3 py-3"><div className="flex items-center gap-2 text-xs"><span className="text-neutral-500">AUDIT</span><code className="break-all text-neutral-300">{event.capabilityId}</code></div><div className="mt-2 text-xs text-neutral-400">{subjectLabel(project?.name, "project", event.projectId)}</div><div className="text-xs text-neutral-400">{subjectLabel(profile?.name, "profile", event.agentProfileId)}</div><div className="mt-1 font-mono text-[10px] text-neutral-600">Event {event.id} · association revision {event.associationRevision}</div><div className="mt-1 break-all font-mono text-[10px] text-neutral-600">Operation digest {event.operationDigest}</div><div className="mt-1 text-[10px] text-neutral-600">Approved {new Date(event.approvedAt).toLocaleString()}{event.revokedAt !== null ? ` · revoked ${new Date(event.revokedAt).toLocaleString()}` : ""}</div></article>;
}

function ActivationChallenge({ challenge, committing, pinRef, onSubmit, onCancel }: { challenge: WorkspaceCapabilityChallenge; committing: boolean; pinRef: React.RefObject<HTMLInputElement | null>; onSubmit: (event: React.FormEvent) => void; onCancel: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => pinRef.current?.focus());
    const containFocus = (event: FocusEvent) => {
      if (dialogRef.current?.contains(event.target as Node)) return;
      pinRef.current?.focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", containFocus);
    };
  }, [pinRef]);
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !committing) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])]
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (!dialogRef.current?.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return <div ref={dialogRef} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3" role="dialog" aria-modal="true" aria-labelledby="capability-challenge-title" onKeyDown={handleKeyDown}><div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-red-800 bg-neutral-950 shadow-2xl"><header className="border-b border-red-900/60 bg-red-950/25 px-4 py-3"><div className="text-[10px] font-bold uppercase tracking-widest text-red-300">Project-Agent capability association · PIN required</div><h2 id="capability-challenge-title" className="mt-1 text-base font-semibold text-neutral-100">{challenge.summary}</h2></header><div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"><dl className="grid gap-x-4 gap-y-2 rounded border border-neutral-800 bg-neutral-900/50 p-3 text-xs sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-neutral-500">Capability ID</dt><dd className="break-all font-mono text-neutral-100">{challenge.capabilityId}</dd><dt className="text-neutral-500">Project</dt><dd className="break-all text-neutral-100">{challenge.projectLabel} · <code>{challenge.projectId}</code>{challenge.projectCwd ? <> · <code>{challenge.projectCwd}</code></> : null}</dd><dt className="text-neutral-500">Agent profile</dt><dd className="break-all text-neutral-100">{challenge.agentProfileLabel} · <code>{challenge.agentProfileId}</code></dd>{challenge.privacyMode && <><dt className="text-neutral-500">Project policy</dt><dd className="text-neutral-100">{challenge.privacyMode} · exact profile {challenge.profileAllowed === false ? "not allowed" : "allowed"}</dd></>}{challenge.profileEnabled !== undefined && <><dt className="text-neutral-500">Profile state</dt><dd className="text-neutral-100">{challenge.profileEnabled ? "enabled" : "disabled"}</dd></>}<dt className="text-neutral-500">Association revision</dt><dd className="font-mono text-neutral-100">{challenge.association.before?.revision ?? "new"} → {challenge.association.after.revision}</dd>{challenge.previewStateDigest && <><dt className="text-neutral-500">Preview state digest</dt><dd className="break-all font-mono text-neutral-300">{challenge.previewStateDigest}</dd></>}<dt className="text-neutral-500">Operation digest</dt><dd className="break-all font-mono text-neutral-300">{challenge.operationDigest}</dd><dt className="text-neutral-500">Expires</dt><dd className="text-neutral-100">{new Date(challenge.expiresAt).toLocaleString()}</dd></dl><div className="rounded border border-blue-900/60 bg-blue-950/20 p-3 text-xs leading-relaxed text-blue-100">This authority follows the stable Project-Agent IDs across every provider/model change and across profile instruction, tool, resource, memory, and default edits. Disabling blocks the profile but preserves the association; re-enabling the same ID restores it through a fresh runtime without another PIN. Only explicit revocation, exact-profile allowlist exclusion, incompatible privacy, or subject deletion ends it, and revocation cannot undo completed effects.</div><div className="rounded border border-amber-900/60 bg-amber-950/20 p-3"><div className="text-xs font-semibold uppercase text-amber-300">Consequences</div><ul className="mt-2 list-disc space-y-2 pl-5 text-xs leading-relaxed text-amber-100">{challenge.consequences.map((line) => <li key={line}>{line}</li>)}</ul></div>{challenge.affectedRuntimes.length > 0 && <div className="text-xs text-neutral-400">Affected idle runtimes: {challenge.affectedRuntimes.map((runtime) => `${runtime.runtimeId} (${runtime.status})`).join(", ")}</div>}</div><form autoComplete="off" onSubmit={onSubmit} className="border-t border-neutral-800 p-4"><label htmlFor="workspace-capability-pin" className="text-xs font-semibold text-neutral-300">8-digit identity PIN</label><p className="mt-1 text-xs text-neutral-500">Read once from this field, cleared immediately, and sent in one non-retrying no-store request.</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><input ref={pinRef} id="workspace-capability-pin" type="password" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} defaultValue="" onInput={(event) => { event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "").slice(0, 8); }} autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 tracking-widest text-neutral-100 outline-none focus:border-red-500" /><button type="submit" disabled={committing} className="rounded bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-600 disabled:opacity-40">{committing ? "Submitting…" : "Associate capability"}</button><button type="button" onClick={onCancel} disabled={committing} className="rounded border border-neutral-700 px-3 py-2 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">Cancel</button></div></form></div></div>;
}
