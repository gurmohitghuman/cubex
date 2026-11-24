import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { DEDUPE_KEEPS, DEDUPE_MATCHES } from '../lib/dedupe/key';
import { agentRemoveDuplicates, dedupeDryRun } from '../services/dedupe-agent';
import { AUTO_DEDUPE_KEEPS } from '../lib/auto-dedupe/key';
import { setAutoDedupe, turnOffAutoDedupe } from '../services/auto-dedupe-setting';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { changedOf } from './changed';

// remove_duplicates: find duplicate rows, and remove them on an explicit
// dry_run: false (services/dedupe-agent.ts). set_auto_dedupe: keep one row per
// key as rows arrive (services/auto-dedupe-setting.ts).
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
      + 'false to remove. Removed rows go to the trash as one batch, kept for the days set in Settings (30 by '
      + 'default; 0 deletes at once): the answer gives its trash_id, and restore_from_trash puts them back. '
      + 'Their AI and HTTP results go. Refused while a run is active on the sheet. Prefer it over read_rows plus '
      + 'delete_rows.',
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      columns: z.array(z.union([
        z.string(),
        z.object({
          column: z.string().describe('A column name'),
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
    const out = await agentRemoveDuplicates(ctx.userId, sheet_id, a, 'mcp');
    if (!('ok' in out)) return err(out.message);
    const removed = 'rows_removed' in out.ok ? out.ok.rows_removed : 0;
    return ok({ ...out.ok, changed: removed ? changedOf(ctx.userId, [{ sheetId: sheet_id, rows: removed }]) : [] });
  });

  registerTool(server, 'set_auto_dedupe', {
    description:
      'Keep ONE row per key in a sheet as rows arrive, for FREE (no AI, no credits). Pick one key column and a '
      + 'match as in remove_duplicates. A row that arrives (webhook, append_rows, import_csv, transfer_rows, '
      + 'enrichment list rows) or whose key is typed in is checked against the rows there; on a match, keep '
      + 'oldest (default: the new row is not kept) or newest (it replaces the older ones, enriched cells '
      + 'included). Blank keys, run statuses and cells over 200 characters never match. Removed rows go to the '
      + 'trash (list_trash with how auto_dedupe; '
      + 'restore_from_trash). Rows already in the sheet stay: get_sheet\'s auto_dedupe.shared_rows counts those '
      + 'sharing a key, and remove_duplicates cleans them once. The key column must be one rows arrive with, not '
      + 'an AI, HTTP, enrichment, waterfall, clean, formula or lookup column; to match a cleaned value, pick the '
      + 'raw column with a match (a website column as domain). The answers of the tools that add or edit rows say '
      + 'which were not kept or were replaced. Call again to change it (fields left out stay). '
      + 'Refused while a run is active on the sheet.',
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      column: z.string().optional().describe('The key column (required to turn it on)'),
      match: z.enum(DEDUPE_MATCHES).optional().describe('How the key matches; default text'),
      phone_country: z.string().length(2).optional().describe('match phone only: how bare digits are read'),
      keep: z.enum(AUTO_DEDUPE_KEEPS).optional().describe('Which row of a key stays; default oldest'),
      off: lenientBoolean().optional().describe('true turns auto-dedupe off'),
    }).strict(),
  }, async ({ sheet_id, off, ...a }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    if (off === true) {
      if (Object.keys(a).length > 0) return err('off: true takes no other field. Nothing was changed.');
      const out = turnOffAutoDedupe(ctx.userId, sheet_id);
      return 'ok' in out ? ok({ auto_dedupe: null, changed: changedOf(ctx.userId, [{ sheetId: sheet_id }]) })
        : err(out.message);
    }
    const out = setAutoDedupe(ctx.userId, sheet_id, a);
    if (!('ok' in out)) return err(out.message);
    // Rows already there stay; rows that arrived while its keys build are checked once they are.
    const { column, state, waiting_rows } = out.ok;
    return ok({ auto_dedupe: out.ok, changed: changedOf(ctx.userId, [{ sheetId: sheet_id, columns: [column],
      moreComing: state === 'building' && waiting_rows > 0 }]) });
  });
}
