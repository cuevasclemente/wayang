# M1 maintenance engine slice

This directory contains the fail-closed, local preparation slice for weekly Pi/Wayang maintenance. It does not publish, promote, deploy, install dependencies, or execute candidate code.

## Trust boundary

`parseIntent` accepts only a bounded `wayang-maintenance-run/v1` request containing a safe run ID, the fixed `prepare`/`pi` operation, and exact expected upstream/downstream SHA-1 object IDs. SHA-256 repositories are rejected in M1 until dedicated fixtures and initialization support are added. Paths, remotes, commands, executable names, argv, credentials, and environment values are not manifest fields.

`prepareCandidate` receives paths, refs, the remote, and an absolute Git executable through a separate trusted programmatic configuration. Mirror/cache, worktree, synthetic-home, and temporary roots must all be strict descendants of the single locked state root. It acquires a host-local exclusive lock, snapshots exact refs into an automation mirror, evaluates the upstream diff policy before creating a worktree, and either records a block/no-action result or creates an exact two-parent merge candidate. It never pushes.

## Durable state

State transitions are canonical bounded JSON written in the same directory with exclusive temporary creation, file `fsync`, atomic rename, and parent-directory `fsync`. Private directory hierarchies are created one component at a time; every new entry is validated and its parent is immediately fsynced. Persisted state is re-parsed with duplicate/unknown-field rejection. Declared phases are:

`initialized -> locked -> refs_snapshot -> policy_passed -> merging -> candidate_ready -> completed`

An already-integrated upstream uses the explicit terminal transition `refs_snapshot -> completed` with reason `pi_up_to_date`; it does not claim policy, merge, or candidate phases that did not occur.

Any nonterminal phase may enter `failed`; policy and merge conflicts enter `blocked` only at their declared boundaries.

## Process and Git invariants

- subprocesses use absolute trusted executables, argv arrays, `shell: false`, a fixed minimal environment, aggregate-bounded redacted results, and process-group termination that does not resolve until the forced KILL/grace phase settles;
- bare caches have no mirror-push flag or broad fetch mapping, fetch only configured exact refs, and reject replacement refs, grafts, attributes, shallow state, alternates, unexpected config, and non-sample hooks; core administrative directories are owner-controlled real directories;
- every Git invocation uses replacement-object and system-attribute disable flags plus verified empty hooks, user-attributes, and global-config controls;
- SSH, scp, remote-helper, and credential-bearing transports are rejected; only absolute local/file and credential-free HTTPS remotes are accepted;
- worktrees are detached at the exact downstream OID;
- successful merge candidates must have exact downstream/upstream first and second parents and pass a second downstream-to-candidate policy gate;
- no shared-ref update API exists in M1.

## Deliberately deferred

Portable strong builder isolation (especially network/filesystem containment on both Linux and macOS), hosted CI, complete Pi package closure, publication fencing, and crash-reconciled partial cross-repository publication remain deferred. Exact remote CAS without force-with-lease is an unresolved M2 design blocker: compatible and deletion races make preflight-plus-normal-push checks insufficient, so M1 deliberately exposes no ref-update API.

Crash reconciliation is also not complete in this slice: stale lock ownership is never guessed, existing run IDs are not resumed or overwritten, interrupted worktrees are preserved, and nonterminal journals require a future deterministic reconciler. These gaps fail closed rather than attempting PID-based stale-lock takeover or heuristic cleanup. Until a reviewed isolated builder exists, the engine stops after candidate preparation and does not run lifecycle/build/test code from fetched candidates.
