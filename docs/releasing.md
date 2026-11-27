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

The tag is the version. Nothing on `main` holds the version Cubex runs, so there is nothing to bump.
The one file that names releases is the list of [changes for agents](#changes-for-agents).

## Cut a release

From a checkout with a remote pointing at `github.com/gurmohitghuman/cubex` and an authenticated `gh`:

1. **Draft the notes.** `scripts/release.sh notes` (or `notes minor`) works out the next version
   from the newest published tag, and writes a notes file with the date, the stats since the
   last release, every commit, and the "Updating" section. It prints the file's path.
2. **Write the notes.** Fill in every `<!-- TODO -->`: a short summary, the highlights, fixes and
   security fixes. Delete a section that has nothing in it. See [Writing the notes](#writing-the-notes).
3. **Record the tool list** in a small pull request, when the release has
   [changes for agents](#changes-for-agents), and merge it before the cut.
4. **Cut it.** `scripts/release.sh cut vX.Y.Z <notes file>`. It creates a **draft** release on
   the current `main` commit and starts the **Release** workflow.
5. **Watch it.** The workflow runs CI (typecheck, unit tests, build), packages `server/dist` and
   `client/dist` (`cubex-dist.tar.gz` and `cubex-dist.tar.gz.sha256`), installs Cubex from that
   archive on Linux and Windows (as `cubex update` installs a release), and installs it with the
   one-line installer on that exact commit. When all pass it attaches the built archive and
   publishes the draft, which creates the tag and marks it the latest release. `cubex update`
   picks it up at once.

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

## Changes for agents

`server/src/mcp/agent-changes.ts` lists, release by release, what changed for AI agents that use
Cubex over MCP: tools added, changed, removed or renamed, and changes to the server's answers. The
MCP instructions show the running release's lines, `get_account` (action `version`) with `since` lists them, and a
call to a removed or renamed tool is told what replaced it ([MCP](mcp.md#after-an-update)).

- **A change to a tool** adds its line under the next release: the one already listed after the
  newest tag, or else the next patch after that tag. Once a release's list is recorded (just
  before its cut), a new line goes under the next patch after it. The unit test
  `tests/unit/mcp-tool-list.test.ts` compares every tool's name and input schema with the list
  recorded last (`tests/unit/mcp-tool-list.json`), and fails on a change with no line. Where the
  checkout has the release tags, it names the release to use.
- **A release's lines stay as it shipped them.** A change made after a release goes under the
  next one, even when it fixes something that release added, and a release that shipped no lines
  gets none afterwards. `scripts/release.sh cut` refuses when what the last tag shipped of the
  file was changed, and so do the unit test (where the checkout has the tags) and the recording.
- **Cutting a release** whose lines sit under another number (a minor release, say): rename them
  to the release on `main` first. `scripts/release.sh cut` refuses until they match.
- **Before cutting a release with lines**, record its tool list in a small pull request, from an
  up-to-date `main` with the tags fetched (`git fetch --tags`):
  `MCP_TOOL_LIST_RECORD=vX.Y.Z npm run test:unit -- mcp-tool-list`. vX.Y.Z is the release the
  changes file lists after the newest tag. It reads the tools from this checkout's code and checks
  them against the list recorded for the release before it, and writes the file only when the
  release's lines match. The file also keeps what those lines name (changes and tools, not their
  wording), and the unit test fails if they change afterwards. `scripts/release.sh cut` refuses a
  release with lines until `main` records its list, and the Release workflow's CI then proves the
  release commit's tools are the ones recorded. So a release is never out without its list.
- **A tool change merged after the recording** gets its line under the next patch, and the cut
  refuses that. Move the line under the release being cut and record it again: until its tag, a
  release can be recorded again (or under a new number), checked against the release before it.
- **A release cut without its list** (an older release) is recorded from its own code instead:
  the same command with a release that is already a tag reads it from a temporary checkout of
  that tag, whatever has merged since. Until it is recorded, the unit test refuses lines for the
  next release, and where the checkout has the tags it asks for the recording at once.

## How it works

- `scripts/release.sh` only ever talks to the public repository, through whichever git remote
  points at it, so a release can't land on another remote.
- `.github/workflows/release.yml` runs by hand (`workflow_dispatch`) with the version. It
  refuses a release that's already published or a commit that isn't on `main`, calls `ci.yml`
  on that commit, builds and checksums `cubex-dist.tar.gz` (`scripts/pack-dist.sh`), installs
  from it (`install-dist.yml` serves it on 127.0.0.1 for `CUBEX_DIST_URL`), runs the installer,
  then attaches `cubex-dist.tar.gz` and `cubex-dist.tar.gz.sha256`, publishes the draft, and
  checks the tag landed on the tested commit.
- `install.sh` installs `stable` by default: it follows `github.com/<repo>/releases/latest` to
  the newest tag (or `main` while there is no release yet). `--ref main` or `--ref vX.Y.Z` pins
  an install to a branch or tag, and `cubex update` keeps that choice. Installs made before
  releases existed recorded `main`; they move to `stable` on their next update.
