import { useCallback, useEffect, useState } from "react";
import {
  type BrowserCredentialChoice,
  type BrowserCredentialStatus,
  type BrowserSessionState,
  allowAgentBrowserCredentialInspection,
  fetchBrowserCredentialMatches,
  fetchBrowserCredentialStatus,
  fillBrowserCredentialLogin,
  fillBrowserCredentialTotp,
  lockBrowserCredentials,
} from "../../api/client";

interface BrowserCredentialsDrawerProps {
  open: boolean;
  sessionId: string | null;
  projectCwd: string | null;
  pageIdentity?: string;
  credentialInspection?: BrowserSessionState["credentialInspection"];
  onClose: () => void;
  onCredentialFilled: () => Promise<void>;
  onInspectionAllowed: (state: BrowserSessionState) => void;
  onNotice: (notice: string) => void;
  onError: (error: string) => void;
}

const LOCKED_STATUS: BrowserCredentialStatus = { availability: "locked", exactOrigin: null };

function originFromPageIdentity(pageIdentity?: string): string | null {
  if (!pageIdentity) return null;
  try {
    const origin = new URL(pageIdentity).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function BrowserCredentialsDrawer({
  open,
  sessionId,
  projectCwd,
  pageIdentity,
  credentialInspection,
  onClose,
  onCredentialFilled,
  onInspectionAllowed,
  onNotice,
  onError,
}: BrowserCredentialsDrawerProps) {
  const [status, setStatus] = useState<BrowserCredentialStatus>(LOCKED_STATUS);
  const [choices, setChoices] = useState<BrowserCredentialChoice[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const brokerStatus = await fetchBrowserCredentialStatus(sessionId, projectCwd);
      if (brokerStatus.availability !== "unlocked") {
        setStatus({
          ...brokerStatus,
          exactOrigin: brokerStatus.exactOrigin ?? originFromPageIdentity(pageIdentity),
        });
        setChoices([]);
        return;
      }

      const matches = await fetchBrowserCredentialMatches(sessionId, projectCwd);
      setStatus({
        availability: matches.availability,
        exactOrigin: matches.exactOrigin ?? brokerStatus.exactOrigin ?? originFromPageIdentity(pageIdentity),
        ...(matches.availability === "unlocked" && brokerStatus.unlockExpiresAt !== undefined
          ? { unlockExpiresAt: brokerStatus.unlockExpiresAt }
          : {}),
      });
      setChoices(matches.choices);
    } catch (err: any) {
      setChoices([]);
      onError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [open, sessionId, projectCwd, pageIdentity, onError]);

  useEffect(() => {
    if (!open) {
      setChoices([]);
      return;
    }
    void refresh();
  }, [open, pageIdentity, refresh]);

  const fillLogin = async (choice: BrowserCredentialChoice) => {
    setLoading(true);
    try {
      await fillBrowserCredentialLogin(sessionId, projectCwd, choice.choiceToken);
      onNotice("Saved login filled. Wayang does not click Submit; the site may react automatically to field changes. The agent remains paused.");
      await onCredentialFilled();
      await refresh();
    } catch (err: any) {
      onError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const fillTotp = async (choice: BrowserCredentialChoice) => {
    setLoading(true);
    try {
      await fillBrowserCredentialTotp(sessionId, projectCwd, choice.choiceToken);
      onNotice("Verification code filled. Wayang does not click Submit; the site may react automatically to field changes. The agent remains paused.");
      await onCredentialFilled();
      await refresh();
    } catch (err: any) {
      onError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const allowAgentInspection = async () => {
    setLoading(true);
    try {
      const result = await allowAgentBrowserCredentialInspection(sessionId, projectCwd);
      onNotice("Agent read-only redacted text and DOM inspection enabled. Agent screenshots and all agent navigation, click, type, and mutations remain blocked until the backend confirms a new top-level document.");
      onInspectionAllowed(result.state);
    } catch (err: any) {
      onError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const lock = async () => {
    setLoading(true);
    setChoices([]);
    try {
      await lockBrowserCredentials(sessionId, projectCwd);
      setStatus((previous) => ({ ...previous, availability: "locked" }));
      onNotice("Credential vault locked. The agent remains paused.");
    } catch (err: any) {
      onError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <aside
      aria-label="Private credentials"
      className="absolute inset-y-0 right-0 z-30 flex w-full max-w-sm flex-col border-l border-neutral-700 bg-neutral-950 shadow-2xl shadow-black/70"
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-800 p-4">
        <div>
          <div className="text-sm font-semibold text-neutral-100">Private credentials</div>
          <div className="mt-1 text-xs text-neutral-500">Guarded Bitwarden fill</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          aria-label="Close credentials drawer"
        >
          Close
        </button>
      </header>

      <div className="shrink-0 border-b border-amber-800/70 bg-amber-950/40 p-3 text-xs text-amber-100">
        <div className="font-semibold">Credentials mode — agent paused</div>
        <div className="mt-1 text-amber-200/80">Closing this drawer does not resume agent inspection or actions.</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <section className="mb-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Exact page origin</div>
          <div className="mt-1 break-all font-mono text-xs text-neutral-100" data-testid="credential-origin">
            {status.exactOrigin || originFromPageIdentity(pageIdentity) || "Origin unavailable"}
          </div>
        </section>

        <div className="mb-4 flex items-center justify-between gap-3">
          <CredentialStatus availability={status.availability} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => void refresh()}
              className="rounded border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            >
              Refresh
            </button>
            <button
              type="button"
              disabled={loading || status.availability === "unavailable"}
              onClick={() => void lock()}
              className="rounded border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            >
              Lock
            </button>
          </div>
        </div>

        {status.availability === "unavailable" && (
          <InfoCard>
            The Bitwarden CLI is unavailable or the private broker is not connected. No credentials can be requested by this page.
          </InfoCard>
        )}

        {status.availability === "locked" && (
          <InfoCard>
            <p>The vault is locked. Unlock it only from your local terminal; never paste the vault password into chat.</p>
            <code className="mt-3 block rounded bg-black/40 px-2 py-2 text-[11px] text-neutral-200">make browser-credentials-unlock</code>
            <p className="mt-2 text-neutral-500">Then return here and press Refresh.</p>
          </InfoCard>
        )}

        {status.availability === "unlocked" && (
          <section aria-label="Matching credentials">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Matching logins
            </div>
            {loading && choices.length === 0 ? (
              <div className="py-6 text-center text-xs text-neutral-500">Checking this origin…</div>
            ) : choices.length === 0 ? (
              <InfoCard>No saved logins match this exact page origin.</InfoCard>
            ) : (
              <div className="space-y-2">
                {choices.map((choice) => (
                  <article key={choice.choiceToken} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-neutral-100">{choice.label}</div>
                      <div className="mt-1 truncate text-xs text-neutral-400" title={choice.maskedIdentifier}>
                        {choice.maskedIdentifier}
                      </div>
                      <div className="mt-1 font-mono text-xs tracking-widest text-neutral-600" aria-label="Password hidden">••••••••••••</div>
                    </div>
                    {choice.matchWarning && (
                      <div className="mt-2 rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-200">
                        {choice.matchWarning}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void fillLogin(choice)}
                        className="rounded border border-sky-600 bg-sky-600/20 px-2.5 py-1.5 text-xs font-semibold text-sky-100 hover:bg-sky-600/30 disabled:opacity-40"
                      >
                        Fill login
                      </button>
                      {choice.hasTotp && (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => void fillTotp(choice)}
                          className="rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
                        >
                          Fill verification code
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      <footer className="shrink-0 border-t border-neutral-800 bg-neutral-950 p-3">
        <div className="text-[11px] leading-relaxed text-neutral-500">
          Wayang does not click Submit; the site may react automatically to field changes. There are no reveal or copy controls.
        </div>
        {credentialInspection === "blocked" ? (
          <div className="mt-3">
            <div className="mb-2 text-[11px] leading-relaxed text-amber-100/80">
              This enables read-only redacted text and DOM inspection only. Agent screenshots and all agent navigation, click, type, and mutations remain blocked until the backend confirms a new top-level document.
            </div>
            <button
              type="button"
              disabled={loading}
              onClick={() => void allowAgentInspection()}
              className="w-full rounded border border-emerald-600 bg-emerald-600/20 px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-600/30 disabled:opacity-40"
            >
              Allow agent read-only redacted inspection
            </button>
          </div>
        ) : (
          <div className="mt-2 text-[11px] leading-relaxed text-neutral-600">
            After a credential fill, review the page here before explicitly allowing read-only redacted text and DOM inspection.
          </div>
        )}
      </footer>
    </aside>
  );
}

function CredentialStatus({ availability }: { availability: BrowserCredentialStatus["availability"] }) {
  const copy = availability === "unlocked"
    ? ["Unlocked", "border-emerald-800 bg-emerald-950/40 text-emerald-200"]
    : availability === "locked"
      ? ["Locked", "border-amber-800 bg-amber-950/40 text-amber-200"]
      : ["Unavailable", "border-neutral-700 bg-neutral-900 text-neutral-400"];
  return <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${copy[1]}`}>{copy[0]}</span>;
}

function InfoCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 text-xs leading-relaxed text-neutral-400">{children}</div>;
}
