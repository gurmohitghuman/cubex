# Keeping Cubex running, sourced by bin/cubex: a launchd login item on macOS, a
# systemd user service on Linux, or else a plain background process (which
# doesn't come back after a restart). CUBEX_SERVICE in config.env overrides the
# choice: launchd, systemd or none. Every function here runs after load_config.

svc_vars() {
  LABEL="${CUBEX_SERVICE_LABEL:-io.github.gurmohitghuman.cubex}"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  UNIT="${CUBEX_SERVICE_UNIT:-cubex}"
  UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT.service"
  PIDFILE="$CUBEX_HOME/cubex.pid"
  DOMAIN="gui/$(id -u)"
  MODE="${CUBEX_SERVICE:-auto}"
  if [ "$MODE" = auto ]; then
    MODE=none
    if [ "$(uname -s)" = Darwin ]; then MODE=launchd
    elif command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then MODE=systemd; fi
  fi
}

service_describe() {
  svc_vars
  case "$MODE" in
    launchd) echo "a macOS login item ($LABEL), so it starts when you log in" ;;
    systemd) echo "a systemd user service ($UNIT.service), so it starts with the computer" ;;
    *) echo "a background process; run cubex start again after a restart" ;;
  esac
}

service_running() {
  local out
  svc_vars
  case "$MODE" in
    launchd) out="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null)" || return 1
      case "$out" in *'state = running'*) return 0 ;; esac; return 1 ;;
    systemd) systemctl --user is-active --quiet "$UNIT" ;;
    *) bg_pid >/dev/null ;;
  esac
}

service_start() {
  svc_vars
  case "$MODE" in launchd) launchd_start ;; systemd) systemd_start ;; *) bg_start ;; esac
}

service_stop() {
  svc_vars
  case "$MODE" in
    launchd) # bootout stops it now; disable keeps it from starting at the next login
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
      launchctl disable "$DOMAIN/$LABEL" 2>/dev/null || true ;;
    systemd) systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true ;;
    *) bg_stop ;;
  esac
}

service_remove() {
  service_stop
  # The plist is going away, so clear the "disabled" mark stop left in launchd.
  if [ "$MODE" = launchd ]; then launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true; fi
  rm -f "$PLIST"
  if [ -f "$UNIT_FILE" ]; then rm -f "$UNIT_FILE"; systemctl --user daemon-reload 2>/dev/null || true; fi
  return 0
}

launchd_start() {
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/bin/cubex</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>CUBEX_HOME</key><string>$CUBEX_HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST" \
      || die "macOS didn't accept the login item. To run Cubex without one, add CUBEX_SERVICE=none to $CONFIG."
  fi
}

systemd_start() {
  local user; user="$(id -un)"
  mkdir -p "$(dirname "$UNIT_FILE")"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Cubex, a self-hosted AI spreadsheet
After=network-online.target

[Service]
Environment="CUBEX_HOME=$CUBEX_HOME"
ExecStart="$APP/bin/cubex" run
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1
  systemctl --user restart "$UNIT"
  # "Linger" keeps user services running after logout and starts them at boot.
  if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" != yes ] \
    && ! loginctl enable-linger "$user" 2>/dev/null; then
    say "Note: Cubex stops when you log out. To keep it running, run: sudo loginctl enable-linger $user"
  fi
}

bg_pid() { # the recorded PID, if it is still Cubex's server
  local pid args
  pid="$(cat "$PIDFILE" 2>/dev/null)" || return 1
  if [ -r "/proc/$pid/cmdline" ]; then args="$(tr '\0' ' ' < "/proc/$pid/cmdline")" # Linux without ps
  else args="$(ps -p "$pid" -o args= 2>/dev/null)" || return 1; fi
  case "$args" in *server/dist/index.js*) echo "$pid" ;; *) return 1 ;; esac
}

bg_start() {
  nohup "$APP/bin/cubex" run >> "$LOG" 2>&1 < /dev/null &
  echo "$!" > "$PIDFILE"
}

bg_stop() {
  local pid i=0
  pid="$(bg_pid)" || { rm -f "$PIDFILE"; return 0; }
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 60 ]; do sleep 0.25; i=$((i + 1)); done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
}
