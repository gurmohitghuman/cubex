#!/usr/bin/env bash
#
# e2e-harness.sh - one-command Playwright E2E run.
#
# Boots the PRODUCTION build against a throwaway data directory
# (server/data/e2e/), runs first-time setup to set the account password, runs
# the specs, and tears everything down. The real server/data/cubex.db is NEVER
# touched: the test DB lives in its own directory, so even the secrets the
# server generates on first boot (.jwt-secret, .encryption-key) land there.
#
# Usage:
#   scripts/e2e-harness.sh                 # build + run the data-consistency suite
#   E2E_SPEC=tests/e2e scripts/e2e-harness.sh   # the whole suite
#   scripts/e2e-harness.sh --no-build      # skip the build (use existing dist/)
#   scripts/e2e-harness.sh -g "H3"         # pass-through Playwright args (grep, --headed, ...)
#
# Env overrides: E2E_PORT (default 3099), E2E_SPEC (default the data-consistency
# specs; a Playwright path filter or a concrete .spec.ts path).
#
# NOTE: written for macOS's stock bash 3.2 (empty-array expansion is guarded).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${E2E_PORT:-3099}"
SPEC="${E2E_SPEC:-data-consistency}"
TEST_DIR="$ROOT/server/data/e2e"
TEST_DB="$TEST_DIR/cubex-e2e.db"
TEST_PASSWORD="password123" # keep in sync with TEST_PASSWORD in tests/e2e/helpers.ts
DO_BUILD=1
PW_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    *) PW_ARGS+=("$arg") ;;
  esac
done

# Safety: the test data must live in its own directory, never next to cubex.db.
case "$TEST_DIR" in
  */server/data/e2e) ;;
  *) echo "[x] refusing: unexpected TEST_DIR $TEST_DIR"; exit 1 ;;
esac

case "$SPEC" in
  *.spec.ts)
    [ -f "$SPEC" ] || { echo "[x] spec not found: $SPEC"; exit 1; }
    ;;
esac

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  # Give the writer a moment to release the files, then remove the test data dir.
  sleep 0.5
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

if [ "$DO_BUILD" -eq 1 ]; then
  echo "[build] client + server ..."
  npm run build >/tmp/cubex-e2e-build.log 2>&1 || { echo "[x] build failed:"; tail -20 /tmp/cubex-e2e-build.log; exit 1; }
fi
[ -f "$ROOT/server/dist/index.js" ]    || { echo "[x] server/dist missing - run without --no-build"; exit 1; }
[ -f "$ROOT/client/dist/index.html" ]  || { echo "[x] client/dist missing - run without --no-build"; exit 1; }

rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

export DB_PATH="$TEST_DB"
export JOBS_DB_PATH="$TEST_DIR/jobs-e2e.db"
# Empty, so a server/.env can't supply them: the server generates both on first
# boot inside TEST_DIR, which exercises that path on every run.
export JWT_SECRET=""
export APP_ENCRYPTION_KEY=""
# Webhook URLs come back absolute, so specs can POST to them directly.
export PUBLIC_URL="http://localhost:$PORT"
# Specs sign in (and deliberately fail sign-ins) far more often than a person
# does; lift the instance-wide failed-attempt budget for the harness only.
export LOGIN_RATE_MAX="${LOGIN_RATE_MAX:-100000}"
# Enables the transfer_rows / transform_column MCP tools so their specs run.
export MCP_EFFICIENT_ROWS_ENABLED="${MCP_EFFICIENT_ROWS_ENABLED:-1}"

echo "[boot] prod server on :$PORT (data: server/data/e2e) ..."
NODE_ENV=production PORT="$PORT" node server/dist/index.js >/tmp/cubex-e2e-server.log 2>&1 &
SERVER_PID=$!

echo -n "[wait] server"
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null; then echo " - up"; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo " - DIED:"; tail -20 /tmp/cubex-e2e-server.log; exit 1
  fi
  echo -n "."; sleep 0.5
done
curl -fsS -o /dev/null "http://localhost:$PORT/api/health" || { echo "[x] server never became ready"; tail -20 /tmp/cubex-e2e-server.log; exit 1; }

echo "[setup] first-time password ..."
SETUP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' \
  -d "{\"password\":\"$TEST_PASSWORD\"}" "http://localhost:$PORT/api/auth/setup")
[ "$SETUP_STATUS" = "200" ] || { echo "[x] setup failed: HTTP $SETUP_STATUS"; tail -20 /tmp/cubex-e2e-server.log; exit 1; }

echo "[test] $SPEC ..."
set +e
# Guard the array expansion: stock bash 3.2 errors on "${arr[@]}" when arr is
# empty under `set -u`. The ${arr[@]+...} form expands to nothing when unset.
E2E_BASE="http://localhost:$PORT" npx playwright test "$SPEC" --reporter=list ${PW_ARGS[@]+"${PW_ARGS[@]}"}
RC=$?
set -e

echo "[done] exit $RC - tearing down server + test data"
exit $RC
