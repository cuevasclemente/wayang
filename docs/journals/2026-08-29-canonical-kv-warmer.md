# Canonical Ruminant KV warmer — Wayang implementation journal

Date: 2026-08-29
Branch: `feat/canonical-kv-warmer-20260829`
Base: `f840101d13e0c442c9578800c8ae54371480974b`
Status: integrated, enabled, and production-validated; optional recoverable canary cleanup pending

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

The first live production canary found one material prompt-stability defect before acceptance: three fresh canonical sessions each produced a different bundle and remained fully cold (~13.9K evaluated tokens / 86–94 seconds). Content-free component hashes showed all 49 tool schemas and chat-template fields were identical; only the leading developer message varied. Temporary memory-only prefix/suffix diagnostics localized the change to the session-coordinator's live peer/claim/message snapshot about 20.4 KB into that message. The follow-up fix recognizes only the extension's exact bounded heading and terminal guideline, removes that advisory snapshot from the canonical developer message, and inserts it unchanged as a provider-only user-context message before the real conversation. The authoritative developer text and schemas become stable; the model still receives coordination context; the warm sanitizer discards it with all other user content; malformed or ambiguous sentinels leave the real request unchanged and reject capture. Focused relocation/privacy tests were added. After restart, the memory-only seed was expectedly cold at 13,742 evaluated tokens / 93.88 seconds; the immediate sanitized warm evaluated 21 tokens / 0.67 seconds. Independent fresh sessions then reused 98.2–98.8% of the prefix, with simple prompt-evaluation samples of 2.11, 2.34, and 2.61 seconds. Cache reload and deliberately accumulated coordination/canary state produced 6.22–6.36-second outliers, so sub-five-second prefill is typical rather than guaranteed while >90% stable reuse is sustained.

The first aggregate attempt inherited production feature flags and produced one Standard-browser startup fixture failure plus cascading store failures. Re-running with only known non-secret feature selectors forced to their documented test defaults passed completely. No environment or credential value was read or printed.

## Production closure

- Wayang follow-up `e3b00ca` was fast-forward integrated, built, and loaded by the controlled service restart.
- An 18,033-token public noncanonical request marked the family dirty; the original bundle was restored automatically with a 21-token / 1.06-second warm request.
- A live foreground request preempted an active warm lease; Ruminant returned retryable HTTP 409, preemption increased without failure inflation, and the coordinator restored the same bundle on its next attempt.
- Unauthenticated status denial, content-free status, and durable-store/log scans passed. The warm marker and internal prefix headers were absent from Ruminant SQLite/WAL/SHM and service logs; the warm marker was absent from Wayang data/logs.
- Normal streaming, one complete tool round-trip, cancellation, and image input passed. The solid-red image returned exact `RED`; llama.cpp emitted image-specific non-consecutive-position warnings but no device loss or request error.
- Wayang, Ruminant, and Narwhal remained active with zero automatic restarts. Installed drop-in hashes matched reviewed artifacts, and Ruminant's rollback preflight re-hashed all eight deployed paths without mutation.
- Final Ruminant status was `warm` with equal desired/warm content-free bundle hashes, no active foreground or background lease, and zero warmup failures.

The owner-selected production policy remains event-driven dirty restoration and memory-only Wayang template storage. No effective prompt template was persisted or logged. Eighteen named canary/diagnostic sessions may be recoverably archived, and disabled temporary diagnostics may be moved to a timestamped holding directory after explicit cleanup approval; permanent transcript deletion is unnecessary.
