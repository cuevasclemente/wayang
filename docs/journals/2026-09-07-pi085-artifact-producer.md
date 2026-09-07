# Pi0.85 triplet producer — real-pack checkpoint

Explicit Wayang source base6b2f749, isolated build/pi085-artifacts-20260907. The reviewed Pi input is685f18a53b14ce33582036e7ef98a7c2f7bc6924 with committed-source derived-catalog proof. No canonical dependencies/builds or live state changed. Source implementation remains uncommitted because real-package acceptance is incomplete.

The new producer requires --catalog-proof and independently pinned --catalog-proof-sha256; sibling derivation.json/data bind the catalog. It validates source/package identities, source/dist/catalog snapshots, runtime/type exports, bundled/lazy/assets, npm records and packed members. SDK/core/AI travel together with the agreed source/catalog metadata. Core/AI retain0.85.0; SDK uses0.85.0-wayang.685f18a5. AI filename uses content-hash prefix; SDK/core use source prefix. Shrinkwrap dependency entries are preserved; no speculative deduplication adaptation.

Synthetic tests were added before production changes. Independent review found tracked-only source cleanliness; committed-Git red regressions proved initial untracked source acceptance and publication after untracked source appeared during packing. Both checks now include nonignored untracked files while allowing ignored build/dependency inputs. Full producer/consistency Node wrapper gate passes4/4; independent source review approved with real build/npm/install/native qualifications.

Real producer command used proof SHA2569bbe9986e81a3e6ba99ee97c96306314cdf5bf4e76a4addfc63d1876b4825ce9 and output pi-stack-deploy/release-output/pi085-triplet-first-20260907. It stopped at `Expected exactly one npm pack record`; no completed triplet was reported. Raw failed stage retained at /tmp/wayang-pi-pack-ug62maov. Log: /tmp/pi085-real-pack-first.log. The precise npm output shape is not established; do not assume whether it is a mapping, multiple records or another mismatch.

A follow-up local diagnostic intended to inspect public npm pack JSON shape was denied by the tool with `Protected identity configuration is unavailable to agent tools.` It was not retried or routed through another tool/helper; no identity configuration or credential inspection was attempted. Open normal-retry questionnaire: ed679631-154e-4da3-8c92-effb0a09ec61. Normal source/deployer Git work remains a separate already approved operation.

Independent deployer work committed052b78f and integrated635e6bb on the isolated rollout branch. Combined gate294tests/289pass/5skip. New Wayang/myPi consumer worktrees exist at their explicit bases but have no pin/install changes yet. Source-sharing/npm shrinkwrap rehearsal, installed SDK/core/AI and public bundled CLI/RPC proof, repeat packing, sealed runtime extraction and native validation remain pending.

Wayang main meanwhile advancedfc0a8de with peerTTS7db3875. Preserve The-Sceptre's published TTS frontend and two staged backend modules; backend restart remains unapproved. Host-scope questionnaire4fc1cae7-d2bc-41f6-898c-9e256177851a is also open. Do not infer either answer or deploy old0.84 artifacts. No host install, restart, push or identity/private-state transfer.

Evidence: /tmp/pi085-producer-{red,green-first,untracked-red,green-fixed}.log; /tmp/pi085-producer-consistency.log; /tmp/pi085-deployer-{red,green-first,green-fixed,integrated-check}.log. Shared plan: ../plans/2026-09-07-pi-085-artifacts-consumers.md.

## 2026-09-07 — Fleet TTS scope resolved

Still-relevant questionnaire4fc1cae7-d2bc-41f6-898c-9e256177851a, submission3f7cc8b6-ec78-41e1-b61d-cbf103691933: TTS on The-Sceptre only; prepare a separate Tribe-Mac candidate. Plans now select reviewedfc0a8de for Sceptre and audited6b2f749 without TTS for Tribe, plus required shared Pi0.85 consumer adaptations. Each candidate needs separate source/lock/archive/release proof and rollback; identical-byte promotion is per candidate. At this checkpoint packaging still awaited separate normal diagnostic authorization; the scope answer authorized no restart, host activation or diagnostic retry.

## Normal retry, npm12 compatibility and actual installed gates

Owner answered normal-retry request ed679631-154e-4da3-8c92-effb0a09ec61 with submission1cfac3ff-5dd3-450c-a914-bff2ada86bdf and renewed session-only guard-off. The ordinary public diagnostic succeeded without policy changes or identity inspection. Node26.4.0/npm12.0.2 returns a singleton package-keyed object. Test-first normalization retains legacy lists and exact key/record/package binding.

Two subsequent real-package failures were independently evidenced and corrected with red/green tests and read-only review: upstream AI bins are0644 in both built source and immutable published archive, so verified declared bins are sealed0755 without changing bytes; npm12 packlist forcibly excludes SDK shrinkwrap, so only that absent member is restored from its exact prevalidated source snapshot after raw record/member verification. No dependency graph regeneration or required-runtime omission is permitted. Final Python39 tests and complete root script gate pass; independent review approved the narrow changes.

Actual685f18a5 triplets in release-output/pi085-triplet-complete-{first,repeat}-20260907 are identical after a full offline rebuild. AI8baeb0f3f10081f4922aae066c24a379767c78b9af8c0b258b5b9fc38b18c20f; core792fe9f16fe38a01ef1f2ccdaa61cdf0ad8f9fbe3c7b24baf9fe5abbba165d3e; SDKa810027b37817b3d3ebf7b9da98dee9a14745f2a94990e9ea23fe89b81eb3225. These are retained intermediate artifacts, not the approved deployment cohort.

Exact-lock offline npmci installed134 packages in release-output/pi085-installed-rehearsal-20260907. Lock seeded from reviewed SDK shrinkwrap changed only root and triplet nodes, preserving unrelated versions. ESM resolver/source/catalog proof shows no nested triplet substitutes. Actual installed publicCLI and exportedRPC each passed synthetic retry and preflight-cancellation scenarios (4/4), including Astra catalog, acceptance, settlement, Unicode framing and EOF cleanup.

Bare modular SDK import exposed an upstream packaging defect hidden by workspace hoisting and bundling: index→main→experimental/server eagerly imports undeclared @earendil-works/pi-server. Do not hoist a workaround in Wayang or remove exports. Repair source metadata and generated locks in pi-mono-worktrees/modular-package-closure-20260907, base685f18a5, then commit/rebuild/reseal a newly identified cohort and repeat installed gates. The earlier temporary resolver fixture used CJS on import-only exports; corrected to Node's enabled parent-specific ESM resolver, without changing packages.

Separate clean Sceptre consumer worktree audit-085-sceptre-consumer-20260907 now starts atfc0a8de; existing audit-085-consumer-20260907 remains6b2f749 for Tribe. Neither has pins/install changes. No host activation/restart/push or private-state transfer.

Evidence: /tmp/pi085-{npm12-record,bin-mode,shrinkwrap-supplement}-{red,green}.log; /tmp/pi085-producer-full-scripts.log; /tmp/pi085-artifact-repeat-build.log; /tmp/pi085-real-pack-complete-{first,repeat}.json; /tmp/pi085-installed-{resolution-esm,modular,bundle}.log. Failed raw stages remain retained.
