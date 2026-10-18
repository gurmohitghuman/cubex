#!/usr/bin/env bash
#
# e2e-parallel.sh - the whole e2e suite in N parts at once (default 3).
#
# Builds once, then starts N harnesses (scripts/e2e-harness.sh), each with its
# own server, mock treg, ports and data dir (server/data/e2e-<n>), each running
# its share of the spec files (Playwright --shard). Specs still run one at a
# time inside a part, since they share that part's one account. Uses about N
# times the CPU and memory of one run for a fraction of the time.
#
# Usage:
#   scripts/e2e-parallel.sh                # build + the whole suite in 3 parts
#   E2E_SHARDS=4 scripts/e2e-parallel.sh   # 4 parts
#   scripts/e2e-parallel.sh --no-build     # skip the build (use existing dist/)
#
# Env overrides: E2E_SHARDS (default 3), E2E_SPEC (default tests/e2e),
# E2E_PARALLEL_PORT (default 3300; part n uses ports base+10n .. base+10n+2).
# Each part's output goes to /tmp/cubex-e2e-part-<n>.log, printed when it fails.
#
# NOTE: written for macOS's stock bash 3.2.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SHARDS="${E2E_SHARDS:-3}"
SPEC="${E2E_SPEC:-tests/e2e}"
BASE_PORT="${E2E_PARALLEL_PORT:-3300}"
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    *) echo "[x] unknown argument: $arg (use scripts/e2e-harness.sh for Playwright args)"; exit 1 ;;
  esac
done
case "$SHARDS" in
  ''|*[!0-9]*|0) echo "[x] E2E_SHARDS must be a number from 1"; exit 1 ;;
esac

if [ "$DO_BUILD" -eq 1 ]; then
  echo "[build] client + server ..."
  npm run build >/tmp/cubex-e2e-build.log 2>&1 \
    || { echo "[x] build failed:"; tail -20 /tmp/cubex-e2e-build.log; exit 1; }
fi

PIDS=()
stop_parts() {
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null; done
}
trap 'stop_parts; exit 130' INT TERM

START=$(date +%s)
for n in $(seq 1 "$SHARDS"); do
  port=$((BASE_PORT + 10 * n))
  # Each part cleans only its own Playwright output folder.
  E2E_INSTANCE="$n" E2E_SPEC="$SPEC" E2E_PORT="$port" E2E_TREG_PORT=$((port + 1)) \
    E2E_RECEIVER_PORT=$((port + 2)) \
    scripts/e2e-harness.sh --no-build "--shard=$n/$SHARDS" "--output=test-results/part-$n" \
    >"/tmp/cubex-e2e-part-$n.log" 2>&1 &
  PIDS+=("$!")
  echo "[part $n/$SHARDS] started on :$port"
done

FAILED=0
for n in $(seq 1 "$SHARDS"); do
  wait "${PIDS[$((n - 1))]}"
  rc=$?
  log="/tmp/cubex-e2e-part-$n.log"
  # The list reporter ends with lines like "  12 passed (2.1m)" and "  1 failed".
  summary=$(grep -E '^ +[0-9]+ (passed|failed|flaky|skipped|did not run)' "$log" | tr -s ' ' | paste -sd ',' -)
  echo "[part $n/$SHARDS] exit $rc:${summary:- no summary}"
  if [ "$rc" -ne 0 ]; then
    FAILED=1
    echo "----- part $n output (last 60 lines; full: $log) -----"
    tail -60 "$log"
    echo "-----"
  fi
done

echo "[done] $(( $(date +%s) - START ))s, $([ "$FAILED" -eq 0 ] && echo 'all parts passed' || echo 'FAILED')"
exit "$FAILED"
