import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  KeyRound,
  Link2,
  Loader2,
  Pause,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import {
  ApiError,
  cancelProtectedAutomationPurge,
  cancelProtectedAutomationRun,
  closeProtectedAutomationPreparation,
  commitProtectedAutomationPurge,
  getProtectedAutomation,
  getProtectedAutomationPreparation,
  listProtectedAutomations,
  navigateProtectedAutomationPreparation,
  pauseProtectedAutomation,
  requestProtectedAutomationPurge,
  type ProtectedAutomationDetail,
  type ProtectedAutomationJob,
  type ProtectedAutomationPreparation,
  type ProtectedAutomationPreparationSelection,
  type ProtectedAutomationPurgeChallenge,
  type ProtectedAutomationRun,
  type ProtectedAutomationStatus,
} from "../api/client";
import { ProtectedAutomationCredentialsDrawer } from "../components/automation/ProtectedAutomationCredentialsDrawer";
import { CdpScreencastViewer } from "../components/browser/BrowserViewer";
import { formatRelativeTime } from "../utils/time";

interface ProtectedAutomationsPanelProps {
  selectedJobId: string | null;
  sourceSessionId: string | null;
  onSelectJob: (jobId: string | null) => void;
  onChanged?: () => void;
  onClose?: () => void;
}

type LoadState = "loading" | "ready" | "unavailable" | "stale" | "error";

function allowedOriginLabel(origin: string): string {
  try { return new URL(origin).hostname; }
  catch { return "allowed site"; }
}

