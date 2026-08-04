import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  "wayang.host-execution.v1":
    "Host execution runs as the Wayang OS user outside the filesystem sandbox. It can affect same-UID files, processes, credentials, network services, and existing privilege mechanisms. A person authenticated to a remotely exposed Wayang instance can trigger those host effects.",
  "wayang.protected-browser.v1":
    "The agent may navigate, click, type non-secret text, download, and cause remote mutations. Existing authenticated cookies may permit purchases, deletion, exports, account-setting changes, logout, or browser-mediated passkey flows; human login handoff does not make later actions read-only.",
  "wayang.protected-automation.v1":
    "Deterministic scheduled Node code runs without a shell and can read or persist writes throughout its exact Protected project; completed or racing writes cannot be rolled back. The child has no generic TCP, UDP, or Unix-socket network access, but backend-owned browser RPC can use authenticated state at agent-configured HTTPS origins to disclose data or cause consequential account changes. Passwords, MFA, CAPTCHA, payments, recovery, and other secret-bearing steps remain human-only. This is not isolation from same-UID processes or trusted in-process code.",
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "Capability Settings requires an authenticated Wayang session. Remote passwordless access cannot approve capabilities; enable the shared password or use a loopback browser origin.";
  }
  return error instanceof ApiError ? error.message || `HTTP ${error.status}` : String(error);
}

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
  const pinRef = useRef<HTMLInputElement>(null);
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
    if (!capabilityId || !projectId || !profileId || requesting) return;
    setRequesting(true);
    setError("");
    setNotice("");
    try {
      setChallenge(await requestWorkspaceCapabilityActivation({
        capabilityId,
        projectId,
        agentProfileId: profileId,
      }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRequesting(false);
    }
  };

  const cancelChallenge = useCallback(async () => {
    const current = challenge;
    if (pinRef.current) pinRef.current.value = "";
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
    setChallenge(null);
    try {
      await commitWorkspaceCapabilityActivation(current.requestId, pin);
      setNotice("Capability associated with the displayed Project-Agent pair. A fresh runtime can use it with any model selected for that agent.");
      await refresh();
      onChanged?.();
    } catch (caught) {
      setError(`${errorMessage(caught)} Create a fresh activation preview before trying again.`);
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
    <div className="min-h-0 flex-1 overflow-y-auto pb-6">
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
              <CapabilityCard key={capability.id} capability={capability} selected={capability.id === capabilityId} onSelect={() => setCapabilityId(capability.id)} />
            ))}
          </div>
        </section>

        <form onSubmit={requestActivation} className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/35 p-4">
          <div><h3 className="text-sm font-semibold text-neutral-100">Associate capability</h3><p className="mt-1 text-xs leading-relaxed text-neutral-500">The backend will render a fresh review of this exact Project, Agent Profile, and capability before accepting a one-use PIN submission.</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project"><select value={projectId} onChange={(event) => setProjectId(event.target.value)} className={inputClass}><option value="">Select compatible project</option>{compatibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.id}</option>)}</select></Field>
            <Field label="Agent profile"><select value={profileId} onChange={(event) => setProfileId(event.target.value)} className={inputClass}><option value="">Select allowed profile</option>{compatibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} — {profile.id}</option>)}</select></Field>
          </div>
          <div className="rounded border border-blue-900/60 bg-blue-950/20 px-3 py-2 text-xs leading-relaxed text-blue-100">
            This grants broad authority to any model currently used by this Agent Profile in this Project. Model switches invalidate old runtime actions and rebuild lazily, but do not require another PIN. The association also survives profile instruction, tool, resource, memory, and default edits, plus disable/re-enable of the same stable profile ID; a disabled profile cannot run.
          </div>
          <p className="text-xs leading-relaxed text-neutral-500">Only explicit revocation, excluding this exact profile from the project allowlist, an incompatible privacy change, or deleting the Project or Agent Profile ends the association. Restoring an excluded/deleted relationship requires a new activation.</p>
          {selectedCapability && <div className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100"><AlertTriangle size={14} className="mr-2 inline text-amber-400" />{CAPABILITY_RISK_DETAILS[selectedCapability.id]}</div>}
          <div className="flex justify-end"><button type="submit" disabled={requesting || !capabilityId || !projectId || !profileId} className={primaryButtonClass}>{requesting ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Review association</button></div>
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

      {challenge && <ActivationChallenge challenge={challenge} committing={committing} pinRef={pinRef} onSubmit={commitChallenge} onCancel={() => void cancelChallenge()} />}
    </div>
  );
}

