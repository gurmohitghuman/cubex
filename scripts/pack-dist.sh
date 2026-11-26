#!/usr/bin/env bash
# Packs the built app (server/dist and client/dist, after npm run build) into <dir>/cubex-dist.tar.gz and its
# .sha256, the archive each release attaches (.github/workflows/release.yml) and install.sh and install.ps1 take.
# Every entry is owned by root (0:0): tar run as root keeps an archive's owners, so an install as root would
# otherwise leave the app owned by the build machine's user. Then checks that the archive holds only those two
# folders, no unsafe path, and unpacks whole.
# Usage, from the repository's root with GNU tar: bash scripts/pack-dist.sh <dir>
set -euo pipefail
out="${1:?usage: bash scripts/pack-dist.sh <dir>}"
for f in server/dist/index.js server/dist/package.json server/dist/db/migrations/001_schema.sql \
  client/dist/index.html; do
  [ -f "$f" ] || { echo "::error::$f is missing: run npm run build first"; exit 1; }
done
mkdir -p "$out"
tar --format=posix --owner=0 --group=0 --numeric-owner -czf "$out/cubex-dist.tar.gz" server/dist client/dist
(cd "$out" && sha256sum cubex-dist.tar.gz > cubex-dist.tar.gz.sha256)
entries="$(tar -tzf "$out/cubex-dist.tar.gz")"
test -n "$entries"
while IFS= read -r entry; do
  case "$entry" in
    server/dist|server/dist/*|client/dist|client/dist/*) ;;
    *) echo "::error::Unexpected entry in archive: $entry"; exit 1 ;;
  esac
  case "/$entry/" in
    */../*|*\\*) echo "::error::Unsafe path in archive: $entry"; exit 1 ;;
  esac
done <<< "$entries"
stage="$(mktemp -d)"
tar -xzf "$out/cubex-dist.tar.gz" -C "$stage"
for f in server/dist/index.js server/dist/package.json server/dist/db/migrations/001_schema.sql \
  client/dist/index.html; do
  [ -f "$stage/$f" ] || { echo "::error::$f is missing from the archive"; exit 1; }
done
rm -rf "$stage"
echo "Packed $out/cubex-dist.tar.gz ($(wc -c < "$out/cubex-dist.tar.gz") bytes)"
