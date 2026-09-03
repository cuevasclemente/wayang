# Session Artifacts Pane: Preview, Presentation, and Download Plan

**Date:** 2026-08-26
**Status:** Implemented, reconciled with `origin/main` `8c11dfb`, and revalidated on `feat/session-artifacts-integration-20260903`; terminal architecture/security review GO; approved for source integration
**Scope:** Canonical design and implementation contract. Clemente authorized full implementation on 2026-08-30 and source integration on 2026-09-03; production deployment/restart remains separate.

## 1. Product goal

Replace Wayang's global **Files** navigator/editor with a session-scoped **Artifacts** surface where files relevant to the active session are easy to find, preview, and download.

The intended experience is:

1. An agent can deliberately share a file through one explicit tool and cause Wayang to show it in the right pane.
2. Wayang does not infer artifact intent from ordinary file tools, shell activity, or prose in v1.
3. The user can click a session artifact in chat or the Artifacts pane, preview supported formats, and download the original bytes.
4. Artifact access follows the active session's current Project/Profile and privacy policy. Merely mentioning a host path never authorizes browser access to it.
5. The pane is read-only in v1. Agents continue to edit files through tools; Wayang does not retain a general browser editor.

## 2. Interview-derived decisions

| Area | Decision |
|---|---|
| Panel model | Replace Files with an **Artifacts list + inline viewer** in one right-pane tab. |
| Access boundary | Allow files under the Wayang user's home only when the current session's effective read policy permits them. Preserve Protected-project isolation and universal secret/control-plane denials. |
| Discovery | Start with one explicit backend-owned agent sharing tool. Defer automatic file-tool, shell, backend-output, and prose discovery. |
| Preview formats | Markdown, text/code, supported raster images, PDF, and safely isolated/sanitized HTML. Other formats receive metadata and download only. |
| Editing | Read-only preview + download in v1. Remove the Files pane's text editing behavior. |

Additional decisions now frozen:

- explicit `present_artifact` focuses the pane; any future automatic source may only update the list/badge;
- references persist in a durable, bounded, per-session registry, deduplicated by authorized canonical locator and revalidated whenever used;
- v1 does not inspect successful `read`/`write`/`edit`, browser publications, backend outputs, shell activity, or prose for artifact intent.

Completed user uploads also populate the initial Artifacts list. Their backend-owned source-session provenance requires no path inference; they update the list quietly and never trigger agent-style panel focus.

## 3. Success criteria

V1 is successful when all of the following are true:

- An interactive agent can call a backend-owned `present_artifact` tool with a file path, title, and optional description.
- An explicit presentation opens/focuses the Artifacts tab and selects the exact artifact without requiring the user to navigate a filesystem tree.
- Files appear after the agent explicitly shares them through the trusted tool or after the user completes a session upload.
- Artifact references survive browser reloads and backend restarts.
- Switching sessions shows only that session's artifact registry and selection state.
- Markdown, text/code, PNG/JPEG/static-WebP, PDF, and sanitized/isolated HTML preview safely; GIF/animated images remain download-only.
- Unsupported or oversized files remain downloadable when policy permits.
- Preview and download freshly authorize the current file at the stored canonical path. A same-path replacement between requests is treated as the current path target; path retargeting or identity change during one request aborts that request.
- No API accepts a browser-supplied host path for preview/download; the browser uses opaque artifact IDs.
- Protected sessions cannot expose another Protected Project or another session's private attachments.
- The Files tree/editor is removed from the right pane without breaking project discovery.
- Backend, frontend, focused security tests, and E2E coverage pass.

## 4. Non-goals and deferrals

- Editing, saving, renaming, moving, deleting, uploading, or creating files from the Artifacts pane.
- Restoring a whole-home or whole-project directory navigator.
- Automatic artifact discovery from ordinary `read`, `write`, `edit`, browser publication, backend-output, assistant prose, Markdown, shell commands, shell output, terminal output, globs, or recursive search results.
- Executing HTML, JavaScript, SVG, notebooks, office documents, archives, or executable files.
- Converting DOCX, ODT, spreadsheets, presentations, or archives to preview formats.
- Cross-session artifact browsing or sharing.
- Copying source files into a durable Wayang artifact store.
- Durable thumbnails, OCR, semantic indexing, or content search.
- Agent-controlled HTML/CSS outside the isolated preview frame.
- Branch-faithful artifact removal in v1; the bounded session registry records session activity even if Pi later changes transcript branch.

## 5. Existing system findings

### 5.1 Files is a global host browser, not a session surface

- `frontend/src/panels/RightPanel.tsx` renders `FileTree` and `FileViewer` without passing the active session to the filesystem API.
- `frontend/src/components/FileTree.tsx` starts at `.` and expands arbitrary directories under the configured filesystem root.
- `frontend/src/components/FileViewer.tsx` loads Monaco, permits editing, and reports binary files as unviewable.
- `backend/src/routes/fs.ts` exposes `/api/fs/tree`, `/api/fs/read`, and `/api/fs/write` without a session binding.
- `backend/src/fs.ts` resolves against `Config.fsRoot` (default `$HOME`) and performs synchronous whole-file reads. It does not use the stronger session policy, no-follow descriptor, file-identity, and post-read authorization patterns used elsewhere.

Artifacts must therefore be a new subsystem. Extending `/api/fs/read?path=...` would preserve the wrong authority model.

### 5.2 Reusable authorization and safe-file patterns

