export function CodePreview({ text, language }: { text: string; language: string | null }) {
  return (
    <div className="h-full overflow-auto bg-neutral-950">
      {language && language !== "plaintext" && (
        <div className="sticky top-0 border-b border-neutral-900 bg-neutral-950/95 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-600">
          {language}
        </div>
      )}
      <pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-neutral-200">{text}</pre>
    </div>
  );
}
