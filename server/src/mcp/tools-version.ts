// get_version: the running Cubex version, the latest release the daily check found and whether it is
// newer (services/version-info.ts; GET /v1/version is the same read). With since, also what changed for
// agents in every release after it (services/version-changes.ts, from mcp/agent-changes.ts).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { versionInfo } from '../services/version-info';
import { changesSince } from '../services/version-changes';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

export function registerVersionTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_version', {
    description:
      'Which Cubex version this server runs and whether a newer release is out: version (the running '
      + 'release, like "v0.8.12"; null for a build from a branch or a local source, or one that doesn\'t '
      + 'record its version, such as Docker), build (the build as the installer recorded it, null when not '
      + 'recorded), pinned_ref (an install made with --ref stays on that ref: `cubex update` reinstalls it, and '
      + 'getting newer releases needs the install command run again without --ref; null otherwise), '
      + 'update_check (the daily release check is on; the user turns it off in Settings), '
      + 'latest_release {version, published_at, notes_url, checked_at} (null when the check is off or has no '
      + 'answer yet) and update_available (null when it can\'t be told). Reads what the check kept: it never '
      + 'asks GitHub itself. On a newer release, an install made with the installer and not pinned updates with '
      + '`cubex update`; others follow the release notes. '
      + 'With since (the version you last used), it adds changes_since {since, releases: [{version, changes: '
      + '[{change: added, changed, removed, renamed or server, tools, replaced_by, summary, details}]}], note}: '
      + 'what changed for agents in every release after it, oldest first. Call it when a tool you expect is '
      + 'missing or the version is not the one you knew. Read-only: costs nothing.',
    inputSchema: {
      since: z.string().optional()
        .describe('A Cubex release, like "v0.8.12": the answer then lists what changed for agents after it.'),
    },
  }, async ({ since }: { since?: string }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const info = versionInfo(ctx.userId);
    if (since === undefined) return ok(info);
    const changes = changesSince(since);
    return 'error' in changes ? err(changes.error) : ok({ ...info, changes_since: changes.ok });
  });
}