- `backend/src/agent-runtime.ts` centralizes structured path-tool policy in `authorizeAgentToolCall()`.
- `backend/src/policy.ts` provides Project/Profile authorization, canonical path resolution, and containment helpers.
- `backend/src/protected-artifacts.ts` enumerates Wayang/Pi/control-plane roots and universal secret-bearing paths.
- `backend/src/session-interop.ts`, `backend/src/standard-transcript-authorization.ts`, and `backend/src/attachments.ts` demonstrate canonical regular-file checks, `O_NOFOLLOW`, descriptor/fingerprint validation, byte bounds, and privacy reauthorization.
- `backend/src/attachments.ts` already records upload provenance during the current process, but its attachment IDs deliberately expire on restart; the new registry must retain a durable reference independent of that in-memory registry.

### 5.3 Reusable session and live-event plumbing

- `backend/src/pi-bridge.ts` creates backend-owned tools, wraps tool execution, serializes Pi events, and forwards live `tool_execution_*` messages.
- `backend/src/routes/ws.ts` owns the authenticated session WebSocket.
- `backend/src/transcript-pagination/` serializes active transcript history in bounded windows.
- `frontend/src/panels/ChatPanel.tsx` already handles live structured tool events and uploaded-file chips.
- `frontend/src/App.tsx` owns desktop/mobile layout and can coordinate chat-originated focus intents with the right pane.

## 6. Core architecture

```text
Pi/Wayang agent runtime
  └─ present_artifact tool ─────────────┐
                                       ▼
                           Artifact registry service
                    (durable metadata; no copied contents)
                           │                 │
                 catalog-changed event      │ authorized locator
                           │                 │
                           ▼                 ▼
                    authenticated WS    artifact HTTP routes
                           │           list / preview / download
                           ▼                 │
                 App/Chat focus state       ▼
                           └──────► ArtifactsPanel
                                  list + safe renderer
```

### Architectural rules

1. The registry stores references and presentation metadata, never source bytes.
2. Registration is not authorization. Every list, preview, and download request reauthorizes the current session and current file.
3. The frontend never submits a host path to a content endpoint.
4. Explicit presentation is a structured backend-owned tool, not an optional personal Pi extension.
5. V1 does not infer artifact intent from ordinary tool activity or text.
6. Preview and download open the file no-follow and verify the exact descriptor before returning bytes.
7. HTML never executes in Wayang's origin.

## 7. Durable artifact registry

### 7.1 Storage and startup lifecycle

Create a dedicated SQLite database at:

```text
$WAYANG_DATA_DIR/artifact-index.db
```

Use `better-sqlite3`, already a backend dependency. Initialize the registry before the HTTP server begins listening. The parent must be an owner-only real directory; an existing database must be a canonical, owner-owned, single-link regular file with mode `0600`. A malformed schema or schema newer than the compiled version fails startup closed rather than being replaced. Use fixed pragmas consistent with the repository's other SQLite stores, bounded busy handling, foreign keys, and explicit transactions. Register an artifact-registry closer in `closeWayangServer()`.

Do not put artifact rows into `store.json`; this avoids coupling a convenience registry to the strict control-plane store schema and its single-writer transaction surface. The registry is durable but derived: losing it loses convenience metadata, never source files or transcripts.

### 7.2 Schema

```ts
interface ArtifactMetaRow {
  schema_version: 1;
}

interface ArtifactCatalogRow {
  session_id: string;            // primary key
  revision: number;              // monotonically increases after each committed visible change
}

interface SessionArtifactRow {
  id: string;                    // random UUID; only opaque ID reaches the browser
  session_id: string;
  locator_kind: "home_file" | "session_attachment";
  locator_path: string;          // backend-private canonical path captured at registration
  display_name: string;
  title: string | null;
  description: string | null;
  source: "presented" | "upload";
  source_event_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
  presented_at: number | null;
  row_revision: number;
}
```

`locator_path` is a private lookup/deduplication locator, never a durable authorization verdict. Registration disallows symlinks and multi-link files, so one session can deduplicate by `(session_id, locator_kind, locator_path)`. Every later use re-canonicalizes the locator and requires it to resolve to the same path under current policy; a moved or retargeted file becomes unavailable rather than silently following elsewhere. MIME, size, hash, and authorization remain live file properties.

Every insert, metadata update, prune, or removal runs in one transaction, increments the affected catalog revision, and emits `artifact_catalog_changed` only after commit. Global pruning increments and emits for every affected session.

### 7.3 Frozen bounds and metadata rules

- at most 100 total artifact rows per session;
- at most 8,192 rows globally;
- encoded list response at most 1 MiB;
- each public artifact projection at most 8 KiB encoded JSON;
- public `display_path` at most 1,024 UTF-8 bytes, middle-elided by the backend when necessary;
- title at most 120 UTF-8 bytes;
- description at most 1,000 UTF-8 bytes;
- display name at most 255 UTF-8 bytes;
- source event ID at most 512 UTF-8 bytes.

User-controlled metadata is NFC-normalized, trimmed where appropriate, and rejects NUL, unsafe display controls, and bidi formatting characters. A repeated explicit share updates `last_seen_at`, title/description, and order rather than adding a row. Explicit presentation wins metadata/order over an upload record for the same file. Prune oldest uploads first, then oldest presented rows.

### 7.4 Session lifecycle and cross-store deletion

- Create/update rows only after successful `present_artifact` authorization or a completed safely persisted upload.
- Keep rows for archived sessions; archived HTTP preview/download remains allowed under exact current durable authorization, while new agent presentation is denied.
- Show missing or newly denied files as unavailable; never silently retarget them.
- On startup, transactionally remove orphan rows/catalogs whose Wayang session no longer exists.
- Permanent session deletion owns an explicit cross-store sequence in `backend/src/routes/sessions.ts`: after runtime stop and search purge, but before canonical `deleteSession()`, commit idempotent artifact row/catalog removal while the existing deletion mutation authority is held. If artifact cleanup fails, call the existing `recoverSearchAfterFailedSessionDelete()` before returning the retained-session failure; if search recovery also fails, use the route's existing bounded retained-session failure semantics. If the later canonical deletion fails, the session may remain without convenience rows; its existing search recovery still runs, and future re-presentation restores convenience metadata.
- Add crash/failure tests around every deletion boundary and ensure artifact cleanup is idempotent.

