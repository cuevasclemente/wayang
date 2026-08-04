# Finance Monarch Milestone P — process/cgroup/FD topology report

Date: 2026-07-27
Decision: **GO-ARCHITECTURE; NO-GO-STAGING and NO-GO-DEPLOYMENT pending Milestone C**

## Scope

Milestone P is tokenless and synthetic. It does not acquire or execute Monarch/provider code, use credentials, contact a financial provider, access Finance data, stage a release, activate a grant, or modify Finance instructions.

Its purpose is to choose and prove the process topology that later installer/runtime work would rely on. No weaker sandbox, cgroup, descriptor, or teardown fallback is allowed.

## Baseline evidence

Normal-host evidence on the deployed Linux x86-64 host:

- `scripts/milestone0/containment-probe.sh --host`: 13 pass, 0 fail, `GO-TESTED-PRIMITIVES`;
- `sandbox-rpc-linux.test.ts`: 9 pass, 0 fail, 0 skip;
- backend TypeScript build: pass.

These separately proved delegated aggregate/per-child cgroup enforcement and the earlier proxy-free bwrap → pinned SRT seccomp → direction-shim → synthetic workload FD3/FD4 path. That earlier run used Node-created duplex AF_UNIX extra-stdio handles and is retained only as superseded baseline evidence; it does not prove the frozen pipe contract below.

## Combined feasibility prototype

The prototype added:

- `backend/src/restricted-mcp/milestone0/cgroup-exec-gate.c`;
- `backend/src/restricted-mcp/milestone0/rpc-pipe-launcher.c` (added by the frozen one-way-pipe correction);
- `backend/src/restricted-mcp/milestone0/combined-systemd-rpc-probe.ts`;
- `scripts/milestone0/combined-systemd-rpc-probe.sh`;
- an optional synthetic `cgroupPlacement` path in `sandbox-rpc-linux.ts`.

It launched the trusted supervisor inside a delegated systemd user service, created aggregate and per-child limits, stopped a fixed static gate, moved and verified the launch PID in the leaf, then resumed into the existing bwrap/seccomp/FD chain. The combined run dynamically passed FD direction, isolation canaries, aggregate/leaf descriptors, hostile descendant teardown, leaf cleanup, and unit collection.

After review, its output was deliberately downgraded to:

`FEASIBLE-NOT-AUTHORIZED`

The gate and TypeScript API are marked rejected synthetic evidence and must never become production authority.

## Independent review

Two independent static reviews returned **REVISE**. The primary blocking finding is decisive:

- `SIGSTOP` plus numeric-PID placement is not race-free. Another same-UID process can resume the gate before verified placement, and numeric PID reuse can invalidate later checks/signals.

Other production blockers:

- path-based check/use races for the gate, bwrap, seccomp helper, shim, workload, and mounts;
- duplex FD wrong halves remain until the trusted direction shim rather than being closed in the earliest launcher;
- the generic SRT filter/net namespace does not yet prove the final socket/socketpair/io_uring/kernel escape syscall policy;
- combined cgroup values are reread but the exact combined tree does not yet exercise all resource enforcement or sibling behavior;
- teardown treats leader exit as primary instead of leaf `cgroup.kill` plus bounded `cgroup.events populated=0` and recursive emptiness;
- incomplete failure-path cleanup and overly coarse structured evidence;
- the prototype seam is not yet the production lifecycle/supervisor API.

## Required revised topology

Milestone P remains open. Production prerequisite work must implement and prove:

