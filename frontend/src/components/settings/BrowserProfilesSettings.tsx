import { useCallback, useEffect, useState } from "react";
import { ArchiveRestore, Loader2, Plus, Power, Trash2 } from "lucide-react";
import {
  ApiError,
  createBrowserProfile,
  fetchBrowserProfiles,
  restoreBrowserProfile,
  trashBrowserProfile,
  updateBrowserProfile,
  type NamedBrowserProfile,
} from "../../api/client";

function message(error: unknown): string {
  return error instanceof ApiError ? error.message || `HTTP ${error.status}` : String(error);
}

export function BrowserProfilesSettings({ onChanged }: { onChanged?: () => void }) {
  const [profiles, setProfiles] = useState<NamedBrowserProfile[]>([]);
  const [consequence, setConsequence] = useState("");
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const value = await fetchBrowserProfiles();
      setProfiles(value.profiles);
      setConsequence(value.consequence);
    } catch (caught) { setError(message(caught)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key); setError("");
    try { await operation(); await refresh(); onChanged?.(); }
    catch (caught) { setError(message(caught)); }
    finally { setBusy(null); }
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-neutral-500"><Loader2 size={16} className="animate-spin" />Loading Browser Profiles…</div>;

  return (
    <section className="w-full space-y-5" aria-labelledby="browser-profiles-heading">
      <div>
        <h3 id="browser-profiles-heading" className="text-sm font-semibold text-neutral-100">Named Browser Profiles</h3>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-amber-200/80">{consequence || "Browser Profiles are unavailable until the startup feature is enabled."}</p>
      </div>
      {error && <div role="alert" className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">{error}</div>}
      <form
        className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed || !name.trim()) return;
          void run("create", async () => { await createBrowserProfile(name.trim()); setName(""); setConfirmed(false); });
        }}
      >
        <label className="block text-xs font-medium text-neutral-300">New profile name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100" /></label>
        <label className="flex items-start gap-2 text-xs leading-5 text-neutral-300"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" /><span>I understand that cookies, logins, and authenticated state in this profile are shared with every approved Standard-browser Project/Agent pair.</span></label>
        <button type="submit" disabled={!confirmed || !name.trim() || busy !== null} className="inline-flex items-center gap-2 rounded bg-blue-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"><Plus size={14} />Create profile</button>
      </form>
      <div className="space-y-2">
        {profiles.map((profile) => {
          const pending = busy === profile.id;
          return <article key={profile.id} className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/30 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-neutral-100">{profile.name}</div><div className="mt-1 text-[11px] text-neutral-500">{profile.state.replaceAll("_", " ")} · {profile.storage_source.replaceAll("_", " ")} · revision {profile.revision}</div></div>
            <div className="flex flex-wrap gap-2">
              {(profile.state === "active" || profile.state === "disabled") && <button type="button" disabled={pending} onClick={() => void run(profile.id, () => updateBrowserProfile(profile.id, { expectedRevision: profile.revision, enabled: profile.state !== "active" }))} className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1.5 text-xs text-neutral-200 disabled:opacity-40"><Power size={13} />{profile.state === "active" ? "Disable" : "Enable"}</button>}
              {(profile.state === "active" || profile.state === "disabled") && <button type="button" disabled={pending} onClick={() => void run(profile.id, () => trashBrowserProfile(profile.id, profile.revision))} className="inline-flex items-center gap-1 rounded border border-red-900/70 px-2 py-1.5 text-xs text-red-300 disabled:opacity-40"><Trash2 size={13} />Move to recovery</button>}
              {profile.state === "trashed" && <button type="button" disabled={pending} onClick={() => void run(profile.id, () => restoreBrowserProfile(profile.id, profile.revision))} className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-1.5 text-xs text-neutral-200 disabled:opacity-40"><ArchiveRestore size={13} />Restore disabled</button>}
              {pending && <Loader2 size={14} className="animate-spin text-neutral-500" />}
            </div>
          </article>;
        })}
        {profiles.length === 0 && <p className="rounded border border-dashed border-neutral-800 p-5 text-sm text-neutral-500">No named Browser Profiles. Existing migrated roots appear here only when metadata-only inventory found an expected root.</p>}
      </div>
    </section>
  );
}
