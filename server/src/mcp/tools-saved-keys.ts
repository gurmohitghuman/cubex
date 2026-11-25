// list_saved_keys: the saved API keys by name and where each is used, never a
// value (services/saved-key-uses.ts; GET /v1/saved-keys is the same read).
// The 'read' scope is enough: a value never leaves Settings, and using a key
// in a new request still needs 'secrets'.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { listSavedKeys } from '../services/saved-key-uses';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { GUIDE_POINTER } from './guides/guide';

export function registerSavedKeyTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'list_saved_keys', {
    description:
      'The saved API keys (Settings > External service keys) by name, never their values, and where each is '
      + 'used: used_in lists the columns whose request names it, and setups the saved setups. Use it to pick a key '
      + 'for a new HTTP request ({{name}} in its URL, '
      + 'headers or body; that needs the secrets scope), or to see what stops working if a key is renamed or '
      + `deleted. Read-only. ${GUIDE_POINTER}`,
    inputSchema: {
      // name and after take any length: each is a saved key's name, and one saved before the cap can be longer.
      name: z.string().min(1).optional().describe('Just this key (any case), with more of its places'),
      after: z.string().min(1).optional().describe('The keys after this name: the next_after of a call'),
    },
  }, async ({ name, after }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = listSavedKeys(ctx.userId, { name, after });
    return 'fail' in out ? err(out.message) : ok(out.ok);
  });
}
