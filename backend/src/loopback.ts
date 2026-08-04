import { isIP } from "node:net";

function normalizedAddress(value: string): string {
  return value.trim().toLowerCase().split("%", 1)[0]!.replace(/^\[|\]$/gu, "");
}

function isIpv4Loopback(value: string): boolean {
  return isIP(value) === 4 && value.split(".", 1)[0] === "127";
}

/** Strict socket-address check; hostnames are never accepted as peer addresses. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = normalizedAddress(address);
  if (normalized === "::1") return true;
  if (isIpv4Loopback(normalized)) return true;
  if (!normalized.startsWith("::ffff:")) return false;
  return isIpv4Loopback(normalized.slice("::ffff:".length));
}

/** Strict configured/request hostname check with intentional localhost support. */
export function isLoopbackHost(host: string): boolean {
  const normalized = normalizedAddress(host);
  return normalized === "localhost" || isLoopbackAddress(normalized);
}
