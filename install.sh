#!/usr/bin/env bash
# Install or update Cubex with one command, no Docker:
#
#   curl -fsSL https://raw.githubusercontent.com/gurmohitghuman/cubex/main/install.sh | bash
#
# Everything lives in ~/.cubex: a private Node.js (Cubex never uses or changes
# yours), the app, your data and config.env. The only thing put elsewhere is
# the `cubex` command in ~/.local/bin, plus one line in your shell's startup file
# if that folder isn't on your PATH yet. Running it again updates Cubex and keeps
# your data and settings. macOS and Linux; on Windows use WSL2.
set -euo pipefail

CUBEX_REPO="${CUBEX_REPO:-gurmohitghuman/cubex}" # the public GitHub repository
CUBEX_REF="${CUBEX_REF:-main}"
CUBEX_HOME="${CUBEX_HOME:-$HOME/.cubex}"
CUBEX_BIN_DIR="${CUBEX_BIN_DIR:-$HOME/.local/bin}"
NODE_MAJOR=22
MARKER=.cubex-home # marks a folder as a Cubex install; uninstall only ever deletes inside those

if [ -t 1 ]; then G=$'\033[32m' R=$'\033[31m' B=$'\033[1m' N=$'\033[0m'; else G='' R='' B='' N=''; fi
say() { printf '%s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
die() { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: install.sh [options]   (with curl: ... | bash -s -- [options])
  --port N           Port to use (default 3002)
  --public           Reachable from other devices, with a generated password
  --ref BRANCH|TAG   Version to install (default: main)
  --dir DIR          Install folder (default: ~/.cubex)
  --no-start         Don't start Cubex afterwards
  --no-service       Plain background process, no launchd/systemd service
  --no-modify-path   Don't edit your shell startup file
  --force            Rebuild even if already up to date
  --source DIR       Install from a local checkout instead of GitHub
EOF
}

main() {
  PORT_ARG='' PUBLIC=0 SOURCE='' NO_START=0 NO_SERVICE=0 NO_PATH=0 FORCE=0 PASSWORD='' LOCKED=0
  NODE_SWAPPED=0 CONFIG_CHANGED=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) PORT_ARG="${2:?--port needs a number}"; shift 2 ;;
      --public) PUBLIC=1; shift ;;
      --ref) CUBEX_REF="${2:?--ref needs a branch or tag}"; shift 2 ;;
      --dir) CUBEX_HOME="${2:?--dir needs a folder}"; shift 2 ;;
      --source) SOURCE="$(cd "${2:?--source needs a folder}" && pwd)"; shift 2 ;;
      --no-start) NO_START=1; shift ;;
      --no-service) NO_SERVICE=1; shift ;;
      --no-modify-path) NO_PATH=1; shift ;;
      --force) FORCE=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "Unknown option: $1" ;;
    esac
  done
  case "$PORT_ARG" in
    '') ;;
    *[!0-9]*) die "--port needs a number from 1 to 65535." ;;
    *) if [ "$PORT_ARG" -lt 1 ] || [ "$PORT_ARG" -gt 65535 ]; then die "--port needs a number from 1 to 65535."; fi ;;
  esac
  case "$CUBEX_HOME" in /*) ;; *) CUBEX_HOME="$PWD/$CUBEX_HOME" ;; esac
  case "$CUBEX_HOME" in /|"$HOME"|"$HOME"/) die "Give Cubex a folder of its own (--dir), not $CUBEX_HOME." ;; esac
  # Never take over a folder with other things in it: uninstall deletes inside it.
  if [ -d "$CUBEX_HOME" ] && [ ! -f "$CUBEX_HOME/$MARKER" ] && [ -n "$(ls -A "$CUBEX_HOME")" ]; then
    die "$CUBEX_HOME already has other files in it. Choose a new or empty folder with --dir."
  fi
  export CUBEX_HOME

  detect_platform
  say "${B}Installing Cubex into $CUBEX_HOME${N}"
  if [ ! -d "$CUBEX_HOME" ]; then mkdir -p "$CUBEX_HOME" && chmod 700 "$CUBEX_HOME"; fi
  echo 'This folder is a Cubex install. "cubex uninstall --delete-data" removes it.' > "$CUBEX_HOME/$MARKER"
  mkdir -p "$CUBEX_HOME/logs"
  TMP="$(mktemp -d)" LOCK="$CUBEX_HOME/.install-lock"
  trap 'rm -rf "$TMP"; [ "$LOCKED" = 0 ] || rm -rf "$LOCK"' EXIT
  mkdir "$LOCK" 2>/dev/null || die "Another install or update is running. If not, delete $LOCK and try again."
  LOCKED=1

  install_node
  write_config
  local built=0 cli="$CUBEX_HOME/app/bin/cubex"
  if fetch_source; then build_app; built=1; else ok "Already up to date ($(cat "$CUBEX_HOME/app/.cubex-version"))"; fi
  # Before starting anything, so `cubex logs` and `cubex uninstall` work even if the start fails.
  printf 'CUBEX_REPO=%q\nCUBEX_REF=%q\nCUBEX_SOURCE=%q\nCUBEX_BIN_DIR=%q\n' \
    "$CUBEX_REPO" "$CUBEX_REF" "$SOURCE" "$CUBEX_BIN_DIR" > "$CUBEX_HOME/install.env"
  install_launcher
  if [ "$built" = 1 ]; then
    activate
  elif [ "$CONFIG_CHANGED" = 1 ] && "$cli" is-active; then
    "$cli" restart --quiet && ok "Restarted Cubex with the new settings"
  fi
  rm -rf "$CUBEX_HOME/node.previous"
  finish
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    *) die "This installer supports macOS and Linux. On Windows, use WSL2 or Docker (see the README)." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "Unsupported processor: $(uname -m). Docker may still work (see the README)." ;;
  esac
  # A Terminal running under Rosetta reports x86_64 on Apple silicon.
  if [ "$OS" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then ARCH=arm64; fi
  if [ "$OS" = linux ]; then # musl's ldd exits 1 even for --version, so read its output instead
    case "$(ldd --version 2>&1 || true)" in
      *musl*) die "Alpine and other musl-based Linux aren't supported by this installer. Use Docker instead." ;;
    esac
  fi
  for tool in curl tar gzip git; do
    if [ "$tool" = git ] && [ -z "$SOURCE" ]; then continue; fi
    command -v "$tool" >/dev/null || die "Please install $tool first."
  done
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# The latest Node.js $NODE_MAJOR for this platform, checksum-verified, in
# $CUBEX_HOME/node. Native modules are built against it and it's the only Node
# Cubex runs on, so installing or upgrading Node elsewhere can't break Cubex.
install_node() {
  local base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x" line file version current=''
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v[0-9.]*-$OS-$ARCH\.tar\.gz\$")" \
    || die "Couldn't find Node.js $NODE_MAJOR for $OS-$ARCH (no internet connection?)."
  file="${line##* }" && version="${file#node-}" && version="${version%%-*}"
  if [ -f "$CUBEX_HOME/node/.version" ]; then current="$(cat "$CUBEX_HOME/node/.version")"; fi
  if [ "$current" != "$version" ]; then
    curl -fsSL "$base/$file" -o "$TMP/$file" || die "Downloading Node.js failed."
    [ "$(sha256 "$TMP/$file")" = "${line%% *}" ] || die "The Node.js download failed its checksum."
    rm -rf "$CUBEX_HOME/node.next" && mkdir "$CUBEX_HOME/node.next"
    tar -xzf "$TMP/$file" -C "$CUBEX_HOME/node.next" --strip-components 1
    echo "$version" > "$CUBEX_HOME/node.next/.version"
    rm -rf "$CUBEX_HOME/node.previous"
    if [ -d "$CUBEX_HOME/node" ]; then mv "$CUBEX_HOME/node" "$CUBEX_HOME/node.previous"; fi
    mv "$CUBEX_HOME/node.next" "$CUBEX_HOME/node"
    # Another major version means another native-module ABI: the app must be rebuilt.
    if [ "${current%%.*}" != "${version%%.*}" ]; then FORCE=1 NODE_SWAPPED=1; fi
  fi
  ok "Node.js $version (a private copy; your system Node is untouched)"
}

# If this run switched Node to a new major and then failed, put the old Node
# back: the installed app's native modules were built for it.
restore_node() {
  if [ "$NODE_SWAPPED" = 1 ] && [ -d "$CUBEX_HOME/node.previous" ]; then
    rm -rf "$CUBEX_HOME/node" && mv "$CUBEX_HOME/node.previous" "$CUBEX_HOME/node"
  fi
}

detect_service() {
  if [ "$OS" = darwin ]; then echo launchd
  elif command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then echo systemd
  else echo none; fi
}

# config.env holds your settings. It is created once and never overwritten;
# options change only their own lines.
write_config() {
  CONFIG="$CUBEX_HOME/config.env"
  if [ ! -f "$CONFIG" ]; then
    cat > "$CONFIG" <<'EOF'
# Cubex settings, one KEY=value per line. After a change, run: cubex restart
# Every setting is listed in the README under "Configuration".

# Who can open Cubex. 127.0.0.1: only this computer. 0.0.0.0: any device that
# can reach it; then also set INITIAL_PASSWORD, and put HTTPS in front if it's
# reachable from the internet.
HOST=127.0.0.1
PORT=3002

# MAX_ROWS_PER_SHEET=1000000
# MAX_COLUMNS_PER_SHEET=200
# MAX_CSV_UPLOAD_MB=500
EOF
    chmod 600 "$CONFIG"
  fi
  if [ -n "$PORT_ARG" ]; then set_config PORT "$PORT_ARG"; fi
  if [ "$NO_SERVICE" = 1 ]; then set_config CUBEX_SERVICE none; fi
  # Saved once, so every later `cubex` command (even from cron or sudo) agrees on it.
  grep -q '^CUBEX_SERVICE=' "$CONFIG" || set_config CUBEX_SERVICE "$(detect_service)"
  if [ "$PUBLIC" = 1 ]; then
    set_config HOST 0.0.0.0
    # Used only if Cubex has no account yet; finish() checks which password is real.
    if ! grep -q '^INITIAL_PASSWORD=.' "$CONFIG"; then
      PASSWORD="$("$CUBEX_HOME/node/bin/node" -e "console.log(require('crypto').randomBytes(15).toString('base64url'))")"
      set_config INITIAL_PASSWORD "$PASSWORD"
    fi
  fi
}

set_config() { # KEY VALUE: replace the line for KEY, or append one
  if grep -Fqx "$1=$2" "$CONFIG"; then return 0; fi
  CONFIG_CHANGED=1
  if grep -q "^$1=" "$CONFIG"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$CONFIG" && rm -f "$CONFIG.bak"
  else
    printf '%s=%s\n' "$1" "$2" >> "$CONFIG"
  fi
}

# Puts the source in $CUBEX_HOME/app.next and sets SRC_ID. Returns 1 when the
# installed app is already this exact version (nothing to do).
fetch_source() {
  local next="$CUBEX_HOME/app.next" sha=''
  rm -rf "$next" && mkdir "$next"
  if [ -n "$SOURCE" ]; then
    # Tracked and new files only: never node_modules, data or .env secrets.
    (cd "$SOURCE" && git ls-files -z --cached --others --exclude-standard \
      | while IFS= read -r -d '' f; do if [ -e "$f" ]; then printf '%s\0' "$f"; fi; done \
      | tar -cf - --null -T -) | tar -xf - -C "$next" || die "Copying $SOURCE failed (it must be a git checkout of Cubex)."
    SRC_ID="local $(git -C "$SOURCE" rev-parse --short HEAD) $(date '+%Y-%m-%d %H:%M')"
    return 0
  fi
  sha="$(curl -fsSL -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/$CUBEX_REPO/commits/$CUBEX_REF" 2>/dev/null)" || sha=''
  SRC_ID="$CUBEX_REF ${sha:0:7}"
  if [ -n "$sha" ] && [ "$FORCE" = 0 ] && [ "$(cat "$CUBEX_HOME/app/.cubex-version" 2>/dev/null)" = "$SRC_ID" ]; then
    rm -rf "$next"; return 1
  fi
  curl -fsSL "https://codeload.github.com/$CUBEX_REPO/tar.gz/${sha:-$CUBEX_REF}" \
    | tar -xzf - -C "$next" --strip-components 1 || die "Downloading Cubex ($CUBEX_REPO, $CUBEX_REF) failed."
  ok "Downloaded Cubex ($SRC_ID)"
}

build_app() {
  local next="$CUBEX_HOME/app.next" log="$CUBEX_HOME/logs/install.log"
  say "  Building Cubex; this takes a minute or two..."
  # shellcheck disable=SC2030 # PATH changes only for the build's subshell
  if ! (cd "$next" && export PATH="$CUBEX_HOME/node/bin:$PATH" npm_config_update_notifier=false &&
    npm ci --include=dev --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund) \
    > "$log" 2>&1; then
    restore_node
    tail -n 25 "$log" >&2
    die "Building Cubex failed (full log: $log). If the log mentions node-gyp or a compiler,
install build tools and run this again: macOS: xcode-select --install;
Debian/Ubuntu: sudo apt install build-essential python3."
  fi
  echo "$SRC_ID" > "$next/.cubex-version"
  chmod +x "$next/bin/cubex"
  ok "Built Cubex"
}

# Swap the new build in. If Cubex was running (or this is a first install) it
# restarts on the new version; if that fails, the previous version comes back.
activate() {
  local cli="$CUBEX_HOME/app/bin/cubex" was_running=1
  if [ -x "$cli" ]; then
    if "$cli" is-active; then "$cli" stop --quiet; else was_running=0; fi
  fi
  rm -rf "$CUBEX_HOME/app.previous"
  if [ -d "$CUBEX_HOME/app" ]; then mv "$CUBEX_HOME/app" "$CUBEX_HOME/app.previous"; fi
  mv "$CUBEX_HOME/app.next" "$CUBEX_HOME/app"
  if [ "$NO_START" = 1 ] || [ "$was_running" = 0 ]; then return 0; fi
  if "$cli" start --quiet; then ok "Started Cubex"; return 0; fi
  [ -d "$CUBEX_HOME/app.previous" ] || die "Cubex didn't start. See: cubex logs"
  rm -rf "$CUBEX_HOME/app.failed" && mv "$CUBEX_HOME/app" "$CUBEX_HOME/app.failed"
  mv "$CUBEX_HOME/app.previous" "$CUBEX_HOME/app"
  restore_node
  "$cli" start --quiet || true
  die "The new version didn't start, so the previous one is back. The failed build is in $CUBEX_HOME/app.failed."
}

# The `cubex` command is a tiny launcher, so nothing else (no node) lands on PATH.
install_launcher() {
  local shim="$CUBEX_BIN_DIR/cubex" home_q had_shim=0
  mkdir -p "$CUBEX_BIN_DIR"
  if [ -e "$shim" ]; then
    grep -q 'Cubex launcher' "$shim" || die "$shim already exists and isn't Cubex's. Move it away and run this again."
    had_shim=1
  fi
  home_q="'$(printf '%s' "$CUBEX_HOME" | sed "s/'/'\\\\''/g")'"
  # shellcheck disable=SC2016 # the launcher's $CUBEX_HOME and $@ are meant literally
  printf '#!/bin/sh\n# Cubex launcher, written by install.sh.\nCUBEX_HOME=%s\nexport CUBEX_HOME\nexec "$CUBEX_HOME/app/bin/cubex" "$@"\n' \
    "$home_q" > "$shim"
  chmod 755 "$shim"
  if [ "$had_shim" = 0 ]; then ok "Added the cubex command ($shim)"; fi
  PATH_NOTE=''
  # shellcheck disable=SC2031 # the user's PATH, not the build subshell's
  case ":$PATH:" in *":$CUBEX_BIN_DIR:"*) return 0 ;; esac
  # Shell startup files are only ever edited on a first install, never by an update.
  if [ "$NO_PATH" = 1 ] || [ "$had_shim" = 1 ]; then
    PATH_NOTE="Add $CUBEX_BIN_DIR to your PATH to use the cubex command."; return 0
  fi
  local rc line="export PATH=\"\$PATH:$CUBEX_BIN_DIR\" # added by the Cubex installer"
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="$HOME/.zshrc" ;;
    bash) if [ "$OS" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path -a $CUBEX_BIN_DIR # added by the Cubex installer" ;;
    *) rc="$HOME/.profile" ;;
  esac
  grep -qs 'added by the Cubex installer' "$rc" || { mkdir -p "$(dirname "$rc")"; printf '\n%s\n' "$line" >> "$rc"; }
  PATH_NOTE="Open a new terminal window first, so your shell finds the cubex command."
}

# Ask the running server rather than guess: is first-run setup open, and does
# the generated password actually sign in?
setup_open() { local s; s="$(curl -fsS "$1/api/auth/status" 2>/dev/null)" || return 1; case "$s" in *'"setupRequired":true'*) return 0 ;; esac; return 1; }
password_works() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    --data "{\"password\":\"$2\"}" "$1/api/auth/login")" = 200 ]
}

finish() {
  local cli="$CUBEX_HOME/app/bin/cubex" url
  say ""
  if "$cli" status --quiet; then
    url="$("$cli" url)"
    say "${G}${B}Cubex is running:${N} $url"
    if [ -n "$PASSWORD" ] && password_works "$url" "$PASSWORD"; then
      say "Sign in with the password ${B}$PASSWORD${N} (also saved in $CONFIG)."
    elif [ -n "$PASSWORD" ]; then
      sed -i.bak '/^INITIAL_PASSWORD=/d' "$CONFIG" && rm -f "$CONFIG.bak"
      say "Cubex already has a password, so sign in with that one. Forgot it? Run: cubex reset-password"
    elif setup_open "$url"; then
      say "Open it and choose your password."
    fi
  else
    say "${B}Cubex is installed.${N} Start it with: cubex start"
    if [ -n "$PASSWORD" ]; then say "Your generated password is ${B}$PASSWORD${N} (saved in $CONFIG)."; fi
  fi
  say "Manage it with: cubex status | stop | start | logs | update | uninstall"
  if [ -n "$PATH_NOTE" ]; then say "$PATH_NOTE"; fi
}

main "$@"
