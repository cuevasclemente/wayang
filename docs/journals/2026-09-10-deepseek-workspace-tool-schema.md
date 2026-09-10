# DeepSeek workspace tool schema compatibility — 2026-09-10

## Summary

Wayang requests using `openrouter-zdr/deepseek/deepseek-v4.1-flash` failed before producing tokens with a generic upstream `invalid request`. Equivalent requests through the checkout's pinned Pi runtime succeeded, including normal extensions and project context.

The failure was isolated to `wayang_workspace_read`: its parameters were expressed as a top-level `Type.Union`, which serializes as a top-level JSON Schema `anyOf`. The active OpenAI-compatible route rejected that tool contract before inference.

## Reproduction evidence

Using the same model, thinking level, strict-ZDR routing, and pinned Pi runtime:

1. A minimal request without the suspect schema returned `OK`.
2. Adding one synthetic custom tool with top-level `Type.Union([Type.Object(...), ...])` reproduced the generic `invalid request`.
3. Replacing it with `Type.Object({ action: Type.Union(...), ... })` returned `OK`.
4. Registering both exact updated Wayang workspace tools together returned `OK`, confirming the nested mutation union remains accepted.

This distinguishes the tool-schema failure from authentication, prompt content, model discovery, or a transient endpoint outage.

## Change

`backend/src/workspace-tools.ts` now gives `wayang_workspace_read` a provider-compatible top-level object schema. The action discriminator remains an enum-like union inside the object, with optional `id` and `project_id` fields.

Because the transport schema is necessarily broader than the former discriminated top-level union, `canonicalizeReadAction` enforces the exact action-specific field set before the workspace service is called. Missing identifiers and incompatible fields fail closed.

Regression tests assert that every Wayang workspace tool has a top-level object parameter schema and that invalid action/field combinations never reach the service.

## Validation

- Exact updated Wayang workspace tool pair with DeepSeek V4.1 strict-ZDR: `OK`.
- Focused `workspace-tools.test.ts`: 5 passed.
- `make check`:
  - Backend: 1,301 passed, 10 skipped, 0 failed.
  - Frontend: 20 passed; lint completed with one pre-existing non-failing Fast Refresh warning.
  - Script tests: 67 passed.
  - Backend and frontend production builds passed.
- `git diff --check`: passed.

## Deployment state

The source fix is integrated into local `main` at commit `605866c`. The running Wayang service has not been rebuilt or restarted for this change; activation requires a separately authorized deployment/restart. Until then, existing and newly retried live sessions continue using the old serialized schema.

Rollback is the parent of `605866c` (`5abe6ef`) or a focused revert of `605866c`.