## 8. Explicit agent presentation tool

### 8.1 Tool contract

Add an immutable backend-owned tool in `backend/src/artifacts/tool.ts`:

```ts
present_artifact({
  artifacts: [{
    path: string,
    title?: string,
    description?: string
  }]
})
```

Bounds:

- 1–20 artifacts per call;
- paths 1–4,096 UTF-8 bytes;
- title/description limits from the registry;
- no unknown fields.

The name alone is not authority. Define an `ArtifactToolRuntime` with an immutable binding containing source session ID, Project ID/CWD, Agent Profile ID, runtime generation, and process boot nonce. Create one `ToolDefinition` object per runtime and prohibit definition reuse across sessions.

In `backend/src/pi-bridge.ts`, add that exact definition to `customTools` and its name to `companionActiveTools` so restricted sessions receive only the backend-issued object. Extend `installAgentToolPolicyGuard()` with the trusted artifact runtime/tool object. Generic `authorizeAgentToolCall()` must deny `present_artifact` unless the candidate is that exact registered object. Store the runtime on `PiSessionHandle`; remove its registry/definition entries and close it during authority denial, model/agent replacement, archive, deletion, and shutdown.

### 8.2 Execution

For every candidate:

1. Preflight the exact current runtime binding and trusted tool object.
2. Resolve the exact durable source session and require a non-archived, non-scheduled, non-quarantined interactive session with no pending switch and exact non-null Project/Profile identity.
3. Resolve and authorize the path through the shared artifact authorization service.
4. Require an existing safe regular file.
5. Begin the registry transaction and run the final synchronous runtime/path preflight immediately before commit, with no `await` between that preflight and commit.
6. Upsert the durable registry row and commit. Any denial before commit makes no registry change.
7. Immediately after commit, emit `artifact_catalog_changed` with `focus_artifact_id` for the first successful item. Commit plus catalog/focus event is an irrevocable side effect of the final synchronous pre-commit authorization.
8. Re-run runtime preflight before returning the opaque artifact ID, display metadata, and bounded success/failure result.
9. A later outer SDK release guard may suppress only the tool result/transcript release; it cannot recall an already committed registry row or emitted focus event. HTTP authorization still prevents content disclosure after revocation.

Post-commit listener/event-send failures are caught and logged as bounded categories. They never roll back registry state, fail an otherwise committed tool/upload operation, or trigger attachment-file cleanup after the artifact transaction committed.

A partial batch may succeed item-by-item, but the result must state every rejected item without exposing denied canonical paths.

### 8.3 Transcript result

Return trusted structured details so chat history can render a durable artifact card and a future registry rebuild can recognize presentation intent:

```ts
details: {
  schema_version: 1,
  kind: "wayang_artifact_presentation",
  session_id: string,
  artifacts: [{ id, name, title, description }]
}
```

Do not place absolute paths in the public tool result. A transcript declaration is only presentation provenance; current HTTP authorization remains authoritative.

### 8.4 Availability

V1 exposes `present_artifact` only to exact live, non-archived interactive runtimes. Scheduled/dream/subagent contexts and archived sessions cannot receive or execute it. Protected sessions may use it only for paths that the exact interactive runtime can read under the shared policy. Add collision, definition replacement/reuse, stale creation, stale handle, scheduled-session, archive/replacement cleanup, and result-suppression tests.

## 9. V1 discovery boundary

### 9.1 Explicit agent sharing

`present_artifact` is the only v1 agent path into the registry. A file created through `write`, `edit`, `bash`, a browser download, an MCP call, or any other tool does not appear merely because that operation occurred. The agent explicitly shares the finished file when it is useful to Clemente.

This narrower contract keeps the first implementation deterministic, avoids cross-cutting wrappers around every tool, and makes panel focus an intentional agent action rather than a side effect of background work.

### 9.2 User uploads

Completed chat uploads are the only non-agent source in v1. Add a backend-private callback to `prepareAttachments()` that receives the complete private persisted records only after every file in the batch is safely written and verified. Register the entire batch in one artifact transaction. If artifact registration fails, `prepareAttachments()` removes every file and process-local attachment record created by the call and rejects the upload. Successful persistence plus artifact commit defines upload completion; a later model-turn failure does not remove the completed upload. Emit passive upload events only after the artifact transaction commits.

### 9.3 Explicit exclusions

V1 never auto-registers from:

- built-in `read`, `write`, `edit`, `grep`, `find`, or `ls` calls;
- `bash` command text or output;
- browser publications or downloads;
- MCP or other backend-tool results;
- Terminal output;
- assistant/user prose or Markdown;
- arbitrary tool-result strings;
- failed, canceled, or pre-commit denied/stale calls.

A post-commit authority change may suppress the tool result/transcript release but cannot recall the committed presentation or already emitted catalog/focus event; list/open authorization remains live.

Files produced by any of those mechanisms become artifacts only when the agent subsequently calls `present_artifact`.

### 9.4 Deferred automatic discovery

A later milestone may add compiled typed sources one at a time. Each source will require its own source-session provenance, final-success signal, authorization recheck, UI badge behavior, and focused tests. It must never be implemented through path regexes or free-form result parsing.

## 10. Shared path authorization and safe opening

### 10.1 Current-session authority

Create `backend/src/artifacts/authorization.ts` with two explicit gates:

