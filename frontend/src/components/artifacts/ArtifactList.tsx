import { File, FileCode2, FileImage, FileText, Upload, WandSparkles } from "lucide-react";
import type { SessionArtifact } from "../../api/client";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(artifact: SessionArtifact) {
  if (artifact.renderer === "image") return <FileImage size={15} />;
  if (artifact.renderer === "markdown" || artifact.renderer === "text" || artifact.renderer === "html") return <FileCode2 size={15} />;
  if (artifact.renderer === "pdf") return <FileText size={15} />;
  return <File size={15} />;
}

export function ArtifactList({
  artifacts,
  selectedId,
  onSelect,
}: {
  artifacts: SessionArtifact[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  return (
    <div className="max-h-48 shrink-0 overflow-y-auto border-b border-neutral-900" role="listbox" aria-label="Session artifacts">
      {artifacts.map((artifact) => (
        <button
          key={artifact.id}
          type="button"
          role="option"
          aria-selected={artifact.id === selectedId}
          onClick={() => onSelect(artifact.id)}
          className={`flex w-full items-start gap-2 border-b border-neutral-900/60 px-3 py-2.5 text-left transition-colors ${
            artifact.id === selectedId ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"
          } ${artifact.available ? "" : "opacity-60"}`}
        >
          <span className="mt-0.5 shrink-0 text-neutral-500">{iconFor(artifact)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{artifact.title || artifact.name}</span>
            <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-neutral-500">
              {artifact.source === "presented" ? <WandSparkles size={10} /> : <Upload size={10} />}
              {artifact.source === "presented" ? "Shared by agent" : "Uploaded"}
              <span aria-hidden="true">·</span>
              {formatBytes(artifact.size)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
