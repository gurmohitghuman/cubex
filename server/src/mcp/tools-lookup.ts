import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { LOOKUP_LIST_MAX } from '../lib/constants';
import { agentLookupColumn } from '../services/lookup-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { fillChanged } from './changed';
import { GUIDE_POINTER } from './guides/guide';

// lookup_column: a column filled for free from another sheet, by matching a
// column of this row against a column there (services/lookup-agent.ts).
export function registerLookupTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'lookup_column', {
    description:
      'Fill a column for FREE from ANOTHER sheet (any table): each row\'s source_column is matched against '
      + 'match_column of other_sheet_id, and the column gets the first match\'s value, Yes/No, a count or a list '
      + '(returns). No AI, no credits. Use it to bring a company\'s data onto its people, check whether a row is '
      + 'already in another list, or count related rows, rather than reading both sheets into your context. '
      + 'The other sheet is read as it is when each row is '
      + 'worked out: later changes there do NOT update the column (call again to look every row up again). '
      + 'Writes into column, always a new column (naming a lookup column already there changes it). '
      + 'Waits for the fill up to 10 seconds; a bigger sheet returns status "filling" (contains on very large '
      + 'sheets can take minutes). Returns filled_rows and error_rows. Next: read_rows to '
      + `check it. ${GUIDE_POINTER}`,
    inputSchema: z.object({
      sheet_id: z.string().describe('The sheet that gets the lookup column'),
      column: z.string().optional().describe('The lookup column to write; required unless preview is true'),
      source_column: z.string().describe('The column of this sheet holding the value to look up'),
      other_sheet_id: z.string().describe('The sheet to look in (list_tables gives ids); not sheet_id itself'),
      match_column: z.string().describe('The column of the other sheet to match against'),
      match: z.enum(['equals', 'contains']).optional()
        .describe('equals (default): whole values; contains: the value anywhere in the other cell (3+ characters; '
          + 'the first 1,000 characters of each cell)'),
      returns: z.enum(['value', 'exists', 'count', 'list'])
        .describe('value: return_column of the first match (top of that sheet first); exists: "Yes" or "No"; '
          + 'count: how many rows match; list: the first limit matches as a JSON list of objects'),
      return_column: z.string().optional().describe('returns "value": the column of the other sheet to write'),
      return_columns: z.array(z.string()).optional()
        .describe('returns "list": the columns each match carries (default: all of them)'),
      limit: z.number().int().min(1).max(LOOKUP_LIST_MAX).optional()
        .describe(`returns "list": at most this many, 1-${LOOKUP_LIST_MAX} (default 10)`),
      auto_run: lenientBoolean().optional()
        .describe('Default true for a new column: new rows, and rows whose source_column changes, are looked up '
          + 'on their own'),
      preview: lenientBoolean().optional().describe('true: show the first rows with their results; write nothing'),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    const out = await agentLookupColumn(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok({ ...out.ok, changed: fillChanged(ctx.userId, sheet_id, out.ok) }) : err(out.message);
  });
}
