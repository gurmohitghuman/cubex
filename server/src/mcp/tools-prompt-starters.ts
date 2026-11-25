// list_prompt_starters: a sheet's prompt starters (services/prompt-starters-read.ts, the same list as the app's AI
// column dialog), each as run_ai_column's arguments. Read-only; reads the column list, no row.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { sheetPromptStarters, STARTERS_NOTE } from '../services/prompt-starters-read';
import { McpAuthCtx, ok, err, missingScope, registerTool, SHEET_ID } from './tool-helpers';

export function registerPromptStarterTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'list_prompt_starters', {
    description:
      'Good first prompts for an AI column on this sheet, the ones the app offers: qualify (YES or NO), classify, '
      + 'write an opener, lead score 1-10, and a company profile filling several typed columns. Each is written '
      + 'with the sheet\'s own columns as /references, and comes as run_ai_column\'s arguments (run). Fill in the '
      + '[square brackets] (the ideal customer, the categories) before running it. Read-only.',
    inputSchema: z.object({ sheet_id: z.string().describe(SHEET_ID) }).strict(),
  }, async ({ sheet_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const starters = sheetPromptStarters(ctx.userId, sheet_id);
    if (!starters) return err('Sheet not found');
    return ok({ starters, note: STARTERS_NOTE });
  });
}
