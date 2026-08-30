# Canonical Ruminant KV warmer — Wayang implementation journal

Date: 2026-08-29
Branch: `feat/canonical-kv-warmer-20260829`
Base: `f840101d13e0c442c9578800c8ae54371480974b`
Status: common Wayang implementation complete and tested; not integrated, configured, deployed, or restarted

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
- leaves the real foreground request payload unchanged;
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
- focused canonical/config/resource-loader tests: 41 passed;
- full backend suite under documented test-default feature selectors: 1122 passed, 0 failed, 8 skipped;
- direct route exclusion, interactive-only scope, hidden extension ordering, history-independent bundle hashing, strict key-file permissions, disabled inertness, bounded controller behavior, and sanitizer privacy tests;
- cross-service alternate-port integration using the compiled Wayang coordinator, the actual Ruminant branch, and a synthetic mock upstream: one authenticated warm attempt completed; only `system` + synthetic `user` roles and one tool schema reached the mock; the synthetic private-history canary was absent; output controls were forced; internal family/bundle headers were stripped; Ruminant reported `warmup_completed` with no active lease.

The first aggregate attempt inherited production feature flags and produced one Standard-browser startup fixture failure plus cascading store failures. Re-running with only known non-secret feature selectors forced to their documented test defaults passed completely. No environment or credential value was read or printed.

## Pending cross-service work

- owner answer for event-driven dirty restoration versus restart-only;
- owner answer for memory-only versus private persistent template;
- apply the answer to Ruminant configuration/default documentation and Wayang storage design;
- mock/live cross-service integration and prompt-leak scan;
- current-main reconciliation and independent review;
- disabled-by-default integration, then controlled Ruminant/Wayang/Narwhal canary.

No production source edit, service restart, credential read by the agent, prompt persistence, session mutation, or Narwhal change was performed.
