import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Lock, RefreshCw, Save } from "lucide-react";
import {
  ApiError,
  fetchBrowserProfiles,
  fetchProjectBrowserDefault,
  fetchProjectInstructions,
  updateProject,
  updateProjectBrowserDefault,
  type NamedBrowserProfile,
  type ProjectBrowserDefault,
  updateProjectInstructions,
  type AgentProfileSummary,
  type ModelOption,
  type ProjectInstructions,
  type WorkspaceProject,
} from "../../api/client";

interface ProjectSettingsFormProps {
  project: WorkspaceProject;
  profiles: AgentProfileSummary[];
  models: ModelOption[];
  onSaved: (project: WorkspaceProject) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message || `HTTP ${error.status}` : String(error);
}

function modelValue(provider: string | null, model: string | null): string {
  return provider && model ? JSON.stringify([provider, model]) : "";
}

function parseModelValue(value: string): { provider: string | null; model: string | null } {
  if (!value) return { provider: null, model: null };
  const parsed = JSON.parse(value) as [string, string];
  return { provider: parsed[0], model: parsed[1] };
}

export function ProjectSettingsForm({ project, profiles, models, onSaved }: ProjectSettingsFormProps) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [color, setColor] = useState(project.color ?? "");
  const [defaultAgentId, setDefaultAgentId] = useState(project.default_agent_profile_id);
  const [defaultModel, setDefaultModel] = useState(modelValue(project.default_provider, project.default_model));
  const [privacyMode, setPrivacyMode] = useState(project.access_policy.privacy_mode);
  const [allowedAgentIds, setAllowedAgentIds] = useState<string[] | null>(project.access_policy.allowed_agent_profile_ids);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const [browserProfiles, setBrowserProfiles] = useState<NamedBrowserProfile[]>([]);
  const [browserDefault, setBrowserDefault] = useState<ProjectBrowserDefault | null>(null);
  const [browserDefaultValue, setBrowserDefaultValue] = useState("");
  const [browserDefaultSaving, setBrowserDefaultSaving] = useState(false);
  const [browserDefaultError, setBrowserDefaultError] = useState("");

  const [instructions, setInstructions] = useState<ProjectInstructions | null>(null);
  const [instructionText, setInstructionText] = useState("");
  const [instructionsLoading, setInstructionsLoading] = useState(true);
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsError, setInstructionsError] = useState("");
  const [instructionsConflict, setInstructionsConflict] = useState(false);

  const enabledProfiles = useMemo(() => profiles.filter((profile) => profile.enabled), [profiles]);
  const availableModels = useMemo(() => models.filter((model) => model.available), [models]);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
    setColor(project.color ?? "");
    setDefaultAgentId(project.default_agent_profile_id);
    setDefaultModel(modelValue(project.default_provider, project.default_model));
    setPrivacyMode(project.access_policy.privacy_mode);
    setAllowedAgentIds(project.access_policy.allowed_agent_profile_ids);
    setSaveError("");
    setSaved(false);
  }, [project]);

  const loadInstructions = async () => {
    setInstructionsLoading(true);
    setInstructionsError("");
    setInstructionsConflict(false);
    try {
      const value = await fetchProjectInstructions(project.id);
      setInstructions(value);
      setInstructionText(value.text ?? "");
    } catch (error) {
      setInstructions(null);
      setInstructionsError(errorMessage(error));
    } finally {
      setInstructionsLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchBrowserProfiles(), fetchProjectBrowserDefault(project.id)]).then(([catalog, current]) => {
      if (cancelled) return;
      setBrowserProfiles(catalog.profiles.filter((profile) => profile.state === "active"));
      setBrowserDefault(current.default);
      setBrowserDefaultValue(current.default?.profile_id ?? "");
      setBrowserDefaultError("");
    }).catch((error: unknown) => {
      if (!cancelled && (!(error instanceof ApiError) || error.status !== 404)) setBrowserDefaultError(errorMessage(error));
    });
    return () => { cancelled = true; };
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    setInstructionsLoading(true);
    setInstructionsError("");
    setInstructionsConflict(false);
    void fetchProjectInstructions(project.id).then((value) => {
      if (cancelled) return;
      setInstructions(value);
      setInstructionText(value.text ?? "");
    }).catch((error: unknown) => {
      if (!cancelled) setInstructionsError(errorMessage(error));
    }).finally(() => {
      if (!cancelled) setInstructionsLoading(false);
    });
    return () => { cancelled = true; };
  }, [project.id]);

  const chooseDefaultAgent = (id: string) => {
    setDefaultAgentId(id);
    setAllowedAgentIds((current) => current && !current.includes(id) ? [...current, id] : current);
  };

  const setProtected = (protectedMode: boolean) => {
    setPrivacyMode(protectedMode ? "protected" : "standard");
    if (protectedMode) {
      setAllowedAgentIds((current) => current?.length ? current : [defaultAgentId]);
    }
  };

  const toggleAllowedAgent = (id: string, checked: boolean) => {
    setAllowedAgentIds((current) => {
      const base = current ?? enabledProfiles.map((profile) => profile.id);
      if (checked) return [...new Set([...base, id])];
      if (id === defaultAgentId) return base;
      return base.filter((candidate) => candidate !== id);
    });
  };

  const saveProject = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const pair = parseModelValue(defaultModel);
      const updated = await updateProject(project.id, {
        name,
        description: description.trim() || null,
        color: color.trim() || null,
        default_agent_profile_id: defaultAgentId,
        default_provider: pair.provider,
        default_model: pair.model,
        access_policy: {
          privacy_mode: privacyMode,
          allowed_agent_profile_ids: allowedAgentIds,
        },
      });
      onSaved(updated);
      setSaved(true);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const saveInstructions = async () => {
    if (!instructions) return;
    setInstructionsSaving(true);
    setInstructionsError("");
    setInstructionsConflict(false);
    try {
      const updated = await updateProjectInstructions(project.id, {
        text: instructionText,
        ...(instructions.exists
          ? { expected_sha256: instructions.sha256 }
          : { create_if_missing: true }),
      });
      setInstructions(updated);
      setInstructionText(updated.text ?? "");
    } catch (error) {
      setInstructionsError(errorMessage(error));
      setInstructionsConflict(error instanceof ApiError && [409, 412, 428].includes(error.status));
    } finally {
      setInstructionsSaving(false);
    }
  };

  return (
    <div className="space-y-6 pb-6">
      <form onSubmit={saveProject} className="space-y-6">
        <SettingsSection title="General" description="Durable metadata for this project.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input value={name} onChange={(event) => setName(event.target.value)} required className={inputClass} />
            </Field>
            <Field label="Color" hint="Optional CSS color, for example #2563eb">
              <div className="flex gap-2">
                <input
                  type="color"
                  aria-label="Choose project color"
                  value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#525252"}
                  onChange={(event) => setColor(event.target.value)}
                  className="h-9 w-12 rounded border border-neutral-700 bg-neutral-950 p-1"
                />
                <input value={color} onChange={(event) => setColor(event.target.value)} placeholder="No color" className={inputClass} />
              </div>
            </Field>
          </div>
          <Field label="Description">
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className={inputClass} />
          </Field>
          <Field label="Project path" hint="The canonical project path is immutable in Wayang.">
            <input value={project.cwd} readOnly className={`${inputClass} font-mono text-neutral-500`} />
          </Field>
        </SettingsSection>

        <SettingsSection title="Defaults" description="New sessions use these settings unless Advanced overrides them. Provider/model defaults are runtime choices and do not change privacy/RBAC-derived authority.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default agent">
              <select value={defaultAgentId} onChange={(event) => chooseDefaultAgent(event.target.value)} className={inputClass}>
                {enabledProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </Field>
            <Field label="Default provider/model" hint="Leave blank to use the selected agent or Pi default.">
              <select value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} className={inputClass}>
                <option value="">Agent / Pi default</option>
                {availableModels.map((model) => (
                  <option key={`${model.provider}:${model.id}`} value={modelValue(model.provider, model.id)}>
                    {model.name || model.id} — {model.provider}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </SettingsSection>

        {privacyMode === "standard" && (browserProfiles.length > 0 || browserDefault) && (
          <SettingsSection title="Browser default" description="New or unassigned sessions may use this named Browser Profile. Changing it does not switch the current session or change project-derived browser authority.">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field label="Default Browser Profile">
                <select value={browserDefaultValue} onChange={(event) => setBrowserDefaultValue(event.target.value)} className={inputClass}>
                  <option value="">No default</option>
                  {browserProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </Field>
              <button type="button" disabled={browserDefaultSaving} onClick={() => {
                setBrowserDefaultSaving(true); setBrowserDefaultError("");
                void updateProjectBrowserDefault(project.id, browserDefaultValue || null, browserDefault?.revision ?? null).then((result) => {
                  setBrowserDefault(result.default); onSaved(project);
                }).catch((error: unknown) => setBrowserDefaultError(errorMessage(error))).finally(() => setBrowserDefaultSaving(false));
              }} className={secondaryButtonClass}>{browserDefaultSaving ? "Saving…" : "Save browser default"}</button>
            </div>
            {browserDefaultError && <p role="alert" className="text-xs text-red-300">{browserDefaultError}</p>}
          </SettingsSection>
        )}

        <SettingsSection title="Allowed agents" description="A non-empty allowlist is enforced even when the project is Standard. Removing a profile immediately removes this Project-Agent pair’s derived authority; adding it automatically grants the authority selected by this Project’s privacy mode.">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-neutral-400">
              {allowedAgentIds === null ? "All enabled agents may open this project." : `${allowedAgentIds.length} agent${allowedAgentIds.length === 1 ? "" : "s"} allowed.`}
            </p>
            {privacyMode === "standard" && allowedAgentIds !== null && (
              <button type="button" onClick={() => setAllowedAgentIds(null)} className={secondaryButtonClass}>Allow all</button>
            )}
            {allowedAgentIds === null && (
              <button type="button" onClick={() => setAllowedAgentIds([defaultAgentId])} className={secondaryButtonClass}>Use allowlist</button>
            )}
          </div>
          {allowedAgentIds !== null && (
            <div className="grid gap-2 sm:grid-cols-2">
              {enabledProfiles.map((profile) => {
                const isDefault = profile.id === defaultAgentId;
                return (
                  <label key={profile.id} className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-200">
                    <input
                      type="checkbox"
                      checked={allowedAgentIds.includes(profile.id)}
                      disabled={isDefault}
                      onChange={(event) => toggleAllowedAgent(profile.id, event.target.checked)}
                      className="accent-blue-500"
                    />
                    <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                    {isDefault && <span className="text-[10px] uppercase text-neutral-500">default</span>}
                  </label>
                );
              })}
            </div>
          )}
        </SettingsSection>

        <SettingsSection title="Privacy" description="Protected is a fixed, fail-closed Wayang policy preset. Privacy directly selects the authority available to enabled allowlisted agents, and affected runtimes rebuild when it changes.">
          <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${privacyMode === "protected" ? "border-amber-700/70 bg-amber-950/20" : "border-neutral-800 bg-neutral-950/60"}`}>
            <input
              type="checkbox"
              checked={privacyMode === "protected"}
              onChange={(event) => setProtected(event.target.checked)}
              className="mt-1 accent-amber-500"
            />
            <Lock size={18} className={privacyMode === "protected" ? "mt-0.5 text-amber-400" : "mt-0.5 text-neutral-500"} />
            <span>
              <span className="block text-sm font-semibold text-neutral-100">Protected project</span>
              <span className="mt-1 block text-xs leading-relaxed text-neutral-400">
                Requires an explicit agent allowlist and excludes Dream, subagents, and global transcript indexing. Scheduled agents may run only as an exact allowed profile under the same Protected filesystem, memory, credential, and transcript policy.
              </span>
            </span>
          </label>
          {privacyMode === "protected" && (
            <div className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100/80">
              TTS, privacy-derived browser authority, and project apps remain separate disclosure boundaries. Protection prevents future background access; it cannot undo prior host, browser, or disclosure effects. It is not isolation from other processes running as the same OS user.
            </div>
          )}
        </SettingsSection>

        {saveError && <ErrorBox>{saveError}</ErrorBox>}
        <div className="flex items-center justify-end gap-3 border-t border-neutral-800 pt-4">
          {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><Check size={13} /> Saved</span>}
          <button type="submit" disabled={saving || !name.trim()} className={primaryButtonClass}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save project
          </button>
        </div>
      </form>

      <SettingsSection title="Project instructions" description="Edit the real project-root AGENTS.md with optimistic conflict protection. Instruction edits preserve privacy/RBAC-derived authority while affected runtimes rebuild.">
        {instructionsLoading ? (
          <div className="flex items-center gap-2 text-sm text-neutral-500"><Loader2 size={14} className="animate-spin" /> Loading AGENTS.md…</div>
        ) : instructions ? (
          <>
            <div className="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100/80">
              <div className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" /><span>This edits <code className="break-all font-mono">{instructions.path}</code> and may change a tracked repository file.</span></div>
              <div className="mt-1 text-amber-200/60">
                Git: {instructions.git_tracked === null ? "status unavailable" : instructions.git_tracked ? "tracked" : "not tracked"}
                {instructions.git_changed === true ? " · currently changed" : ""}
              </div>
            </div>
            <textarea
              aria-label="Project AGENTS.md instructions"
              value={instructionText}
              onChange={(event) => setInstructionText(event.target.value)}
              rows={16}
              spellCheck={false}
              className={`${inputClass} min-h-64 resize-y font-mono text-xs leading-relaxed`}
              placeholder="# Project instructions"
            />
            {instructionsError && (
              <div className="space-y-2">
                <ErrorBox>{instructionsError}</ErrorBox>
                {instructionsConflict && <p className="text-xs text-amber-300">The file was not overwritten. Reload it to review the external version.</p>}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => void loadInstructions()} disabled={instructionsSaving} className={secondaryButtonClass}>
                <RefreshCw size={13} /> Reload from disk
              </button>
              <button type="button" onClick={() => void saveInstructions()} disabled={instructionsSaving} className={primaryButtonClass}>
                {instructionsSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save AGENTS.md
              </button>
            </div>
          </>
        ) : (
          <div className="space-y-2"><ErrorBox>{instructionsError || "Unable to load AGENTS.md."}</ErrorBox><button type="button" onClick={() => void loadInstructions()} className={secondaryButtonClass}>Retry</button></div>
        )}
      </SettingsSection>
    </div>
  );
}

export const inputClass = "w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-600 focus:outline-none disabled:opacity-50";
export const primaryButtonClass = "inline-flex items-center justify-center gap-2 rounded bg-blue-700 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButtonClass = "inline-flex items-center justify-center gap-2 rounded border border-neutral-700 px-3 py-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-50";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5"><span className="block text-xs font-medium text-neutral-300">{label}</span>{children}{hint && <span className="block text-[11px] leading-relaxed text-neutral-500">{hint}</span>}</label>;
}

export function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="space-y-3"><div><h3 className="text-sm font-semibold text-neutral-100">{title}</h3><p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{description}</p></div><div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/35 p-4">{children}</div></section>;
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div role="alert" className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">{children}</div>;
}
