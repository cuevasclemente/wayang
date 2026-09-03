import { PackageOpen } from "lucide-react";
import { ArtifactHeader } from "../components/artifacts/ArtifactHeader";
import { ArtifactList } from "../components/artifacts/ArtifactList";
import { ArtifactPreview } from "../components/artifacts/ArtifactPreview";
import { useSessionArtifacts, type ArtifactFocusIntent } from "../hooks/useSessionArtifacts";

export function ArtifactsPanel({
  sessionId,
  focusIntent,
}: {
  sessionId: string | null;
  focusIntent: ArtifactFocusIntent | null;
}) {
  const catalog = useSessionArtifacts(sessionId, focusIntent);

  if (!sessionId) {
    return <EmptyState title="No session selected" detail="Select a session to view its artifacts." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <ArtifactHeader
        sessionId={sessionId}
        artifact={catalog.selected}
        count={catalog.artifacts.length}
        loading={catalog.loading}
        onRefresh={() => void catalog.refresh()}
      />
      {catalog.error && (
        <div role="alert" className="border-b border-red-950 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {catalog.error}
        </div>
      )}
      {catalog.loading && catalog.artifacts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-neutral-500">Loading artifacts…</div>
      ) : catalog.artifacts.length === 0 ? (
        <EmptyState
          title="No artifacts yet"
          detail="Completed uploads appear here automatically. Agents can deliberately share finished files with present_artifact."
        />
      ) : (
        <>
          <ArtifactList artifacts={catalog.artifacts} selectedId={catalog.selectedId} onSelect={catalog.setSelectedId} />
          <div className="min-h-0 flex-1">
            <ArtifactPreview sessionId={sessionId} artifact={catalog.selected} />
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <PackageOpen size={28} className="text-neutral-700" />
      <div className="text-sm font-medium text-neutral-400">{title}</div>
      <div className="max-w-sm text-xs leading-5 text-neutral-600">{detail}</div>
    </div>
  );
}