- **Presentation gate:** exact live non-archived, non-scheduled interactive `ArtifactToolRuntime`; no quarantine, pending switch, stale generation, missing Project/Profile, or authority drift.
- **HTTP gate:** active or archived sessions may list/preview/download, but deletion, quarantine, pending switch, missing identity, or current policy denial fails closed.

Both gates require `legacy_private_session_quarantine === false`, a non-null exact `project_id`, a non-null exact `agent_profile_id`, exact Project ID/CWD equality, an enabled exact profile still allowed by that Project, and no fallback to the Project's default profile. Re-run `authorizeProjectAction({ actor: "interactive", agentProfileId: exactId })`, resolve the current Standard-resources witness through `resolveCurrentStandardResourcesWitness()`, and pass both `sourceSessionId` and the witness decision into `authorizeAgentToolCall()` as an exact non-recursive `read` operation.

This intentionally follows structured read-tool policy. Host-execution/browser capability does not independently widen artifact serving.

### 10.2 Additional artifact-surface boundary

Apply universal deny predicates before either allow. Then, even if runtime read policy is broader, admit only:

- an existing file canonically within the canonical real home root; or
- an exact regular child of the current session's attachment root when storage is configured outside home.

Explicitly deny:

- Pi transcript files and transcript storage roots;
- any other session's attachment root;
- Wayang data except the current session's exact attachment child;
- command-guard PIN paths;
- Pi auth/settings/models files;
- registered project `.env` and `.env.backup` paths;
- Wayang checkout `.env` and `.env.backup`;
- browser profile/storage roots;
- `/proc`, `/sys`, `/dev`;
- any other root returned by the universal protected-artifact deny helpers;
- another registered Protected Project;
- directories, sockets, FIFOs, devices, symlinks, and files with link count other than one.

The implementation should reuse/export shared predicates from `protected-artifacts.ts` rather than duplicating lists.

### 10.3 Descriptor and streaming protocol

For preview or download:

1. Re-canonicalize the stored locator under current policy and require the same canonical path.
2. `lstat` and require a canonical, single-link, non-symlink regular file.
3. Capture `{dev, ino, size, mtimeMs, ctimeMs}` plus policy generation and current session/Project/Profile/Standard-resources witness.
4. Open with `O_RDONLY | O_NOFOLLOW` and compare `fstat` to the captured identity.
5. Enforce endpoint-specific byte/type limits before allocation or headers.
6. Re-run session/path/runtime authorization and identity immediately before headers.
7. For byte bodies, use a descriptor-owned, backpressure-aware async stream with fixed 256 KiB maximum chunks; never reopen content by pathname. Before every chunk, re-`lstat` the stored locator and require its `{dev, ino}` to match the open descriptor, then compare the live session/policy witness and descriptor identity. Abort before the next chunk if path identity, authority, or file identity changes.
8. Handle client abort, stream error, normal completion, and response-close idempotently; every path closes the descriptor exactly once.

Add tests for mid-stream policy/profile/privacy/file replacement, short reads, client abort, backpressure, double-close, and descriptor leaks. A same-UID hostile process remains outside Wayang's isolation promise, but these checks protect cooperative races and accidental retargeting consistently with the rest of the codebase.

## 11. HTTP API

Mount a new router under `/api/sessions/:sessionId/artifacts`. The generic `/api` layer supplies authentication and effective Host authority on every request and Origin checks on unsafe methods. Artifact routes apply this fixed Fetch Metadata matrix:

- non-browser clients with all Fetch Metadata headers absent remain allowed after normal authentication/Host checks;
- an explicit `Sec-Fetch-Site` must be `same-origin` or `none`; `cross-site` and `same-site` are denied;
- list and text/HTML/PDF fetches require `Sec-Fetch-Dest: empty` with mode `cors`, `same-origin`, or `no-cors`;
- image preview permits destination `image` with mode `no-cors`, plus `empty` for explicit same-origin test/client fetches;
- download `GET` permits navigation mode with destination `document` or `empty`; download `HEAD` also permits destination `empty` with fetch mode;
- explicit combinations outside this matrix are denied.

Send no CORS allow headers. Preserve passwordless loopback and same-origin navigation/download behavior with focused browser tests before rollout.

### 11.1 List

```http
GET /api/sessions/:sessionId/artifacts
```

Response:

```json
{
  "session_id": "...",
  "revision": 12,
  "artifacts": [{
    "id": "opaque-uuid",
    "name": "report.md",
    "display_path": "~/src/project/reports/report.md",
    "title": "Final report",
    "description": "...",
    "source": "presented",
    "renderer": "markdown",
    "size": 1234,
    "modified_at": 0,
    "last_seen_at": 0,
    "available": true,
    "unavailable_reason": null,
    "preview_available": true,
    "preview_unavailable_reason": null,
    "download_available": true,
    "download_unavailable_reason": null
  }]
}
```

Rules:

- Never return an attachment backing path or unrestricted absolute host path. Use project-relative, `~/...`, or upload display names.
- Reauthorize every row before returning actionable metadata.
- Use generic artifact reasons such as `missing` or `policy_changed`; renderer/download limitations have separate reason fields. Never reveal a denied target's canonical path.
- Bound the response to 100 rows, 8 KiB per encoded projection, and 1 MiB total. Metadata/path limits must make the worst-case 100-row response fit; an invariant violation returns one bounded fixed error rather than omitting rows.
- `GET` returns JSON; `HEAD` performs the same authorization and headers with no body.

### 11.2 Preview

```http
GET /api/sessions/:sessionId/artifacts/:artifactId/preview
```

