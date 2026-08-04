export type ParsedSessionRoute =
  | { kind: "root" }
  | { kind: "session"; sessionId: string; canonicalPath: string }
  | { kind: "invalid"; requestedPath: string };

const SESSION_ROUTE_PREFIX = "/sessions/";

export function sessionPath(sessionId: string): string {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function parseSessionPath(pathname: string): ParsedSessionRoute {
  if (pathname === "/") return { kind: "root" };
  if (!pathname.startsWith(SESSION_ROUTE_PREFIX)) {
    return { kind: "invalid", requestedPath: pathname };
  }

  const encodedSegment = pathname.slice(SESSION_ROUTE_PREFIX.length).replace(/\/$/, "");
  if (!encodedSegment || encodedSegment.includes("/")) {
    return { kind: "invalid", requestedPath: pathname };
  }

  try {
    const sessionId = decodeURIComponent(encodedSegment);
    if (!sessionId) return { kind: "invalid", requestedPath: pathname };
    return { kind: "session", sessionId, canonicalPath: sessionPath(sessionId) };
  } catch {
    return { kind: "invalid", requestedPath: pathname };
  }
}

export function isCurrentSessionPath(sessionId: string, pathname = window.location.pathname): boolean {
  return pathname === sessionPath(sessionId);
}
