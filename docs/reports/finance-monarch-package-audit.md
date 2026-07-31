# Finance Monarch read-only package source audit

Date: 2026-07-28
Owner: Milestone D CandidateRemediator
Candidate: `backend/src/restricted-mcp/provider-packages/monarch-readonly-v1/`
Decision: **STAGE-INELIGIBLE — FAIL CLOSED**

## Executive decision

The candidate now records a substantially closed read-only D contract, but it is not an applicable source patch, build, package, installer, registry entry, activation, or provider authorization. No upstream source was acquired or executed, no network/provider/data/credential access occurred, and no out-of-scope registry/runtime/installer/catalog file was changed.

The governing plan names upstream `mikelane/monarch-mcp` v0.4.2 commit `e570eef7a27cdaefea51360f494d82be35031164`. The full value is recorded separately as **unverified plan metadata**. The only observed source-review snapshot remains the mismatched commit `a8a807a3c7da358d7112fece4f6c7be47bd5905a`. Nothing in this audit claims that the observed bytes represent the intended commit.

## Reconciled D authority

The candidate describes exactly 15 read tools and eight query operations. `apply_changeset`, provider mutations, login/password/TOTP handling, token persistence, generic GraphQL, direct HTTP, remote MCP transports/listeners, project/goals-file access, and child socket creation are forbidden.

The governing plan's initially empty goals projection is restored: `progress_vs_goals` accepts `{}` only. No authorized operation supplies goal configuration, so the tool makes zero provider calls and returns exactly `{"status":"not_configured","goals":[]}`. It cannot claim current/target values, a configured goal, or on/off-track status. It receives no project mount, goals file, or inline goal values.

### Exact ordered plans

`query-allowlist.json` now defines ordered steps and exact minimum/maximum provider-call counts, rather than unordered operation membership:

| Tool | Ordered operations | Calls |
|---|---|---:|
| `financial_overview` | Accounts → current-month cash flow → 12-month aggregate snapshots → complete transaction pagination | 4..23 |
| `spending_report` | current-month planning → categories → current-month cash flow → complete transaction pagination | 4..23 |
| `triage_uncategorized` | needs-review transaction pagination | 1..20 |
| `cashflow_forecast` | accounts → recurring items through next-month end | 2 |
| `net_worth_trend` | snapshots by account type | 1 |
| `recurring_scan` | recurring items through three-month end | 1 |
| `subscription_audit` | recurring items through 12-month end | 1 |
| `inspect_transactions` | complete transaction pagination, then local filter/output paging | 1..20 |
| `account_inventory` | accounts | 1 |
| `asset_allocation` | accounts | 1 |
| `retirement_readiness` | accounts → complete bounded transaction pagination | 2..21 |
| `budget_review` | current-month planning → categories → complete current-month transaction pagination | 3..22 |
| `spending_history` | complete bounded transaction pagination | 1..20 |
| `savings_rate` | complete bounded transaction pagination | 1..20 |
| `progress_vs_goals` | no provider operation; exact local `not_configured` result only | 0 |

Canonical variables derive only from schema-defaulted outer arguments and one broker-captured UTC date. Every date is accepted only after exact ten-byte ASCII parsing and construction in the real proleptic Gregorian calendar for year `0001..9999` (leap years divisible by 4 except centuries not divisible by 400); every month requires exact seven-byte ASCII parsing and constructible first day. Arithmetic underflow/overflow rejects rather than normalizes. The contract specifies month/range symbols, default ranges, recurring ceilings, empty provider filter arrays/search, and local-only merchant/category filters. The broker independently re-derives and structurally compares variables; child variables are never authority.

The reviewed recurring response selects no occurrence-date field. D therefore does not invent one: `cashflow_forecast` now returns `as_of`, bounded `window_end`, known starting balance, null counts, and an explicitly **undated** sum/count of returned non-past recurring items. It emits no dated forecast points, cadence expansion, projected balances, or frequency annualization. `recurring_scan` and `subscription_audit` likewise expose only bounded-window semantics from reviewed fields.

Transaction pagination is a closed state machine: offsets `0,500,...,9500`, limit exactly 500, stable `totalCount` `0..10000`, exact expected page length, globally unique internal IDs, contiguous pages, complete count equality, and zero retry. Short, duplicate, overlapping, changing-total, gapped, oversized, partial, or extra pages fail closed.

## Typed query and output contracts

Each query operation now has:

- a closed variables schema;
- a closed typed data response schema matching only selected fields;
- exact array/record ceilings;
- a query-only document identity field distinct from review state.

Provider `errors`, `extensions`, headers, cookies, unknown fields, and raw failure text never enter success data. IDs used for pagination, joins, or recurring-stream deduplication are internal only and erased before final output construction.

`output-policy.json` now contains one closed final schema and one exact backend reconstruction rule for every tool, plus exact global/per-tool bounds. The backend reconstructs solely from its own captured typed responses, bound canonical arguments, and captured UTC date. The child never supplies or serializes a result. Final MCP JSON is at most 128 KiB, one text item, 100 records/array items, depth 12, 128 object properties, 256 bytes per general string, and 120 bytes per retained display string. Limits fail with enum-only `OUTPUT_LIMIT`; they never truncate a provider page or pair totals with partial rows.