- Text/Markdown/code/HTML source: bounded `application/json; charset=utf-8` containing UTF-8 text, renderer, language hint, and content fingerprint.
- Raster images: exact verified `image/png`, `image/jpeg`, or `image/webp` body after signature/static-image validation.
- PDF: exact verified `application/pdf` body, fetched by the local PDF.js renderer; v1 does not implement HTTP Range.
- Unsupported/oversized: `422 preview_unavailable` with metadata retained in the list.
- Missing, guessed, cross-session, stale, or denied IDs: uniform `404 artifact_not_found`.
- `HEAD` performs identical authorization/type/size checks and returns no body.

### 11.3 Download

```http
GET /api/sessions/:sessionId/artifacts/:artifactId/download
```

- Always `Content-Type: application/octet-stream`.
- Always `Content-Disposition: attachment` with CR/LF-safe ASCII fallback and RFC 5987 `filename*`.
- Stream only from the verified descriptor through the protocol in §10.3.
- Apply the frozen 512 MiB per-file ceiling; report larger files as download unavailable rather than truncating.
- Do not support Range, client filename override, or path parameters in v1.
- `HEAD` performs identical authorization/size/name checks and returns no body.

### 11.4 Shared response policy

Every list/preview/download success and error sends:

```text
Cache-Control: private, no-store
Pragma: no-cache
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: no-referrer
```

No route sends `Access-Control-Allow-Origin`. JSON errors are bounded and path-free. Artifact preview endpoints do not claim that response CSP sanitizes later rendering; HTML safety is enforced in the constructed sandboxed `srcDoc` described below.

## 12. Type classification and preview limits

Do not trust filename extension or client-declared MIME alone. Combine extension, signature/magic bytes, UTF-8 validity, NUL detection, and bounded parser checks.

Frozen limits and parser choices:

| Renderer | Accepted types | Preview ceiling | Notes |
|---|---|---:|---|
| Markdown | `.md`, `.markdown` + UTF-8 text | 2 MiB | Raw HTML disabled. |
| Text/code | UTF-8 text with supported language hint | 2 MiB | Escaped, read-only; lazy Monaco optional. |
| Image | PNG, JPEG, static WebP | 25 MiB / 40 MP | Use a bounded header parser; SVG, GIF, animated WebP, malformed dimensions, and decompression bombs are download-only. |
| PDF | `%PDF-` signature | 50 MiB | Render locally with `pdfjs-dist`; no native object/iframe, scripting, XFA, annotation actions, or external assets. |
| HTML | `.html`/`.htm` + UTF-8 text | 2 MiB | Sanitize with DOMPurify and isolate; no external resources or artifact-authored styles. |
| Other | Any safe regular file | none | Metadata + bounded download only. |

These are preview limits, not upload limits. Original files are never rewritten. Add locked `dompurify` and `pdfjs-dist` frontend dependencies after package/license/advisory review; bundle the PDF.js worker locally. Implement bounded PNG/JPEG/static-WebP header parsing in backend source with corpus tests rather than claiming full decoder validation.

## 13. Frontend design

### 13.1 Right-panel integration

Replace the `files` tab with `artifacts` in `frontend/src/panels/RightPanel.tsx`:

```ts
type Tab = "artifacts" | "terminal" | "pi" | "apps" | "browser";
```

Migrate saved localStorage value `files` to `artifacts`. Update the header tooltip in `frontend/src/App.tsx` from “files panel” to “tools panel” or “right panel.”

Delete `FileTree` from the rendered path. Keep `FileViewer` only long enough to extract useful read-only Monaco/language mapping code; do not preserve save/edit state in the new component.

### 13.2 Component structure

```text
frontend/src/panels/ArtifactsPanel.tsx
frontend/src/components/artifacts/ArtifactList.tsx
frontend/src/components/artifacts/ArtifactHeader.tsx
frontend/src/components/artifacts/ArtifactPreview.tsx
frontend/src/components/artifacts/MarkdownPreview.tsx
frontend/src/components/artifacts/CodePreview.tsx
frontend/src/components/artifacts/HtmlPreview.tsx
frontend/src/hooks/useSessionArtifacts.ts
```

`ArtifactsPanel` receives:

```ts
{
  sessionId: string | null;
  focusIntent: { artifactId: string; requestKey: string } | null;
  onUnreadCountChange(count: number): void;
}
```

### 13.3 Layout

The right rail is narrow and the mobile Tools view is full-screen, so use a vertical layout rather than the current nested horizontal split:

- compact header with artifact count, refresh, and Download;
- scrollable recent list, badged as **Shared by agent** or **Uploaded**;
- selected artifact preview below or replacing the list with a clear Back action at narrow widths;
- metadata row with display path, size, modified time, source, and unavailable state;
- empty state explaining how the agent can present artifacts.

Persist selected artifact per session in memory/localStorage by opaque ID. Clear stale selection when the session changes or the artifact becomes unavailable.

### 13.4 Focus and unread behavior

Frozen behavior:

- `present_artifact` emits an explicit focus intent. `App.tsx` switches the right panel to Artifacts, expands the desktop panel if collapsed (without resizing an already open panel), and selects the item. On mobile, do not forcibly leave Chat; show a visible artifact chip/badge that opens Tools when tapped unless Clemente explicitly chooses mobile auto-navigation later.
- Uploads quietly refresh the list/badge and never change the active tab or selection.
- Clicking a trusted artifact chip in chat focuses the same opaque ID.

Do not make arbitrary assistant Markdown path text clickable. Only trusted artifact presentation details, upload records, and catalog items receive artifact actions.

### 13.5 Renderers

