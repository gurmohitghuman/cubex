#!/usr/bin/env bash
# Settings' "Update now" for real, on Linux or macOS (.github/workflows/update-now.yml; plans/settings-update-now.md's
# must-pass). The commit under test is installed from its checkout with the installer, then labeled the release
# before the latest and set to follow releases, so the button offers the latest. Through the API, as the page does,
# with a session (never a token):
# 1. An update whose new version doesn't start: install.env's CUBEX_SOURCE points `cubex update` at a copy of the
#    checkout whose server exits at start. The installer must put the version before back with the data as it was,
#    and Settings must say the update failed, with what it said.
# 2. An update that comes through: CUBEX_SOURCE points `cubex update` at a newer build of the commit (a local commit
#    on top). Cubex must come back on it, the updater must have written exit code 0, and the password and a sheet
#    made before must read back as they were. Not the latest release: this commit can hold a migration that release
#    doesn't, and an older build refuses a newer database. The release's own download is checked by the installers'
#    workflows, and an update from the last release with the button before the next one is announced.
# Nothing is pushed or tagged. Usage: tests/install/update-now.sh <checkout>; CUBEX_HOME, CUBEX_BIN_DIR and
# TEST_PORT may be set (by default a new folder under the temp folder, and port 3002).
set -euo pipefail
# Not in macOS's bash 3.2: there each command substitution this needs is an assignment, which set -e stops on.
shopt -s inherit_errexit 2>/dev/null || true

SRC="$(cd "${1:?usage: update-now.sh <checkout of the commit under test>}" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cubex-update-now.XXXXXX")"
export CUBEX_HOME="${CUBEX_HOME:-$WORK/home}" CUBEX_BIN_DIR="${CUBEX_BIN_DIR:-$WORK/bin}"
TEST_PORT="${TEST_PORT:-3002}"
TEST_PASSWORD=update-now-password
RELEASE_REPO="${RELEASE_REPO:-gurmohitghuman/cubex}"
CLI="$CUBEX_BIN_DIR/cubex"
url="http://127.0.0.1:$TEST_PORT"
jar="$WORK/cookies" answer="$WORK/answer"
: > "$jar"

