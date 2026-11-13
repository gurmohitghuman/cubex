// Reading the changes file (mcp/agent-changes.ts): what get_version's since and GET /v1/version?since=
// answer, the lines the MCP instructions carry for the running release, and what a call to a removed or
// renamed tool is told (mcp/replaced-tools.ts).
import { CUBEX_RELEASES_PAGE } from '../lib/constants';
import { compareVersions, parseTag, runningBuild } from '../lib/cubex-version';
import { AGENT_CHANGES, CHANGES_RECORDED_AFTER, AgentChange, ReleaseChanges } from '../mcp/agent-changes';

export interface ChangesSince {
  since: string;
  // Every release after since, oldest first, so they read in the order they happened.
  releases: ReleaseChanges[];
  // Set when since is older than the first release the file covers.
  note?: string;
}

const SINCE_SHOWN = 40;
// The running release's changes the instructions name; the rest are behind get_version.
const NOTE_CHANGES = 3;

const newer = (a: string, b: string) => compareVersions(parseTag(a)!, parseTag(b)!) > 0;

// What changed for agents after since (a release, "v0.8.12" or "0.8.12"), or the sentence that says what
// to send instead. since is checked here, not in a schema, so REST and MCP refuse it in the same words.
export function changesSince(since: unknown, list: ReleaseChanges[] = AGENT_CHANGES):
  { ok: ChangesSince } | { error: string } {
  const tag = typeof since === 'string' && since.length <= SINCE_SHOWN ? parseTag(since) : null;
  if (!tag) {
    const got = typeof since === 'string' ? `"${since.slice(0, SINCE_SHOWN)}"` : `a ${Array.isArray(since)
      ? 'list' : typeof since}`;
    return { error: `since must be a Cubex release like "v0.8.12", not ${got}. A build that is not a release `
      + 'has no place in the list: pass the last release you used.' };
  }
  const from = `v${tag.major}.${tag.minor}.${tag.patch}`;
  const releases = list.filter(r => newer(r.version, from)).reverse();
  const covered = !newer(CHANGES_RECORDED_AFTER, from);
  return { ok: { since: from, releases, ...(covered ? {} : { note: `Changes are listed for the releases after `
    + `${CHANGES_RECORDED_AFTER} only. For earlier ones, read the release notes: ${CUBEX_RELEASES_PAGE}` }) } };
}

// For the MCP instructions: the running release and what changed for agents in it, in a few lines.
export function versionNote(running = runningBuild(), list: ReleaseChanges[] = AGENT_CHANGES): string {
  const after = 'After an update, get_version with since set to the version you last used lists every change '
    + 'for agents after it. ';
  if (!running.version) {
    return (running.build ? `This server runs a Cubex build that is not a release (${running.build}). `
      : 'This server does not record its Cubex version. ') + after;
  }
  const changes = list.find(r => r.version === running.version)?.changes ?? [];
  if (!changes.length) return `This server runs Cubex ${running.version}, with no changes for agents. ` + after;
  const shown = changes.slice(0, NOTE_CHANGES).map(c => c.summary).join(' ');
  const more = changes.length > NOTE_CHANGES ? ` And ${changes.length - NOTE_CHANGES} more.` : '';
  return `This server runs Cubex ${running.version}. New for agents in it: ${shown}${more} ` + after;
}

function replacedMessage(tool: string, version: string, c: AgentChange): string {
  const what = c.change === 'renamed'
    ? `${tool} was renamed to ${c.replaced_by} in Cubex ${version}: call ${c.replaced_by} instead.`
    : `${tool} was removed in Cubex ${version}.${c.replaced_by ? ` Call ${c.replaced_by} instead.` : ''}`;
  return `${what} ${c.details ?? c.summary} Your tool list is older than this server: list the tools again.`;
}

// Each tool a release removed or renamed, with what its caller is told. Read oldest first, so a name a
// later release brings back as a tool is no longer answered this way.
export function replacedTools(list: ReleaseChanges[] = AGENT_CHANGES): Map<string, string> {
  const replaced = new Map<string, string>();
  for (const release of [...list].reverse()) {
    for (const c of release.changes) {
      for (const tool of c.tools ?? []) {
        if (c.change === 'added') replaced.delete(tool);
        if (c.change === 'removed' || c.change === 'renamed') {
          replaced.set(tool, replacedMessage(tool, release.version, c));
        }
      }
      if (c.replaced_by) replaced.delete(c.replaced_by);
    }
  }
  return replaced;
}
