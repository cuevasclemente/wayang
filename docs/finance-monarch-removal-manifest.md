# Finance/Monarch removal manifest

This is a deletion manifest, not an instruction to delete private data. The listed source paths are obsolete identity/vendor-specific implementation surfaces and are safe to remove **only after all imports, routes, runtime assembly, UI wiring, and test references to them have been removed**.

Do not delete or inspect `.env`, `WAYANG_DATA_DIR`, browser profiles, downloads, raw exports, SQLite databases, catalogs, backups, or other private state as part of source cleanup. Historical journals and plans are also out of scope and remain historical records.

## Recursive source-directory removals

Each path below is a dedicated Finance/Monarch directory. Remove the directory and all tracked files beneath it, including colocated `*.test.ts` files:

- `backend/src/finance-browser/`
- `backend/src/finance-exports/`
- `backend/src/restricted-mcp/catalog/`
- `backend/src/restricted-mcp/provider-runtime/`
- `backend/src/restricted-mcp/provider-packages/monarch-readonly-v1/`

These entries intentionally use exact directory roots rather than broad `finance*` or `monarch*` globs.

## Standalone backend files

Remove these dedicated files and tests after their imports are gone:

- `backend/src/finance-export-composition.ts`
- `backend/src/finance-export-composition.test.ts`
- `backend/src/finance-runtime-eligibility.ts`
- `backend/src/finance-runtime-eligibility.test.ts`
- `backend/src/routes/finance-browser.ts`
- `backend/src/routes/finance-browser.test.ts`

## Standalone frontend files

Remove these dedicated Finance viewer/export components after mixed callers and API-client symbols are removed:

- `frontend/src/panels/FinanceExportBrowserPanel.tsx`
- `frontend/src/components/browser/FinanceBrowserViewer.tsx`
- `frontend/src/components/browser/FinanceExportProgress.tsx`
- `frontend/src/components/browser/FinanceExportToolbar.tsx`

## Explicitly not in the deletion set

The following are mixed/general files and must be edited by their runtime owners rather than deleted:

- `backend/src/app.ts`
- `backend/src/config.ts`
- `backend/src/db.ts`
- `backend/src/pi-bridge.ts`
- `backend/src/policy.ts`
- `backend/src/projects.ts`
- `backend/src/sessions.ts`
- `backend/src/browser/manager.ts`
- `backend/src/browser/request-auth.ts`
- `backend/src/restricted-mcp/index.ts`
- `frontend/src/api/client.ts`
- `frontend/src/panels/RightPanel.tsx`
- mixed backend/frontend/E2E tests that cover both generic behavior and the obsolete Finance path

Before applying the manifest, verify that the remaining source contains no import, dynamic import, route mount, tool registration, UI import, fixture reference, or package/file loader pointing into a listed path. Then run the full unit/build/script gate and E2E suite.