function CapabilityCard({ capability, selected, onSelect }: { capability: WorkspaceCapabilityCatalogItem; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} className={`rounded-lg border p-3 text-left ${selected ? "border-blue-600 bg-blue-950/35" : "border-neutral-800 bg-neutral-950/60 hover:border-neutral-700"}`}><div className="text-sm font-semibold text-neutral-100">{capability.title}</div><div className="mt-1 break-all font-mono text-[10px] text-blue-300">{capability.id}</div><div className="mt-2 text-xs leading-relaxed text-neutral-400">{capability.riskSummary}</div><div className="mt-2 text-[10px] uppercase text-neutral-600">{capability.compatiblePrivacyMode} projects</div></button>;
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
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3" role="dialog" aria-modal="true" aria-labelledby="capability-challenge-title" onKeyDown={(event) => { if (event.key === "Escape" && !committing) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}><div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-red-800 bg-neutral-950 shadow-2xl"><header className="border-b border-red-900/60 bg-red-950/25 px-4 py-3"><div className="text-[10px] font-bold uppercase tracking-widest text-red-300">Project-Agent capability association · PIN required</div><h2 id="capability-challenge-title" className="mt-1 text-base font-semibold text-neutral-100">{challenge.summary}</h2></header><div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"><dl className="grid gap-x-4 gap-y-2 rounded border border-neutral-800 bg-neutral-900/50 p-3 text-xs sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-neutral-500">Capability ID</dt><dd className="break-all font-mono text-neutral-100">{challenge.capabilityId}</dd><dt className="text-neutral-500">Project</dt><dd className="break-all text-neutral-100">{challenge.projectLabel} · <code>{challenge.projectId}</code>{challenge.projectCwd ? <> · <code>{challenge.projectCwd}</code></> : null}</dd><dt className="text-neutral-500">Agent profile</dt><dd className="break-all text-neutral-100">{challenge.agentProfileLabel} · <code>{challenge.agentProfileId}</code></dd>{challenge.privacyMode && <><dt className="text-neutral-500">Project policy</dt><dd className="text-neutral-100">{challenge.privacyMode} · exact profile {challenge.profileAllowed === false ? "not allowed" : "allowed"}</dd></>}{challenge.profileEnabled !== undefined && <><dt className="text-neutral-500">Profile state</dt><dd className="text-neutral-100">{challenge.profileEnabled ? "enabled" : "disabled"}</dd></>}<dt className="text-neutral-500">Association revision</dt><dd className="font-mono text-neutral-100">{challenge.association.before?.revision ?? "new"} → {challenge.association.after.revision}</dd>{challenge.previewStateDigest && <><dt className="text-neutral-500">Preview state digest</dt><dd className="break-all font-mono text-neutral-300">{challenge.previewStateDigest}</dd></>}<dt className="text-neutral-500">Operation digest</dt><dd className="break-all font-mono text-neutral-300">{challenge.operationDigest}</dd><dt className="text-neutral-500">Expires</dt><dd className="text-neutral-100">{new Date(challenge.expiresAt).toLocaleString()}</dd></dl><div className="rounded border border-blue-900/60 bg-blue-950/20 p-3 text-xs leading-relaxed text-blue-100">This authority follows the stable Project-Agent IDs across every provider/model change and across profile instruction, tool, resource, memory, and default edits. Disabling blocks the profile but preserves the association; re-enabling the same ID restores it through a fresh runtime without another PIN. Only explicit revocation, exact-profile allowlist exclusion, incompatible privacy, or subject deletion ends it, and revocation cannot undo completed effects.</div><div className="rounded border border-amber-900/60 bg-amber-950/20 p-3"><div className="text-xs font-semibold uppercase text-amber-300">Consequences</div><ul className="mt-2 list-disc space-y-2 pl-5 text-xs leading-relaxed text-amber-100">{challenge.consequences.map((line) => <li key={line}>{line}</li>)}</ul></div>{challenge.affectedRuntimes.length > 0 && <div className="text-xs text-neutral-400">Affected idle runtimes: {challenge.affectedRuntimes.map((runtime) => `${runtime.runtimeId} (${runtime.status})`).join(", ")}</div>}</div><form autoComplete="off" onSubmit={onSubmit} className="border-t border-neutral-800 p-4"><label htmlFor="workspace-capability-pin" className="text-xs font-semibold text-neutral-300">8-digit identity PIN</label><p className="mt-1 text-xs text-neutral-500">Read once from this field, cleared immediately, and sent in one non-retrying no-store request.</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><input ref={pinRef} id="workspace-capability-pin" type="password" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} defaultValue="" onInput={(event) => { event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "").slice(0, 8); }} autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 tracking-widest text-neutral-100 outline-none focus:border-red-500" /><button type="submit" disabled={committing} className="rounded bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-600 disabled:opacity-40">{committing ? "Submitting…" : "Associate capability"}</button><button type="button" onClick={onCancel} disabled={committing} className="rounded border border-neutral-700 px-3 py-2 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">Cancel</button></div></form></div></div>;
}
