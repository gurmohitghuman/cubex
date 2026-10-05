#!/usr/bin/env bash
#
# backup-cubex-db.sh - one-shot, consistent snapshot of cubex.db.
#
# Run it before an upgrade so you have an immediate restore point. It's
# READ-ONLY: it never modifies the source DB, and it's safe to run while the
# server is live.
#
# Usage:
#   scripts/backup-cubex-db.sh                  # backs up ./server/data/cubex.db
#   scripts/backup-cubex-db.sh /path/to/cubex.db # explicit source
#   DB_PATH=/path/to/cubex.db scripts/backup-cubex-db.sh
#   scripts/backup-cubex-db.sh <src> <dest.db>  # explicit dest
#
# With Docker, either run it inside the container (cubex.db at
# /app/server/data/cubex.db) or on the host against the volume path.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${1:-${DB_PATH:-$ROOT/server/data/cubex.db}}"

if [ ! -f "$DB" ]; then
  echo "[x] no database at: $DB" >&2
  echo "    pass the path explicitly or set DB_PATH." >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
DEST="${2:-${DB%.db}.backup-$TS.db}"

if [ -e "$DEST" ]; then echo "[x] destination already exists: $DEST" >&2; exit 1; fi

echo "[backup] $DB -> $DEST"

# Preferred: SQLite online backup (atomic, includes WAL, safe while live).
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$DEST'"
# Fallback: better-sqlite3's online backup via node (present in the app image).
elif command -v node >/dev/null 2>&1 && [ -d "$ROOT/node_modules/better-sqlite3" ]; then
  node -e '
    const Database = require(process.env.ROOT + "/node_modules/better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true });
    db.backup(process.argv[2]).then(() => { console.log("ok"); }).catch(e => { console.error(e); process.exit(1); });
  ' "$DB" "$DEST" ROOT="$ROOT" || { echo "[x] node backup failed" >&2; exit 1; }
# Last resort: copy the DB + WAL + SHM together (recoverable as a set).
else
  echo "[backup] sqlite3/node unavailable - copying db + wal + shm" >&2
  cp "$DB" "$DEST"
  [ -f "$DB-wal" ] && cp "$DB-wal" "$DEST-wal"
  [ -f "$DB-shm" ] && cp "$DB-shm" "$DEST-shm"
fi

# The secrets sit next to the DB and never change after first boot, but a
# snapshot without .encryption-key can't decrypt saved keys: copy them alongside
# (cubex.backup-<ts>.encryption-key, cubex.backup-<ts>.jwt-secret).
DATA_DIR="$(dirname "$DB")"
for secret in .encryption-key .jwt-secret; do
  if [ -f "$DATA_DIR/$secret" ]; then
    cp -p "$DATA_DIR/$secret" "${DEST%.db}$secret"
    echo "[backup] $secret -> ${DEST%.db}$secret"
  fi
done

# Integrity-check the snapshot if we can.
if command -v sqlite3 >/dev/null 2>&1; then
  ok="$(sqlite3 "$DEST" 'PRAGMA integrity_check;' 2>/dev/null | head -1)"
  echo "[backup] integrity_check: ${ok:-unknown}"
fi
echo "[backup] done: $DEST ($(du -h "$DEST" 2>/dev/null | cut -f1))"
echo "[backup] restore later (server stopped): cp '$DEST' '$DB'"
echo "[backup]   and copy each ${DEST%.db}.<secret> back to $DATA_DIR/.<secret>"
