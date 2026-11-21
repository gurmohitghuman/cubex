#!/usr/bin/env bash
# Temporary (removed before the review): runs a group of unit tests many times each, printing each run's result
# with its loop lines, then how many passed. The regex group takes transform-regex-pages and the loop watch from the
# branch of the tests that fail now and then (its test waits for the WAL to be copied back after its biggest call),
# so the run shows this change with that test as both will be on main.
set -u
group=$1
case $group in
  regex)
    git fetch -q --depth=1 origin test/ci-green-unit
    git checkout FETCH_HEAD -- tests/unit/transform-regex-pages.test.ts tests/unit/loop-watch.ts \
      tests/unit/loop-watch-disk.ts
    git log -1 --format='test files from %h %s' FETCH_HEAD
    runs="transform-regex-pages:40" ;;
  wal) runs="wal-turn-late:20 wal-checkpoint-waits:10 wal-turn:10" ;;
  *) echo "no group $group"; exit 2 ;;
esac
mkdir -p repeat-logs
lines='loop held|in it:|began after|answered after|^FAIL|Assertion|calls, '
failed=0
for r in $runs; do
  t=${r%%:*} n=${r#*:} pass=0
  for i in $(seq 1 "$n"); do
    s=$(date +%s) res=ok
    node scripts/unit-tests.mjs "$t.test" > "repeat-logs/$t-run$i.log" 2>&1 && pass=$((pass + 1)) || res=FAILED
    echo "$t run$i: $res in $(( $(date +%s) - s ))s"
    grep -hE "$lines" "repeat-logs/$t-run$i.log" | cut -c1-600 | sed 's/^/    /'
  done
  echo "== $t: $pass of $n passed"
  [ "$pass" = "$n" ] || failed=1
done
exit $failed
