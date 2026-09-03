import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, FileQuestion } from "lucide-react";
import {
  ApiError,
  artifactPreviewUrl,
  fetchArtifactTextPreview,
  type ArtifactTextPreviewResponse,
  type SessionArtifact,
} from "../../api/client";
import { CodePreview } from "./CodePreview";
import { HtmlPreview } from "./HtmlPreview";
import { MarkdownPreview } from "./MarkdownPreview";
const PdfPreview = lazy(() => import("./PdfPreview").then((module) => ({ default: module.PdfPreview })));

export function ArtifactPreview({ sessionId, artifact }: { sessionId: string; artifact: SessionArtifact | null }) {
  const [textPreview, setTextPreview] = useState<ArtifactTextPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTextPreview(null);
    setError("");
    if (!artifact?.preview_available || !["markdown", "text", "html"].includes(artifact.renderer)) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchArtifactTextPreview(sessionId, artifact.id, controller.signal)
      .then((preview) => setTextPreview(preview))
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught.message : String(caught));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, artifact?.id, artifact?.preview_available, artifact?.renderer]);

  if (!artifact) {
    return <div className="flex h-full items-center justify-center text-xs text-neutral-600">Select an artifact to preview</div>;
  }

  const title = artifact.title || artifact.name;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-neutral-900 px-3 py-2">
        <div className="truncate text-xs font-medium text-neutral-200">{title}</div>
        <div className="truncate font-mono text-[10px] text-neutral-600" title={artifact.display_path}>{artifact.display_path}</div>
        {artifact.description && <div className="mt-1 text-[11px] leading-4 text-neutral-400">{artifact.description}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!artifact.available ? (
          <EmptyPreview icon={<AlertTriangle size={20} />} text="This artifact is no longer available under the session's current policy." />
        ) : !artifact.preview_available ? (
          <EmptyPreview icon={<FileQuestion size={20} />} text="Preview unavailable for this format or size. The original can still be downloaded when permitted." />
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-xs text-neutral-500">Loading preview…</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-red-400">{error}</div>
        ) : artifact.renderer === "markdown" && textPreview ? (
          <MarkdownPreview text={textPreview.text} />
        ) : artifact.renderer === "text" && textPreview ? (
          <CodePreview text={textPreview.text} language={textPreview.language} />
        ) : artifact.renderer === "html" && textPreview ? (
          <HtmlPreview html={textPreview.text} title={title} />
        ) : artifact.renderer === "image" ? (
          <div className="flex min-h-full items-center justify-center bg-neutral-900 p-3">
            <img
              src={artifactPreviewUrl(sessionId, artifact.id)}
              alt={title}
              referrerPolicy="no-referrer"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : artifact.renderer === "pdf" ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-neutral-500">Loading PDF renderer…</div>}>
            <PdfPreview url={artifactPreviewUrl(sessionId, artifact.id)} title={title} />
          </Suspense>
        ) : (
          <EmptyPreview icon={<FileQuestion size={20} />} text="No preview renderer is available." />
        )}
      </div>
    </div>
  );
}

function EmptyPreview({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-neutral-500">
      <span className="text-neutral-600">{icon}</span>
      <span className="max-w-sm">{text}</span>
    </div>
  );
}
