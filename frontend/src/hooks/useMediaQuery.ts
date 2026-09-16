import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query. Used to gate mobile-only layout
 * affordances without relying on fragile CSS-only visual hiding for
 * interactive controls.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** Width at which Wayang switches between the mobile and desktop shell. */
export const MOBILE_BREAKPOINT_QUERY = "(max-width: 768px)";
