# @wayang/protocol

Shared TypeScript wire contract between the Wayang backend and companion
clients (the web frontend and the React Native mobile app).

- **Types only.** No runtime code, no dependencies. Importing this package
  never changes a bundle or the deterministic `npm ci` contract.
- `src/rest.ts` — REST payload types for the v1 HTTP endpoint set.
- `src/ws.ts` — chat WebSocket message types (client→server and server→client)
  for `/ws/chat`.

The backend serializers in `backend/src/routes/ws.ts` and
`backend/src/routes/sessions.ts` are the source of truth; this package mirrors
them and is kept honest by wire-contract tests under
`backend/src/routes/*protocol-contract.test.ts`.

## Consumption

- **backend/**: TypeScript project reference + path mapping
  (`backend/tsconfig.json` maps `@wayang/protocol` to
  `../packages/protocol/src/index.ts`; `npm --prefix backend run build` runs
  `tsc -b`, which builds this package's declarations first). Imports are
  `import type` only.
- **mobile/**: tsconfig path mapping to `../packages/protocol/src/index.ts`
  plus Metro `watchFolders` on this package (types are erased at bundle time).

## Evolution policy

Additive-only. New message types and new optional fields may be added at any
time; existing types and fields are never removed, renamed, or retyped within
a major protocol version. Consumers must ignore unknown message types and
unknown fields without crashing. See `docs/mobile-app.md` for the full
contract.
