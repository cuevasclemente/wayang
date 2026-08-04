import { useCallback, useEffect, useState } from "react";
import {
  fetchProtectedAutomationCredentialMatches,
  fetchProtectedAutomationCredentialStatus,
  fillProtectedAutomationCredentialLogin,
  fillProtectedAutomationCredentialTotp,
  lockProtectedAutomationCredentials,
  type BrowserCredentialChoice,
  type BrowserCredentialStatus,
  type ProtectedAutomationPreparationSelection,
} from "../../api/client";

interface ProtectedAutomationCredentialsDrawerProps {
  open: boolean;
  selection: ProtectedAutomationPreparationSelection;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const LOCKED: BrowserCredentialStatus = { availability: "locked", exactOrigin: null };

export function ProtectedAutomationCredentialsDrawer({
  open,
  selection,
  onClose,
  onChanged,
  onNotice,
  onError,
}: ProtectedAutomationCredentialsDrawerProps) {
  const [status, setStatus] = useState<BrowserCredentialStatus>(LOCKED);
  const [choices, setChoices] = useState<BrowserCredentialChoice[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!open) return;
    setBusy(true);
    try {
      const nextStatus = await fetchProtectedAutomationCredentialStatus(selection);
      if (nextStatus.availability !== "unlocked") {
        setStatus(nextStatus);
        setChoices([]);
        return;
      }
      const matches = await fetchProtectedAutomationCredentialMatches(selection);
      setStatus({
        availability: matches.availability,
        exactOrigin: matches.exactOrigin ?? nextStatus.exactOrigin,
        ...(nextStatus.unlockExpiresAt !== undefined ? { unlockExpiresAt: nextStatus.unlockExpiresAt } : {}),
      });
      setChoices(matches.choices);
    } catch (error) {
      setChoices([]);
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [onError, open, selection]);

  useEffect(() => {
    if (!open) {
      setChoices([]);
      return;
    }
    void refresh();
  }, [open, refresh]);

  const fill = async (choice: BrowserCredentialChoice, totp: boolean) => {
    setBusy(true);
    try {
      if (totp) await fillProtectedAutomationCredentialTotp(selection, choice.choiceToken);
      else await fillProtectedAutomationCredentialLogin(selection, choice.choiceToken);
      onNotice(totp
        ? "Verification code filled into the preparation browser. Wayang did not submit the form."
        : "Saved login filled into the preparation browser. Wayang did not submit the form.");
      await onChanged();
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    setBusy(true);
    setChoices([]);
    try {
      await lockProtectedAutomationCredentials(selection);
      setStatus((previous) => ({ ...previous, availability: "locked" }));
      onNotice("Credential vault locked. The preparation browser remains under human control.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <aside
      aria-label="Protected automation credentials"
      data-testid="protected-automation-credentials-drawer"
      className="absolute inset-y-0 right-0 z-30 flex w-full max-w-sm flex-col border-l border-neutral-700 bg-neutral-950 shadow-2xl shadow-black/70"
    >
      <header className="flex items-start justify-between gap-3 border-b border-neutral-800 p-4">
        <div>
          <h3 className="text-sm font-semibold text-neutral-100">Preparation credentials</h3>
          <p className="mt-1 text-xs text-neutral-500">Human-only guarded fill for this automation realm</p>
        </div>
        <button type="button" onClick={onClose} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800">
          Close
        </button>
      </header>

      <div className="border-b border-amber-800/70 bg-amber-950/40 p-3 text-xs text-amber-100">
        Values travel only from the backend credential broker to the active preparation document. There are no reveal or copy controls.
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <section className="mb-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Exact origin</div>
          <div data-testid="protected-automation-credential-origin" className="mt-1 break-all font-mono text-xs text-neutral-100">
            {status.exactOrigin ?? "Origin unavailable"}
          </div>
        </section>

        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="text-xs text-neutral-300">Vault: {status.availability}</span>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 disabled:opacity-40">Refresh</button>
            <button type="button" disabled={busy || status.availability === "unavailable"} onClick={() => void lock()} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 disabled:opacity-40">Lock</button>
          </div>
        </div>

        {status.availability === "unavailable" && <Info>Guarded credential fill is unavailable for this preparation lease.</Info>}
        {status.availability === "locked" && (
          <Info>
            Unlock the broker from your local terminal with <code className="mt-2 block rounded bg-black/40 p-2 text-neutral-200">make browser-credentials-unlock</code>. Never enter a vault password in Wayang.
          </Info>
        )}
        {status.availability === "unlocked" && choices.length === 0 && !busy && <Info>No saved login matches this exact origin.</Info>}
        {status.availability === "unlocked" && (
          <div className="space-y-2" aria-label="Matching automation credentials">
            {choices.map((choice) => (
              <article key={choice.choiceToken} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="truncate text-sm font-medium text-neutral-100">{choice.label}</div>
                <div className="mt-1 truncate text-xs text-neutral-400">{choice.maskedIdentifier}</div>
                <div className="mt-1 font-mono text-xs tracking-widest text-neutral-600" aria-label="Password hidden">••••••••••••</div>
                {choice.matchWarning && <div className="mt-2 rounded border border-amber-900/60 bg-amber-950/30 p-2 text-[11px] text-amber-200">{choice.matchWarning}</div>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" data-testid="protected-automation-fill-login" disabled={busy} onClick={() => void fill(choice, false)} className="rounded border border-sky-600 bg-sky-600/20 px-2.5 py-1.5 text-xs font-semibold text-sky-100 disabled:opacity-40">Fill login</button>
                  {choice.hasTotp && <button type="button" data-testid="protected-automation-fill-totp" disabled={busy} onClick={() => void fill(choice, true)} className="rounded border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-200 disabled:opacity-40">Fill verification code</button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      <footer className="border-t border-neutral-800 p-3 text-[11px] leading-relaxed text-neutral-500">
        Review and submit in the viewer yourself. A later automation run receives a separate bounded browser lease.
      </footer>
    </aside>
  );
}

function Info({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 text-xs leading-relaxed text-neutral-400">{children}</div>;
}
