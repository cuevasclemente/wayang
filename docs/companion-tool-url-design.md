# Companion browser startup configuration design

## Problem

Wayang distinguishes the browser-facing public origin from the address used by optional companion pi tools. `WAYANG_PUBLIC_ORIGIN` defines the exact authority accepted by the backend's origin and DNS-rebinding defenses. Companion tools address the backend through `WAYANG_URL` and otherwise commonly default to `http://127.0.0.1:8787`.

A supported non-loopback configuration can therefore become internally inconsistent: `make configure` records an exact public origin but neither recommends nor manages `WAYANG_URL`. A companion tool that uses the documented loopback default then receives `403 Origin not allowed`, even though the Wayang UI works through the configured public origin.

Observed reproduction:

- configured browser origin: `http://wayang-host.test:8787`;
- companion URL: unset, so the tool used `http://127.0.0.1:8787`;
- the same safe browser-status request returned 403 through the loopback authority and 200 through the configured authority.

After the authorized authority was used, browser startup exposed a second portability defect. Chrome was installed at the standard macOS application path, but Wayang's executable resolver checked only Linux system paths and Linux Playwright-cache layouts. Startup therefore failed with `Chromium executable not found` despite a compatible browser being present.

## Decision

Keep the backend's exact-origin security behavior unchanged. Extend the supported configuration flow so it explicitly manages the optional companion-tool URL:

1. After host, port, and public origin are resolved, compute a recommended companion URL:
   - configured public origin, when present;
   - otherwise the selected loopback bind host and port, with IPv6 bracketed;
   - safely fall back to `http://127.0.0.1:<port>` when the host is absent, unspecified, wildcard, invalid, or non-loopback.
2. Prompt for `WAYANG_URL`, defaulting to the existing value when present and otherwise to the recommendation.
3. Validate it as an absolute HTTP(S) origin without credentials, path, query, or fragment.
4. When an existing value differs from the new recommendation, preserve the explicit value by default rather than silently overwriting it.
5. Document that companion tools remain optional and that built-in authentication requires a separately designed authenticated integration.

This makes the supported configuration path self-consistent without assuming a companion extension is installed.

Also extend Chromium discovery without changing launch or profile semantics:

1. Keep the precedence order: explicit environment override, Playwright cache, system installation, then `PATH` lookup.
2. Use the platform's Playwright cache root (`~/Library/Caches/ms-playwright` on macOS; the existing `~/.cache/ms-playwright` on Linux).
3. Recognize current macOS Playwright Chromium and Chromium headless-shell layouts for x64 and arm64, select the detected host architecture, and detect Apple Silicon even when Node runs under Rosetta; retain the legacy Chromium app layout where practical.
4. Recognize standard system and per-user macOS Google Chrome and Chromium application paths.
5. Keep Linux behavior unchanged and add pure/testable candidate generation so platform coverage does not depend on the test machine's installed browsers.

## Alternatives considered

### Allow loopback and public authorities simultaneously in the backend

This would make the default tool URL work, but it broadens an intentional authority boundary and does not solve authentication for companion tools. Rejected.

### Change only one private companion client

A private companion client could fall back to `WAYANG_PUBLIC_ORIGIN`, but that would fix only one client rather than the public configuration contract. Rejected as the upstream solution.

### Documentation-only warning

This would explain the mismatch but leave the supported wizard able to reproduce it. Rejected because a small validated configuration change can prevent the error.

### Require `WAYANG_CHROMIUM_PATH` on macOS

An explicit path is a valid immediate workaround, but requiring it contradicts Wayang's documented automatic browser discovery and makes the default Mac installation fail unnecessarily. Rejected as the upstream behavior.

## Security and privacy

- Do not relax authority or Origin validation.
- Do not add browser cookies, shared passwords, or secrets to companion-tool arguments or source.
- Treat `WAYANG_URL` as non-secret configuration.
- Preserve `.env` through the existing atomic, mode-0600 configuration writer; tests must not print or inspect secret values.
- Authenticated companion-tool transport remains out of scope.
- Browser discovery inspects only candidate path metadata and executable existence; it never reads browser profiles, cookies, or storage.

## Testing

Use test-first development around pure configuration helpers and the existing script tests:

- a public origin becomes the recommendation;
- loopback-only configuration recommends the selected bind host, including bracketed IPv6, with `http://127.0.0.1:<port>` as the safe fallback;
- invalid companion URLs, including empty ports erased by WHATWG parsing, are rejected;
- an explicit existing override is preserved by default;
- dry-run remains non-interactive and secret-free;
- macOS candidate generation includes standard Chrome/Chromium application paths;
- macOS Playwright discovery covers current Chromium and headless-shell arm64/x64 layouts, native-only selection, deterministic product/revision order, and Rosetta-aware Apple Silicon detection;
- Linux candidate ordering and behavior remain intact;
- the full Wayang test/build suite remains green.

## Rollout and rollback

During rollout, rerun `make configure`, review the recommended companion URL for the deployment, restart Wayang, and verify the browser status/open/navigate flow. Automatic macOS discovery should find a standard compatible browser installation; `WAYANG_CHROMIUM_PATH` remains available as an explicit non-secret override.

Roll back by restoring the previous supported configuration or removing newly added non-secret overrides, restarting Wayang, and confirming core UI access. Rollback does not require relaxing origin checks or deleting user data.
