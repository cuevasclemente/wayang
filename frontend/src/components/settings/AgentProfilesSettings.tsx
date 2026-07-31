import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Copy, Loader2, Plus, Save, Shield, Trash2 } from "lucide-react";
import {
  ApiError,
  createAgentProfile,
  deleteAgentProfile,
  fetchAgentProfile,
  updateAgentProfile,
  type AgentProfile,
  type AgentProfileSummary,
  type MemoryAccess,
  type ModelOption,
  type ResourceMode,
} from "../../api/client";
import {
  ErrorBox,
  Field,
  SettingsSection,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "./ProjectSettingsForm";

interface AgentProfilesSettingsProps {
  profiles: AgentProfileSummary[];
  models: ModelOption[];
  onProfilesChanged: () => Promise<void>;
}

const NEW_PROFILE_ID = "__new_profile__";

type Draft = {
  id: string | null;
  name: string;
  description: string;
  enabled: boolean;
  resourceMode: ResourceMode;
  instructions: string;
  memoryAccess: MemoryAccess;
  defaultModel: string;
};

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

function draftFromProfile(profile: AgentProfile): Draft {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description ?? "",
    enabled: profile.enabled,
    resourceMode: profile.resource_mode,
    instructions: profile.instructions ?? "",
    memoryAccess: profile.memory_access,
    defaultModel: modelValue(profile.default_provider, profile.default_model),
  };
}