- **Markdown:** reuse `react-markdown` + `remark-gfm` with custom link/image components; do not enable raw HTML. Images never auto-load remote URLs. Links reject `file:`, `javascript:`, `data:`, credentials, and unsafe schemes; allowed external links open only on user click with `noopener noreferrer` and no referrer.
- **Text/code:** escaped read-only `<pre>` for the initial slice or lazy Monaco without Vim/edit/save controls. Map language from backend hint.
- **Images:** `<img>` only for backend-validated PNG/JPEG/static-WebP from the same-origin opaque preview URL; include alt text and fit controls. Revoke object URLs on selection/session change.
- **PDF:** use a locally bundled `pdfjs-dist` worker and canvas renderer. Fetch the bounded opaque preview into memory, render pages lazily, and disable scripting/eval, XFA, annotation actions/layers, external assets, and document-initiated network access. Do not use native `<object>`/PDF iframe in v1.
- **HTML:** use DOMPurify's HTML-only profile with this exact tag allowlist: `a, abbr, address, article, aside, b, blockquote, br, caption, code, col, colgroup, dd, del, details, div, dl, dt, em, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, i, ins, kbd, li, main, mark, ol, p, pre, q, s, samp, section, small, span, strong, sub, summary, sup, table, tbody, td, tfoot, th, thead, time, tr, u, ul, var`; and attribute allowlist `aria-label, colspan, datetime, open, rowspan, scope, title`. Strip every resource-bearing tag/attribute including `img`, `audio`, `video`, `source`, `link`, `href`, `src`, `srcset`, `poster`, and CSS URLs, plus SVG/MathML, scripts, event handlers, forms, frames, objects, embeds, `base`, `meta`, and all artifact-authored `style` tags/attributes. Construct a complete wrapper with CSP `default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` and sanitized body, then render only through `<iframe sandbox="" srcDoc=...>`. Do not use `dangerouslySetInnerHTML` in Wayang's document.
- **Unknown/oversized:** show metadata, reason preview is unavailable, and Download if permitted.

## 14. Live updates and chat integration

### 14.1 Backend event

Add a session-scoped registry subscription and forward this authenticated WS message through `backend/src/routes/ws.ts`:

```json
{
  "type": "artifact_catalog_changed",
  "session_id": "...",
  "selection_id": "...",
  "revision": 12,
  "reason": "presented|uploaded|removed",
  "focus_artifact_id": "opaque-id-or-null"
}
```

The server emits no path or content. Define the message in `packages/protocol/src/ws.ts` and artifact REST shapes in `packages/protocol/src/rest.ts`. Subscribe/unsubscribe inside the exact `setupSession()` lifecycle in `backend/src/routes/ws.ts`; gate sends on setup version, current session ID, and current selection ID. Emit revisions only after database commit. Reconnect performs a list refresh but never replays an old focus intent.

### 14.2 App-level coordination

`ChatPanel` already receives the event stream, but `RightPanel` is its sibling. Add an `onArtifactEvent` callback from `ChatPanel` to `App.tsx`, and pass a focus/refresh intent into `RightPanel`/`ArtifactsPanel`. Before calling `App`, validate current socket identity, transport generation, session ID, and selection ID; ignore duplicate/older catalog revisions. Avoid a global browser event bus unless existing architecture makes the callback materially harder.

### 14.3 Chat cards

- Render successful `present_artifact` tool results as compact artifact cards with **Open** and **Download** actions using opaque IDs.
- Make durable upload chips open the matching artifact once the registry has created it.
- Historical cards call the catalog/list endpoint; stale IDs show unavailable rather than falling back to a raw path.

## 15. Files API retirement

### Phase A

Stop rendering `FileTree`/`FileViewer`. Keep `/api/fs/discover-projects`, which supports project setup/discovery.

### Phase B

Audit all remaining consumers of:

- `GET /api/fs/tree`
- `GET /api/fs/read`
- `PUT /api/fs/write`

If no supported consumer remains, remove those routes, filesystem client types/functions, `FileTree.tsx`, and editing-only dependencies (`react-arborist`, `monaco-vim`; Monaco itself may remain for read-only code preview). Keep project discovery in a narrower project route or retain only `/api/fs/discover-projects` temporarily. Add route tests that `/api/fs/tree`, `/api/fs/read`, and `/api/fs/write` return 404 after removal while project discovery still works.

Do not remove routes in the first backend vertical slice; removal belongs in the final compatibility milestone and requires focused auth/E2E review.

## 16. Implementation milestones

### Milestone 0 — Freeze contracts

- Incorporate the terminal plan review.
- Confirm the frozen registry bounds, preview/download ceilings, shared protocol schemas, DOMPurify policy, PDF.js design, and static-image parser contract.
- Review and lock the selected dependency versions without changing the accepted renderer boundaries.

Exit: accepted plan and API/type contract; implementation approval from Clemente.

### Milestone 1 — Registry and authorization core

Owner: Backend Artifact Core agent.

- Add SQLite registry lifecycle and strict schema.
- Add current-session artifact authorization.
- Add verified descriptor opening, type detection, metadata, pruning, and session deletion cleanup.
- Add focused policy/race/storage tests.

Exit: synthetic project/home/attachment files list correctly; every denial and replacement race fails closed.

### Milestone 2 — HTTP list/preview/download

Owner: Backend Serving agent, coordinated with Artifact Core.

- Add authenticated routes and response headers.
- Add bounded text/image/PDF/HTML-source preview.
- Add safe descriptor-owned download/preview streaming without Range support.
- Add route, MIME, filename, byte-limit, and race tests.

Exit: opaque ID is the only browser content handle; renderer inputs and downloads pass focused security tests.

### Milestone 3 — Explicit presentation tool

Owner: Runtime Integration agent.

- Add immutable `present_artifact` tool.
- Bind it to exact source sessions and shared authorization.
- Register completed uploads after safe persistence.
- Add session-scoped catalog change events.
- Add tool/runtime/revocation tests.

