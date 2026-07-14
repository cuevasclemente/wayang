/**
 * SessionResultSnippet — Renders a search snippet returned by
 * /api/sessions/search with a strict HTML allowlist.
 *
 * The backend wraps matched tokens in <mark>…</mark> and replaces newlines
 * with <br>. To defend against accidental snippet leakage from upstream FTS
 * changes or malicious payloads, we re-sanitize on the client: any tag other
 * than <mark> or <br> is stripped and rendered as plain text.
 */

import { useMemo } from "react";

interface SessionResultSnippetProps {
  html: string;
  className?: string;
  /** Optional aria label for screen readers. */
  ariaLabel?: string;
}

const ALLOWED_TAG_RE = /^<(\/?mark|br\s*\/?)>$/i;

/**
 * Conservative sanitizer for backend search snippets.
 *
 * The backend HTML-escapes all transcript text and then re-introduces a
 * tiny allowlist of structural tags (`<mark>`, `</mark>`, `<br>`). We trust
 * that contract but verify on the client: any tag that does not match the
 * allowlist is replaced with its HTML-entity rendering so it shows up as
 * literal text rather than executing.
 *
 * Text outside tag boundaries is left untouched because the backend already
 * encoded `<`, `>`, `&`, `"`, `'` as entities. Re-escaping would double the
 * ampersands.
 */
export function sanitizeSnippetHtml(input: string): string {
  if (!input) return "";
  return input.replace(/<[^>]*>/g, (tag) => {
    if (ALLOWED_TAG_RE.test(tag)) {
      if (/^<br/i.test(tag)) return "<br>";
      return tag.toLowerCase();
    }
    // Unknown tag: render as literal text.
    return tag.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  });
}

export function SessionResultSnippet({ html, className, ariaLabel }: SessionResultSnippetProps) {
  const safe = useMemo(() => sanitizeSnippetHtml(html), [html]);
  return (
    <div
      className={className}
      aria-label={ariaLabel}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
