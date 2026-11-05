// list_saved_keys: the saved API keys by name and where each is used, never a
// value (services/saved-key-uses.ts; GET /v1/saved-keys is the same read).
// The 'read' scope is enough: a value never leaves Settings, and using a key
// in a new request still needs 'secrets'.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listSavedKeys } from '../services/saved-key-uses';
import { SAVED_KEY_USES_LISTED } from '../lib/api-v1-constants';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

export function registerSavedKeyTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'list_saved_keys', {
    description:
      'The saved API keys (Settings > External service keys) by name, never their values: for each, '
      + 'created_at and updated_at (UTC), and where it is used: used_in lists each HTTP API, enrichment or '
      + 'waterfall column whose request names the key (sheet_id, sheet_name, table_id, table_name, column, kind, '
      + 'and auto_run when the column fills new rows on its own), and setups the saved setups that name it '
      + `(at most ${SAVED_KEY_USES_LISTED} of each; used_in_count and setups_count are whole). Sheets in the trash `
      + 'are left out. Use it to pick a key for a new HTTP request ({{name}} in its URL, headers or body; '
      + 'that needs the secrets scope), or to see what stops working if a key is renamed or deleted. '
      + 'name narrows it to one key. Read-only.',
    inputSchema: {
      name: z.string().min(1).max(200).optional().describe('Just this key (any case)'),
    },
  }, async ({ name }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = listSavedKeys(ctx.userId, name);
    return 'fail' in out ? err(out.message) : ok(out.ok);
  });
}
