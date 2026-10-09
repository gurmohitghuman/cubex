#!/usr/bin/env bash
#
# release.sh - cut a Cubex release (see docs/releasing.md).
#
# A release is a draft GitHub release on a commit already on main, plus the
# Release workflow: it tests that exact commit and only then publishes the
# draft, which is when the vX.Y.Z tag is created. A failed run leaves no tag.
#
# Usage:
#   scripts/release.sh notes [patch|minor|major]   draft the next version's notes from git
#   scripts/release.sh cut vX.Y.Z NOTES.md         make the draft and start the Release workflow
#   scripts/release.sh abandon vX.Y.Z              delete a draft whose run failed
#
# Releases always go to the public repository (CUBEX_REPO), through whichever
# git remote points at it; never to another remote such as a private mirror.
# Needs git and an authenticated gh. Written for macOS's stock bash 3.2.
set -euo pipefail

CUBEX_REPO="${CUBEX_REPO:-gurmohitghuman/cubex}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf 'release: %s\n' "$*" >&2; exit 1; }

# The git remote that pushes to the public repository.
public_remote() {
  local r
  for r in $(git remote); do
    case "$(git remote get-url --push "$r")" in
      *github.com[:/]"$CUBEX_REPO"|*github.com[:/]"$CUBEX_REPO".git) echo "$r"; return 0 ;;
    esac
  done
  die "no git remote points at github.com/$CUBEX_REPO"
}

# Refreshes main and the release tags from the public repository.
fetch_public() {
  git fetch -q "$REMOTE" "+refs/heads/main:refs/remotes/$REMOTE/main" "+refs/tags/v*:refs/tags/v*"
}

# The newest vX.Y.Z tag on the public repository, or nothing before the first release.
latest_tag() {
  git ls-remote --tags --refs "$REMOTE" 'v*' | sed 's|.*refs/tags/||' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n \
    | tail -n 1 | sed 's/^/v/'
}

# Whether version $1 (X.Y.Z, no v) is newer than $2.
newer() {
  local IFS=. a b
  read -r -a a <<< "$1"; read -r -a b <<< "$2"
  [ "${a[0]}" -gt "${b[0]}" ] || { [ "${a[0]}" -eq "${b[0]}" ] && { [ "${a[1]}" -gt "${b[1]}" ] ||
    { [ "${a[1]}" -eq "${b[1]}" ] && [ "${a[2]}" -gt "${b[2]}" ]; }; }; }
}

bump() { # bump KIND X.Y.Z
  local IFS=. v
  read -r -a v <<< "$2"
  case "$1" in
    major) echo "$((v[0] + 1)).0.0" ;;
    minor) echo "${v[0]}.$((v[1] + 1)).0" ;;
    patch) echo "${v[0]}.${v[1]}.$((v[2] + 1))" ;;
    *) die "bump must be patch, minor or major, not '$1'" ;;
  esac
}

