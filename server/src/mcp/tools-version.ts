// get_version: the running Cubex version, the latest release the daily check found and whether it is
// newer (services/version-info.ts; GET /v1/version is the same read).
import { McpServer } from '@modelcontextprotocol/server';
import { versionInfo } from '../services/version-info';
import { McpAuthCtx, ok, missingScope, registerTool } from './tool-helpers';

export function registerVersionTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_version', {
    description:
      'Which Cubex version this server runs and whether a newer release is out: version (the running '
      + 'release, like "v0.8.12"; null for a build from a branch or a local source, or one that doesn\'t '
      + 'record its version, such as Docker), build (the build as the installer recorded it, null when not '
      + 'recorded), update_check (the daily release check is on; the user turns it off in Settings), '
      + 'latest_release {version, published_at, notes_url, checked_at} (null when the check is off or has no '
      + 'answer yet) and update_available (null when it can\'t be told). Reads what the check kept: it never '
      + 'asks GitHub itself. On a newer release, an install made with the installer updates with '
      + '`cubex update`; others follow the release notes. Read-only: costs nothing.',
    inputSchema: {},
  }, async () => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    return ok(versionInfo(ctx.userId));
  });
}
