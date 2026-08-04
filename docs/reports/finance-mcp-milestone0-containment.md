# Finance MCP Milestone 0 — host containment probe

Status: **GO-TESTED-PRIMITIVES / final normal-host run passed 13/13 with exit 0** (2026-07-24)

This report covers synthetic host-containment primitives only. It does not authorize Finance MCP, Monarch, provider RPC, PIN approval, credentials, browser access, or real data. It makes no network-isolation, closed-filesystem-allowlist, or anti-container provenance claim.

## Independent-review disposition

The findings in `/tmp/m0-sandbox-review.md` were accepted for this owned probe and addressed as follows:

- The shared `/tmp` canary now lives inside a random mode-`0700` `mktemp` directory and is created by `O_CREAT|O_EXCL|O_NOFOLLOW`, followed by regular-file and owner checks. No predictable shell redirection is used.
- Filesystem evidence and GO language are path-specific. The service tests an explicitly hidden marker, private `/tmp`, the protected synthetic home, a sibling under the synthetic work root, a separate synthetic runtime-directory canary, and the writable workspace. It does **not** claim those canaries prove a closed write allowlist across every mount.
- Aggregate memory attribution requires `memory.events.local`, unchanged local child OOM counters, bounded pre-pressure `memory.current` values, a parent-local OOM kill, exactly one surviving sibling, and deadline-driven observation. Per-child memory enforcement separately requires a child-local event without a parent-local event.
- Bounded enforcement probes now cross both aggregate and per-child PID ceilings using local `pids.events.local` counters. A 1.5-second busy fixture must increase per-child CPU usage and throttling. Aggregate CPU GO is deliberately limited to exact `cpu.max` installation; aggregate CPU enforcement is not claimed.
- Every child-cgroup removal is checked with a deadline. GO integrates exact transient-unit collection (`LoadState=not-found`), exact cgroup-path disappearance, and PID-plus-start-time process disappearance. Manager calls and runner waits are bounded.
- The hostile teardown fixture now includes an ordinary chain, a new-session descendant, and a double-forked descendant that closes stdio and ignores termination. The systemd scope must remove all of them irrespective of process group.

The review's RPC/network/descriptor findings concern artifacts outside this containment owner's paths and are not addressed or credited here.

## First normal-host run and remediation

The maintainer ran the documented command from the intended normal unprivileged login session. The Finance directory prerequisite was corrected and verified as mode `0700` and owned by the Wayang OS user.

The containment probe exited 1 and correctly made no GO claim. It exposed three fixture/portability defects:

- `ProtectHome=yes` hid the synthetic fixture beneath `/run/user/$UID`. The revision explicitly makes `/home` and `/root` inaccessible, makes the user runtime read-only, reopens only the exact workspace, and makes the synthetic home/work sibling read-only again.
- This systemd version rejects `systemd-run --wait --scope`. Delegated-resource and hostile-teardown probes now use transient `.service` units with `--service-type=exec`, `Delegate=yes` where required, and `KillMode=control-group` for teardown.
- `wait_runner` evaluated its deadline before assigning the local `seconds` value under `set -u`; assignment is now sequenced explicitly.

After revision, shell syntax validation, Python compilation, and the hostile nested fixture passed 3/3 with intentional exit 3.

### Second normal-host run

The revised host run passed 12 of 13 checks:

- filesystem path controls and service residue;
- cgroup descriptors and controller delegation;
- multi-helper coexistence;
- aggregate/per-child PID enforcement and inter-phase cleanup;
- per-child CPU throttling;
- delegated-service cleanup;
- hostile setsid/double-fork service stop, full tree teardown, and residue cleanup.

Only `delegated-resource-enforcement` failed. Diagnostics showed all pre-pressure/descriptors/PID/CPU checks true, but the aggregate fixture concurrently told both memory workers to allocate. Both could be killed by successive parent OOM events before reclamation, while the oracle required exactly one survivor and then reused that survivor for the per-child phase. This was a nondeterministic fixture dependency, not memory-containment GO or proof of a kernel-limit failure.

The corrected memory oracle now:

1. triggers aggregate pressure from one dynamically bounded worker;
2. requires a parent-local `oom_kill`, unchanged child-local counters, a worker death, and bounded post-event usage;
3. fully kills/reaps/reclaims the aggregate phase;
4. lowers both fresh child limits to an exact 96 MiB and computes a child-crossing allocation only when at least 32 MiB of aggregate margin remains;
5. requires helper-a local OOM advancement, unchanged parent/helper-b local counters, helper-a death, and a surviving helper-b that completes a follow-up CPU command.

Every prerequisite gates pressure, and fixed boolean diagnostics identify each attribution condition.

### Third normal-host run and final trigger revision