The raw provider decimal grammar is exactly `-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?`, absolute value at most `1000000000000000`. Raw provider tokens are checked before conversion; exponent notation, leading plus/zero, trailing decimal point, non-finite values, excess scale, and negative zero are rejected. Parsing and calculations use exact base-10/rational arithmetic, never binary floating point. Provider money is converted once to signed integer hundredths with round-half-to-even, and every final `*_minor` field uses the exact checked range `-9007199254740991..9007199254740991` (±`Number.MAX_SAFE_INTEGER`) or a tighter bound. Thus every emitted monetary JSON integer is exactly representable by ECMAScript `Number`; overflow fails with `OUTPUT_LIMIT`. Rates/shares are integer basis points with one final half-even rounding and null on zero denominator. The reviewed fields carry no currency code, so the output makes no currency identity, conversion, or cross-currency comparability claim.

`retirement_readiness` no longer accepts decimal `withdrawal_rate`. Its closed input is integer `withdrawal_rate_basis_points` in `200..1000`, with trusted-proxy default `400`. Those small integer values are exactly representable after ordinary JSON parsing, so the contract neither inspects a retirement-input raw numeric lexeme nor performs binary-float, decimal-rational, conversion, or rate-rounding logic. Backend reconstruction echoes the exact bound integer and uses it directly in `known_investable_balance_minor * withdrawal_rate_basis_points / 10000`, rounding only the resulting monetary rational once half-even.

Canonical result serialization is UTF-8 without BOM, one object, schema-declared property order, no insignificant whitespace, exact integer grammar with no `-0`, fixed literal/string escaping and Unicode sanitation, deterministic array ordering, and SHA-256 over the exact bytes. The output property denylist removes identifiers, notes/tags, account objects, credentials/session material, GraphQL errors/extensions, URLs/paths, and headers. Account names become nonpersistent `Account 1..N` labels.

No financial arguments, variables, provider responses, identifiers, values, errors, or outputs may spill into project artifacts, shared temp, catalog reports, worker/runtime logs, caches, attachments, crash reports, or ordinary audit records. Accepted bounded final output can enter only the authorized Finance transcript/model boundary in the later lifecycle.

## Inherited FD3/FD4 broker protocol

The obsolete environment-selected UnixStream design is removed from the candidate contract. The child now receives only:

- stdio MCP;
- child-write-only request FD 3;
- child-read-only response FD 4;
- fixed `LANG`, `LC_ALL`, and `TZ`.

It receives no socket path and must not call `socket`, `connect`, `bind`, `listen`, or `accept`; socket creation is denied for every domain, including AF_UNIX. The trusted launcher creates exactly two distinct anonymous unidirectional pipes with `pipe2(O_CLOEXEC)` before child creation. Before bwrap or any package-controlled instruction, the child branch closes request-read/response-write and installs only request-write as `S_IFIFO`/`O_WRONLY` FD 3 plus response-read as `S_IFIFO`/`O_RDONLY` FD 4; the backend branch closes request-write/response-read and retains only the opposite access modes. Only FD3/FD4 have `FD_CLOEXEC` cleared for child exec, and the two pipe inode identities must differ. Socketpairs, `shutdown(2)` pseudo-directionality, post-`exec` descriptor passing, ancillary data, and `SCM_RIGHTS` are forbidden. The inherited pair remains open for the runtime lifetime and serializes outer invocations; only the backend can install one fresh process-local context while the broker is in `NO_CONTEXT`.

Each bounded big-endian `query` frame carries contract/invocation/request IDs, exact tool, sequence, step/page indices, operation enum, and typed variables. Its FD4 response has the same sequence/request ID and `kind=query`. After all ordered queries, FD3 sends exactly one `kind=query_complete` frame at the next sequence containing only contract/invocation/request IDs and tool—no result. The backend reconstructs, validates, canonically serializes, hashes, and retains the output, then FD4 returns `kind=query_complete`, `status=complete`, exact byte length, and SHA-256 only. Canonical result bytes never cross FD3/FD4; the backend, not the child, inserts them as the sole MCP text result.

One backend-opened process-local invocation context binds release/grant/eligibility, source runtime/session, exact outer tool and canonical-argument digest, ordered plan digest, output-policy digest, deadline, and cancellation generation. No context exists during initialize, tools/list, metadata smoke, activation, idle, or between calls. The broker permits one in-flight frame and runs one exact state machine: `NO_CONTEXT → EXPECT_ACTION → QUERY_IN_FLIGHT → EXPECT_ACTION`, then `EXPECT_COMPLETE → COMPLETE → NO_CONTEXT`, with every fault entering `TERMINAL`. Sequence numbers restart at zero and are contiguous across every query and query-complete pair; a two-query plan uses sequences 0, 1, then completion 2, while zero-action `progress_vs_goals` completes at sequence 0. Any nonempty child-authored MCP result is terminal. Mismatch, error, EOF, timeout, cancellation, or revocation closes both pipes without reconnect.

