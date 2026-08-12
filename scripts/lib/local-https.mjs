import { isLoopbackHost, normalizePublicOrigin } from "./config.mjs";

const CADDY_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
]);

function required(values, key, message) {
  const value = values.get(key)?.trim() || "";
  if (!value) throw new Error(message);
  return value;
}

function localHttpsPublicOrigin(raw) {
  const exact = raw.match(/^https:\/\/([^/?#@\\\u0000-\u0020\u007f]+)\/?$/iu);
  if (!exact || exact[1].endsWith(":")) {
    throw new Error("Local HTTPS proxy origin must be one exact HTTPS authority without credentials, path, query, fragment, controls, or backslashes");
  }
  const publicOrigin = normalizePublicOrigin(raw);
  const parsed = new URL(publicOrigin);
  if (parsed.protocol !== "https:") throw new Error("Local HTTPS proxy mode requires an exact HTTPS WAYANG_PUBLIC_ORIGIN");
  const hostname = parsed.hostname.toLowerCase();
  if (isLoopbackHost(hostname) || ["0.0.0.0", "::", "[::]", "*"].includes(hostname)) {
    throw new Error("Local HTTPS proxy mode requires a non-loopback browser origin");
  }
  const httpsPort = Number(parsed.port);
  if (!parsed.port || !Number.isInteger(httpsPort) || httpsPort < 1024 || httpsPort > 65535) {
    throw new Error("Local HTTPS proxy mode requires an explicit unprivileged port from 1024 through 65535");
  }
  return { publicOrigin, publicAuthority: parsed.host };
}

/** Validate only the non-secret deployment shape needed by the local Caddy
 * foreground proxy. Secret values are checked for presence but are never
 * returned, printed, or inherited by Caddy. */
export function localHttpsSettings(values) {
  if (!(values instanceof Map)) throw new Error("Wayang configuration values are unavailable");
  const host = required(values, "WAYANG_HOST", "Local HTTPS proxy mode requires WAYANG_HOST=127.0.0.1");
  if (host !== "127.0.0.1") throw new Error("Local HTTPS proxy mode requires WAYANG_HOST=127.0.0.1");
  const backendPort = Number(required(values, "WAYANG_PORT", "Local HTTPS proxy mode requires a backend port"));
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
    throw new Error("WAYANG_PORT must be an integer from 1 through 65535");
  }

  const origin = localHttpsPublicOrigin(required(
    values,
    "WAYANG_PUBLIC_ORIGIN",
    "Local HTTPS proxy mode requires an exact HTTPS WAYANG_PUBLIC_ORIGIN",
  ));
  if (values.get("WAYANG_AUTH_ENABLED") !== "1") {
    throw new Error("Local HTTPS proxy mode requires Wayang built-in authentication");
  }
  if (!(values.get("WAYANG_AUTH_PASSWORD_HASH")?.trim() && values.get("WAYANG_AUTH_SESSION_SECRET")?.trim())) {
    throw new Error("Wayang shared-password credentials are unavailable; rerun make configure in a local terminal");
  }
  if ((values.get("WAYANG_TRUST_PROXY") || "loopback") !== "loopback") {
    throw new Error("Local HTTPS proxy mode requires WAYANG_TRUST_PROXY=loopback");
  }
  if (!["auto", "1"].includes(values.get("WAYANG_AUTH_COOKIE_SECURE") || "auto")) {
    throw new Error("Local HTTPS proxy mode requires Secure cookies (auto or 1)");
  }
  if (values.get("WAYANG_AUTH_PROXY_IDENTITY_HEADER")?.trim()) {
    throw new Error("Built-in authentication and WAYANG_AUTH_PROXY_IDENTITY_HEADER are mutually exclusive");
  }

  return Object.freeze({
    ...origin,
    backendOrigin: `http://127.0.0.1:${backendPort}`,
  });
}

/** Render a complete no-access-log Caddyfile. Caddy terminates a local-CA HTTPS
 * origin, proxies every path/WebSocket to loopback, and replaces rather than
 * trusts caller-supplied forwarding metadata. */
export function buildLocalHttpsCaddyfile(settings) {
  if (!settings?.publicOrigin || !settings?.publicAuthority || !settings?.backendOrigin) {
    throw new Error("Validated local HTTPS settings are required");
  }
  return `{
\tadmin off
}

${settings.publicOrigin} {
\ttls internal
\treverse_proxy ${settings.backendOrigin} {
\t\theader_up -Forwarded
\t\theader_up -X-Forwarded-For
\t\theader_up -X-Forwarded-Host
\t\theader_up -X-Forwarded-Proto
\t\theader_up Host ${JSON.stringify(settings.publicAuthority)}
\t\theader_up X-Forwarded-For "{http.request.remote.host}"
\t\theader_up X-Forwarded-Proto "https"
\t}
}
`;
}

/** Caddy receives only process mechanics needed for executable discovery,
 * private local-CA storage, locale, and temporary files. Wayang/provider/proxy
 * credentials and loader hooks are never forwarded. */
export function localHttpsCaddyEnvironment(source = process.env) {
  const environment = {};
  for (const key of CADDY_ENVIRONMENT_KEYS) {
    if (typeof source[key] === "string" && source[key]) environment[key] = source[key];
  }
  return environment;
}