The third run again passed 12/13. Its expanded diagnostics showed both allocation bounds true, zero OOM/death events, and a responsive sibling. The aggregate request had likely computed to the same 64 MiB string as the earlier baseline; the worker's exact-string deduplication therefore treated it as already handled. The phase also lacked a durable positive acknowledgment that the intended allocation had started.

The final revision:

- publishes all commands and acknowledgments by same-directory `O_EXCL` temporary file plus atomic `os.replace`;
- uses strict decimal/finite command grammars;
- requires unique, nonreusable allocation tokens before deduplication state changes;
- atomically publishes exact `allocating:<bytes>:<token>` before touching pages;
- requires the exact token/size acknowledgment before interpreting OOM counters;
- crosses the aggregate limit by a bounded 32 MiB while staying at least 8 MiB below the child limit;
- crosses the fresh 96 MiB child limit by 32 MiB while retaining at least 32 MiB aggregate headroom;
- disables swap on the transient service and both child cgroups with exact `memory.swap.max=0`, and requires root/child `memory.swap.current=0` before and after both pressure phases.

Static checks and nested hostile 3/3 pass. Independent review verified the transient service's swap, atomic command, bounds, acknowledgment, and diagnostics.

### Fourth normal-host run and cgroup attribution correction

The fourth run proved both exact pressure triggers executed. The independent per-child phase passed every condition: helper-a crossed its exact cap and died; helper-b survived and responded; helper-a local events advanced; root/helper-b constraints and all swap counters stayed unchanged.

The aggregate phase also killed a worker, but its `oom_kill` advanced at the victim leaf rather than at the parent, so the prior oracle rejected it. That rejection exposed an incorrect accounting assumption: cgroup v2 local `oom_kill` identifies victim membership and need not identify the cgroup whose limit triggered the OOM.

The corrected final attribution now:

- sets both aggregate-phase child `memory.max` values to `max`, making the transient service's 192 MiB parent limit the only memory constraint;
- requires parent-local `memory.events.local` `max` and `oom` advancement, unchanged child-local `max`/`oom`, a worker death, bounded current use, and zero swap;
- treats leaf `oom_kill` only as victim-location diagnostics;
- after full reclaim, installs exact 96 MiB child limits and requires helper-a local `max`/`oom`/`oom_kill` advancement while parent/helper-b local constraint counters remain unchanged, with helper-b alive and responsive.

Static/nested checks passed. Independent cgroup-v2 attribution review issued GO to request another human rerun.

### Final normal-host run

The maintainer ran the final reviewed probe from the intended normal unprivileged login session. It produced exactly:

```text
PASS prerequisite-cgroup-v2
PASS prerequisite-python3
PASS prerequisite-systemctl
PASS prerequisite-systemd-run
PASS prerequisite-timeout
PASS filesystem-path-controls
PASS filesystem-service-residue-free
PASS delegated-resource-enforcement
PASS delegated-scope-residue-free
PASS systemd-hostile-scope-started
PASS systemd-hostile-scope-stop
PASS full-hostile-tree-teardown
PASS teardown-scope-residue-free
SUMMARY pass=13 fail=0 decision=GO-TESTED-PRIMITIVES
```

Exit status was exactly 0. No failure or diagnostic line appeared. This is GO evidence for the enumerated normal-host primitives and exact transient-service fixture only.

## Safety boundary

The probe:

- reads only its own two source files, caller-created synthetic paths/results, `/proc` records for exact PIDs it created, its transient unit metadata, and its own cgroup v2 controls;
- never lists project content or the general environment and never reads home content, credentials, PINs, Finance data, browser state, real sockets, or network configuration;
- reads only the documented non-secret `XDG_RUNTIME_DIR` and `M0_HOST_CONFIRM` controls in host mode;
- uses no `sudo`, network I/O, package installation, persistent unit, system configuration, or unrelated cgroup;
- gives every resource-pressure helper an empty environment and bounds the aggregate scope to 192 MiB, 32 tasks, and 50% of one CPU;
- removes only exact recorded PIDs, exact `finance-m0-*` transient user units, and random owned roots matching the probe's strict prefixes;
- fails closed on absent local counters, skipped checks, timeouts, cleanup failures, missing evidence, or residue.

## Files

- `scripts/milestone0/containment-probe.sh`
- `scripts/milestone0/synthetic_containment_helper.py`

Neither imports or runs Wayang, Monarch, Finance MCP, browser, provider, RPC launcher, or application code.

## Normal-host checks

A successful host run proves only these enumerated properties for the exact tested systemd/cgroup arrangement:

1. Unified cgroup v2 and the required user-manager commands are available.
2. A transient delegated user service receives exact aggregate `memory.max`, `pids.max`, and `cpu.max` descriptors.
3. `cpu`, `memory`, and `pids` are delegated to two synthetic child cgroups with exact child descriptors.
4. Both helpers coexist in distinct child cgroups.
5. Parent-local versus child-local counters attribute aggregate and per-child memory OOM events; pre-pressure current usage and all event/death transitions are deadline-bounded.
6. Aggregate and per-child PID ceilings are crossed safely and attributed with local counters; helpers remain inside the 32-task parent scope.
7. A bounded per-child CPU workload records usage and throttling. Aggregate CPU **enforcement** is not tested or claimed.
8. The filesystem service produces the seven path-specific outcomes listed above. This is not proof that every other mount is read-only or absent.
9. Child/manager cgroups are removed, exact helper identities disappear, and transient units become `LoadState=not-found`.
10. Stopping a `KillMode=control-group` service removes ordinary, new-session, and double-forked descendants that ignore SIGTERM.

A passing result is therefore a **GO for these tested primitives only**, not a complete filesystem sandbox or overall Finance MCP containment GO. A reviewed launcher with a closed mount policy and the separately owned proxy-free network/RPC gates remains required.

## Safe nested command

Run only in an already nested agent/container shell:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent \
  /bin/bash scripts/milestone0/containment-probe.sh --nested
```

Expected successful lines for the revised fixture:

```text
PASS nested-hostile-fixture-started
PASS nested-escaped-descendants-outlive-process-group
PASS nested-exact-fixture-cleanup
SUMMARY pass=3 fail=0 decision=NESTED-ONLY-NO-HOST-DECISION
```

Exit 3 is intentional. The second PASS confirms the hostile descendants escaped the leader's process group; the third confirms exact PID-plus-start-time fixture cleanup. This does not prove systemd, cgroup, mount, network, bwrap/SRT, or normal-host behavior.

### Nested evidence record

The earlier `pass=2` record applied to the superseded ordinary process-group fixture and is no longer evidence for the revised files.

The orchestrator ran the revised nested fixture on 2026-07-24 and reported exactly:

```text
PASS nested-hostile-fixture-started
PASS nested-escaped-descendants-outlive-process-group
PASS nested-exact-fixture-cleanup
SUMMARY pass=3 fail=0 decision=NESTED-ONLY-NO-HOST-DECISION
```

Exit status was exactly 3 as designed. The same 3/3 result was reproduced after the first normal-host portability fixes. This validates only revised hostile-fixture construction, process-group escape, and exact synthetic PID-plus-start-time cleanup in the already nested environment. It provides no systemd-user-service, cgroup delegation, resource-enforcement, filesystem-mount, network, bwrap/SRT, normal-host, or Finance MCP evidence. The first host run failed closed; revised host mode remains unrun and NO-GO.

## Required normal-host command — do not run from an agent

A human must run this from the intended normal unprivileged login user terminal, with that user's systemd manager active, from the repository root:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent \
  XDG_RUNTIME_DIR="/run/user/$(/usr/bin/id -u)" \
  M0_HOST_CONFIRM=synthetic-only \
  /bin/bash scripts/milestone0/containment-probe.sh --host
```

Do not use `sudo`, `su`, `machinectl`, a container, an agent bash tool, an SSH forced-command sandbox, or a system service. Human normal-host provenance remains an attestation; the two control variables are not an anti-container proof.

## Exact interpretation

**GO for the tested primitives only** requires all of the following:

- execution in the intended normal-host user session;
- exit status exactly 0;
- no `FAIL` line;
- final line exactly `SUMMARY pass=13 fail=0 decision=GO-TESTED-PRIMITIVES`;
- no timeout, skipped check, unreviewed source change, or synthetic residue.

Anything else is **NO-GO**, including nested exit 3, unavailable `*.events.local`, ambiguous OOM attribution, absent CPU/PID enforcement evidence, any child-cgroup removal failure, an inactive-but-still-loaded unit, a live exact PID identity, or an extant exact cgroup path.

Even that narrow GO leaves the complete containment sub-gate and overall Finance MCP Milestone 0 at **NO-GO** until the closed filesystem/mount launcher and all independent PIN, RPC descriptor, invocation-scope, proxy-free network, and teardown gates pass.

## Optional independent residue audit

The script now includes exact residue checks in its GO calculation. A human may additionally run these read-only checks; both should produce no output:

```sh
systemctl --user list-units --all --plain --no-legend 'finance-m0-*'
pgrep -af 'finance-m0\.|synthetic_containment_helper.py'
```

Treat any live synthetic artifact as NO-GO. Stop only an exact reported `finance-m0-*` user unit; never use a broad kill pattern.

## Current decision

The earlier runs failed closed while improving the oracle; none is treated as a partial pass. The final reviewed run passed every required check with exact exit 0.

Current tested-primitives decision: **GO-TESTED-PRIMITIVES**. Combined with the separately reviewed closed-root sandbox/RPC fixture, the Milestone 0 containment sub-gate is **GO**. This does not authorize production Finance MCP, Monarch code, credentials, provider calls, or real data.
