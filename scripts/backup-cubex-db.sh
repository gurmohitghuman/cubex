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
# With Docker, the image doesn't include this script: copy it in, then run it
# there (node is on PATH; the snapshot lands in the volume next to cubex.db):
#   docker compose cp scripts cubex:/app/scripts
#   docker compose exec cubex bash /app/scripts/backup-cubex-db.sh \
#     /app/server/data/cubex.db /app/server/data/backup.db
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

# The one-line installer keeps a private Node next to the app (~/.cubex/node)
# and built the native modules against it, so it wins over any node on PATH.
NODE="$(command -v node 2>/dev/null || true)"
if [ -f "$ROOT/../.cubex-home" ] && [ -x "$ROOT/../node/bin/node" ]; then NODE="$ROOT/../node/bin/node"; fi
COPIED_FILES=0

# Preferred: SQLite online backup (atomic, includes WAL, safe while live).
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$DEST'" || { echo "[x] sqlite3 backup failed" >&2; exit 1; }
# Fallback: better-sqlite3's online backup via node (present in the app image).
elif [ -n "$NODE" ] && [ -d "$ROOT/node_modules/better-sqlite3" ]; then
  ROOT="$ROOT" "$NODE" -e '
    const Database = require(process.env.ROOT + "/node_modules/better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true });
    db.backup(process.argv[2]).then(() => { console.log("ok"); }).catch(e => { console.error(e); process.exit(1); });
  ' "$DB" "$DEST" || { echo "[x] node backup failed" >&2; exit 1; }
# Last resort: copy the DB + WAL + SHM together (recoverable as a set).
else
  echo "[backup] sqlite3/node unavailable - copying db + wal + shm" >&2
  COPIED_FILES=1
  for ext in '' -wal -shm; do
    if [ -f "$DB$ext" ]; then cp "$DB$ext" "$DEST$ext" || { echo "[x] copying $DB$ext failed" >&2; exit 1; }; fi
  done
fi

# The secrets sit next to the DB and never change after first boot, but a
# snapshot without .encryption-key can't decrypt saved keys: copy them alongside
# (cubex.backup-<ts>.encryption-key, cubex.backup-<ts>.jwt-secret).
DATA_DIR="$(dirname "$DB")"
for secret in .encryption-key .jwt-secret; do
  if [ -f "$DATA_DIR/$secret" ]; then
    cp -p "$DATA_DIR/$secret" "${DEST%.db}$secret" || { echo "[x] copying $secret failed" >&2; exit 1; }
    echo "[backup] $secret -> ${DEST%.db}$secret"
  fi
done

# Integrity-check the snapshot if we can.
if command -v sqlite3 >/dev/null 2>&1; then
  ok="$(sqlite3 "$DEST" 'PRAGMA integrity_check;' 2>/dev/null | head -1)"
  echo "[backup] integrity_check: ${ok:-unknown}"
  [ "$ok" = ok ] || { echo "[x] the snapshot failed its integrity check" >&2; exit 1; }
fi
echo "[backup] done: $DEST ($(du -h "$DEST" 2>/dev/null | cut -f1))"
# Delete the live DB's -wal/-shm first: SQLite would replay that WAL onto the
# restored file.
echo "[backup] restore later, with the server stopped:"
echo "[backup]   rm -f '$DB-wal' '$DB-shm' && cp '$DEST' '$DB'"
if [ "$COPIED_FILES" = 1 ] && [ -f "$DEST-wal" ]; then echo "[backup]   cp '$DEST-wal' '$DB-wal'"; fi
echo "[backup]   and copy each ${DEST%.db}.<secret> back to $DATA_DIR/.<secret>"
