import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfPreview({ url, title }: { url: string; title: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let task: ReturnType<typeof getDocument> | null = null;
    setDocument(null);
    setPageNumber(1);
    setError("");
    setLoading(true);
    void fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("PDF preview is unavailable");
        return response.arrayBuffer();
      })
      .then(async (buffer) => {
        if (cancelled) return;
        task = getDocument({ data: new Uint8Array(buffer), enableXfa: false });
        const loaded = await task.promise;
        if (cancelled) { await task.destroy(); return; }
        setDocument(loaded);
        setLoading(false);
      })
      .catch((caught) => {
        if (cancelled || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
      void task?.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<unknown> } | null = null;
    void document.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const base = page.getViewport({ scale: 1 });
      const available = Math.max(320, canvasRef.current.parentElement?.clientWidth ?? 720) - 24;
      const scale = Math.min(2.25, Math.max(0.5, available / base.width));
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas is unavailable");
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      return renderTask.promise;
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber]);

  if (loading) return <div className="flex h-full items-center justify-center text-xs text-neutral-500">Loading PDF…</div>;
  if (error) return <div className="flex h-full items-center justify-center p-4 text-center text-xs text-red-400">{error}</div>;
  if (!document) return null;

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={`PDF preview of ${title}`}>
      <div className="flex shrink-0 items-center justify-center gap-3 border-b border-neutral-900 py-1.5 text-xs text-neutral-400">
        <button type="button" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))} className="rounded p-1 hover:bg-neutral-800 disabled:opacity-30" aria-label="Previous PDF page"><ChevronLeft size={15} /></button>
        <span>Page {pageNumber} of {document.numPages}</span>
        <button type="button" disabled={pageNumber >= document.numPages} onClick={() => setPageNumber((page) => Math.min(document.numPages, page + 1))} className="rounded p-1 hover:bg-neutral-800 disabled:opacity-30" aria-label="Next PDF page"><ChevronRight size={15} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-neutral-900 p-3">
        <canvas ref={canvasRef} className="mx-auto block max-w-none bg-white shadow-xl" />
      </div>
    </div>
  );
}
