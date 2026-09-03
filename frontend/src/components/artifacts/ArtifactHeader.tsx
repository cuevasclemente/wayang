import { Download, RefreshCw } from "lucide-react";
import { artifactDownloadUrl, type SessionArtifact } from "../../api/client";

export function ArtifactHeader({
  sessionId,
  artifact,
  count,
  loading,
  onRefresh,
}: {
  sessionId: string;
  artifact: SessionArtifact | null;
  count: number;
  loading: boolean;
  onRefresh(): void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 border-b border-neutral-900 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs font-semibold text-neutral-200">Session artifacts</div>
        <div className="text-[10px] text-neutral-500">{count} {count === 1 ? "artifact" : "artifacts"}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-50"
          aria-label="Refresh artifacts"
          title="Refresh artifacts"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
        {artifact?.download_available && (
          <a
            href={artifactDownloadUrl(sessionId, artifact.id)}
            className="flex items-center gap-1 rounded px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-neutral-800 hover:text-white"
            title={`Download ${artifact.name}`}
          >
            <Download size={14} />
            Download
          </a>
        )}
      </div>
    </div>
  );
}