export function ProtectedAutomationsPanel({
  selectedJobId,
  sourceSessionId,
  onSelectJob,
  onChanged,
  onClose,
}: ProtectedAutomationsPanelProps) {
  const [status, setStatus] = useState<ProtectedAutomationStatus | null>(null);
  const [detail, setDetail] = useState<ProtectedAutomationDetail | null>(null);
  const [catalogJobs, setCatalogJobs] = useState<ProtectedAutomationJob[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [sourceInput, setSourceInput] = useState(sourceSessionId ?? "");
  const [preparationInput, setPreparationInput] = useState("");
  const [preparation, setPreparation] = useState<ProtectedAutomationPreparation | null>(null);
  const [preparationSelection, setPreparationSelection] = useState<ProtectedAutomationPreparationSelection | null>(null);
  const [credentialsOpen, setCredentialsOpen] = useState(false);

  const [purgeChallenge, setPurgeChallenge] = useState<ProtectedAutomationPurgeChallenge | null>(null);
  const purgeChallengeRef = useRef<{ jobId: string; requestId: string } | null>(null);
  const [purgePin, setPurgePin] = useState("");
  const [purgeError, setPurgeError] = useState<string | null>(null);

  useEffect(() => {
    if (sourceSessionId) setSourceInput(sourceSessionId);
  }, [sourceSessionId]);

  useEffect(() => {
    purgeChallengeRef.current = purgeChallenge
      ? { jobId: purgeChallenge.job_id, requestId: purgeChallenge.request_id }
      : null;
  }, [purgeChallenge]);

  useEffect(() => () => {
    const pending = purgeChallengeRef.current;
    if (pending) void cancelProtectedAutomationPurge(pending.jobId, pending.requestId).catch(() => undefined);
    purgeChallengeRef.current = null;
  }, []);

  const refreshPreparation = useCallback(async (quiet = false) => {
    if (!preparationSelection) return;
    try {
      const next = await getProtectedAutomationPreparation(preparationSelection);
      setPreparation(next);
      if (!quiet) setNotice("Exact source-bound preparation attached.");
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 404 || caught.status === 410)) {
        setPreparation(null);
        setPreparationSelection(null);
        setCredentialsOpen(false);
        setNotice("The selected preparation is no longer available.");
        return;
      }
      setError(errorMessage(caught));
    }
  }, [preparationSelection]);

  const handlePreparationViewerStatus = useCallback(() => {
    void refreshPreparation(true);
  }, [refreshPreparation]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoadState("loading");
    setError(null);
    try {
      if (selectedJobId) {
        const next = await getProtectedAutomation(selectedJobId);
        setStatus(next.status);
        setDetail(next);
      } else {
        const catalog = await listProtectedAutomations();
        setStatus(catalog.status);
        setCatalogJobs(catalog.jobs);
        setDetail(null);
      }
      setLoadState("ready");
    } catch (caught) {
      setDetail(null);
      if (caught instanceof ApiError && caught.status === 503) {
        setStatus(null);
        setLoadState("unavailable");
      } else if (selectedJobId && caught instanceof ApiError && caught.status === 404) {
        setLoadState("stale");
      } else {
        setError(errorMessage(caught));
        setLoadState("error");
      }
    }
  }, [selectedJobId]);

  useEffect(() => {
    setPreparation(null);
    setPreparationSelection(null);
    setPreparationInput("");
    setCredentialsOpen(false);
    setPurgeChallenge(null);
    setPurgePin("");
    setPurgeError(null);
    setNotice(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || busyAction || purgeChallenge) return;
      void refresh(true);
      void refreshPreparation(true);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [busyAction, purgeChallenge, refresh, refreshPreparation]);

  const pause = useCallback(async () => {
    const job = detail?.job;
    if (!job || busyAction) return;
    setBusyAction("pause");
    setError(null);
    try {
      const result = await pauseProtectedAutomation(job.id, job.revision);
      setDetail((previous) => previous ? { ...previous, job: result.job } : previous);
      setNotice("Emergency pause committed. Active work is being terminated by the backend.");
      onChanged?.();
      void refresh(true);
    } catch (caught) {
      setError(errorMessage(caught));
      if (caught instanceof ApiError && caught.status === 409) void refresh(true);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, detail?.job, onChanged, refresh]);

  const cancelRun = useCallback(async (run: ProtectedAutomationRun) => {
    const job = detail?.job;
    if (!job || busyAction) return;
    setBusyAction(`cancel:${run.id}`);
    setError(null);
    try {
      const result = await cancelProtectedAutomationRun(job.id, run.id);
      setDetail((previous) => previous ? {
        ...previous,
        runs: previous.runs.map((candidate) => candidate.id === result.run.id ? result.run : candidate),
      } : previous);
      setNotice("Emergency cancellation sent. The returned run projection is shown below.");
      onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, detail?.job, onChanged]);

  const attachPreparation = useCallback(async () => {
    const job = detail?.job;
    const selection = job ? {
      sourceSessionId: sourceInput.trim(),
      jobId: job.id,
      preparationId: preparationInput.trim(),
    } : null;
    if (!selection?.sourceSessionId || !selection.preparationId || busyAction) return;
    setBusyAction("attach-preparation");
    setError(null);
    try {
      const next = await getProtectedAutomationPreparation(selection);
      setPreparationSelection(selection);
      setPreparation(next);
      setNotice("Exact source-bound preparation attached.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, detail?.job, preparationInput, sourceInput]);

  const closePreparation = useCallback(async () => {
    if (!preparationSelection || busyAction) return;
    setBusyAction("close-preparation");
    setError(null);
    try {
      await closeProtectedAutomationPreparation(preparationSelection);
      setPreparation(null);
      setPreparationSelection(null);
      setPreparationInput("");
      setCredentialsOpen(false);
      await refresh(true);
      setNotice("Preparation saved to the protected browser profile and closed. Future runs will reuse it.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, preparationSelection, refresh]);

  const navigatePreparation = useCallback(async (origin: string) => {
    if (!preparationSelection || busyAction) return;
    let url: string;
    try { url = new URL("/", origin).toString(); }
    catch { setError("The configured preparation origin is invalid."); return; }
    setBusyAction("navigate-preparation");
    setError(null);
    try {
      const next = await navigateProtectedAutomationPreparation(preparationSelection, url);
      setPreparation(next);
      setNotice(`Preparation opened ${allowedOriginLabel(origin)}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, preparationSelection]);

  const requestPurge = useCallback(async () => {
    const job = detail?.job;
    if (!job || busyAction || job.deleted_at === null) return;
    setBusyAction("request-purge");
    setError(null);
    setPurgeError(null);
    setPurgePin("");
    try {
      setPurgeChallenge(await requestProtectedAutomationPurge(job.id, job.revision));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, detail?.job]);

  const cancelPurge = useCallback(async () => {
    const job = detail?.job;
    const challenge = purgeChallenge;
    setPurgePin("");
    if (!job || !challenge || busyAction === "commit-purge" || busyAction === "cancel-purge") return;
    setBusyAction("cancel-purge");
    setPurgeError(null);
    try {
      await cancelProtectedAutomationPurge(job.id, challenge.request_id);
      setPurgeChallenge(null);
    } catch (caught) {
      setPurgeError(errorMessage(caught));
    } finally {
      setPurgePin("");
      setBusyAction(null);
    }
  }, [busyAction, detail?.job, purgeChallenge]);

  const commitPurge = useCallback(async () => {
    const job = detail?.job;
    const challenge = purgeChallenge;
    if (!job || !challenge || busyAction || purgePin.length !== 8) return;
    const pin = purgePin;
    setPurgePin("");
    setBusyAction("commit-purge");
    setPurgeError(null);
    try {
      await commitProtectedAutomationPurge(job.id, challenge.request_id, pin);
      setPurgeChallenge(null);
      setPreparation(null);
      setPreparationSelection(null);
      setCredentialsOpen(false);
      onChanged?.();
      onSelectJob(null);
    } catch (caught) {
      // Commit consumes the one-use challenge even when the PIN is rejected or
      // the final tombstone check conflicts. Never retain a reusable-looking
      // dialog or PIN field after a commit attempt.
      setError(`Purge was not completed: ${errorMessage(caught)}`);
      setPurgeChallenge(null);
      setPurgeError(null);
    } finally {
      setPurgePin("");
      setBusyAction(null);
    }
  }, [busyAction, detail?.job, onChanged, onSelectJob, purgeChallenge, purgePin]);

  const job = detail?.job ?? null;
  const held = status?.activationAvailable === false;
  const productionAvailable = status?.production_services === true;
  const activeRuns = useMemo(
    () => detail?.runs.filter((run) => run.status === "queued" || run.status === "running") ?? [],
    [detail?.runs],
  );

  return (
    <div data-testid="protected-automations-panel" className="relative flex h-full min-h-0 flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-900 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 items-center gap-3">
          {onClose && <button type="button" onClick={onClose} aria-label="Back to chat" className="rounded p-1 text-neutral-400 hover:bg-neutral-800"><ArrowLeft size={18} /></button>}
          <ShieldCheck size={20} className="shrink-0 text-violet-300" />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">Protected Automations</h1>
            <p className="text-xs text-neutral-500">Deterministic protected jobs — not Scheduled Agent Jobs</p>
          </div>
        </div>
        <button type="button" data-testid="protected-automation-refresh" disabled={Boolean(busyAction)} onClick={() => void refresh()} className="rounded border border-neutral-700 p-2 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40" aria-label="Refresh protected automations">
          <RefreshCw size={14} className={loadState === "loading" ? "animate-spin" : ""} />
        </button>
      </header>

      {status && (
        <div data-testid="protected-automations-status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-900 px-4 py-2 text-xs text-neutral-500 sm:px-6">
          <span>Milestone {safeNumber(status.milestone)}</span>
          <span>{productionAvailable ? "production services online" : "production services unavailable"}</span>
          <span className={held ? "text-amber-300" : "text-emerald-300"}>{held ? "activation held" : "activation available"}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {held && (
          <div data-testid="protected-automations-held" className="mx-auto mb-4 max-w-5xl rounded border border-amber-900/60 bg-amber-950/20 p-3 text-xs leading-relaxed text-amber-100/80">
            Activation is held. This owner surface cannot create, enable, rebind, or run jobs. Existing metadata is read-only except for emergency pause/cancel, exact human preparation handoff, and PIN-approved purge of an already tombstoned job.
          </div>
        )}

        {loadState === "loading" && <StatusLine><Loader2 size={16} className="animate-spin" /> Loading backend status…</StatusLine>}
        {loadState === "unavailable" && <UnavailableState onRetry={() => void refresh()} />}
        {loadState === "stale" && <StaleSelection onOverview={() => onSelectJob(null)} />}
        {loadState === "error" && <ErrorState message={error} onRetry={() => void refresh()} />}

        {loadState === "ready" && !selectedJobId && <AutomationOverview jobs={catalogJobs} onSelectJob={onSelectJob} />}

        {loadState === "ready" && job && detail && (
          <div className="mx-auto max-w-5xl space-y-4">
            <section data-testid="protected-automation-detail" className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-xl font-semibold">{safeText(job.name, "Unnamed automation")}</h2>
                    <JobStatus job={job} runs={detail.runs} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
                    <IdLabel label="Project" value={job.project_id} />
                    <IdLabel label="Agent" value={job.agent_profile_id} />
                    <span className="font-mono">{safeText(job.cron_expr, "schedule unavailable")}</span>
                    <span>revision {safeNumber(job.revision)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {job.enabled && job.deleted_at === null && (
                    <ActionButton testId="protected-automation-pause" busy={busyAction === "pause"} disabled={Boolean(busyAction)} onClick={() => void pause()} icon={<Pause size={13} />}>Emergency pause</ActionButton>
                  )}
                  {job.deleted_at !== null && (
                    <ActionButton danger testId="protected-automation-purge-request" busy={busyAction === "request-purge"} disabled={Boolean(busyAction) || activeRuns.length > 0} onClick={() => void requestPurge()} icon={<Trash2 size={13} />}>Request purge</ActionButton>
                  )}
                </div>
              </div>

              {job.blocked_reason && <div data-testid="protected-automation-blocked" className="mt-4 flex items-start gap-2 rounded border border-amber-900/60 bg-amber-950/25 p-3 text-xs text-amber-100"><ShieldAlert size={15} className="mt-0.5 shrink-0" /><span><strong>Backend block:</strong> {humanize(job.blocked_reason)}</span></div>}
              {job.attention && <div data-testid="protected-automation-attention" className="mt-4 flex items-start gap-2 rounded border border-sky-900/60 bg-sky-950/30 p-3 text-xs text-sky-100"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span><strong>Human attention:</strong> {humanize(job.attention.reason)}. Ask the source agent to issue a preparation, then attach it below.</span></div>}

              <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <Info label="Next run" value={formatTimestamp(job.next_run_at)} />
                <Info label="Last run" value={job.last_run_at == null ? "never" : formatRelativeTime(job.last_run_at)} />
                <Info label="Timeout" value={Number.isFinite(job.timeout_ms) ? `${Math.round(job.timeout_ms / 60_000)} min` : "—"} />
                <Info label="Missed run" value={humanize(safeText(job.missed_run_policy, "—"))} />
              </div>
            </section>

            {job.uses_browser_profile && job.deleted_at === null && (
              <section data-testid="protected-automation-preparation" className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/50">
                <div className="border-b border-neutral-800 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Human preparation</h3>
                      <p className="mt-1 text-xs text-neutral-500">Attach only with IDs returned by the source-bound agent preparation tool. Login state is stored in the protected browser profile; Save &amp; close stops Chromium cleanly for later runs.</p>
                    </div>
                    {preparation && preparationSelection && (
                      <div className="flex flex-wrap gap-2">
                        {preparation.state === "ready" && preparation.allowed_https_origins.map((origin, index) => (
                          <ActionButton
                            key={origin}
                            testId={`protected-automation-preparation-open-${index}`}
                            busy={busyAction === "navigate-preparation"}
                            disabled={Boolean(busyAction)}
                            onClick={() => void navigatePreparation(origin)}
                            icon={<Link2 size={13} />}
                          >Open {allowedOriginLabel(origin)}</ActionButton>
                        ))}
                        {preparation.state === "ready" && preparation.credential_broker?.supported === true && <ActionButton testId="protected-automation-credentials" disabled={Boolean(busyAction)} onClick={() => setCredentialsOpen(true)} icon={<KeyRound size={13} />}>Credentials</ActionButton>}
                        <ActionButton testId="protected-automation-preparation-close" busy={busyAction === "close-preparation"} disabled={Boolean(busyAction)} onClick={() => void closePreparation()} icon={<Square size={13} />}>Save &amp; close preparation</ActionButton>
                      </div>
                    )}
                  </div>

                  <div data-testid="protected-automation-browser-profile-state" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
                    <span>Protected browser profile:</span>
                    <strong className={job.browser_profile?.saved ? "text-emerald-300" : "text-neutral-300"}>
                      {job.browser_profile?.saved ? "saved" : "not yet saved"}
                    </strong>
                    {job.browser_profile?.saved && job.browser_profile.last_saved_at !== null && (
                      <span>Last saved {formatTimestamp(job.browser_profile.last_saved_at)}</span>
                    )}
                  </div>

                  {!preparation && (
                    <form className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); void attachPreparation(); }}>
                      <label className="text-[11px] text-neutral-400">Source session ID
                        <input data-testid="protected-automation-preparation-source-session" value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} autoComplete="off" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-2 font-mono text-xs text-neutral-100 focus:border-violet-500 focus:outline-none" />
                      </label>
                      <label className="text-[11px] text-neutral-400">Preparation ID
                        <input data-testid="protected-automation-preparation-id" value={preparationInput} onChange={(event) => setPreparationInput(event.target.value)} autoComplete="off" className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-2 font-mono text-xs text-neutral-100 focus:border-violet-500 focus:outline-none" />
                      </label>
                      <button type="submit" data-testid="protected-automation-preparation-attach" disabled={Boolean(busyAction) || !sourceInput.trim() || !preparationInput.trim()} className="mt-auto inline-flex items-center justify-center gap-1.5 rounded border border-neutral-700 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40">{busyAction === "attach-preparation" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Attach</button>
                    </form>
                  )}
                </div>

                {preparation && (
                  <div data-testid="protected-automation-preparation-state" className="flex flex-wrap gap-x-3 gap-y-1 border-b border-neutral-800 px-4 py-2 font-mono text-[11px] text-neutral-500">
                    <span>state: {humanize(preparation.state)}</span>
                    <span title={preparation.source_session_id}>source: {shortId(preparation.source_session_id)}</span>
                    <span title={preparation.preparation_id}>preparation: {shortId(preparation.preparation_id)}</span>
                  </div>
                )}

                <div className="h-[22rem] min-h-[16rem] sm:h-[30rem]">
                  {preparation?.state === "ready" && preparation.websocket_path ? (
                    <CdpScreencastViewer websocketUrl={preparation.websocket_path} running pasteThroughViewer requireReadyHandshake connectionLabel="Preparation viewer" imageAlt="Protected automation preparation browser" testId="protected-automation-viewer" onStatus={handlePreparationViewerStatus} />
                  ) : (
                    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">{preparation ? `Preparation is ${humanize(preparation.state)}.` : "No exact preparation attached."}</div>
                  )}
                </div>
              </section>
            )}

            {notice && <div role="status" data-testid="protected-automation-notice" className="rounded border border-sky-900/60 bg-sky-950/30 p-3 text-xs text-sky-100">{notice}</div>}
            {error && <div role="alert" data-testid="protected-automation-action-error" className="rounded border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-200">{error}</div>}
            <RunHistory runs={detail.runs} busyAction={busyAction} onCancel={cancelRun} />
          </div>
        )}
      </div>

      {preparation && preparationSelection && (
        <ProtectedAutomationCredentialsDrawer open={credentialsOpen} selection={preparationSelection} onClose={() => setCredentialsOpen(false)} onChanged={() => refreshPreparation(true)} onNotice={setNotice} onError={setError} />
      )}

      {purgeChallenge && job && (
        <PurgeDialog challenge={purgeChallenge} job={job} pin={purgePin} error={purgeError} busyAction={busyAction} onPinChange={setPurgePin} onCancel={() => void cancelPurge()} onCommit={() => void commitPurge()} />
      )}
    </div>
  );
}

function AutomationOverview({ jobs, onSelectJob }: { jobs: ProtectedAutomationJob[]; onSelectJob: (id: string) => void }) {
  if (!Array.isArray(jobs) || jobs.length === 0) return <section data-testid="protected-automations-empty" className="mx-auto max-w-xl rounded-lg border border-neutral-800 bg-neutral-900/40 p-6 text-center"><ShieldCheck size={28} className="mx-auto text-violet-300" /><h2 className="mt-3 text-base font-semibold">No protected automations</h2><p className="mt-2 text-sm text-neutral-500">No backend-captured jobs are available.</p></section>;
  return <section className="mx-auto max-w-3xl"><h2 className="text-sm font-semibold">Jobs</h2><div className="mt-3 space-y-2">{jobs.map((job) => <button key={job.id} type="button" data-testid="protected-automation-overview-row" data-job-id={job.id} onClick={() => onSelectJob(job.id)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 text-left hover:bg-neutral-900"><span className="min-w-0"><span className="block truncate text-sm font-medium">{safeText(job.name, "Unnamed automation")}</span><span className="mt-1 block truncate font-mono text-xs text-neutral-500">{safeText(job.cron_expr, "schedule unavailable")}</span></span><JobStatus job={job} runs={[]} /></button>)}</div></section>;
}

function RunHistory({ runs, busyAction, onCancel }: { runs: ProtectedAutomationRun[]; busyAction: string | null; onCancel: (run: ProtectedAutomationRun) => void }) {
  const safeRuns = Array.isArray(runs) ? runs : [];
  return <section data-testid="protected-automation-runs" className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4"><h3 className="text-sm font-semibold">Run history</h3>{safeRuns.length === 0 ? <p className="mt-2 text-sm text-neutral-500">No runs yet.</p> : <div className="mt-3 space-y-2">{safeRuns.map((run) => { const active = run.status === "queued" || run.status === "running"; return <article key={run.id} data-testid="protected-automation-run" data-run-id={run.id} className="rounded border border-neutral-800 bg-neutral-950/60 p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span data-testid="protected-automation-run-status" className={runStatusClass(run.status)}>{humanize(safeText(run.status, "unknown"))}</span><span className="text-neutral-500">{formatTimestamp(run.started_at)}</span></div>{run.outcome_code && <p className="mt-2 text-xs text-neutral-400">Outcome: {humanize(run.outcome_code)}</p>}{run.attention && <p data-testid="protected-automation-run-attention" className="mt-2 text-xs text-sky-200">Attention: {humanize(run.attention.reason)}</p>}{active && <button type="button" data-testid="protected-automation-cancel-run" disabled={Boolean(busyAction)} onClick={() => onCancel(run)} className="mt-2 inline-flex items-center gap-1 rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40">{busyAction === `cancel:${run.id}` ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />} Emergency cancel</button>}</article>; })}</div>}</section>;
}

function PurgeDialog({ challenge, job, pin, error, busyAction, onPinChange, onCancel, onCommit }: { challenge: ProtectedAutomationPurgeChallenge; job: ProtectedAutomationJob; pin: string; error: string | null; busyAction: string | null; onPinChange: (value: string) => void; onCancel: () => void; onCommit: () => void }) {
  const committing = busyAction === "commit-purge";
  const cancelling = busyAction === "cancel-purge";
  return <div role="dialog" aria-modal="true" aria-labelledby="protected-automation-purge-title" data-testid="protected-automation-purge-dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"><form className="w-full max-w-md rounded-lg border border-red-900/60 bg-neutral-950 shadow-2xl" onSubmit={(event) => { event.preventDefault(); onCommit(); }}><div className="border-b border-neutral-800 p-4"><div className="text-[10px] font-semibold uppercase tracking-wider text-red-400">Permanent protected automation purge</div><h3 id="protected-automation-purge-title" className="mt-1 text-sm font-semibold">Purge tombstoned job {safeText(job.name, shortId(job.id))}?</h3><p data-testid="protected-automation-purge-summary" className="mt-2 text-xs leading-relaxed text-amber-100">{safeText(challenge.summary, "Purge challenge summary unavailable")}</p><p className="mt-2 text-xs leading-relaxed text-neutral-400">This permanently removes the tombstoned job row, run history, immutable source snapshots, isolated browser profile, and private runtime state. Project outputs remain in the project.</p><p className="mt-2 text-[11px] text-neutral-600">Challenge expires {formatTimestamp(challenge.expires_at)}.</p></div><div className="space-y-3 p-4"><label className="block text-xs text-neutral-300">8-digit identity PIN<input type="password" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} autoComplete="off" autoFocus data-testid="protected-automation-purge-pin" value={pin} onChange={(event) => onPinChange(event.target.value.replace(/\D/g, "").slice(0, 8))} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm focus:border-red-500 focus:outline-none" /></label>{error && <div role="alert" data-testid="protected-automation-purge-error" className="rounded border border-red-900/60 bg-red-950/30 p-2 text-xs text-red-200">{error}</div>}</div><div className="flex justify-end gap-2 border-t border-neutral-800 p-3"><button type="button" data-testid="protected-automation-purge-cancel" disabled={committing || cancelling} onClick={onCancel} className="rounded px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40">{cancelling ? "Cancelling…" : "Cancel challenge"}</button><button type="submit" data-testid="protected-automation-purge-commit" disabled={committing || cancelling || pin.length !== 8} className="inline-flex items-center gap-2 rounded bg-red-700 px-3 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-40">{committing && <Loader2 size={12} className="animate-spin" />} Commit permanent purge</button></div></form></div>;
}

function UnavailableState({ onRetry }: { onRetry: () => void }) { return <section role="status" data-testid="protected-automations-unavailable" className="mx-auto max-w-xl rounded-lg border border-amber-900/60 bg-amber-950/20 p-6 text-center"><ShieldAlert size={30} className="mx-auto text-amber-400" /><h2 className="mt-3 font-semibold">Protected Automations unavailable</h2><p className="mt-2 text-sm text-amber-100/70">The backend returned 503 for the production integration.</p><button type="button" onClick={onRetry} className="mt-4 rounded border border-amber-700 px-3 py-1.5 text-xs">Retry</button></section>; }
function StaleSelection({ onOverview }: { onOverview: () => void }) { return <section role="status" data-testid="protected-automation-stale-selection" className="mx-auto max-w-xl rounded-lg border border-neutral-800 bg-neutral-900/50 p-6 text-center"><AlertTriangle size={28} className="mx-auto text-amber-400" /><h2 className="mt-3 font-semibold">Job no longer available</h2><p className="mt-2 text-sm text-neutral-500">The selected job returned 404. Refresh the overview rather than retaining stale controls.</p><button type="button" data-testid="protected-automation-stale-overview" onClick={onOverview} className="mt-4 rounded border border-neutral-700 px-3 py-1.5 text-xs">Return to overview</button></section>; }
function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) { return <div role="alert" data-testid="protected-automations-error" className="rounded border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">{message ?? "Protected Automations could not be loaded."}<button type="button" onClick={onRetry} className="ml-2 underline">Retry</button></div>; }
function ActionButton({ children, icon, testId, disabled, busy, danger, onClick }: { children: React.ReactNode; icon: React.ReactNode; testId: string; disabled?: boolean; busy?: boolean; danger?: boolean; onClick: () => void }) { return <button type="button" data-testid={testId} disabled={disabled} onClick={onClick} className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-medium disabled:opacity-40 ${danger ? "border-red-900/60 text-red-300 hover:bg-red-950/40" : "border-neutral-700 text-neutral-200 hover:bg-neutral-800"}`}>{busy ? <Loader2 size={13} className="animate-spin" /> : icon}{children}</button>; }
function JobStatus({ job, runs }: { job: ProtectedAutomationJob; runs: ProtectedAutomationRun[] }) { const label = deriveJobStatus(job, runs); return <span data-testid="protected-automation-job-status" className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${label === "enabled" ? "border-emerald-800 text-emerald-300" : label === "running" || label === "queued" ? "border-blue-800 text-blue-300" : label === "needs attention" ? "border-sky-800 text-sky-200" : label === "tombstoned" || label === "blocked" ? "border-amber-800 text-amber-300" : "border-neutral-700 text-neutral-400"}`}>{label}</span>; }
function deriveJobStatus(job: ProtectedAutomationJob, runs: ProtectedAutomationRun[]): string { if (job?.deleted_at != null) return "tombstoned"; if (job?.attention) return "needs attention"; const active = Array.isArray(runs) ? runs.find((run) => run?.status === "running" || run?.status === "queued") : undefined; if (active?.status === "running") return "running"; if (active?.status === "queued") return "queued"; if (job?.blocked_reason) return job.blocked_reason === "paused" ? "paused" : "blocked"; return job?.enabled === true ? "enabled" : "paused"; }
function runStatusClass(status: string): string { return status === "completed" ? "text-emerald-300" : status === "running" || status === "queued" ? "text-blue-300" : status === "needs_user" ? "text-sky-200" : status === "failed" || status === "denied" ? "text-red-300" : "text-neutral-400"; }
function IdLabel({ label, value }: { label: string; value: string }) { const text = safeText(value, "unavailable"); return <span title={`${label}: ${text}`}>{label}: <span className="font-mono">{shortId(text)}</span></span>; }
function Info({ label, value }: { label: string; value: string }) { return <div><div className="text-[10px] uppercase tracking-wider text-neutral-600">{label}</div><div className="mt-1 text-neutral-300">{value}</div></div>; }
function StatusLine({ children }: { children: React.ReactNode }) { return <div className="flex items-center gap-2 text-sm text-neutral-500">{children}</div>; }
function formatTimestamp(value: unknown): string { return typeof value === "number" && Number.isFinite(value) ? new Date(value).toLocaleString() : "—"; }
function safeNumber(value: unknown): string { return typeof value === "number" && Number.isFinite(value) ? String(value) : "—"; }
function safeText(value: unknown, fallback: string): string { return typeof value === "string" && value ? value : fallback; }
function shortId(value: string): string { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function humanize(value: string): string { return value.replaceAll("_", " "); }
function errorMessage(error: unknown): string { return error instanceof ApiError ? error.message || `HTTP ${error.status}` : error instanceof Error ? error.message : String(error); }