Exit: explicit presentations persist across restart and focus the intended artifact; no ordinary tool or prose activity auto-registers a file.

### Milestone 4 — Artifacts panel and safe renderers

Owner: Frontend Artifacts agent.

- Replace Files tab and migrate saved tab state.
- Build list/header/preview components and API client.
- Add Markdown, code/text, image, PDF, and isolated sanitized HTML rendering.
- Add loading, error, unavailable, unsupported, and download states.
- Validate desktop and mobile Tools layouts.

Exit: user can browse, preview, and download all supported synthetic artifacts without an active agent turn.

### Milestone 5 — Focus, badges, and chat cards

Owner: Frontend Integration agent, coordinated with Runtime Integration.

- Wire WebSocket catalog events through `App.tsx`.
- Implement explicit focus behavior and passive upload badge behavior.
- Render trusted presentation and upload artifact cards in chat.
- Ensure reconnect, pagination, and session switching are idempotent.

Exit: explicit “show” behavior is immediate and passive discovery never hijacks the UI.

### Milestone 6 — Files retirement and compatibility cleanup

Owner: Lead integrator.

- Audit consumers and remove obsolete tree/read/write routes when safe.
- Remove FileTree/editing code and unused dependencies.
- Retain/move project discovery.
- Update README, SECURITY, capabilities/configuration docs where stable behavior changed.
- Add implementation journal.

Exit: no global filesystem browser/editor remains; project registration/discovery still works.

### Milestone 7 — Integrated validation and rollout

Owner: QA/Security agent.

- Run focused backend/frontend tests and builds.
- Run `make check` and relevant Playwright suite.
- Perform synthetic manual smoke tests on desktop/mobile.
- Review dependency changes and production headers.
- Rebuild/deploy only with separate explicit authorization and normal restart handoff.

Exit: all gates pass, rollback is documented, and no private fixture/path/content was used.

## 17. Agent-team roles and ownership

Implementation should use separate task worktrees and focused commits. Before parallel work, the lead freezes `packages/protocol/src/rest.ts` and `packages/protocol/src/ws.ts` in a dedicated protocol commit. Shared integration files have one writer at a time: Runtime Integration owns `backend/src/pi-bridge.ts`, `backend/src/agent-runtime.ts`, `backend/src/routes/ws.ts`, and `backend/src/attachments.ts`; Backend Artifact Core owns `backend/src/routes/sessions.ts`; Backend Serving owns `backend/src/app.ts`; Frontend Artifacts owns `frontend/package.json` and the root/frontend lockfile changes; the Lead owns final documentation. Other agents consume those contracts without editing the same files concurrently.

### Lead Orchestrator

Owns the accepted plan, shared REST/WS protocol commit, schemas, integration order, conflict resolution, final documentation, and deployment handoff. Does not delegate consequential contract changes without updating the plan.

### Backend Artifact Core Agent

Owns:

- `backend/src/artifacts/registry.ts`
- `backend/src/artifacts/authorization.ts`
- `backend/src/artifacts/file.ts`
- `backend/src/routes/sessions.ts` artifact cleanup ordering
- core unit/deletion-failure tests

Must not touch frontend or runtime tool composition. Coordinates the registry/service interface with Runtime Integration and HTTP Serving.

### Backend Serving Agent

Owns:

- `backend/src/routes/artifacts.ts`
- preview classification/streaming helpers
- route/render/headers/streaming tests
- route mounting and artifact-registry startup/close integration in `backend/src/app.ts`

Must preserve generic authentication/Host/unsafe-method Origin controls, add the route-specific same-origin Fetch Metadata policy, and never accept raw browser paths.

### Runtime Integration Agent

Owns:

- `backend/src/artifacts/tool.ts`
- exact tool registration in `backend/src/pi-bridge.ts`
- exact tool authorization integration in `backend/src/agent-runtime.ts`
- completed-upload registration hook
- artifact WS subscription/event integration in `backend/src/routes/ws.ts`
- completed-upload registration in `backend/src/attachments.ts` or its exact caller

Must not add ordinary tool, backend-output, bash, or prose discovery in v1.

### Frontend Artifacts Agent

Owns:

- `ArtifactsPanel` and artifact components/hooks
- artifact API client usage of shared protocol types
- locked `dompurify`/`pdfjs-dist` dependencies and package/lockfile changes
- renderer safety and component tests
- `RightPanel.tsx` tab replacement

Must not implement editing or render raw HTML in Wayang's document.

### Frontend Integration Agent

Owns:

- `App.tsx` focus/unread coordination
- `ChatPanel.tsx` trusted artifact cards
- reconnect/pagination/session-switch behavior
- desktop/mobile E2E additions

Coordinates shared files with Frontend Artifacts; do not edit the same worktree concurrently.

### QA/Security Agent

Owns read-only terminal review and validation evidence after integration. May propose fixes but does not make broad unreviewed code changes.

## 18. Validation plan

### 18.1 Backend authorization tests

Cover:

- exact current session/Project/Profile success;
- archived HTTP read success under exact current authority, but archived tool execution denial;
- deleted, quarantined, switching, disabled, or disallowed session denial;
- Standard restricted Project file success and outside-Project denial;
- Standard-resources-authorized ordinary home file success;
- Protected session own Project and permitted ordinary-home behavior;
- another Protected Project denial;
- own attachment success and another session's attachment denial;
- Wayang/Pi/PIN/browser-profile/project-secret/transcript/pseudo-filesystem denials;
- traversal, symlink, hard link, directory, socket, FIFO, and device denial;
- inode replacement before open, after open, and before headers;
- policy generation, privacy, profile, and Project changes during request;
- guessed/cross-session artifact IDs returning uniform 404.