Broker failures contain one fixed enum only: `AUTH_REQUIRED`, `SESSION_EXPIRED`, `INVALID_REQUEST`, `POLICY_DENIED`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `TIMEOUT`, `OUTPUT_LIMIT`, `SCHEMA_MISMATCH`, or `CANCELLED`. No raw broker/provider message is accepted, surfaced, modeled, or logged. Final MCP mapping substitutes `INVALID_INPUT` for child-facing validation failures.

## GraphQL closed grammar

The static validator now performs lexical and AST-equivalent closed-subset checks rather than prefix/token substring checks. It rejects unknown characters, strings/numbers, BOM/NUL, comments/directives/fragments, lists/input literals, introspection names, duplicate arguments/variables/sibling response keys, undeclared variable use, multiple definitions, trailing tokens, non-query operations, and operation/file mismatch. It parses the sole query definition and requires the exact hard-coded token/AST-equivalent signature for each of the eight reviewed candidate documents.

This is in addition to exact candidate byte-digest checks. The broker never receives query text from the child.

## Patch status

All three patch files begin with `WAYANG NON-APPLICABLE PATCH PLACEHOLDER`, name the intended commit as unverified, set `APPLICABLE false`, and require failure if application is attempted. They are design guidance based partly on the mismatched observed snapshot, not final patches. Contradictory triage-suggestion guidance and the stale implication that the child supplies a final result have been removed: triage is projection-only, `query_complete` is result-free, and canonical output remains backend-authored.

The patch series still contains mandatory whole-file transformations and blocked toolchain/lockfile replacements. Patch 0003 now requires the integer `withdrawal_rate_basis_points` input, removes every legacy decimal/raw-lexeme rate path, and pins all final `*_minor` bounds to ±9007199254740991 or tighter. The validator rejects reintroduction of the known contradictory/child-output/decimal-retirement markers and treats every placeholder marker as an eligibility failure. Once verified intended bytes exist, reviewers must discard/regenerate exact complete preimage/postimage patches, bind every digest, and independently review the entire post-patch tree. No current patch may be applied, compiled, or represented as stageable.

## Review manifest and eligibility

`review-manifest.json` lists every owned D package/report artifact. Its own digest is structurally excluded to avoid a recursive fixed-point claim; a later enclosing reviewed package/release manifest must bind it externally. Locally computed candidate artifact/query digests are mechanical byte identities stored only in `locally_computed_candidate_sha256`; `independent_reviewed_sha256` remains null and independent review remains false. Artifacts changed by the exact-integer correction are deliberately reset to null until `--record-candidate-digests` is run in a command-capable review environment; an unrecorded local digest is a blocker, never an eligibility shortcut.

The manifest names only these outside-ownership integration dependencies and deliberately does not hash them:

- Milestone B: `backend/src/restricted-mcp/installer/`
- Milestone C: `backend/src/restricted-mcp/provider-runtime/`

Eligibility is derived from `source-identity.json.verified_artifacts`, required non-null matching identities/digests, exact placeholder-free patches, complete matching manifest bytes, and independent review records. Mutable blocker prose is informational only and cannot confer or remove eligibility. Every verified-artifact value is currently false, so the only possible result is stage-ineligible.

## Static validation policy

Validation status on 2026-07-28: **review mode exit 0; stage mode exit 2** with 53 explicit evidence gaps. Artifact digest/review fields remain null where authority is unavailable and therefore fail closed.

`validate_candidate.py` reads owned candidate/report bytes only. It imports or executes no upstream code and performs no build, installation, network, credential, provider, or Finance-data action. Its explicit digest-recording mode computes local SHA-256 byte identities only and leaves every independent-review field false/null. Review mode requires structurally closed contracts while confirming evidence gaps. `--stage` derives failure from verified artifacts/digests/reviews and non-applicable patch markers and must exit 2 for this candidate. A malformed contract exits 1 rather than being misreported as an ordinary blocker.

## Remaining verified-artifact gaps

- immutable intended archive and verification of the plan-supplied commit;
- archive, pre/post-tree, observed/patched lock, closure, SBOM, license, binary, and reproducibility digests, plus independent binding of the locally computed candidate/review-manifest identities;
- exact applicable patch preimages/postimages;
- exact Rust/Cargo/components/target/linker/helper provenance and vendored closure;
- offline frozen builds and second-builder reproduction;
- independent query/operation/output/post-patch source/security review;
- written Monarch permission or a supported customer-data API: the current authoritative terms review is complete and recommends `NO-GO` for unofficial live GraphQL access because the published terms prohibit programmatic/automated access and scraping; see `docs/reports/finance-monarch-terms-risk-review.md`;
- Milestone B installer and Milestone C runtime/broker integration evidence;
- a production reviewed-registry entry (which must remain absent now).

A real provider read remains a later, separately PIN-authorized fresh-turn action after all governing milestones. This D candidate authorizes none.
