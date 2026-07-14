#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if [ "${1:-}" = "--dry-run" ]; then
  printf '%s\n' '[dry-run] Would verify Linux/macOS, Node >=22.19, npm, Git, Make, and native build prerequisites.'
  printf '%s\n' '[dry-run] Would run npm ci in backend/, frontend/, and e2e/.'
  printf '%s\n' '[dry-run] Would build backend and frontend, run the configuration wizard, doctor, and an isolated health smoke test.'
  node scripts/configure.mjs --dry-run
  node scripts/smoke.mjs --dry-run
  exit 0
fi
if [ "$#" -ne 0 ]; then
  printf '%s\n' 'Usage: scripts/bootstrap.sh [--dry-run]' >&2
  exit 2
fi

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) printf '%s\n' 'Wayang v0.1 supports Linux and macOS.' >&2; exit 1 ;;
esac

for command in node npm git make; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  fi
done

if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22||(major===22&&minor>=19)?0:1)'; then
  printf '%s\n' 'Node >=22.19.0 is required.' >&2
  exit 1
fi

printf 'Bootstrapping Wayang on %s/%s with Node %s\n' "$(uname -s)" "$(uname -m)" "$(node --version)"
printf '%s\n' 'If better-sqlite3 needs a source build, install Python 3 and C/C++ build tools first.'
if [ "$(uname -s)" = "Darwin" ]; then
  printf '%s\n' 'macOS guidance: install the Xcode Command Line Tools with: xcode-select --install'
else
  printf '%s\n' 'Linux guidance: use your distribution package manager to install Python 3, make, and a C/C++ compiler.'
fi
printf '%s\n' 'The bootstrap never runs sudo or a system package manager.'

node scripts/doctor.mjs
npm --prefix backend ci --include=dev
npm --prefix frontend ci --include=dev
npm --prefix e2e ci --include=dev
npm --prefix backend run build
npm --prefix frontend run build
node scripts/configure.mjs
node scripts/doctor.mjs
node scripts/smoke.mjs

printf '%s\n' 'Bootstrap complete. Start Wayang in the foreground with: make start'
