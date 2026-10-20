# The copy of the data an update keeps (bin/cubex-backup.mjs does the copying) and
# `cubex rollback`, sourced by bin/cubex after cubex-service.sh. Every function
# here runs inside bin/cubex (load_config, say, die, cmd_stop, cmd_start, $NODE,
# $APP, $HERE). bin/cubex-rollback.ps1 is the Windows twin.

# The data files an update copies before the new version can change them
# (bin/cubex-backup.mjs). A relative JOBS_DB_PATH is the server's: from the app folder.
data_files() {
  DB="${DB_PATH:-$CUBEX_HOME/data/cubex.db}"
  JOBS="${JOBS_DB_PATH:-$(dirname "$DB")/jobs.db}"
  case "$JOBS" in /*) ;; *) JOBS="$APP/$JOBS" ;; esac
}

# For the installers: never while a server could still write the files.
backup_step() {
  load_config && data_files
  if service_running || healthy; then die "Cubex is still running. Stop it first: cubex stop"; fi
  "$NODE" "$HERE/cubex-backup.mjs" "$1" "$DB" "$JOBS" "${@:2}"
}

# Puts back the version before the last update and the data as it was then.
# The apps swap first: if that fails, the data is untouched; if putting the
# data back fails, the apps swap back.
cmd_rollback() {
  local info at kept prev answer='' was_running=0 node_major built_for lock="$CUBEX_HOME/.install-lock"
  load_config && data_files
  [ -d "$CUBEX_HOME/app.previous" ] || die "There's no previous version to go back to: one is kept after an update."
  info="$("$NODE" "$HERE/cubex-backup.mjs" info "$DB")" \
    || die "There's no copy of your data from before the last update, so going back isn't safe."
  at="$(printf '%s' "$info" | sed -n 's/.*"at":"\([^"]*\)".*/\1/p')"
  kept="$(printf '%s' "$info" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  prev="$(cat "$CUBEX_HOME/app.previous/.cubex-version" 2>/dev/null || echo unknown)"
  if [ "$kept" != "$prev" ]; then
    die "The data kept before the last update is from Cubex $kept, but the previous version is $prev.
Going back isn't safe."
  fi
  # The previous version's native modules were built for the Node it was installed with.
  node_major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
  built_for="$(cat "$CUBEX_HOME/app.previous/.cubex-node" 2>/dev/null || echo 22)"
  if [ "$built_for" != "$node_major" ]; then
    die "Cubex $prev was built for Node $built_for, and Node $node_major is installed now. Install that version again
instead: curl -fsSL https://raw.githubusercontent.com/gurmohitghuman/cubex/main/install.sh | bash -s -- --ref <its tag>"
  fi
  say "This puts back Cubex $prev and your data as it was at $at, before the update. Everything changed since"
  say "then goes: rows, runs and settings, and sign-in too (a password changed or a token revoked since comes back)."
  say "The data from now is kept in $(dirname "$DB")/backups."
  if [ "${1:-}" != --yes ]; then
    printf 'Type rollback to confirm: '
    { read -r answer < /dev/tty; } 2>/dev/null || true
    [ "$answer" = rollback ] || die "Nothing was changed."
  fi
  mkdir "$lock" 2>/dev/null || die "An install or update is running. If not, delete $lock and try again."
  # The path is put in now: the trap runs at exit, after this function's locals are gone.
  trap "rm -rf $(printf '%q' "$lock")" EXIT
  if service_running || service_loaded; then was_running=1; fi
  QUIET=1 cmd_stop
  if service_running || healthy; then die "Cubex is still running, so nothing was changed. Try cubex stop."; fi
  rm -rf "$CUBEX_HOME/app.failed" || die "Couldn't clear $CUBEX_HOME/app.failed. Nothing was changed."
  mv "$CUBEX_HOME/app" "$CUBEX_HOME/app.failed" || die "Couldn't move the current version aside. Nothing was changed."
  if ! mv "$CUBEX_HOME/app.previous" "$CUBEX_HOME/app"; then
    mv "$CUBEX_HOME/app.failed" "$CUBEX_HOME/app"
    die "Couldn't put the previous version in place. Nothing was changed."
  fi
  # This script's own folder moved to app.failed with the newer version.
  if ! "$NODE" "$CUBEX_HOME/app.failed/bin/cubex-backup.mjs" restore "$DB" "$JOBS" >/dev/null; then
    mv "$CUBEX_HOME/app" "$CUBEX_HOME/app.previous" && mv "$CUBEX_HOME/app.failed" "$CUBEX_HOME/app"
    if [ "$was_running" = 1 ]; then cmd_start || true; fi
    die "Putting your data back stopped (see above); the newer version is in place again. Run cubex rollback to retry."
  fi
  rm -rf "$lock" && trap - EXIT
  say "Cubex $prev is back, with your data from before the update. The newer version is in $CUBEX_HOME/app.failed."
  # This (newer) script's start, which waits for a big database; the service runs what's in app now.
  if [ "$was_running" = 1 ]; then cmd_start; fi
}