1. A native trusted launcher using `clone3(CLONE_INTO_CGROUP | CLONE_PIDFD)` so the bwrap chain begins in the exact leaf atomically.
2. Pidfd-owned signaling/reaping and parent-death handling; no numeric-PID authorization transition.
3. Cgroup directory identity held by descriptor, exact systemd `ControlGroup` binding, initial emptiness/type/limit/controller validation, and complete ancestry evidence.
4. Descriptor-bound execution (`execveat`/equivalent) and descriptor-backed artifact/mount inputs with exact digests and minimal runtime tree.
5. Exactly two launcher-created anonymous unidirectional pipes: request child endpoint FD3 is `S_IFIFO`/`O_WRONLY`, response child endpoint FD4 is `S_IFIFO`/`O_RDONLY`, both are installed before bwrap or any package-controlled instruction, every unused end is closed in the corresponding launch branch at that earliest point, and the existing direction shim is retained to revalidate pipe type/access modes as defense in depth. Duplex sockets, socketpairs, `shutdown(2)`-derived pseudo-directionality, ancillary data, and post-exec descriptor passing are invalid.
6. Final seccomp probes requiring denial of network/socket classes, SCM_RIGHTS paths, io_uring, namespace/mount, ptrace/process-memory, keyring, perf, and eBPF surfaces not required by the workload.
7. Leaf and aggregate resource enforcement, sibling survival, manager accounting, cancellation, abrupt supervisor/systemd stop, and restart reconciliation in the combined production seam.
8. Teardown that first denies authority, then uses `cgroup.kill`, waits for `populated 0`, verifies recursive emptiness, removes leaves, and reports cleanup failure as denied/unhealthy.
9. Atomic bounded structured pass/failure evidence with source/executable/policy digests and no raw stderr, argv, environment, private paths, provider data, or secrets.
10. Independent GO after all normal-host tests pass with no skipped containment evidence.

## Atomic revision evidence

The first review's central architectural findings were subsequently implemented in the synthetic seam:

- the rejected SIGSTOP/numeric-PID mode was removed from the TypeScript launch API;
- a static native launcher now uses `clone3(CLONE_INTO_CGROUP | CLONE_PIDFD)`, pidfd signal forwarding, `waitid(P_PIDFD)`, parent-death handling, and blocked signal setup;
- both direct and atomic synthetic launchers create two anonymous `pipe2(O_CLOEXEC)` channels, close unused ends before bwrap, install only child-write `FD3` and child-read `FD4`, and retain the trusted direction shim solely as exact `S_IFIFO`/access-mode verification; no provider child inherits the Node-created duplex extra-stdio sockets;
- the launcher itself is executed through an opened descriptor; bwrap is executed with `execveat(AT_EMPTY_PATH)`; runtime artifacts are opened/hashed by Node, copied into sealed memfds by the native launcher, and supplied to bwrap through descriptor-backed bindings;
- Node retains the exact cgroup directory descriptor through the lifecycle; teardown requires `populated 1`, writes descriptor-relative `cgroup.kill`, waits for `populated 0`, removes the leaf, then closes the descriptor;
- an additive final seccomp layer rejects x32 syscall numbers, all socket families/socketpair/message paths, io_uring, clone3 and namespace-bearing clone, legacy/new mount APIs, ptrace/process-memory, pidfd-getfd, userfaultfd, keyring, perf, and eBPF surfaces;
- standalone x32/filter probes and combined in-sandbox socket/netlink/packet/io_uring/clone3/fsopen/userfaultfd probes pass;
- the exact combined bwrap/RPC tree now exercises CPU throttling, pids denial, memory OOM/kill with swap zero, TERM-immune descendants, and cgroup-owned teardown;
- result evidence is atomic, fsynced, explicitly `authoritative:false`, uses schema v2 with an explicit `anonymousOneWayPipes:true` gate, and includes bounded artifact digests.

Latest normal-host evidence before the one-way-pipe correction:

- host containment: 13/13;
- superseded duplex direct RPC/bwrap suite: 9/9, no skips;
- superseded duplex combined atomic topology: three consecutive passes after the OOM victim was deterministically biased with `oom_score_adj`;
- backend TypeScript build: pass.

The anonymous-pipe correction is not represented as tested evidence until the direct RPC suite, combined systemd probe, and backend build rerun on the normal host. Failure or skip keeps staging and deployment denied.

An independent architecture-gate review issued **GO-ARCHITECTURE**: the topology may freeze and Milestone A may begin. The remaining startup/exec/signal/cancellation/sibling/resource/revocation/failure-cleanup matrix belongs to the production provider-runtime Milestone C and remains a hard staging/deployment gate. The standalone probe output remains `FEASIBLE-NOT-AUTHORIZED` so it cannot itself be mistaken for deployment authority.

## Boundary

Milestones A–G remain blocked on Milestone P GO. In particular, no production catalog lifecycle freeze, staging approval, provider acquisition, credential helper, activation, or financial-data call is authorized by this feasibility result.