# What went wrong, then what the update and Cubex wrote (the last update's status and log, Cubex's log). On stderr:
# fail often runs inside a command substitution, which would keep stdout.
fail() {
  local f
  {
    echo "::error::$*"
    for f in update-status.json update.log logs/cubex.log; do
      echo "--- $f"; tail -n 60 "$CUBEX_HOME/$f" 2>/dev/null || true
    done
  } >&2
  exit 1
}
step() { echo; echo "== $*"; }
password_json() { jq -nc --arg password "$1" '{password: $password}'; }
# One request: prints the HTTP status and keeps the body in $answer. A body goes as JSON; curl options last.
send() { # METHOD PATH [JSON [curl options...]]
  local method="$1" path="$2" json="${3:-}"
  shift 2
  if [ $# -gt 0 ]; then shift; fi
  local args=(-sS -o "$answer" -w '%{http_code}' --max-time 60 -b "$jar" -c "$jar" -X "$method")
  if [ -n "$json" ]; then args+=(-H 'Content-Type: application/json; charset=utf-8' --data-binary "$json"); fi
  curl "${args[@]}" "$@" "$url$path"
}
# The answer's body when it has the expected status; otherwise stop, saying what came back.
need() { # STATUS WHAT METHOD PATH [JSON [curl options...]]
  local want="$1" what="$2" got
  shift 2
  got="$(send "$@")" || fail "$what got no answer."
  echo "$what -> $got" >&2
  [ "$got" = "$want" ] || fail "$what answered $got, expected $want. Body: $(cat "$answer")"
  cat "$answer"
}
# The sheet as the API token reads it: its name, row count and columns, then every row (values as JSON).
sheet_lines() { # SHEET_ID TOKEN
  local sheet rows
  sheet="$(need 200 "GET /api/v1/sheets/$1" GET "/api/v1/sheets/$1" '' -H "Authorization: Bearer $2")"
  rows="$(need 200 "GET /api/v1/sheets/$1/rows" GET "/api/v1/sheets/$1/rows?limit=100" '' \
    -H "Authorization: Bearer $2")"
  jq -r '"sheet \(.name | tojson), \(.row_count) rows, columns: \(.columns | join(", "))"' <<< "$sheet"
  jq -r --argjson cols "$(jq -c .columns <<< "$sheet")" '.rows[] | . as $r | "row \(.id) at \(.index): "
    + ([$cols[] | . as $c | "\($c)=\($r.data[$c] // "" | tostring | tojson)"] | join(" "))' <<< "$rows"
}
signed_in() {
  : > "$jar"
  need 200 'POST /api/auth/login' POST /api/auth/login "$(password_json "$TEST_PASSWORD")" > /dev/null
}
# Healthy, the password signs in (a wrong one gets 401), and the sheet reads back as it did before.
as_before() {
  local health
  health="$(need 200 'GET /api/health' GET /api/health)"
  [ "$(jq -r .status <<< "$health")" = ok ] || fail "Cubex answers, but isn't healthy: $health"
  : > "$jar"
  need 401 'POST /api/auth/login with a wrong password' POST /api/auth/login \
    "$(password_json "$TEST_PASSWORD-wrong")" > /dev/null
  signed_in
  sheet_lines "$SHEET" "$TOKEN" > "$WORK/sheet-now.txt"
  sed 's/^/  /' "$WORK/sheet-now.txt"
  cmp -s "$WORK/sheet-before.txt" "$WORK/sheet-now.txt" || fail 'The sheet reads back differently from before.'
}
installed() { echo "Installed: $(cat "$CUBEX_HOME/app/.cubex-version")"; }
status_file() { cat "$CUBEX_HOME/update-status.json" 2>/dev/null || echo '{}'; }
# Settings' update, pressed: the release check first, then the button's own request.
press_update() { # WHAT
  local version
  version="$(need 200 'POST /api/settings/version/check' POST /api/settings/version/check)"
  [ "$(jq -r .latest_release.version <<< "$version")" = "$LATEST" ] \
    || fail "The release check didn't find $LATEST: $version"
  [ "$(jq -r .self_update.how <<< "$version")" = button ] || fail "No button on this install: $version"
  version="$(need 202 "POST /api/settings/version/update ($1)" POST /api/settings/version/update)"
  [ "$(jq -r .self_update.run.state <<< "$version")" = running ] || fail "The update isn't running: $version"
  echo "The update is running: $(jq -c '.self_update.run | {from, to}' <<< "$version")"
}
# Until the updater has written its exit code (the server is down meanwhile), at most 20 minutes.
updater_done() {
  local i
  for i in $(seq 1 600); do
    if [ "$(jq -r '.code // empty' <<< "$(status_file)")" != '' ] && "$CLI" status --quiet 2>/dev/null; then
      echo "The updater ended after about $((i * 2)) s: $(status_file)"
      return 0
    fi
    sleep 2
  done
  echo "--- cubex status: $("$CLI" status 2>&1 || true)"
  echo '--- processes'; ps -ef | grep -E '[n]ode|[c]ubex' | head -20 || true
  fail "The update didn't end within 20 minutes, or Cubex isn't running after it."
}

step "The latest release, and the label for the build under test (the release before it)"
LATEST="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$RELEASE_REPO/releases/latest")"
case "$LATEST" in */releases/tag/v*) LATEST="${LATEST##*/}" ;; *) fail "$RELEASE_REPO has no release: $LATEST" ;; esac
[[ "$LATEST" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || fail "The latest release isn't vX.Y.Z: $LATEST"
[ "${BASH_REMATCH[3]}" -gt 0 ] || fail "The latest release, $LATEST, has no patch before it to label this build with."
LABEL="v${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] - 1))"
echo "Latest release: $LATEST. This build is labeled $LABEL."

step "Install the commit under test from its checkout"
bash "$SRC/install.sh" --source "$SRC" --port "$TEST_PORT" --no-service --no-modify-path
installed

step "A stand-in for GitHub's releases API that answers $LATEST: a runner's shared address hits its rate limit"
# The release check asks RELEASE_CHECK_URL (an operator setting in config.env), as the e2e harness points it.
STANDIN_PORT=$((TEST_PORT + 1))
cat > "$WORK/standin.js" <<'JS'
const [tag, port] = process.argv.slice(2)
require('http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ tag_name: tag, published_at: new Date().toISOString() }))
}).listen(Number(port), '127.0.0.1')
JS
"$CUBEX_HOME/node/bin/node" "$WORK/standin.js" "$LATEST" "$STANDIN_PORT" &
STANDIN=$!
# However it ends: the stand-in and Cubex stopped, so a run after this one finds its ports free.
trap 'kill "$STANDIN" 2>/dev/null || true; "$CLI" stop > /dev/null 2>&1 || true' EXIT
printf '\nRELEASE_CHECK_URL=http://127.0.0.1:%s/latest\n' "$STANDIN_PORT" >> "$CUBEX_HOME/config.env"

step "Label it $LABEL, following releases, and start it again"
echo "$LABEL $(git -C "$SRC" rev-parse --short HEAD)" > "$CUBEX_HOME/app/.cubex-version"
# As install.sh writes it: the latest release, no source folder.
sed -i.bak -e 's/^CUBEX_REF=.*/CUBEX_REF=stable/' -e "s/^CUBEX_SOURCE=.*/CUBEX_SOURCE=''/" "$CUBEX_HOME/install.env"
rm -f "$CUBEX_HOME/install.env.bak"
"$CLI" restart
installed

step "Choose the password, sign in, and make a sheet that must come through both updates"
need 200 'POST /api/auth/setup' POST /api/auth/setup "$(password_json "$TEST_PASSWORD")" > /dev/null
signed_in
made="$(need 201 'POST /api/settings/access-tokens' POST /api/settings/access-tokens \
  '{"name":"update now","scopes":["write"]}')"
TOKEN="$(jq -r .token <<< "$made")"
echo "::add-mask::$TOKEN"
auth=(-H "Authorization: Bearer $TOKEN")
table="$(need 201 'POST /api/v1/tables' POST /api/v1/tables '{"name":"Survives the update"}' "${auth[@]}")"
SHEET="$(jq -r '.sheets[0].id' <<< "$table")"
for name in Name City Note; do
  need 201 "POST /api/v1/sheets/$SHEET/columns ($name)" POST "/api/v1/sheets/$SHEET/columns" \
    "$(jq -nc --arg name "$name" '{name: $name}')" "${auth[@]}" > /dev/null
done
rows='[{"Name":"Ada Lovelace","City":"London","Note":"first row"},
  {"Name":"Grace Hopper","City":"Arlington","Note":"commas, \"quotes\" and a\nline break"},
  {"Name":"Renée Müller","City":"Zürich"}]'
