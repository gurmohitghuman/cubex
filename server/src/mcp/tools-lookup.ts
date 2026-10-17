import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LOOKUP_LIST_MAX } from '../lib/constants';
import { agentLookupColumn } from '../services/lookup-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

// lookup_column: a column filled for free from another sheet, by matching a
// column of this row against a column there (services/lookup-agent.ts).
export function registerLookupTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'lookup_column', {
    description:
      'Fill a column for FREE from ANOTHER sheet (any table): for each row, the value of source_column is '
      + 'matched against match_column of the sheet other_sheet_id, and the column gets: returns "value" = '
      + 'return_column of the first match (top of that sheet first), "exists" = "Yes"/"No", "count" = how many '
      + 'rows match, "list" = the first `limit` matches (1-100, default 10) as a JSON list of objects with '
      + 'return_columns (left out: every column). match "equals" (default) compares whole values; "contains" '
      + 'finds the value anywhere inside the other cell (needs 3+ characters; looks at the first 1,000 '
      + 'characters of each cell). Both ignore case (accented letters too) and surrounding spaces. No AI, no '
      + 'credits. Use it to bring a company\'s data onto its people, check whether a row is already in another '
      + 'list, or count related rows; prefer it over reading both sheets into your context. Status cells '
      + '("⏳ ...", "❌ ...", "⏭️ ...") read as empty on both sides. A row the lookup cannot answer '
      + 'honestly shows '
      + '"❌ <why>" (a contains value under 3 characters; over 10,000 contains matches) and counts in '
      + 'error_rows. The other sheet is read as it is when each row is worked out: later changes there do NOT '
      + 'update the column; call again with the same arguments to look every row up again. auto_run (default '
      + 'true for a new column) re-looks a row up whenever its source_column changes, and new rows. Renaming '
      + 'columns of the other sheet updates the lookup; deleting that sheet or a column it reads stops it '
      + '(broken says why). Writes into column, always a new column (naming a lookup column already there '
      + 'changes it); never the sheet itself. preview:true shows the first rows with their results and writes '
      + 'nothing. Waits for the fill up to 10 seconds; a bigger sheet returns status "filling" (contains on very '
      + 'large sheets can take minutes).',
    inputSchema: z.object({
      sheet_id: z.string().describe('The sheet that gets the lookup column'),
      column: z.string().optional().describe('The lookup column to write; required unless preview is true'),
      source_column: z.string().describe('The column of this sheet holding the value to look up'),
      other_sheet_id: z.string().describe('The sheet to look in (list_tables gives ids); not sheet_id itself'),
      match_column: z.string().describe('The column of the other sheet to match against'),
      match: z.enum(['equals', 'contains']).optional(),
      returns: z.enum(['value', 'exists', 'count', 'list']),
      return_column: z.string().optional().describe('returns "value": the column of the other sheet to write'),
      return_columns: z.array(z.string()).optional()
        .describe('returns "list": the columns each match carries (default: all of them)'),
      limit: z.number().int().min(1).max(LOOKUP_LIST_MAX).optional().describe('returns "list": at most this many'),
      auto_run: lenientBoolean().optional(),
      preview: lenientBoolean().optional(),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentLookupColumn(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
