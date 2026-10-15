import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEDUPE_KEEPS, DEDUPE_MATCHES } from '../lib/dedupe/key';
import { agentRemoveDuplicates, dedupeDryRun } from '../services/dedupe-agent';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

// remove_duplicates: find duplicate rows, and remove them on an explicit
// dry_run: false (services/dedupe-agent.ts).
export function registerDedupeTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'remove_duplicates', {
    description:
      'Find duplicate rows in a sheet and remove them, for FREE (no AI, no credits). Rows are duplicates when '
      + 'every listed column matches, ignoring upper/lower case and extra spaces. Each column can match as: text '
      + '(default), email, domain ("https://www.acme.com/x", "jo@acme.com" and "acme.com" all match; a free '
      + 'email address such as Gmail never matches by domain, and a page on a shared site such as '
      + 'facebook.com/acme matches only the same page), phone (any format, an extension kept apart; '
      + 'phone_country, default US, says how bare digits are read), company (ignores Inc, LLC, Corp and other '
      + 'legal endings) or person_name ("Smith, John" matches "John Smith"; Jr and Sr kept apart). One row of '
      + 'each group stays: '
      + 'keep first (default, the highest row), last, or most_complete (fills the most cells; the highest of a '
      + 'tie). A row with any listed column empty, unreadable as its match, or holding a run status such as '
      + '"⏭️ Not found" is never removed. Works on the whole sheet (filters do not apply). dry_run DEFAULTS TO '
      + 'TRUE: it changes nothing and returns how many rows would go, with sample groups (row ids and the key '
      + 'cells) and the largest group, so you can check what "duplicate" meant. Then call again with dry_run: '
      + 'false to remove. REMOVED ROWS ARE DELETED PERMANENTLY, with their AI and HTTP results; this cannot be '
      + 'undone. Refused while a run is active on the sheet. Prefer it over read_rows plus delete_rows.',
    inputSchema: z.object({
      sheet_id: z.string(),
      columns: z.array(z.union([
        z.string(),
        z.object({
          column: z.string(),
          match: z.enum(DEDUPE_MATCHES).optional().describe('How the column matches; default text'),
          phone_country: z.string().length(2).optional().describe('match phone only: how bare digits are read'),
        }).strict(),
      ])).min(1).describe('The columns rows must all match on: names, or { column, match }'),
      keep: z.enum(DEDUPE_KEEPS).optional().describe('Which row of each group stays; default first'),
      dry_run: lenientBoolean().optional().describe('Default true: report only. false removes the rows'),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, dedupeDryRun(a.dry_run) === false ? 'write' : 'read');
    if (denied) return denied;
    const out = await agentRemoveDuplicates(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
