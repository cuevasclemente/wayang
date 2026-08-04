#!/usr/bin/env bash
# Synthetic-only combined delegated-cgroup + proxy-free FD3/FD4 proof.
# No provider code, credentials, Finance data, project enumeration, or network
# provider access. Controlled loopback listeners are isolation oracles only.
set -u -o pipefail

PATH=/usr/bin:/bin
export PATH
unset CDPATH ENV BASH_ENV GLOBIGNORE
umask 077

if [[ ${M0_COMBINED_CONFIRM:-} != synthetic-only ]]; then
  printf 'NO-GO combined host confirmation missing\n'
  exit 2
fi

uid=$(id -u)
runtime=/run/user/$uid
if [[ ${XDG_RUNTIME_DIR:-} != "$runtime" || ! -d "$runtime" || ! -O "$runtime" ]]; then
  printf 'NO-GO trusted user runtime directory unavailable\n'
  exit 2
fi
for command in cc node systemd-run systemctl python3 timeout; do
  command -v "$command" >/dev/null 2>&1 || { printf 'NO-GO combined prerequisite unavailable\n'; exit 2; }
done

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P) || exit 1
root=$(mktemp -d "$runtime/finance-m0-combined.XXXXXX") || exit 1
unit=finance-m0-combined-$$.service
log=$root/probe.log
result=$root/result.json

cleanup() {
  /usr/bin/timeout 5s systemctl --user stop "$unit" >/dev/null 2>&1 || true
  /usr/bin/timeout 5s systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  if [[ "$root" == "$runtime"/finance-m0-combined.* ]]; then rm -rf -- "$root"; fi
}
trap cleanup EXIT HUP INT TERM

shim=$root/sandbox-helper-direction
helper=$root/fixture-rpc-helper
final_seccomp=$root/final-seccomp-loader
seccomp_probe=$root/final-seccomp-probe
launcher=$root/cgroup-clone3-launcher
denied=$root/synthetic-denied-home
canary=$denied/synthetic-canary
scratch=$root/scratch
unix_socket=$root/controlled-host.sock
ready=$scratch/tree-ready
go=$scratch/tree-go
escape=$scratch/tree-escape
abstract=wayang-m0-combined-$$
mkdir "$denied"
printf 'SYNTHETIC_COMBINED_CANARY' >"$canary"

if ! /usr/bin/cc -std=c11 -O2 -static -Wall -Wextra -Werror \
    "$repo/backend/src/restricted-mcp/milestone0/sandbox-helper-direction.c" -o "$shim" >"$log" 2>&1 \
  || ! /usr/bin/cc -std=c11 -O2 -static -Wall -Wextra -Werror \
    "$repo/backend/src/restricted-mcp/milestone0/fixture-rpc-helper.c" -o "$helper" >>"$log" 2>&1 \
  || ! /usr/bin/cc -std=c11 -O2 -static -Wall -Wextra -Werror \
    "$repo/backend/src/restricted-mcp/milestone0/final-seccomp-loader.c" -o "$final_seccomp" >>"$log" 2>&1 \
  || ! /usr/bin/cc -std=c11 -O2 -static -Wall -Wextra -Werror \
    "$repo/backend/src/restricted-mcp/milestone0/final-seccomp-probe.c" -o "$seccomp_probe" >>"$log" 2>&1 \
  || ! /usr/bin/cc -std=c11 -O2 -static -Wall -Wextra -Werror \
    "$repo/backend/src/restricted-mcp/milestone0/cgroup-clone3-launcher.c" -o "$launcher" >>"$log" 2>&1; then
  printf 'NO-GO combined fixture compilation failed\n'
  exit 1
fi
chmod 0500 "$shim" "$helper" "$final_seccomp" "$seccomp_probe" "$launcher"
if ! /usr/bin/timeout 5s "$final_seccomp" "$seccomp_probe" >>"$log" 2>&1; then
  printf 'NO-GO final seccomp standalone probe failed\n'
  exit 1
fi

if ! /usr/bin/timeout 40s systemd-run --user --quiet --wait --collect --pipe \
    --service-type=exec --unit="$unit" --working-directory="$repo/backend" \
    -p Delegate=yes -p MemoryAccounting=yes -p MemoryMax=256M -p MemorySwapMax=0 \
    -p TasksAccounting=yes -p TasksMax=64 -p CPUQuota=75% \
    -p KillMode=control-group -p TimeoutStopSec=2s -p NoNewPrivileges=yes -p LimitCORE=0 -p LimitNOFILE=64 \
    -p RestrictSUIDSGID=yes \
    /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME=/nonexistent \
      WAYANG_M0_COMBINED_CONFIRM=synthetic-only \
      /usr/bin/node \
      "$repo/backend/dist/restricted-mcp/milestone0/combined-systemd-rpc-probe.js" \
      "$shim" "$helper" "$final_seccomp" "$launcher" "$root" "$scratch" "$denied" "$canary" \
      "$unix_socket" "$ready" "$go" "$escape" "$abstract" "$unit" "$result" >"$log" 2>&1; then
  diagnostic=$(grep -E '^NO-GO [a-z][a-z0-9_]{0,63}$' "$log" | tail -n 1 || true)
  printf '%s\n' "${diagnostic:-NO-GO combined topology service failed}"
  exit 1
fi

if ! /usr/bin/python3 - "$result" <<'PY'
import json, pathlib, sys
try:
    value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(1)
required = (
    "pass", "aggregateLimits", "delegatedControllers", "childLimits", "combinedResourceEnforcement",
    "atomicCloneIntoCgroup", "pidfdLifecycle", "descriptorBoundArtifacts",
    "finalSeccompDeny", "cgroupKillTeardown", "fd3Fd4", "anonymousOneWayPipes", "sandboxIsolation",
    "descendantTeardown", "cgroupResidueFree",
)
identities = value.get("identities")
identity_ok = isinstance(identities, dict) and len(identities) == 4 and all(
    isinstance(item, str) and len(item) == 64 and all(character in "0123456789abcdef" for character in item)
    for item in identities.values()
)
raise SystemExit(0 if value.get("schemaVersion") == 2 and value.get("authoritative") is False
                 and value.get("decision") == "feasible_not_authorized" and identity_ok
                 and all(value.get(key) is True for key in required) else 1)
PY
then
  printf 'NO-GO combined result invalid\n'
  exit 1
fi

for _ in $(seq 1 70); do
  state=$(/usr/bin/timeout 2s systemctl --user show "$unit" -p LoadState --value 2>/dev/null || true)
  [[ "$state" == not-found ]] && { printf 'PASS combined-systemd-cgroup-rpc-feasibility\n'; printf 'SUMMARY pass=1 fail=0 decision=FEASIBLE-NOT-AUTHORIZED\n'; exit 0; }
  sleep 0.1
done
printf 'NO-GO combined unit residue\n'
exit 1
