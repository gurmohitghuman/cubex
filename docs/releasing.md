# Releasing Cubex

Pushing to `main` doesn't ship anything to users. A **release** does: a `vX.Y.Z` tag plus a GitHub
release with notes. `cubex update` and the one-line installer install the latest release, so
work can land on `main` in pieces and reach people only when it's ready.

## Versions

Semantic versions, `vMAJOR.MINOR.PATCH`, starting at `v0.1.0`:

- **patch** (`v0.1.0` → `v0.1.1`): fixes and small improvements. The usual release.
- **minor** (`v0.1.1` → `v0.2.0`): a new feature people will notice, or a change they need to
  know about (a new setting, a changed default).
- **major**: reserved for after `v1.0.0`; until then, breaking changes go in a minor release and
  say so at the top of the notes.

The tag is the version. Nothing on `main` holds a version number, so there is nothing to bump.

## Cut a release

From a checkout with a remote pointing at `github.com/gurmohitghuman/cubex` and an authenticated `gh`:

1. **Draft the notes.** `scripts/release.sh notes` (or `notes minor`) works out the next version
   from the newest published tag, and writes a notes file with the date, the stats since the
   last release, every commit, and the "Updating" section. It prints the file's path.
2. **Write the notes.** Fill in every `<!-- TODO -->`: a short summary, the highlights, fixes and
   security fixes. Delete a section that has nothing in it. See [Writing the notes](#writing-the-notes).
3. **Cut it.** `scripts/release.sh cut vX.Y.Z <notes file>`. It creates a **draft** release on
   the current `main` commit and starts the **Release** workflow.
4. **Watch it.** The workflow runs CI (typecheck, unit tests, build) and installs Cubex with the
   one-line installer on that exact commit. When both pass it publishes the draft, which
   creates the tag and marks it the latest release. `cubex update` picks it up at once.

If the workflow fails, nothing was tagged. Fix `main`, then `scripts/release.sh abandon vX.Y.Z`
and cut the same version again. Only one draft can be open at a time.

Never publish a draft by hand from GitHub: that skips the tests. A published release is never
deleted or re-tagged; a bad release is fixed by the next one.

## Writing the notes

The notes are for people running Cubex, not for us. Start from what changed for them:

- **Summary:** one short paragraph. What this release is about, in plain words.
- **Highlights:** most important first. `- **What changed**: what it means for you.` and a link
  to the commit. Say what someone can now do, not which file moved.
- **Fixes:** what was broken and now works, from the user's side ("Rerun now works on
  multi-column runs"), not the cause.
- **Security:** every security fix, how serious it was, and who reported it.
- **Breaking changes**, if any, go first, under their own heading, with what to do.

Plain words, short sentences, no em dashes. Leave the stats line, "Updating", the commit list
and the changelog link as the script wrote them.

## How it works

- `scripts/release.sh` only ever talks to the public repository, through whichever git remote
  points at it, so a release can't land on another remote.
- `.github/workflows/release.yml` runs by hand (`workflow_dispatch`) with the version. It
  refuses a release that's already published or a commit that isn't on `main`, calls `ci.yml`
  on that commit, runs the installer, then publishes the draft and checks the tag landed on
  the tested commit.
- `install.sh` installs `stable` by default: it follows `github.com/<repo>/releases/latest` to
  the newest tag (or `main` while there is no release yet). `--ref main` or `--ref vX.Y.Z` pins
  an install to a branch or tag, and `cubex update` keeps that choice. Installs made before
  releases existed recorded `main`; they move to `stable` on their next update.
