// get_tool_guide: a tool's guide, the details its description leaves out (services/tool-guide.ts, from
// mcp/guides). Read-only; the scope check stays the first statement.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { toolGuide } from '../services/tool-guide';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { GUIDE_POINTER } from './guides/guide';

export function registerToolGuideTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_tool_guide', {
    description:
      `The full details of a tool whose description ends with "${GUIDE_POINTER}": its edge cases, examples, `
      + 'long lists and rarer limits, and the whole notes of its long input fields. Read it before a first call '
      + 'of a paid or destructive tool, and after a call is refused. Without tool, it lists the tools that have '
      + 'a guide. Read-only: costs nothing.',
    inputSchema: {
      tool: z.string().max(200).optional()
        .describe('A tool\'s name, e.g. run_ai_column. Omit it for the list of tools that have a guide.'),
    },
  }, async ({ tool }: { tool?: string }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = toolGuide(tool);
    return 'error' in out ? err(out.error) : ok(out.ok);
  });
}