function uniqueCopyName(name: string, profiles: AgentProfileSummary[]): string {
  const used = new Set(profiles.map((profile) => profile.name.toLocaleLowerCase()));
  const base = `${name} copy`;
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${name} copy ${index}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${name} ${Date.now()}`;
}

export function AgentProfilesSettings({ profiles, models, onProfilesChanged }: AgentProfilesSettingsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(profiles[0]?.id ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [replacementId, setReplacementId] = useState("");

  const selectedSummary = profiles.find((profile) => profile.id === selectedId) ?? null;
  const availableModels = useMemo(() => models.filter((model) => model.available), [models]);
  const replacementProfiles = profiles.filter((profile) => profile.enabled && profile.id !== selectedId);

  useEffect(() => {
    if (selectedId) return;
    setSelectedId(profiles[0]?.id ?? null);
  }, [profiles, selectedId]);

  useEffect(() => {
    if (!selectedId || selectedId === NEW_PROFILE_ID) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSaved(false);
    void fetchAgentProfile(selectedId).then((profile) => {
      if (!cancelled) setDraft(draftFromProfile(profile));
    }).catch((caught: unknown) => {
      if (!cancelled) setError(errorMessage(caught));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  const patchDraft = (patch: Partial<Draft>) => setDraft((current) => current ? { ...current, ...patch } : current);

  const startCreate = () => {
    setSelectedId(NEW_PROFILE_ID);
    setDraft({
      id: null,
      name: "",
      description: "",
      enabled: true,
      resourceMode: "project_only",
      instructions: "",
      memoryAccess: "none",
      defaultModel: "",
    });
    setError("");
    setSaved(false);
  };

  const cloneSelected = async () => {
    if (!selectedSummary) return;
    setSaving(true);
    setError("");
    try {
      const source = await fetchAgentProfile(selectedSummary.id);
      const created = await createAgentProfile({
        name: uniqueCopyName(source.name, profiles),
        description: source.description,
        resource_mode: source.resource_mode,
        instructions: source.instructions,
        memory_access: source.memory_access,
        default_provider: source.default_provider,
        default_model: source.default_model,
      });
      await onProfilesChanged();
      setSelectedId(created.id);
      setDraft(draftFromProfile(created));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const pair = parseModelValue(draft.defaultModel);
      const common = {
        name: draft.name,
        description: draft.description.trim() || null,
        resource_mode: draft.resourceMode,
        instructions: draft.instructions || null,
        memory_access: draft.memoryAccess,
        default_provider: pair.provider,
        default_model: pair.model,
      };
      const profile = draft.id
        ? await updateAgentProfile(draft.id, {
            ...common,
            resource_mode: draft.resourceMode,
            enabled: draft.enabled,
          })
        : await createAgentProfile(common);
      await onProfilesChanged();
      setSelectedId(profile.id);
      setDraft(draftFromProfile(profile));
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    if (!window.confirm(`Delete agent profile “${draft.name}”? This cannot be undone.`)) return;
    setSaving(true);
    setError("");
    try {
      await deleteAgentProfile(draft.id, replacementId || undefined);
      setDraft(null);
      setSelectedId(null);
      await onProfilesChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      <aside className="w-full shrink-0 border-b border-neutral-800 pb-4 md:w-56 md:border-b-0 md:border-r md:pb-0 md:pr-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Profiles</h3>
          <button type="button" onClick={startCreate} className="rounded p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" title="Create agent profile" aria-label="Create agent profile"><Plus size={15} /></button>
        </div>
        <div className="flex gap-2 overflow-x-auto md:block md:space-y-1 md:overflow-visible">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => setSelectedId(profile.id)}
              className={`min-w-40 rounded px-3 py-2 text-left md:block md:w-full ${profile.id === selectedId ? "bg-blue-950/60 text-blue-100" : "text-neutral-300 hover:bg-neutral-900"}`}
            >
              <div className="flex items-center gap-2"><Bot size={14} className="shrink-0" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{profile.name}</span>{!profile.enabled && <span className="text-[9px] uppercase text-neutral-600">off</span>}</div>
              <div className="mt-1 flex gap-1">
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-500">{profile.resource_mode.replace("project_only", "project only")}</span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-500">{profile.memory_access.replace("read_write", "read/write")}</span>
              </div>
            </button>
          ))}
        </div>
        {selectedSummary && (
          <button type="button" onClick={() => void cloneSelected()} disabled={saving} className={`${secondaryButtonClass} mt-3 w-full`}><Copy size={13} /> Clone profile</button>
        )}
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto pr-0 md:pr-2">
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-neutral-500"><Loader2 size={15} className="animate-spin" /> Loading profile…</div>
        ) : draft ? (
          <form onSubmit={save} className="space-y-6 pb-6">
            <SettingsSection title={draft.id ? "Agent profile" : "Create agent profile"} description="The stable profile ID—not its name, definition, provider, or model—is the agent identity used by capability associations.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name"><input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} required className={inputClass} autoFocus={!draft.id} /></Field>
                <Field label="Default provider/model" hint="Optional. Projects or sessions may override this pair.">
                  <select value={draft.defaultModel} onChange={(event) => patchDraft({ defaultModel: event.target.value })} className={inputClass}>
                    <option value="">Pi default</option>
                    {availableModels.map((model) => <option key={`${model.provider}:${model.id}`} value={modelValue(model.provider, model.id)}>{model.name || model.id} — {model.provider}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Description"><textarea value={draft.description} onChange={(event) => patchDraft({ description: event.target.value })} rows={3} className={inputClass} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Resource mode" hint="This is a profile preference, not authority. Standard resources require a direct capability association for each Project-Agent pair.">
                  <select value={draft.resourceMode} onChange={(event) => patchDraft({ resourceMode: event.target.value as ResourceMode })} className={inputClass}>
                    <option value="standard">Standard resources</option>
                    <option value="project_only">Project only</option>
                    <option value="custom">Project only + custom instructions</option>
                  </select>
                </Field>
                <Field label="Memory access" hint="This is enforced as runtime authorization, not prompt text.">
                  <select value={draft.memoryAccess} onChange={(event) => patchDraft({ memoryAccess: event.target.value as MemoryAccess })} className={inputClass}>
                    <option value="none">None</option>
                    <option value="read">Read only</option>
                    <option value="read_write">Read and write</option>
                  </select>
                </Field>
              </div>
              {draft.id && (
                <>
                  <label className="flex items-center gap-2 text-xs text-neutral-300"><input type="checkbox" checked={draft.enabled} onChange={(event) => patchDraft({ enabled: event.target.checked })} className="accent-blue-500" /> Enabled</label>
                  <div className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100">
                    Capability associations follow this stable profile ID. Renaming it or changing instructions, tools, resources, memory, or defaults preserves them. Disabling blocks all runtimes but does not remove associations; re-enabling this same ID restores them through fresh runtime handles without another PIN. Choose another workspace/project default first when required. Deleting the profile tombstones its associations, and a replacement or clone never inherits them.
                  </div>
                </>
              )}
            </SettingsSection>

            <SettingsSection title="Profile instructions" description="Private profile overlay. It is returned only by the authenticated detail endpoint and is not included in profile lists.">
              <textarea aria-label="Agent profile instructions" value={draft.instructions} onChange={(event) => patchDraft({ instructions: event.target.value })} rows={12} spellCheck={false} placeholder="Optional identity or task-specific guidance" className={`${inputClass} min-h-48 resize-y font-mono text-xs leading-relaxed`} />
              <div className="flex items-start gap-2 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs leading-relaxed text-neutral-400"><Shield size={14} className="mt-0.5 shrink-0 text-blue-400" />Tool and extension allowlists are backend-reviewed in v1 and cannot be weakened here.</div>
            </SettingsSection>

            {draft.id && (
              <SettingsSection title="Delete profile" description="In-use profiles may require an enabled replacement for ordinary references. Capability associations are tombstoned first and never transfer to the replacement.">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1"><Field label="Replacement if in use"><select value={replacementId} onChange={(event) => setReplacementId(event.target.value)} className={inputClass}><option value="">None selected</option>{replacementProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field></div>
                  <button type="button" onClick={() => void remove()} disabled={saving} className="inline-flex items-center justify-center gap-2 rounded border border-red-900/70 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-950/40 disabled:opacity-50"><Trash2 size={13} /> Delete</button>
                </div>
              </SettingsSection>
            )}

            {error && <ErrorBox>{error}</ErrorBox>}
            <div className="flex items-center justify-end gap-3 border-t border-neutral-800 pt-4">
              {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><Check size={13} /> Saved</span>}
              <button type="submit" disabled={saving || !draft.name.trim()} className={primaryButtonClass}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {draft.id ? "Save agent" : "Create agent"}</button>
            </div>
          </form>
        ) : (
          <div className="py-8 text-sm text-neutral-500">Select a profile or create a new one.</div>
        )}
      </div>
    </div>
  );
}
