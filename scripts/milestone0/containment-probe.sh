#!/usr/bin/env bash
# Synthetic-only Milestone 0 containment probe.
# No sudo, network I/O, project enumeration, general environment inspection,
# real user/application data, credentials, PIN, Finance data, or browser state.
set -u -o pipefail

MODE=${1:-}
case "$MODE" in
  --nested|--host) ;;
  *) printf 'usage: containment-probe.sh --nested|--host\n' >&2; exit 64 ;;
esac

PATH=/usr/bin:/bin
export PATH
unset CDPATH ENV BASH_ENV GLOBIGNORE
umask 077

PASS_COUNT=0
FAIL_COUNT=0
SCOPE_UNITS=()
SYNTH_ROOTS=()
IDENTITY_DIRS=()
WORK_ROOT=
HELPER_COPY=
EXPECTED_RUNTIME=

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL %s\n' "$1"; }

identity_alive() {
  local identity=$1 pid start current
  pid=${identity%%:*}
  start=${identity#*:}
  [[ "$pid" =~ ^[0-9]+$ && "$start" =~ ^[0-9]+$ && -r /proc/$pid/stat ]] || return 1
  current=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null) || return 1
  [[ "$current" == "$start" ]]
}

kill_recorded_identities() {
  local directory record identity pid
  shopt -s nullglob
  for directory in "${IDENTITY_DIRS[@]}"; do
    [[ -d "$directory" ]] || continue
    for record in "$directory"/identity-*; do
      identity=$(<"$record")
      if identity_alive "$identity"; then
        pid=${identity%%:*}
        kill -KILL "$pid" >/dev/null 2>&1 || true
      fi
    done
  done
  shopt -u nullglob
}

cleanup() {
  local unit root
  for unit in "${SCOPE_UNITS[@]}"; do
    /usr/bin/timeout 5s systemctl --user stop "$unit" >/dev/null 2>&1 || true
    /usr/bin/timeout 5s systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  done
  kill_recorded_identities
  sleep 0.1
  kill_recorded_identities
  for root in "${SYNTH_ROOTS[@]}"; do
    if [[ "$root" == /tmp/finance-m0-host.* || "$root" == /run/user/[0-9]*/finance-m0-runtime.* ]]; then
      rm -rf -- "$root"
    fi
  done
  if [[ -n "$WORK_ROOT" && ( "$WORK_ROOT" == /tmp/finance-m0.* || "$WORK_ROOT" == /run/user/[0-9]*/finance-m0.* ) ]]; then
    rm -rf -- "$WORK_ROOT"
  fi
}

on_signal() {
  trap - HUP INT TERM
  exit 130
}
trap cleanup EXIT
trap on_signal HUP INT TERM

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || exit 1
source_helper=$script_dir/synthetic_containment_helper.py
if [[ ! -f "$source_helper" ]]; then
  printf 'FAIL synthetic-helper-present\n'
  exit 1
fi

if [[ "$MODE" == --host ]]; then
  EXPECTED_RUNTIME=/run/user/$(id -u)
  if [[ ${M0_HOST_CONFIRM:-} != synthetic-only ]]; then
    printf 'NO-GO host confirmation missing; use the documented env -i command\n'
    exit 2
  fi
  if [[ ${XDG_RUNTIME_DIR:-} != "$EXPECTED_RUNTIME" || ! -d "$EXPECTED_RUNTIME" || ! -O "$EXPECTED_RUNTIME" ]]; then
    printf 'NO-GO trusted user runtime directory unavailable\n'
    exit 2
  fi
  WORK_ROOT=$(mktemp -d "$EXPECTED_RUNTIME/finance-m0.XXXXXX") || exit 1
else
  WORK_ROOT=$(mktemp -d /tmp/finance-m0.XXXXXX) || exit 1
fi
HELPER_COPY=$WORK_ROOT/helper.py
cp -- "$source_helper" "$HELPER_COPY" || exit 1
chmod 0700 "$HELPER_COPY"

wait_for_file() {
  local path=$1 attempts=${2:-100}
  while (( attempts > 0 )); do
    [[ -s "$path" ]] && return 0
    sleep 0.05
    attempts=$((attempts - 1))
  done
  return 1
}

wait_for_hostile_identities() {
  local directory=$1
  wait_for_file "$directory/identity-leader" 160 &&
    wait_for_file "$directory/identity-chain-1" 160 &&
    wait_for_file "$directory/identity-chain-2" 160 &&
    wait_for_file "$directory/identity-setsid" 160 &&
    wait_for_file "$directory/identity-double-fork" 160
}