cmd_notes() {
  local kind="${1:-patch}" prev next target range stats count file
  fetch_public
  prev="$(latest_tag)" target="$(git rev-parse "$REMOTE/main")"
  if [ -n "$prev" ]; then next="v$(bump "$kind" "${prev#v}")" range="$prev..$target"
  else next=v0.1.0 range="$target"; fi
  count="$(git rev-list --count --no-merges "$range")"
  [ "$count" -gt 0 ] || die "main has nothing new since $prev"
  # " 612 files changed, 65351 insertions(+), 12 deletions(-)" -> "612 files changed · +65,351 / −12"
  stats="$(git diff --shortstat "${prev:-$(git hash-object -t tree /dev/null)}" "$target" | awk '
    function c(n) { while (n ~ /[0-9]{4}/) sub(/[0-9]{3}($|,)/, ",&", n); return n }
    { f = i = d = 0
      for (k = 2; k <= NF; k++) {
        if ($k ~ /^file/) f = $(k-1); if ($k ~ /^insert/) i = $(k-1); if ($k ~ /^delet/) d = $(k-1)
      }
      printf "%s files changed · +%s / −%s", c(f), c(i), c(d) }')"
  file="${TMPDIR:-/tmp}"; file="${file%/}/cubex-release-$next.md"
  {
    echo "# Cubex $next"
    echo
    echo "**Release date:** $(LC_ALL=C date '+%B %-d, %Y')"
    echo "**Since ${prev:-the first public commit}:** $count commits · $stats"
    echo
    echo '> <!-- TODO: one short paragraph, in plain words: what this release is about. -->'
    echo
    echo '## Highlights'
    echo
    echo '<!-- TODO: the changes people will notice, most important first. One bullet each:'
    echo "- **What changed**: what it means for you. ([abc1234](https://github.com/$CUBEX_REPO/commit/abc1234)) -->"
    echo
    echo '## Fixes'
    echo
    echo '<!-- TODO: bugs fixed, one bullet each, or delete this section. -->'
    echo
    echo '## Security'
    echo
    echo '<!-- TODO: security fixes and who reported them, or delete this section. -->'
    echo
    echo '## Updating'
    echo
    echo '- **One-line install:** run `cubex update`. Your data and settings stay, and if the new version'
    echo "  doesn't start, the previous one comes back."
    echo "- **Docker:** in your checkout, run \`git fetch --tags && git checkout $next\`, then"
    echo '  `docker compose up -d --build`.'
    echo '- **Coolify:** Redeploy.'
    echo
    echo '<details><summary>Every commit in this release</summary>'
    echo
    git log --no-merges --reverse --format="- [%h](https://github.com/$CUBEX_REPO/commit/%H) %s" "$range"
    echo
    echo '</details>'
    echo
    if [ -n "$prev" ]; then
      echo "**Full changelog:** https://github.com/$CUBEX_REPO/compare/$prev...$next"
    else
      echo "**Full changelog:** https://github.com/$CUBEX_REPO/commits/$next"
    fi
  } > "$file"
  echo "Drafted $next notes ($count commits since ${prev:-the start}): $file"
  echo "Fill in every TODO, then: scripts/release.sh cut $next $file"
}

cmd_cut() {
  local tag="${1:-}" notes="${2:-}" prev target drafts
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "give the version as vX.Y.Z, not '$tag'"
  [ -f "$notes" ] || die "notes file not found: '$notes' (make one with: scripts/release.sh notes)"
  ! grep -q '<!-- TODO' "$notes" || die "$notes still has TODOs"
  [ "$(head -n 1 "$notes")" = "# Cubex $tag" ] || die "$notes must start with '# Cubex $tag'"
  fetch_public
  prev="$(latest_tag)" target="$(git rev-parse "$REMOTE/main")"
  if [ -n "$prev" ]; then newer "${tag#v}" "${prev#v}" || die "$tag isn't newer than $prev"; fi
  drafts="$(gh release list --repo "$CUBEX_REPO" --json tagName,isDraft \
    --jq '.[] | select(.isDraft) | .tagName')"
  [ -z "$drafts" ] || die "draft $drafts is still open: let its run finish, or: scripts/release.sh abandon $drafts"
  gh release create "$tag" --repo "$CUBEX_REPO" --draft --target "$target" \
    --title "Cubex $tag" --notes-file "$notes" > /dev/null
  echo "Draft $tag created on main at $(git rev-parse --short "$target")"
  gh workflow run release.yml --repo "$CUBEX_REPO" --ref main -f tag="$tag"
  echo "Release workflow started: it tests that commit, then publishes $tag."
  echo "Watch it: gh run list --repo $CUBEX_REPO --workflow release.yml -L 1  (then gh run watch <id>)"
}

cmd_abandon() {
  local tag="${1:-}"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "give the version as vX.Y.Z, not '$tag'"
  [ "$(gh release view "$tag" --repo "$CUBEX_REPO" --json isDraft --jq .isDraft)" = true ] \
    || die "$tag is published; a published release is never deleted, ship a fix as the next version"
  gh release delete "$tag" --repo "$CUBEX_REPO" --yes
  echo "Deleted the $tag draft. No tag was made; fix main and cut $tag again."
}

REMOTE="$(public_remote)"
case "${1:-}" in
  notes) shift; cmd_notes "$@" ;;
  cut) shift; cmd_cut "$@" ;;
  abandon) shift; cmd_abandon "$@" ;;
  *) sed -n '9,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