### 18.2 Registry/tool tests

Cover:

- strict DB ownership/schema/startup behavior;
- bounds, pruning, source precedence, deduplication, and restart persistence;
- explicit batch partial success;
- exact source-session binding and stale runtime denial;
- no registry changes from ordinary `read`/`write`/`edit`, browser, MCP, backend-output, bash, prose, or result strings;
- completed upload registration and passive event behavior;
- session deletion cleanup;
- catalog revision/event idempotence.

### 18.3 Serving/renderer tests

Cover:

- MIME/signature disagreement;
- invalid UTF-8/NUL/binary handling;
- Markdown raw HTML and unsafe URL blocking;
- HTML script/event/form/frame/base/meta/external resource/style attacks;
- iframe sandbox/CSP and same-origin isolation;
- SVG rejection;
- malformed/oversized/image-dimension-bomb rejection;
- malformed PDF rejection and local PDF.js network/script/XFA/annotation-action denial;
- CR/LF/Unicode/very-long filename handling;
- no-store/nosniff/CSP/content-disposition headers;
- preview/download byte ceilings and no truncation.

### 18.4 Frontend tests

Cover:

- no-session/empty/loading/error/unavailable/unsupported states;
- stale fetch cancellation when switching session/artifact;
- localStorage migration from `files` to `artifacts`;
- explicit focus and passive badge behavior;
- reconnect and duplicate catalog events;
- trusted chat cards and refusal to link arbitrary path prose;
- keyboard navigation, focus management, accessible labels, and screen-reader status;
- desktop collapsed panel and mobile Tools navigation;
- object URL/iframe cleanup.

### 18.5 Commands

After implementation, run through the repository command surface:

```sh
make doctor
make build
make test
make check
make test-e2e
```

Use focused backend/frontend/E2E commands during development, then the full authorized gate. Never weaken tests or inspect private artifacts to make a check pass.

### 18.6 Synthetic smoke fixtures

Use only a synthetic temporary HOME/data/project/session containing:

- Markdown with GFM and attempted raw HTML;
- TypeScript/text;
- small PNG/JPEG/static-WebP plus download-only GIF/animated-WebP fixtures;
- benign PDF;
- HTML containing scripts, handlers, forms, remote images, iframes, and CSS URL attempts;
- unsupported binary;
- oversized sparse files;
- symlink/hard-link/replacement race fixtures;
- two Standard Projects and two Protected Projects.

## 19. Security review checklist

- [ ] Every artifact route has generic authentication/Host authority, unsafe-method Origin checks, and route-specific same-origin Fetch Metadata enforcement for sensitive GETs.
- [ ] Browser requests contain only session ID + opaque artifact ID, never a host path.
- [ ] Registration never substitutes for current authorization.
- [ ] Current Project/Profile/privacy/policy and file identity are rechecked before publication.
- [ ] Universal denials and other Protected roots remain denied.
- [ ] Another session's attachment is never exposed through the current session catalog.
- [ ] Source files are never copied into public/static storage.
- [ ] Downloads are forced attachments with safe names and bounds.
- [ ] HTML uses sanitizer + unique-origin sandbox + restrictive CSP; no raw HTML enters Wayang's DOM.
- [ ] Markdown cannot fetch local files or silently load remote resources.
- [ ] SVG and executable document behavior are excluded.
- [ ] Errors and logs do not reveal denied paths or file content.
- [ ] Registry/preview caches are private, bounded, and invalidated on policy/file changes.
- [ ] Protected and quarantined session behavior has explicit regression tests.

## 20. Rollout and rollback

### Rollout

1. Land backend registry/authorization behind routes that no current UI calls.
2. Land the explicit sharing tool and completed-upload registration with focused tests.
3. Land Artifacts UI and focus integration.
4. Validate on synthetic sessions.
5. Remove obsolete Files UI/routes only after compatibility audit.
6. Rebuild and deploy through the normal Wayang process with separate approval.

No migration copies or transforms user files. The new SQLite database contains only bounded private metadata.

### Rollback

- Before Files-route removal, frontend rollback simply restores the old Files tab while leaving the inert artifact database/routes unused.
- After removal, revert the Files-retirement commit separately from the artifact core commits.
- Stop/revert artifact discovery before deleting registry metadata.
- Use recoverable deletion for `artifact-index.db` only on explicit request; leaving an unused owner-private database is safer during rollback.
- Rollback cannot undo a file the user already downloaded, but it makes no source-file mutations itself.

## 21. Documentation and journal updates during implementation

Update:

- `README.md` feature list and architecture summary;
- `SECURITY.md` threat model, sensitive-data list, path authorization, HTML/PDF/download behavior, and same-UID limitations;
- `docs/capabilities.md` to document `present_artifact` as a backend-owned core tool;
- `docs/configuration.md` only if stable new size/path settings are introduced;
- a dated implementation journal under `docs/journals/` with commands/results and known limitations.

## 22. Terminal review and implementation authorization checkpoint

A read-only terminal architecture/security review reached **GO** after the plan froze exact tool-object authority, archived/live session gates, registry/deletion failure semantics, descriptor streaming, response policy, renderer containment, shared protocol correlation, upload completion, and post-commit event behavior. No tests were run during planning.

This plan originally did not authorize implementation. Clemente explicitly authorized the full feature on 2026-08-30 and asked to finish and merge it on 2026-09-03. Implementation was completed in the isolated worktree documented by `docs/journals/2026-08-30-session-artifacts-implementation.md`; current-main reconciliation and validation are documented by `docs/journals/2026-09-03-session-artifacts-integration.md`. Production deployment and service restart remain separately controlled.
