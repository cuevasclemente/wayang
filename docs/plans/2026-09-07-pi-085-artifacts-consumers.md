# Pi0.85 artifacts and coordinated consumer validation

## Authority, source and current bounds

Owner selected port/validate0.85 before The-Sceptre then Tribe-Mac and approved guarded commits of validated local work. Reviewed source685f18a53b14ce33582036e7ef98a7c2f7bc6924 in pi-mono-worktrees/astra-085-preservation-20260907 includes core/SDK74b37800 plus approved Astra preservation. Gates:47AI/73core/311SDKtests+2existing skips, fullcheck/nochanges, offlinebuild, modular and actual bundled worktree smokes. Canonical Pi main remains363cef07.

Catalog input/output proof: pi-stack-deploy/release-output/pi-085-astra-derived-repeat-20260907/{source-provenance.json,derivation.json,data}. Committed-source repeat matches first output;39providers,36byte-identical files,exactly3approved additions. Published46188bd… and approved61da6928… archives unchanged. AI output manifest SHA256e6dd5f432d502e84981ac15c14d9eb0f78bab7baf1aac8dbb805d48b8b3c3655. Codex remains intentionally unverified; no real account/provider request.

New isolated source bases: Wayang producer/consumer worktrees at6b2f749, myPi consumer ata9d8cee, deployer proof at482439f (reviewed pairing+launcher,202tests/5skip). Do not touch canonical dependency/build trees or divergent myPi recovery checkout. New worktrees have not silently copied dirty draft pins.

Wayang main advanced tofc0a8de with independently reviewed TTS7db3875 and release journals. The-Sceptre already has published TTS frontend and two staged backend modules; restart remains unapproved. Preserve that work. Owner answered questionnaire4fc1cae7-d2bc-41f6-898c-9e256177851a, submission3f7cc8b6-ec78-41e1-b61d-cbf103691933 (2026-09-07T01:56:40.398Z): **TTS on The-Sceptre only; prepare a separate Tribe-Mac candidate.** This remains relevant and resolves fleet scope. Use separate isolated Wayang consumer branches: Sceptre starts from reviewed fc0a8de including TTS7db3875; Tribe retains audited6b2f749 without that TTS change. Apply the same validated Pi0.85 triplet and necessary shared consumer adaptations to both, then test and seal each independently. No broad latest-main merge or TTS cherry-pick into Tribe. Record separate Wayang source revisions, locks, archive hashes, release manifests and host-local rollback; shared Pi/myPi inputs may match, but full-stack candidate digests need not. No timer or restart may be inferred from this scope answer or staged files.

## Verified contract changes

Pi0.85 keeps modular SDK imports atdist/index.js, declaresbin.pi=dist/bundle/cli.js and exports./rpc-entry=dist/bundle/rpc-entry.js. Both compiled core/AI and lazy implementations are bundled; updating modular dependencies alone cannot fix a stale bundle. Upstream SDK has root shrinkwrap plus a separate installer-root install-lock; neither is assumed to implement the custom exact triplet automatically. Never execute local-release.mjs or generate-models.ts: those regenerate live catalogs/install broadly.

Existing Wayang packer is0.84-specific and packs SDK/core only. Its generic repack preserves shrinkwrap when present and rewrites top/root SDK versions. Existing deployer proves artifact/installed bytes and resolver edges, but AI source markers are exempt, no installed bundled behavior is checked, and POSIX staging hardcodesdist/cli.js. Existing myPi RPC fixture proves the modular implementation, not public bundled entrypoints.

## Artifact contract and naming

Use npm pack --ignore-scripts against verified prebuilt source, then deterministic bounded repack; do not rebuild/install/publish inside the packer. Require exact supported0.85 package identities, source-clean revision, complete required modular/bundle/lazy/assets, unchanged catalog file hashes and reviewed source/report proof. Capture source/dist/catalog identity before pack and verify archive members afterward.

Keep core/AI package versions0.85.0; SDK version0.85.0-wayang.685f18a5. Preserve existing canonical filename conventions:
- earendil-works-pi-coding-agent-0.85.0-wayang.685f18a5.tgz
- earendil-works-pi-agent-core-0.85.0-wayang.685f18a5.tgz
- earendil-works-pi-ai-0.85.0-wayang.<AI-tar-SHA256-prefix>.tgz

Names are locators, not integrity proof. Never reuse an immutable destination for different bytes. External manifest records every tarSHA256/SHA512/size; runtime staging alone translates basenames topi.tgz/core.tgz/ai.tgz.

Agreed package metadata for the new0.85 cohort:
- All three: wayangSourceRevision and wayangAiCatalogManifestSha256.
- SDK: existingwayangRequiredCoreSourceRevision pluswayangRequiredAiSourceRevision.
- Core: wayangRequiredAiSourceRevision.
- AI: wayangAiCatalogDerivationSha256, wayangAiCatalogProvenanceSha256, wayangAiPublishedArchiveSha256, wayangAiApprovedArchiveSha256, wayangAiDeriverSha256.

Full40/64-character values only. Preserve upstream dependency/peer metadata unless an actual install rehearsal demonstrates a necessary adaptation. Metadata must match verified source/catalog inputs, not merely a supplied label. Keep SDK/core source pins and AI content-prefix convention in consistency tests; add missing AI lock-SHA512 checks.

## Roles and ownership

