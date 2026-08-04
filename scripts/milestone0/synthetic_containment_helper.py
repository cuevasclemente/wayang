#!/usr/bin/env python3
"""Synthetic-only helper for the Milestone 0 host-containment probe.

Only caller-created synthetic paths, this process's /proc records, and its own
transient cgroup are accessed. The helper never uses the network or reads the
project, general environment, credentials, browser state, or application data.
"""

from __future__ import annotations

import json
import math
import os
import re
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

PAGE = 4096
MIB = 1024 * 1024


def atomic_text(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{time.monotonic_ns()}")
    descriptor = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(temporary, flags, 0o600)
        payload = text.encode("utf-8")
        written = 0
        while written < len(payload):
            count = os.write(descriptor, payload[written:])
            if count <= 0:
                raise OSError("atomic text write made no progress")
            written += count
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_json(path: Path, value: dict[str, object]) -> None:
    atomic_text(path, json.dumps(value, sort_keys=True) + "\n")


def proc_identity(pid: int) -> str:
    fields = Path(f"/proc/{pid}/stat").read_text(encoding="ascii").split()
    return f"{pid}:{fields[21]}"


def cgroup_relative() -> str:
    for line in Path("/proc/self/cgroup").read_text(encoding="ascii").splitlines():
        if line.startswith("0::"):
            relative = line[3:]
            if not relative.startswith("/") or ".." in Path(relative).parts:
                raise RuntimeError("invalid unified cgroup path")
            return relative
    raise RuntimeError("unified cgroup v2 membership not found")


def cgroup_path() -> Path:
    return Path("/sys/fs/cgroup") / cgroup_relative().lstrip("/")


def read_scalar(path: Path) -> str:
    return path.read_text(encoding="ascii").strip()


def keyed_value(path: Path, key: str) -> int:
    for line in path.read_text(encoding="ascii").splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0] == key:
            return int(fields[1])
    raise RuntimeError(f"counter missing: {key}")


def local_counter(group: Path, controller: str, key: str) -> int:
    # Local counters are required so a descendant event cannot be mistaken for
    # enforcement at the aggregate parent.
    path = group / f"{controller}.events.local"
    if not path.is_file():
        raise RuntimeError(f"local {controller} counters unavailable")
    return keyed_value(path, key)


def exclusive_create(path: Path, text: str) -> int:
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("O_NOFOLLOW unavailable")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise RuntimeError("exclusive marker identity mismatch")
        os.write(descriptor, text.encode("ascii"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return 0


def attempt_exclusive_write(directory: Path, name: str) -> bool:
    path = directory / name
    descriptor = None
    try:
        if not hasattr(os, "O_NOFOLLOW"):
            return False
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        os.write(descriptor, b"synthetic-write\n")
        return True
    except OSError:
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)


def fs_check(
    workspace: Path,
    denied_marker: Path,
    synthetic_home: Path,
    host_tmp_marker: Path,
    work_sibling: Path,
    runtime_canary: Path,
) -> int:
    result: dict[str, object] = {
        "cgroup_relative": cgroup_relative(),
        "process_identities": [proc_identity(os.getpid())],
    }
    result["denied_marker_hidden"] = not denied_marker.exists()
    result["host_tmp_marker_hidden"] = not host_tmp_marker.exists()
    result["workspace_writable"] = attempt_exclusive_write(workspace, "workspace-write")
    result["synthetic_home_read_only"] = not attempt_exclusive_write(synthetic_home, "must-not-write")
    result["work_sibling_read_only"] = not attempt_exclusive_write(work_sibling, "must-not-write")
    result["runtime_canary_read_only"] = not attempt_exclusive_write(runtime_canary, "must-not-write")

    private_name = f"finance-m0-private-{os.getpid()}"
    private_tmp = Path("/tmp") / private_name
    result["private_tmp_writable"] = attempt_exclusive_write(Path("/tmp"), private_name)
    try:
        private_tmp.unlink()
    except FileNotFoundError:
        pass

    required = [
        "denied_marker_hidden",
        "host_tmp_marker_hidden",
        "workspace_writable",
        "synthetic_home_read_only",
        "work_sibling_read_only",
        "runtime_canary_read_only",
        "private_tmp_writable",
    ]
    result["pass"] = all(result.get(name) is True for name in required)
    atomic_json(workspace / "fs-result.json", result)
    return 0 if result["pass"] else 1


def ignore_termination() -> None:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)


