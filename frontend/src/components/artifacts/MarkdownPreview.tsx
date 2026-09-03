import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeExternalHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    return parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none px-5 py-4 text-neutral-200 prose-headings:text-neutral-100 prose-a:text-sky-300 prose-code:text-neutral-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => safeExternalHref(url) ?? ""}
        components={{
          a({ href, children }: { href?: string; children?: ReactNode }) {
            const safe = safeExternalHref(href);
            return safe
              ? <a href={safe} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>
              : <span>{children}</span>;
          },
          img({ alt }: { alt?: string }) {
            return <span className="rounded bg-neutral-900 px-2 py-1 text-xs text-neutral-500">[Remote image blocked{alt ? `: ${alt}` : ""}]</span>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