1. **Producer writer**, Wayang audit-085-artifacts worktree: scripts/vendor-pi-artifacts.py and exact scripts/tests/vendor-pi-artifacts.test.{py,mjs}, pi-vendor-consistency.test.mjs; relevant configuration documentation only. Parent owns this plan, commands, source/dist proof and actual packing. Preserve generic legacy repack tests while adding new0.85main/triplet/provenance/asset/determinism/destination gates.
2. **Deployer writer**, separate audit-085-proof worktree: src/release/pi-compatibility.ts, declared-bin selection incomponents/node-pi.ts, focused release/staging tests. New0.85requires AI source/catalog agreement; retain legacy rollback readability and never infer fallback from file existence. Required selected bin isbundledCLI; narrowly allow legacy declareddist/cli.js where previously supported. Validate relative regular in-package targets, offline synthetic staging and coexisting-wrong-modular-path tests. Inspect Windows contracts before any shared change; no guessed counterpart edits.
3. **myPi consumer writer**, separate audit-085-consumer worktree, after artifacts: explicit SDK/core/AI development pins; fixture assertions/necessary0.85API adaptations; actual installed modular and bundled CLI/exportedRPC offline tests. Preserve existing retry/no-run/LF/EOF and tool-ceiling assertions. Parent owns lock generation/install.
4. **Wayang consumer writer**, separate audit-085-consumer worktree, after artifacts and source-choice resolution: exact three pins and installed vendor/SDK contracts, focused source API compatibility and browser regressions. Preserve TTS/echo/other approved main work. Parent owns lock generation/install/build.
5. Fresh read-only independent reviewers review producer/deployer and integrated consumer results. Every writer stays in its own branch/worktree; parent owns commands, integration, commits and live operations.

## Execution and gates

1. Red/synthetic producer+deployer regressions before fixes. No arbitrary archive extraction, missing-asset waiver, version-only proof or weakening origin/privacy tests.
2. Build/pack triplet once into fresh retained output; independently verify package members/metadata/catalog, hashes and bundle closure. Rebuild offline from the same clean source/input, repeatpack, compare bytes. Require a new destination/name on differing bytes, not overwrite.
3. Rehearse exact triplet installation in a fresh synthetic root using exact Node/npm andignore-scripts. Inspect actualroot→SDK/core/AI, SDK→core/AI, core→AI resolution and search the installed package graph for nested substitutes. Preserve all lock bytes duringci.
4. If upstream shrinkwrap prevents coherent sharing, stop that affected action and review the smallest lock/shrinkwrap adaptation before changing it. Do not drop the shrinkwrap wholesale or declare deduplication from version equality.
5. Produce reviewed consumer/runtime v3locks from exact local tarballs; preserve unrelated dependency versions. Install only isolated worktrees. Run Wayang/myPi full checks and focused installed contracts/ceiling/E2E tests with synthetic state and no real accounts.
6. Execute actual installed publicbin and exportedRPC in synthetic directories outside source workspaces, without test aliases to source packages. Official bundle virtual modules remain part of the tested production runtime. Check catalog metadata, correlated acceptance/retry/settlement, no-run handling, cancellation, LF framing and confirmed cleanup. Modular SDK/core constructor identity remains a separate test.
7. Re-extract sealed runtime artifacts and repeat identity/entrypoint tests; run native Darwin assembly/appropriate filesystem checks. Transfer existing verified bytes, not mutable source/configuration or identities.
8. Once all gates pass and TTS scope is resolved, prepare host-local exact backups/rollback, recheck live drift/service provenance, request normal privileged restart approval, activate The-Sceptre canary then Tribe-Mac, and promote identical bytes. Source commits or guard override are not privileged restart approval.

## Deferrals and rollback

Retain old0.84artifacts, all failed/staged outputs, older runtimes and unrelated dirty work. No source-main mutation, service restart, host installation, publication, private-state migration or identity transfer until the relevant gates explicitly pass. Signing remains optional per the existing deployer decision. Native Windows live rollout, real provider/TTS/account tests and performance redesign are not added to this task.

## Execution checkpoint

Normal-retry request ed679631-154e-4da3-8c92-effb0a09ec61 was answered by submission1cfac3ff-5dd3-450c-a914-bff2ada86bdf; the ordinary diagnostic succeeded without bypass. npm12 keyed JSON, upstream0644 bin modes, and intentional shrinkwrap omission are now handled by independently reviewed, test-first, source-bound producer transformations. Python39 and root scripts67 pass. Exact685f18a5 triplets repeat identically after offline rebuild. Failed stages and earlier proofs remain retained.

Installed exact-lock rehearsal validates triplet ESM resolution, no nested substitutes, and actual publicCLI/exportedRPC4/4 offline scenarios. Bare modularSDK import exposed undeclared pi-server. Repair SDK production metadata and regenerate existing locks in pi-mono-worktrees/modular-package-closure-20260907 (base685f18a5); preserve all exports and runtime code. Commit a newly identified source cohort and refresh committed-source/catalog proof after source gates, then repeat packing and installed tests. The685f18a5 filenames/hashes above are intermediate evidence, not the final selected cohort. Do not compensate by hoisting pi-server only in consumers.

Sceptre's clean consumer worktree is wayang-worktrees/audit-085-sceptre-consumer-20260907 atfc0a8de; existing audit-085-consumer-20260907 at6b2f749 is reserved for Tribe. No consumer pins or installs yet. Separately fix deployer conditional RPC export handling in audit-085-export-shape-20260907 from635e6bb: actual0.85 manifest uses an import object, not the old fixture's string. Keep public path/hash gates and per-host candidate separation.

Deployer proof/declared-bin changes independently approved and committed052b78fff19a56c5fccf0c721db06233a0f87eab, integrated635e6bb65faa0eadb0cba1b5c672e1be2bce2b5a. Combined294tests/289pass/5skip. Legacy fixture fixes preserve intended negative health gates. No actual installed-artifact behavior or native acceptance claimed. Consumer worktrees remain at explicit bases without pin/install changes. Journal records exact state and remaining gates.