def sleep_forever() -> int:
    while True:
        time.sleep(60)


def chain_node(status_dir: Path, depth: int) -> int:
    ignore_termination()
    (status_dir / f"identity-chain-{depth}").write_text(proc_identity(os.getpid()) + "\n", encoding="ascii")
    if depth < 2:
        subprocess.Popen(
            [sys.executable, str(Path(__file__)), "chain-node", str(status_dir), str(depth + 1)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    return sleep_forever()


def detached_node(status_dir: Path) -> int:
    ignore_termination()
    (status_dir / "identity-setsid").write_text(proc_identity(os.getpid()) + "\n", encoding="ascii")
    return sleep_forever()


def double_fork(status_dir: Path) -> None:
    first = os.fork()
    if first == 0:
        os.setsid()
        second = os.fork()
        if second > 0:
            os._exit(0)
        ignore_termination()
        (status_dir / "identity-double-fork").write_text(proc_identity(os.getpid()) + "\n", encoding="ascii")
        for descriptor in (0, 1, 2):
            try:
                os.close(descriptor)
            except OSError:
                pass
        sleep_forever()
        os._exit(0)
    os.waitpid(first, 0)


def hostile_tree(status_dir: Path) -> int:
    ignore_termination()
    (status_dir / "identity-leader").write_text(proc_identity(os.getpid()) + "\n", encoding="ascii")
    subprocess.Popen(
        [sys.executable, str(Path(__file__)), "chain-node", str(status_dir), "1"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    subprocess.Popen(
        [sys.executable, str(Path(__file__)), "detached-node", str(status_dir)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )
    double_fork(status_dir)
    return sleep_forever()


def worker(command_file: Path, ready_file: Path) -> int:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    atomic_text(ready_file, "ready\n")
    allocations: list[bytearray] = []
    children: list[subprocess.Popen[bytes]] = []
    used_allocation_tokens: set[str] = set()
    last_command = ""
    try:
        while True:
            try:
                command = command_file.read_text(encoding="ascii").strip()
            except FileNotFoundError:
                command = ""
            if command and command != last_command:
                if command == "wait":
                    last_command = command
                elif command == "exit":
                    last_command = command
                    return 0
                elif command == "reap":
                    last_command = command
                    for child in children:
                        if child.poll() is None:
                            child.kill()
                    for child in children:
                        try:
                            child.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            pass
                    children.clear()
                    atomic_text(ready_file, "reaped\n")
                elif command.startswith("fork:"):
                    fields = command.split(":")
                    if len(fields) != 2 or not re.fullmatch(r"[1-9][0-9]{0,2}", fields[1]):
                        return 65
                    requested = int(fields[1])
                    if requested > 64:
                        return 65
                    last_command = command
                    failed = 0
                    for _ in range(requested):
                        try:
                            children.append(
                                subprocess.Popen(
                                    ["/usr/bin/sleep", "30"],
                                    stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL,
                                    close_fds=True,
                                )
                            )
                        except OSError:
                            failed += 1
                            break
                    atomic_text(ready_file, f"forked:{len(children)}:failed:{failed}\n")
                elif command.startswith("burn:"):
                    fields = command.split(":")
                    if len(fields) != 2 or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", fields[1]):
                        return 65
                    seconds = float(fields[1])
                    if not math.isfinite(seconds) or seconds <= 0 or seconds > 5:
                        return 65
                    last_command = command
                    deadline = time.monotonic() + seconds
                    value = 1
                    while time.monotonic() < deadline:
                        value = (value * 1103515245 + 12345) & 0x7FFFFFFF
                    atomic_text(ready_file, f"burned:{value}\n")
                elif command.startswith("allocate:"):
                    fields = command.split(":")
                    if (len(fields) != 3
                            or not re.fullmatch(r"[1-9][0-9]{0,11}", fields[1])
                            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", fields[2])):
                        return 65
                    amount = int(fields[1])
                    token = fields[2]
                    if amount < MIB or amount > 256 * MIB or token in used_allocation_tokens:
                        return 65
                    used_allocation_tokens.add(token)
                    last_command = command
                    atomic_text(ready_file, f"allocating:{amount}:{token}\n")
                    allocation = bytearray(amount)
                    for offset in range(0, amount, PAGE):
                        allocation[offset] = 1
                    allocations.append(allocation)
                    atomic_text(ready_file, f"allocated:{amount}:{token}\n")
                else:
                    return 65
            time.sleep(0.02)
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
        for child in children:
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass


def wait_for_text(path: Path, predicate, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate(path.read_text(encoding="ascii").strip()):
                return True
        except FileNotFoundError:
            pass
        time.sleep(0.04)
    return False


def command_worker(
    command: Path,
    ready: Path,
    value: str,
    expected: str,
    timeout: float = 8.0,
    *,
    exact: bool = False,
) -> bool:
    atomic_text(command, value + "\n")
    return wait_for_text(ready, lambda text: text == expected if exact else text.startswith(expected), timeout)


def delegated_check(
    result_path: Path,
    expected_memory_max: str,
    expected_pids_max: str,
    expected_cpu_max: str,
) -> int:
    root = cgroup_path()
    manager = root / "probe-manager"
    child_groups = [root / "helper-a", root / "helper-b"]
    workers: list[subprocess.Popen[bytes]] = []
    result: dict[str, object] = {
        "cgroup_relative": cgroup_relative(),
        "process_identities": [proc_identity(os.getpid())],
    }
    try:
        result["aggregate_memory_descriptor"] = read_scalar(root / "memory.max") == expected_memory_max
        result["aggregate_swap_disabled"] = read_scalar(root / "memory.swap.max") == "0"
        result["aggregate_pids_descriptor"] = read_scalar(root / "pids.max") == expected_pids_max
        result["aggregate_cpu_descriptor"] = read_scalar(root / "cpu.max") == expected_cpu_max

        manager.mkdir()
        (manager / "cgroup.procs").write_text(str(os.getpid()), encoding="ascii")
        (root / "cgroup.subtree_control").write_text("+cpu +memory +pids", encoding="ascii")
        enabled = set(read_scalar(root / "cgroup.subtree_control").split())
        result["delegated_controllers"] = {"cpu", "memory", "pids"}.issubset(enabled)

        for child in child_groups:
            child.mkdir()
            (child / "memory.max").write_text("max", encoding="ascii")
            (child / "memory.swap.max").write_text("0", encoding="ascii")
            (child / "pids.max").write_text("24", encoding="ascii")
            (child / "cpu.max").write_text("20000 100000", encoding="ascii")

        result["per_child_descriptors"] = all(
            read_scalar(child / "memory.max") == "max"
            and read_scalar(child / "pids.max") == "24"
            and read_scalar(child / "cpu.max") == "20000 100000"
            for child in child_groups
        )
        result["aggregate_child_memory_unbounded"] = all(
            read_scalar(child / "memory.max") == "max" for child in child_groups
        )
        result["per_child_swap_disabled"] = all(
            read_scalar(child / "memory.swap.max") == "0" for child in child_groups
        )

        commands = [result_path.parent / "command-a", result_path.parent / "command-b"]
        ready = [result_path.parent / "ready-a", result_path.parent / "ready-b"]

        def start_worker(index: int) -> subprocess.Popen[bytes]:
            atomic_text(commands[index], "wait\n")
            try:
                ready[index].unlink()
            except FileNotFoundError:
                pass
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__)), "worker", str(commands[index]), str(ready[index])],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            workers.append(process)
            (child_groups[index] / "cgroup.procs").write_text(str(process.pid), encoding="ascii")
            identities = result["process_identities"]
            if not isinstance(identities, list):
                raise RuntimeError("process identity result is unavailable")
            identities.append(proc_identity(process.pid))
            return process

        initial_workers = [start_worker(index) for index in range(2)]
        both_ready = all(wait_for_text(path, lambda text: text == "ready") for path in ready)
        distinct = all(
            f"/{child.name}" in Path(f"/proc/{initial_workers[index].pid}/cgroup").read_text(encoding="ascii")
            for index, child in enumerate(child_groups)
        )
        result["multi_helper_coexistence"] = both_ready and distinct

        # Aggregate PID enforcement: each child remains below 24, while their
        # combined request crosses the parent's 32-task ceiling.
        root_pids_before = local_counter(root, "pids", "max")
        child_pids_before = [local_counter(child, "pids", "max") for child in child_groups]
        first_fork = command_worker(commands[0], ready[0], "fork:18", "forked:")
        second_fork = command_worker(commands[1], ready[1], "fork:18", "forked:")
        root_pids_after = local_counter(root, "pids", "max")
        child_pids_after = [local_counter(child, "pids", "max") for child in child_groups]
        result["aggregate_pids_enforced"] = (
            first_fork
            and second_fork
            and root_pids_after > root_pids_before
            and child_pids_after == child_pids_before
            and all(process.poll() is None for process in workers)
        )
        aggregate_reaped = all(
            command_worker(commands[index], ready[index], "reap", "reaped") for index in range(2)
        )
        deadline = time.monotonic() + 3.0
        while int(read_scalar(root / "pids.current")) > 3 and time.monotonic() < deadline:
            time.sleep(0.05)
        result["inter_phase_pid_cleanup"] = aggregate_reaped and int(read_scalar(root / "pids.current")) <= 3

        # Per-child PID enforcement with aggregate headroom restored.
        root_pids_before = local_counter(root, "pids", "max")
        child_pids_before_one = local_counter(child_groups[0], "pids", "max")
        child_fork = command_worker(commands[0], ready[0], "fork:30", "forked:")
        result["per_child_pids_enforced"] = (
            child_fork
            and local_counter(child_groups[0], "pids", "max") > child_pids_before_one
            and local_counter(root, "pids", "max") == root_pids_before
            and workers[0].poll() is None
        )
        child_reaped = command_worker(commands[0], ready[0], "reap", "reaped")
        deadline = time.monotonic() + 3.0
        while int(read_scalar(root / "pids.current")) > 3 and time.monotonic() < deadline:
            time.sleep(0.05)
        result["inter_phase_pid_cleanup"] = (
            result["inter_phase_pid_cleanup"]
            and child_reaped
            and int(read_scalar(root / "pids.current")) <= 3
        )

        # A single bounded busy worker is below the parent's 50% quota but above
        # its child's 20% quota; child throttling and usage must both advance.
        cpu_throttled_before = keyed_value(child_groups[0] / "cpu.stat", "nr_throttled")
        cpu_usage_before = keyed_value(child_groups[0] / "cpu.stat", "usage_usec")
        burned = command_worker(commands[0], ready[0], "burn:1.5", "burned:", 5.0)
        result["per_child_cpu_enforced"] = (
            burned
            and keyed_value(child_groups[0] / "cpu.stat", "nr_throttled") > cpu_throttled_before
            and keyed_value(child_groups[0] / "cpu.stat", "usage_usec") > cpu_usage_before
        )

        # Establish bounded pre-pressure memory evidence for both children.
        baseline_allocation = 64 * MIB
        baseline_ready = all(
            command_worker(
                commands[index], ready[index],
                f"allocate:{baseline_allocation}:baseline-{index}",
                f"allocated:{baseline_allocation}:baseline-{index}",
                exact=True,
            )
            for index in range(2)
        )
        child_currents = [int(read_scalar(child / "memory.current")) for child in child_groups]
        root_current = int(read_scalar(root / "memory.current"))
        root_limit = int(expected_memory_max)
        memory_headroom = (
            baseline_ready
            and all(current < 96 * MIB for current in child_currents)
            and root_current < root_limit
            and all(process.poll() is None for process in workers)
        )
        pre_pressure_swap_zero = (
            int(read_scalar(root / "memory.swap.current")) == 0
            and all(int(read_scalar(child / "memory.swap.current")) == 0 for child in child_groups)
        )
        result["pre_pressure_memory_bounded"] = memory_headroom
        result["pre_pressure_swap_zero"] = pre_pressure_swap_zero
        result["pre_pressure_root_current_below_max"] = root_current < root_limit
        result["pre_pressure_children_bounded"] = all(current < 96 * MIB for current in child_currents)

        # Child memory.max is deliberately unlimited in the aggregate phase, so
        # only the transient service's parent cap can constrain this allocation.
        # Constraint attribution uses local max/oom boundary events; oom_kill is
        # victim-location accounting and may advance in a leaf cgroup.
        root_max_before = local_counter(root, "memory", "max")
        root_oom_before = local_counter(root, "memory", "oom")
        root_oom_kill_before = local_counter(root, "memory", "oom_kill")
        child_max_before = [local_counter(child, "memory", "max") for child in child_groups]
        child_oom_before = [local_counter(child, "memory", "oom") for child in child_groups]
        child_oom_kill_before = [local_counter(child, "memory", "oom_kill") for child in child_groups]
        aggregate_allocation = (root_limit - root_current) + 32 * MIB
        aggregate_allocation_bounded = 32 * MIB <= aggregate_allocation <= 256 * MIB
        result["aggregate_allocation_bounded"] = aggregate_allocation_bounded
        aggregate_token = "aggregate-trigger"
        aggregate_trigger_observed = False
        if aggregate_allocation_bounded:
            atomic_text(commands[0], f"allocate:{aggregate_allocation}:{aggregate_token}\n")
            aggregate_trigger_observed = wait_for_text(
                ready[0],
                lambda text: text in {
                    f"allocating:{aggregate_allocation}:{aggregate_token}",
                    f"allocated:{aggregate_allocation}:{aggregate_token}",
                },
                3.0,
            )
        result["aggregate_trigger_observed"] = aggregate_trigger_observed
        deadline = time.monotonic() + 10.0
        while aggregate_trigger_observed and time.monotonic() < deadline:
            if local_counter(root, "memory", "max") > root_max_before and any(
                process.poll() is not None for process in initial_workers
            ):
                break
            time.sleep(0.05)
        root_max_advanced = local_counter(root, "memory", "max") > root_max_before
        root_oom_advanced = local_counter(root, "memory", "oom") > root_oom_before
        root_oom_kill_observed = local_counter(root, "memory", "oom_kill") > root_oom_kill_before
        child_max_after = [local_counter(child, "memory", "max") for child in child_groups]
        child_oom_after = [local_counter(child, "memory", "oom") for child in child_groups]
        child_oom_kill_after = [local_counter(child, "memory", "oom_kill") for child in child_groups]
        aggregate_worker_killed = any(process.poll() is not None for process in initial_workers)
        result["aggregate_root_max_advanced"] = root_max_advanced
        result["aggregate_root_oom_advanced"] = root_oom_advanced
        result["aggregate_root_oom_kill_observed"] = root_oom_kill_observed
        result["aggregate_child_constraints_unchanged"] = (
            child_max_after == child_max_before and child_oom_after == child_oom_before
        )
        result["aggregate_leaf_victim_oom_kill_observed"] = child_oom_kill_after != child_oom_kill_before
        result["aggregate_worker_killed"] = aggregate_worker_killed
        aggregate_swap_zero = (
            int(read_scalar(root / "memory.swap.current")) == 0
            and all(int(read_scalar(child / "memory.swap.current")) == 0 for child in child_groups)
        )
        result["aggregate_swap_zero"] = aggregate_swap_zero
        result["aggregate_memory_enforced"] = (
            memory_headroom
            and pre_pressure_swap_zero
            and aggregate_allocation_bounded
            and aggregate_trigger_observed
            and root_max_advanced
            and root_oom_advanced
            and child_max_after == child_max_before
            and child_oom_after == child_oom_before
            and aggregate_worker_killed
            and aggregate_swap_zero
            and int(read_scalar(root / "memory.current")) <= root_limit
        )

        # End the aggregate phase completely, then use two fresh workers. One
        # crosses only helper-a's lower limit while helper-b must survive. This
        # makes child attribution independent of which aggregate victim was
        # selected and proves sibling isolation.
        for process in initial_workers:
            if process.poll() is None:
                process.kill()
        for process in initial_workers:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            if int(read_scalar(root / "pids.current")) <= 1 and all(
                int(read_scalar(child / "memory.current")) < 16 * MIB for child in child_groups
            ):
                break
            time.sleep(0.05)
        memory_interphase_cleanup = (
            int(read_scalar(root / "pids.current")) <= 1
            and all(int(read_scalar(child / "memory.current")) < 16 * MIB for child in child_groups)
        )
        result["memory_interphase_cleanup"] = memory_interphase_cleanup

        # Lower the fresh-phase child limits so helper-a can cross its own cap
        # with ample aggregate headroom while helper-b remains alive.
        per_child_phase_max = 96 * MIB
        for child in child_groups:
            (child / "memory.max").write_text(str(per_child_phase_max), encoding="ascii")
        per_child_phase_descriptors = all(
            read_scalar(child / "memory.max") == str(per_child_phase_max) for child in child_groups
        )
        result["per_child_phase_descriptors"] = per_child_phase_descriptors

        fresh_workers = [start_worker(index) for index in range(2)]
        fresh_ready = all(wait_for_text(path, lambda text: text == "ready") for path in ready)
        fresh_child_current = int(read_scalar(child_groups[0] / "memory.current"))
        fresh_root_current = int(read_scalar(root / "memory.current"))
        child_headroom = per_child_phase_max - fresh_child_current
        root_headroom = root_limit - fresh_root_current
        per_child_allocation = child_headroom + 32 * MIB
        per_child_allocation_bounded = (
            child_headroom > 32 * MIB
            and root_headroom > 64 * MIB
            and per_child_allocation <= root_headroom - 32 * MIB
        )
        result["per_child_allocation_bounded"] = per_child_allocation_bounded
        child_max_before = local_counter(child_groups[0], "memory", "max")
        child_oom_before = local_counter(child_groups[0], "memory", "oom")
        child_oom_kill_before = local_counter(child_groups[0], "memory", "oom_kill")
        sibling_max_before = local_counter(child_groups[1], "memory", "max")
        sibling_oom_before = local_counter(child_groups[1], "memory", "oom")
        sibling_oom_kill_before = local_counter(child_groups[1], "memory", "oom_kill")
        root_max_before = local_counter(root, "memory", "max")
        root_oom_before = local_counter(root, "memory", "oom")
        root_oom_kill_before = local_counter(root, "memory", "oom_kill")
        fresh_prepressure = (
            memory_interphase_cleanup
            and per_child_phase_descriptors
            and fresh_ready
            and all(process.poll() is None for process in fresh_workers)
            and fresh_child_current < per_child_phase_max
            and fresh_root_current < root_limit
            and per_child_allocation_bounded
        )
        result["per_child_fresh_prepressure_bounded"] = fresh_prepressure
        per_child_token = "child-trigger"
        per_child_trigger_observed = False
        if fresh_prepressure:
            atomic_text(commands[0], f"allocate:{per_child_allocation}:{per_child_token}\n")
            per_child_trigger_observed = wait_for_text(
                ready[0],
                lambda text: text in {
                    f"allocating:{per_child_allocation}:{per_child_token}",
                    f"allocated:{per_child_allocation}:{per_child_token}",
                },
                3.0,
            )
            deadline = time.monotonic() + 10.0
            while per_child_trigger_observed and fresh_workers[0].poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
        result["per_child_trigger_observed"] = per_child_trigger_observed

        per_child_victim_killed = fresh_prepressure and per_child_trigger_observed and fresh_workers[0].poll() is not None
        per_child_sibling_survived = fresh_prepressure and fresh_workers[1].poll() is None
        victim_max_advanced = local_counter(child_groups[0], "memory", "max") > child_max_before
        victim_oom_advanced = local_counter(child_groups[0], "memory", "oom") > child_oom_before
        victim_oom_kill_advanced = local_counter(child_groups[0], "memory", "oom_kill") > child_oom_kill_before
        sibling_constraints_unchanged = (
            local_counter(child_groups[1], "memory", "max") == sibling_max_before
            and local_counter(child_groups[1], "memory", "oom") == sibling_oom_before
            and local_counter(child_groups[1], "memory", "oom_kill") == sibling_oom_kill_before
        )
        root_constraints_unchanged = (
            local_counter(root, "memory", "max") == root_max_before
            and local_counter(root, "memory", "oom") == root_oom_before
            and local_counter(root, "memory", "oom_kill") == root_oom_kill_before
        )
        sibling_responsive = per_child_sibling_survived and command_worker(
            commands[1], ready[1], "burn:0.1", "burned:", 3.0
        )
        result["per_child_victim_killed"] = per_child_victim_killed
        result["per_child_sibling_survived"] = per_child_sibling_survived
        result["per_child_victim_max_advanced"] = victim_max_advanced
        result["per_child_victim_oom_advanced"] = victim_oom_advanced
        result["per_child_victim_oom_kill_advanced"] = victim_oom_kill_advanced
        result["per_child_sibling_constraints_unchanged"] = sibling_constraints_unchanged
        result["per_child_root_constraints_unchanged"] = root_constraints_unchanged
        per_child_swap_zero = (
            int(read_scalar(root / "memory.swap.current")) == 0
            and all(int(read_scalar(child / "memory.swap.current")) == 0 for child in child_groups)
        )
        result["per_child_swap_zero"] = per_child_swap_zero
        result["per_child_sibling_responsive"] = sibling_responsive
        result["per_child_memory_enforced"] = (
            fresh_prepressure
            and per_child_trigger_observed
            and per_child_victim_killed
            and per_child_sibling_survived
            and victim_max_advanced
            and victim_oom_advanced
            and victim_oom_kill_advanced
            and sibling_constraints_unchanged
            and root_constraints_unchanged
            and per_child_swap_zero
            and sibling_responsive
        )

        required = [
            "aggregate_memory_descriptor",
            "aggregate_swap_disabled",
            "aggregate_pids_descriptor",
            "aggregate_cpu_descriptor",
            "delegated_controllers",
            "per_child_descriptors",
            "aggregate_child_memory_unbounded",
            "per_child_swap_disabled",
            "multi_helper_coexistence",
            "aggregate_pids_enforced",
            "per_child_pids_enforced",
            "inter_phase_pid_cleanup",
            "per_child_cpu_enforced",
            "pre_pressure_memory_bounded",
            "pre_pressure_swap_zero",
            "aggregate_allocation_bounded",
            "aggregate_trigger_observed",
            "aggregate_root_max_advanced",
            "aggregate_root_oom_advanced",
            "aggregate_child_constraints_unchanged",
            "aggregate_swap_zero",
            "aggregate_memory_enforced",
            "memory_interphase_cleanup",
            "per_child_phase_descriptors",
            "per_child_allocation_bounded",
            "per_child_fresh_prepressure_bounded",
            "per_child_trigger_observed",
            "per_child_sibling_survived",
            "per_child_victim_max_advanced",
            "per_child_victim_oom_advanced",
            "per_child_victim_oom_kill_advanced",
            "per_child_sibling_constraints_unchanged",
            "per_child_root_constraints_unchanged",
            "per_child_sibling_responsive",
            "per_child_swap_zero",
            "per_child_memory_enforced",
        ]
        result["checks_before_cleanup"] = all(result.get(name) is True for name in required)
    except Exception as error:
        result["checks_before_cleanup"] = False
        result["error_type"] = type(error).__name__
    finally:
        for process in workers:
            if process.poll() is None:
                process.kill()
        for process in workers:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass

        child_cleanup = True
        for child in child_groups:
            deadline = time.monotonic() + 2.0
            removed = False
            while time.monotonic() < deadline:
                try:
                    if read_scalar(child / "cgroup.procs"):
                        time.sleep(0.05)
                        continue
                    child.rmdir()
                    removed = not child.exists()
                    if removed:
                        break
                except OSError:
                    time.sleep(0.05)
            if not removed:
                child_cleanup = False
        result["child_cgroups_removed"] = child_cleanup

        manager_cleanup = True
        try:
            (root / "cgroup.subtree_control").write_text("-cpu -memory -pids", encoding="ascii")
            (root / "cgroup.procs").write_text(str(os.getpid()), encoding="ascii")
            deadline = time.monotonic() + 2.0
            while manager.exists() and time.monotonic() < deadline:
                try:
                    manager.rmdir()
                except OSError:
                    time.sleep(0.05)
        except OSError:
            manager_cleanup = False
        if manager.exists():
            manager_cleanup = False
        result["manager_cgroup_removed"] = manager_cleanup
        result["pass"] = (
            result.get("checks_before_cleanup") is True
            and result["child_cgroups_removed"] is True
            and result["manager_cgroup_removed"] is True
        )
        atomic_json(result_path, result)

    return 0 if result.get("pass") is True else 1


def main() -> int:
    if len(sys.argv) < 2:
        return 64
    mode = sys.argv[1]
    if mode == "exclusive-create":
        return exclusive_create(Path(sys.argv[2]), sys.argv[3])
    if mode == "fs":
        return fs_check(*(Path(value) for value in sys.argv[2:8]))
    if mode == "hostile-tree":
        return hostile_tree(Path(sys.argv[2]))
    if mode == "chain-node":
        return chain_node(Path(sys.argv[2]), int(sys.argv[3]))
    if mode == "detached-node":
        return detached_node(Path(sys.argv[2]))
    if mode == "worker":
        return worker(Path(sys.argv[2]), Path(sys.argv[3]))
    if mode == "delegate":
        return delegated_check(Path(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5])
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
