# Canonical Ruminant KV warmer — Wayang implementation journal

Date: 2026-08-29
Branch: `feat/canonical-kv-warmer-20260829`
Base: `f840101d13e0c442c9578800c8ae54371480974b`
Status: integrated and enabled; live prompt-stability follow-up implemented and gate-complete, pending restart/revalidation

## Scope

Implemented the Wayang-owned capture and controller half of a canonical Wren + Memoriki + Qwen prefix warmer.

The new path is disabled by default and requires an exact authorized Standard interactive Project/Profile, exact provider/model, and proof that the selected model actually routes through the configured Ruminant origin plus `/v1`. Direct Narwhal, Protected, scheduled, subagent, restricted-resource, other-project/profile, and other-model runtimes do not load the hidden capture extension.

The final inline provider hook:

- loads after ordinary file-backed and memory-first payload handlers;
- creates a new allowlisted JSON template from the final provider payload;
- retains only contiguous leading system/developer messages, exact tool schemas, and selected chat-template fields;
- drops every real user, assistant, tool-result, session/account metadata, cache key, and conversation-history message;
- appends one fixed public synthetic user message;
- forces the warm copy to non-streaming, one output token, and `tool_choice=none`;
- leaves ordinary real conversation content unchanged while relocating only the exact bounded dynamic coordination snapshot after the stable developer/tool prefix;
- keeps the sanitized template only in Wayang process memory;
- tags later canonical Ruminant requests only with a family label and SHA-256 bundle identifier.

The process controller:

- opens the explicit Ruminant bearer file only when enabled;
- requires a private regular non-symlink key file;
- polls bounded authenticated content-free warm status;
- keeps at most one status/warm request in flight;
- submits the sanitized body directly to Ruminant, without an AgentSession or tool dispatcher;
- consumes bounded response bodies, handles preemption as retryable, and applies bounded exponential backoff;
- aborts and clears key material on shutdown;
- never writes the template to Wayang's store, Pi JSONL, search index, browser state, or logs.

## Files

- `backend/src/canonical-kv-warmup.ts`
- `backend/src/canonical-kv-warmup.test.ts`
- `backend/src/config.ts`
- `backend/src/config.test.ts`
- `backend/src/agent-runtime.ts`
- `backend/src/agent-runtime.test.ts`
- `backend/src/pi-bridge.ts`
- `backend/src/app.ts`
- `.env.example`
- `docs/configuration.md`

## Validation

Passed:

- backend TypeScript production build;
- focused canonical/config/resource-loader tests: 43 passed;
- full backend suite under documented test-default feature selectors after the live follow-up: 1126 passed, 0 failed, 8 skipped;
- direct route exclusion, interactive-only scope, hidden extension ordering, history-independent bundle hashing, strict key-file permissions, disabled inertness, bounded controller behavior, and sanitizer privacy tests;
- cross-service alternate-port integration using the compiled Wayang coordinator, the actual Ruminant branch, and a synthetic mock upstream: one authenticated warm attempt completed; only `system` + synthetic `user` roles and one tool schema reached the mock; the synthetic private-history canary was absent; output controls were forced; internal family/bundle headers were stripped; Ruminant reported `warmup_completed` with no active lease.

The first live production canary found one material prompt-stability defect before acceptance: three fresh canonical sessions each produced a different bundle and remained fully cold (~13.9K evaluated tokens / 86–94 seconds). Content-free component hashes showed all 49 tool schemas and chat-template fields were identical; only the leading developer message varied. Temporary memory-only prefix/suffix diagnostics localized the change to the session-coordinator's live peer/claim/message snapshot about 20.4 KB into that message. The follow-up fix recognizes only the extension's exact bounded heading and terminal guideline, removes that advisory snapshot from the canonical developer message, and inserts it unchanged as a provider-only user-context message before the real conversation. The authoritative developer text and schemas become stable; the model still receives coordination context; the warm sanitizer discards it with all other user content; malformed or ambiguous sentinels leave the real request unchanged and reject capture. Focused relocation/privacy tests were added. Live revalidation remains required after restart.

The first aggregate attempt inherited production feature flags and produced one Standard-browser startup fixture failure plus cascading store failures. Re-running with only known non-secret feature selectors forced to their documented test defaults passed completely. No environment or credential value was read or printed.

## Pending cross-service work

- commit, fast-forward integrate, build, and restart the gate-complete prompt-stability follow-up;
- repeat two fresh canonical sessions and require a stable bundle plus >90% prefix reuse / <5-second prompt processing;
- exercise noncanonical eviction with event-driven idle restoration and live foreground preemption;
- complete unauthenticated-denial, durable-store/log absence, normal streaming/tool/vision/cancellation, and Narwhal error-log gates;
- retain memory-only template storage and existing rollback bundles.

Production currently runs the reviewed common warmer with event-driven restoration and memory-only Wayang storage. No prompt template was persisted or logged. The follow-up changes above remain isolated until commit/integration/restart.
