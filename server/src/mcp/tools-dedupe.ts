import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEDUPE_KEEPS, DEDUPE_MATCHES } from '../lib/dedupe/key';
import { agentRemoveDuplicates, dedupeDryRun } from '../services/dedupe-agent';
import { AUTO_DEDUPE_KEEPS } from '../lib/auto-dedupe/key';
import { setAutoDedupe, turnOffAutoDedupe } from '../services/auto-dedupe-setting';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

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
    const out = await agentRemoveDuplicates(ctx.userId, sheet_id, a, 'mcp');
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });

  registerTool(server, 'set_auto_dedupe', {
    description:
      'Keep ONE row per key in a sheet as rows arrive, for FREE (no AI, no credits): auto-dedupe. Pick one key '
      + 'column, read the same ways as remove_duplicates (match: text by default, or email, domain, phone, '
      + 'company, person_name). From then on, a row that arrives (a webhook delivery, append_rows, import_csv, '
      + 'transfer_rows, list rows from an enrichment) or whose key someone types in (update_cells, the app) is '
      + 'checked against the rows already there; when another row has the same key, one stays: keep oldest '
      + '(default: the row that was there first stays, the new one is not kept) or newest (the new row replaces '
      + 'the older ones, enriched cells included). Blank keys, run statuses and cells over 200 characters never '
      + 'match. Removed rows go to the trash: list_trash with how auto_dedupe and the sheet_id lists them (one '
      + 'batch a day), and restore_from_trash puts them back (a restore isn\'t checked; a later row with the '
      + 'same key is, against them too). Rows '
      + 'already in the sheet stay as they are when it is turned on: get_sheet\'s auto_dedupe.shared_rows says how '
      + 'many share a key with an older row, and remove_duplicates cleans those up once. The key column must be '
      + 'one rows arrive with: not an AI, HTTP, enrichment, waterfall, clean, formula or lookup column (they fill '
      + 'later). To match a cleaned value, pick the raw column with a match, such as a website column as domain. '
      + 'Values runs write are kept in the index but never remove a row. The answers of append_rows, update_cells, '
      + 'import_csv and transfer_rows say which rows were not kept or were replaced. A big sheet\'s keys take a '
      + 'moment to build (state building); rows arriving meanwhile are checked once they are. Call again to change '
      + 'it (fields left out stay), or off: true to turn it off. Refused while a run is active on the sheet.',
    inputSchema: z.object({
      sheet_id: z.string(),
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
      return 'ok' in out ? ok({ auto_dedupe: null }) : err(out.message);
    }
    const out = setAutoDedupe(ctx.userId, sheet_id, a);
    return 'ok' in out ? ok({ auto_dedupe: out.ok }) : err(out.message);
  });
}