wait_identities_gone() {
  local directory=$1 deadline=$((SECONDS + 6)) record identity alive
  while (( SECONDS <= deadline )); do
    alive=0
    shopt -s nullglob
    for record in "$directory"/identity-*; do
      identity=$(<"$record")
      if identity_alive "$identity"; then alive=1; fi
    done
    shopt -u nullglob
    (( alive == 0 )) && return 0
    sleep 0.1
  done
  return 1
}

json_true() {
  /usr/bin/python3 - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
raise SystemExit(0 if value.get(sys.argv[2]) is True else 1)
PY
}

json_string() {
  /usr/bin/python3 - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream).get(sys.argv[2])
if not isinstance(value, str) or "\n" in value:
    raise SystemExit(1)
print(value)
PY
}

json_boolean_diagnostics() {
  local file=$1 label=$2
  shift 2
  /usr/bin/python3 - "$file" "$label" "$@" <<'PY'
import json, pathlib, re, sys
path, label, *keys = sys.argv[1:]
try:
    value = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
except Exception:
    print(f"DIAG {label} result=missing-or-invalid")
    raise SystemExit(0)
parts = []
for key in keys:
    item = value.get(key)
    parts.append(f"{key}={'true' if item is True else 'false' if item is False else 'missing'}")
error_type = value.get("error_type")
if isinstance(error_type, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", error_type):
    parts.append(f"error_type={error_type}")
print(f"DIAG {label} " + " ".join(parts))
PY
}

json_processes_gone() {
  /usr/bin/python3 - "$1" <<'PY'
import json, pathlib, sys, time
with open(sys.argv[1], encoding="utf-8") as stream:
    identities = json.load(stream).get("process_identities", [])
if not isinstance(identities, list) or not identities or not all(isinstance(value, str) for value in identities):
    raise SystemExit(1)
def alive(identity):
    try:
        pid_text, start = identity.split(":", 1)
        fields = pathlib.Path(f"/proc/{int(pid_text)}/stat").read_text(encoding="ascii").split()
        return fields[21] == start
    except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
        return False
deadline = time.monotonic() + 6
while time.monotonic() < deadline:
    if not any(alive(identity) for identity in identities):
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(1)
PY
}

wait_unit_collected() {
  local unit=$1 deadline=$((SECONDS + 7)) state
  while (( SECONDS <= deadline )); do
    state=$(/usr/bin/timeout 2s systemctl --user show "$unit" -p LoadState --value 2>/dev/null || true)
    [[ "$state" == not-found ]] && return 0
    sleep 0.1
  done
  return 1
}

wait_control_group() {
  local unit=$1 deadline=$((SECONDS + 7)) value
  while (( SECONDS <= deadline )); do
    value=$(/usr/bin/timeout 2s systemctl --user show "$unit" -p ControlGroup --value 2>/dev/null || true)
    if [[ "$value" == /* && "$value" != *..* && "$value" == */"$unit" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

cgroup_matches_unit() {
  local relative=$1 unit=$2
  [[ "$relative" == /* && "$relative" != *..* && "$relative" == */"$unit" ]]
}

wait_cgroup_gone() {
  local relative=$1 deadline=$((SECONDS + 7))
  [[ "$relative" == /* && "$relative" != *..* ]] || return 1
  while (( SECONDS <= deadline )); do
    [[ ! -e /sys/fs/cgroup${relative} ]] && return 0
    sleep 0.1
  done
  return 1
}

wait_runner() {
  local pid=$1 seconds=$2 deadline
  deadline=$((SECONDS + seconds))
  while kill -0 "$pid" >/dev/null 2>&1; do
    if (( SECONDS > deadline )); then
      kill -KILL "$pid" >/dev/null 2>&1 || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.1
  done
  wait "$pid"
}

run_nested_teardown_fixture() {
  local status=$WORK_ROOT/nested-hostile leader escaped_one escaped_two
  mkdir "$status"
  IDENTITY_DIRS+=("$status")
  setsid /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent \
    /usr/bin/python3 "$HELPER_COPY" hostile-tree "$status" >/dev/null 2>&1 &
  leader=$!
  if ! wait_for_hostile_identities "$status"; then
    fail nested-hostile-fixture-started
    kill_recorded_identities
    return
  fi
  pass nested-hostile-fixture-started

  kill -TERM -- "-$leader" >/dev/null 2>&1 || true
  sleep 0.2
  kill -KILL -- "-$leader" >/dev/null 2>&1 || true
  wait "$leader" 2>/dev/null || true
  escaped_one=$(<"$status/identity-setsid")
  escaped_two=$(<"$status/identity-double-fork")
  if identity_alive "$escaped_one" && identity_alive "$escaped_two"; then
    pass nested-escaped-descendants-outlive-process-group
  else
    fail nested-escaped-descendants-outlive-process-group
  fi

  kill_recorded_identities
  if wait_identities_gone "$status"; then pass nested-exact-fixture-cleanup; else fail nested-exact-fixture-cleanup; fi
}

run_filesystem_service() {
  local workspace=$WORK_ROOT/workspace denied=$WORK_ROOT/denied synthetic_home=$WORK_ROOT/home
  local sibling=$WORK_ROOT/sibling runtime_canary host_tmp_root host_marker
  local unit=finance-m0-fs-$$.service result=$WORK_ROOT/workspace/fs-result.json rc=0 relative
  mkdir "$workspace" "$denied" "$synthetic_home" "$sibling"
  printf 'synthetic-denied\n' >"$denied/marker"
  printf 'synthetic-home\n' >"$synthetic_home/marker"

  runtime_canary=$(mktemp -d "$EXPECTED_RUNTIME/finance-m0-runtime.XXXXXX") || { fail filesystem-path-controls; return; }
  host_tmp_root=$(mktemp -d /tmp/finance-m0-host.XXXXXX) || { fail filesystem-path-controls; return; }
  SYNTH_ROOTS+=("$runtime_canary" "$host_tmp_root")
  host_marker=$host_tmp_root/marker
  if ! /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent \
      /usr/bin/python3 "$HELPER_COPY" exclusive-create "$host_marker" 'synthetic-host-temp'; then
    fail filesystem-path-controls
    return
  fi
  [[ -f "$host_marker" && ! -L "$host_marker" && -O "$host_marker" ]] || { fail filesystem-path-controls; return; }

  SCOPE_UNITS+=("$unit")
  if ! /usr/bin/timeout 20s systemd-run --user --quiet --wait --collect --service-type=exec --unit="$unit" \
      -p ProtectSystem=strict -p ProtectHome=no -p PrivateTmp=yes \
      -p NoNewPrivileges=yes -p RestrictSUIDSGID=yes \
      -p "ReadOnlyPaths=$EXPECTED_RUNTIME $synthetic_home $sibling" -p "ReadWritePaths=$workspace" \
      -p "InaccessiblePaths=/home /root $denied" \
      /usr/bin/env -i PATH=/usr/bin:/bin HOME="$synthetic_home" \
      /usr/bin/python3 "$HELPER_COPY" fs "$workspace" "$denied/marker" "$synthetic_home" \
      "$host_marker" "$sibling" "$runtime_canary"; then
    rc=1
  fi

  if (( rc == 0 )) && [[ -s "$result" ]] && json_true "$result" pass \
      && [[ -f "$workspace/workspace-write" ]] \
      && [[ ! -e "$synthetic_home/must-not-write" && ! -e "$sibling/must-not-write" ]] \
      && [[ ! -e "$runtime_canary/must-not-write" ]] \
      && [[ -f "$host_marker" && ! -L "$host_marker" && -O "$host_marker" ]] \
      && [[ $(<"$host_marker") == synthetic-host-temp ]]; then
    pass filesystem-path-controls
  else
    fail filesystem-path-controls
    json_boolean_diagnostics "$result" filesystem \
      pass denied_marker_hidden host_tmp_marker_hidden workspace_writable \
      synthetic_home_read_only work_sibling_read_only runtime_canary_read_only private_tmp_writable
  fi

  relative=$(json_string "$result" cgroup_relative 2>/dev/null || true)
  if cgroup_matches_unit "$relative" "$unit" \
      && json_processes_gone "$result" \
      && wait_unit_collected "$unit" \
      && wait_cgroup_gone "$relative"; then
    pass filesystem-service-residue-free
  else
    fail filesystem-service-residue-free
  fi
}

run_delegated_scope() {
  local result=$WORK_ROOT/delegation-result.json unit=finance-m0-delegate-$$.service
  local memory_max=$((192 * 1024 * 1024)) runner relative= control= rc=0
  SCOPE_UNITS+=("$unit")
  systemd-run --user --quiet --wait --collect --service-type=exec --unit="$unit" \
      -p Delegate=yes -p MemoryAccounting=yes -p MemoryMax=192M -p MemorySwapMax=0 \
      -p TasksAccounting=yes -p TasksMax=32 \
      -p CPUQuota=50% \
      /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent \
      /usr/bin/python3 "$HELPER_COPY" delegate "$result" "$memory_max" 32 '50000 100000' &
  runner=$!
  control=$(wait_control_group "$unit" || true)
  wait_runner "$runner" 45 || rc=$?

  if (( rc == 0 )) && [[ -s "$result" ]] && json_true "$result" pass; then
    pass delegated-resource-enforcement
  else
    fail delegated-resource-enforcement
    json_boolean_diagnostics "$result" delegated \
      pass aggregate_memory_descriptor aggregate_swap_disabled aggregate_pids_descriptor aggregate_cpu_descriptor \
      delegated_controllers per_child_descriptors aggregate_child_memory_unbounded per_child_swap_disabled multi_helper_coexistence \
      aggregate_pids_enforced per_child_pids_enforced inter_phase_pid_cleanup \
      per_child_cpu_enforced pre_pressure_memory_bounded pre_pressure_swap_zero aggregate_allocation_bounded aggregate_trigger_observed \
      aggregate_root_max_advanced aggregate_root_oom_advanced aggregate_root_oom_kill_observed \
      aggregate_child_constraints_unchanged aggregate_leaf_victim_oom_kill_observed aggregate_worker_killed \
      aggregate_swap_zero aggregate_memory_enforced \
      memory_interphase_cleanup per_child_phase_descriptors per_child_allocation_bounded \
      per_child_fresh_prepressure_bounded per_child_trigger_observed per_child_victim_killed per_child_sibling_survived \
      per_child_victim_max_advanced per_child_victim_oom_advanced per_child_victim_oom_kill_advanced \
      per_child_sibling_constraints_unchanged per_child_root_constraints_unchanged per_child_swap_zero \
      per_child_sibling_responsive per_child_memory_enforced child_cgroups_removed manager_cgroup_removed
  fi
  relative=$(json_string "$result" cgroup_relative 2>/dev/null || true)
  [[ -n "$relative" ]] || relative=$control
  if [[ -n "$control" && "$relative" == "$control" ]] \
      && cgroup_matches_unit "$relative" "$unit" \
      && json_processes_gone "$result" \
      && wait_cgroup_gone "$relative" \
      && wait_unit_collected "$unit"; then
    pass delegated-scope-residue-free
  else
    fail delegated-scope-residue-free
  fi
}

run_scope_teardown() {
  local status=$WORK_ROOT/scope-hostile unit=finance-m0-tree-$$.service runner control= rc=0
  mkdir "$status"
  IDENTITY_DIRS+=("$status")
  SCOPE_UNITS+=("$unit")
  systemd-run --user --quiet --wait --collect --service-type=exec --unit="$unit" \
    -p TimeoutStopSec=2s -p KillMode=control-group \
    /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent \
    /usr/bin/python3 "$HELPER_COPY" hostile-tree "$status" >/dev/null 2>&1 &
  runner=$!
  control=$(wait_control_group "$unit" || true)
  if ! wait_for_hostile_identities "$status"; then
    fail systemd-hostile-scope-started
    /usr/bin/timeout 5s systemctl --user stop "$unit" >/dev/null 2>&1 || true
    wait_runner "$runner" 8 >/dev/null 2>&1 || true
    return
  fi
  pass systemd-hostile-scope-started

  if /usr/bin/timeout 7s systemctl --user stop "$unit" >/dev/null 2>&1; then
    pass systemd-hostile-scope-stop
  else
    fail systemd-hostile-scope-stop
  fi
  wait_runner "$runner" 8 >/dev/null 2>&1 || rc=$?
  if (( rc != 124 )) && wait_identities_gone "$status"; then
    pass full-hostile-tree-teardown
  else
    fail full-hostile-tree-teardown
  fi
  if [[ -n "$control" ]] && wait_cgroup_gone "$control" && wait_unit_collected "$unit"; then
    pass teardown-scope-residue-free
  else
    fail teardown-scope-residue-free
  fi
}

if [[ "$MODE" == --nested ]]; then
  run_nested_teardown_fixture
  printf 'SUMMARY pass=%d fail=%d decision=NESTED-ONLY-NO-HOST-DECISION\n' "$PASS_COUNT" "$FAIL_COUNT"
  (( FAIL_COUNT == 0 )) || exit 1
  exit 3
fi

if [[ $(uname -s) != Linux || ! -r /sys/fs/cgroup/cgroup.controllers ]]; then
  printf 'NO-GO unified cgroup v2 unavailable\n'
  exit 2
fi
pass prerequisite-cgroup-v2
for command in python3 systemctl systemd-run timeout; do
  if command -v "$command" >/dev/null 2>&1; then pass "prerequisite-$command"; else fail "prerequisite-$command"; fi
done
if (( FAIL_COUNT == 0 )); then
  run_filesystem_service
  run_delegated_scope
  run_scope_teardown
fi

if (( FAIL_COUNT == 0 )); then
  printf 'SUMMARY pass=%d fail=0 decision=GO-TESTED-PRIMITIVES\n' "$PASS_COUNT"
  exit 0
fi
printf 'SUMMARY pass=%d fail=%d decision=NO-GO\n' "$PASS_COUNT" "$FAIL_COUNT"
exit 1
