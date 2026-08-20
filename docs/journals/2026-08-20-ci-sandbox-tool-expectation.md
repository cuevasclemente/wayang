# CI sandbox-tool expectation repair

Date: 2026-08-20

## Problem

The Standard interactive-browser runtime injection test required `bash` unconditionally. Restricted Wayang runtimes intentionally remove `bash` when the operating-system sandbox prerequisites are unavailable. GitHub's Linux runners currently lack `rg`, Bubblewrap, and `socat`, so the security-preserving behavior made both Linux CI jobs fail on otherwise unrelated changes.

## Change

The test now derives the expected restricted tool set from the production `getBashSandboxAvailability()` preflight. It still requires the exact reviewed read/edit/write and browser tools, permits no unrelated tools, requires `bash` when the sandbox is available, and expects it to be absent when Wayang must fail closed.

## Validation

- Focused `interactive-browser-runtime-injection.test.ts`: 1/1 passed on a host where sandbox prerequisites are available.
- Backend TypeScript build: passed.
- Frontend production build: passed.

GitHub CI is the complementary unavailable-sandbox validation environment.