need 201 "POST /api/v1/sheets/$SHEET/rows" POST "/api/v1/sheets/$SHEET/rows" \
  "$(jq -c '{rows: map({data: .})}' <<< "$rows")" "${auth[@]}" > /dev/null
sheet_lines "$SHEET" "$TOKEN" > "$WORK/sheet-before.txt"
sed 's/^/  /' "$WORK/sheet-before.txt"
# An API token can't start one: the route takes a session only.
: > "$jar"
need 401 'POST /api/settings/version/update with the API token' POST /api/settings/version/update '' "${auth[@]}" \
  > /dev/null
signed_in

step "1. An update whose new version doesn't start: the version before comes back, with the data"
# A copy of the checkout whose server ends as soon as it has loaded, before it answers.
git clone --quiet --no-hardlinks "$SRC" "$WORK/broken"
git -C "$WORK/broken" checkout --quiet "$(git -C "$SRC" rev-parse HEAD)"
printf '\n// The must-pass: this build does not start.\n%s\n' \
  "setImmediate(() => { console.error('This build does not start (update-now.sh).'); process.exit(1); });" \
  >> "$WORK/broken/server/src/index.ts"
sed -i.bak -e "s|^CUBEX_SOURCE=.*|CUBEX_SOURCE=$WORK/broken|" "$CUBEX_HOME/install.env"
rm -f "$CUBEX_HOME/install.env.bak"
press_update 'to a build that does not start'
updater_done
code="$(jq -r .code <<< "$(status_file)")"
[ "$code" != 0 ] || fail "The update that can't start ended with code 0."
signed_in
version="$(need 200 'GET /api/settings/version' GET /api/settings/version)"
echo "$(jq -c '{version, run: .self_update.run | {state, from, to, code}}' <<< "$version")"
[ "$(jq -r .version <<< "$version")" = "$LABEL" ] || fail "Not back on $LABEL: $version"
[ "$(jq -r .self_update.run.state <<< "$version")" = failed ] || fail "Settings doesn't say it failed: $version"
jq -r .self_update.run.log <<< "$version" | grep -q 'the previous one is back' \
  || fail "Settings doesn't show what the update said: $(jq -r .self_update.run.log <<< "$version")"
as_before
installed

step "2. An update that comes through, to a newer build of the commit: Cubex comes back on it with the data"
git clone --quiet --no-hardlinks "$SRC" "$WORK/newer"
git -C "$WORK/newer" checkout --quiet "$(git -C "$SRC" rev-parse HEAD)"
git -C "$WORK/newer" -c user.name='Update now check' -c user.email=check@example.invalid commit --quiet \
  --allow-empty -m 'A newer build (update-now.sh)'
NEWER="$(git -C "$WORK/newer" rev-parse HEAD)"
sed -i.bak -e "s|^CUBEX_SOURCE=.*|CUBEX_SOURCE=$WORK/newer|" "$CUBEX_HOME/install.env"
rm -f "$CUBEX_HOME/install.env.bak"
signed_in
press_update "to the newer build ${NEWER:0:7}"
updater_done
[ "$(jq -r .code <<< "$(status_file)")" = 0 ] || fail "The update ended with code $(jq -r .code <<< "$(status_file)")."
# "local <short commit> <date>": the short commit as the installer's git abbreviated it.
read -r kind short _ < "$CUBEX_HOME/app/.cubex-version"
[ "$kind" = local ] && [ -n "$short" ] && [ "${NEWER#"$short"}" != "$NEWER" ] \
  || fail "Not on ${NEWER:0:7}: $(installed)"
as_before
installed
echo; echo "Update now works here: a failed update rolled back with the data, and the next one came through."
"$CLI" stop || true
