import { useMemo } from "react";
import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption", "code",
  "col", "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "ins",
  "kbd", "li", "main", "mark", "ol", "p", "pre", "q", "s", "samp", "section", "small",
  "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "time", "tr", "u", "ul", "var",
];
const ALLOWED_ATTR = ["aria-label", "colspan", "datetime", "open", "rowspan", "scope", "title"];

function escapeTitle(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function HtmlPreview({ html, title }: { html: string; title: string }) {
  const srcDoc = useMemo(() => {
    const sanitized = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      FORBID_TAGS: ["style", "script", "svg", "math", "form", "iframe", "object", "embed", "base", "meta", "link", "img", "audio", "video", "source"],
      FORBID_ATTR: ["style", "href", "src", "srcset", "poster"],
    });
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeTitle(title)}</title><style>html{color-scheme:dark;background:#0a0a0a;color:#e5e5e5;font:15px/1.55 system-ui,sans-serif}body{max-width:72ch;margin:0 auto;padding:24px}pre,code{font-family:ui-monospace,monospace}pre{overflow:auto;background:#171717;padding:12px;border-radius:6px}table{border-collapse:collapse}th,td{border:1px solid #404040;padding:6px 8px}blockquote{border-left:3px solid #525252;margin-left:0;padding-left:16px;color:#b3b3b3}</style></head><body>${sanitized}</body></html>`;
  }, [html, title]);

  return (
    <iframe
      title={`Sanitized preview of ${title}`}
      sandbox=""
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-neutral-950"
    />
  );
}
