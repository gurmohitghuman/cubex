#!/bin/sh
# Runs `cubex update` for Settings' "Update now" (server/src/lib/self-update.ts), started where Cubex's service
# won't stop it: the update stops Cubex first. Copied to the install folder before it starts, so the update moving
# the app folder can't touch it. It holds update.lock with its pid while it runs, writes the update's output to
# update.log and, once it ends, update-status.json: the update's exit code and the versions it went from and to.
# Usage: cubex-update-run.sh <install folder> <from> <to>
home="$1" from="$2" to="$3"
cd "$home" || exit 1
echo "$$" > "$home/update.lock"
"$home/app/bin/cubex" update > "$home/update.log" 2>&1 < /dev/null
code=$?
printf '{"code":%d,"from":"%s","to":"%s","ended_at":"%s"}\n' "$code" "$from" "$to" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$home/update-status.json.next"
mv -f "$home/update-status.json.next" "$home/update-status.json"
rm -f "$home/update.lock"
