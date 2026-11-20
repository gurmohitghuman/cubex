#!/usr/bin/env bash
# Temporary (removed before the review): runs a group of unit tests many times each, and prints each run's result
# with its loop, heap and formula lines, then how many passed. The load group runs the tests that bound the event
# loop while another process loads the disk their databases are on, then each break proof under that load: a
# break must still fail.
set -u
group=$1
LIGHT=${LIGHT_ONLY:-"loop-watch token-last-used transform-regex-pages transform-regex-worker transform-stop-busy transform-wal-slow
  wal-turn dedupe-name-keys bulk-wal-dedupe"}
n=20
case $group in
  light) tests=$LIGHT ;;
  moving) tests=column-trash-moving ;;
  pages) tests=transform-pages ;;
  follow) tests=transform-formula-follow ;;
  undo) tests=run-undo-slices; n=10 ;;
  clear) tests=run-clear-big; n=10 ;;
  load) tests=$LIGHT; n=5 ;;
  regex) tests="transform-regex-pages transform-regex-worker"; n=40 ;;
  *) echo "no group $group"; exit 2 ;;
esac
# A quick check of this script: REPEAT_N=1, and NO_LOAD=1 to leave the disk alone.
n=${REPEAT_N:-$n}
mkdir -p repeat-logs
lines='loop held|let off|kept at most|waits for the formula|OVER|^FAIL|Assertion|held: |formulas: '
one() { # test, run label: 0 when it passed
  local s=$(date +%s) r=ok status=0
  node scripts/unit-tests.mjs "$1.test" > "repeat-logs/$1-$2.log" 2>&1 || { r=FAILED; status=1; }
  echo "$1 $2: $r in $(( $(date +%s) - s ))s"
  grep -hE "$lines" "repeat-logs/$1-$2.log" | cut -c1-600 | sed 's/^/    /'
  return $status
}
if [ "$group" = load ] && [ -z "${NO_LOAD:-}" ]; then
  tmp=$(node -p "require('os').tmpdir()")
  node .github/ci-temp/disk-load.mjs "$tmp" > repeat-logs/disk-load.log 2>&1 &
  load=$!
  sleep 5
fi
failed=0
for t in $tests; do
  pass=0
  for i in $(seq 1 $n); do one "$t" "run$i" && pass=$((pass + 1)); done
  echo "== $t: $pass of $n passed"
  [ "$pass" = "$n" ] || failed=1
done
if [ "$group" = regex ]; then
  # A small commit's time while the checkpoint worker copies a big WAL back, against none running.
  for i in 1 2 3; do
    d=$(mktemp -d)
    DB_PATH=$d/t.db TMPDIR=$d npx tsx tests/unit/temp-commit-in-checkpoint.ts 2>&1 | grep '^round'
    rm -rf "$d"
  done
fi
if [ "$group" = load ]; then
  # Each break, its test under the load: it must fail.
  for b in token:token-last-used stopbusy:transform-stop-busy walturn:wal-turn regex:transform-regex-worker \
    regex:transform-regex-pages walslow:transform-wal-slow mainthread:bulk-wal-dedupe; do
    file=$(node .github/ci-temp/break.mjs "${b%%:*}")
    if one "${b#*:}" "break-${b%%:*}"; then echo "== break ${b%%:*}: ${b#*:} PASSED (it must fail)"; failed=1
    else echo "== break ${b%%:*}: ${b#*:} failed, as it must"; fi
    git checkout -- "$file"
  done
  [ -z "${NO_LOAD:-}" ] && { kill "$load"; tail -5 repeat-logs/disk-load.log; }
fi
exit $failed
