// get_version: the running Cubex version, the latest release the daily check found and whether it is
// newer (services/version-info.ts; GET /v1/version is the same read). With since, also what changed for
// agents in every release after it (services/version-changes.ts, from mcp/agent-changes.ts).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { versionInfo } from '../services/version-info';
import { changesSince } from '../services/version-changes';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { GUIDE_POINTER } from './guides/guide';

export function registerVersionTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_version', {
    description:
      'Which Cubex version this server runs and whether a newer release is out (update_available, '
      + 'latest_release). With since (the version you last used), it adds what changed for agents in every '
      + 'release after it. Call it when a tool you expect is '
      + `missing or the version is not the one you knew. Read-only: costs nothing. ${GUIDE_POINTER}`,
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
