import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { DEDUPE_KEEPS, DEDUPE_MATCHES, type DedupeMatch } from '../lib/dedupe/key';
import { agentRemoveDuplicates, dedupeDryRun } from '../services/dedupe-agent';
import { AUTO_DEDUPE_KEEPS, type AutoDedupeKeep } from '../lib/auto-dedupe/key';
import { setAutoDedupe, turnOffAutoDedupe } from '../services/auto-dedupe-setting';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { changedOf } from './changed';
import { GUIDE_POINTER } from './guides/guide';

// remove_duplicates: find duplicate rows, and remove them on an explicit dry_run: false
// (services/dedupe-agent.ts); with keep_doing (set_auto_dedupe before v0.8.47), keep one row per key as rows
// arrive instead (services/auto-dedupe-setting.ts). Each part's fields are exported for REST's bodies
// (openapi/routes-rows.ts), which stay what the two tools took.
const phoneCountry = z.string().length(2).optional().describe('match phone only: how bare digits are read');
export const REMOVE_DUPLICATES_INPUT = {
  sheet_id: z.string().describe(SHEET_ID),
  columns: z.array(z.union([
    z.string(),
    z.object({
      column: z.string().describe('A column name'),
      match: z.enum(DEDUPE_MATCHES).optional().describe('How the column matches; default text'),
      phone_country: phoneCountry,
    }).strict(),
  ])).min(1).describe('The columns rows must all match on: names, or { column, match }'),
  keep: z.enum(DEDUPE_KEEPS).optional().describe('Which row of each group stays; default first'),
  dry_run: lenientBoolean().optional().describe('Default true: report only. false removes the rows'),
};
export const AUTO_DEDUPE_INPUT = {
  column: z.string().optional().describe('The key column (required to turn it on)'),
  match: z.enum(DEDUPE_MATCHES).optional().describe('How the key matches; default text'),
  phone_country: phoneCountry,
  keep: z.enum(AUTO_DEDUPE_KEEPS).optional().describe('Which row of a key stays; default oldest'),
};

export function registerDedupeTool(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'remove_duplicates', {
    description:
      'Find duplicate rows in a sheet and remove them, for FREE (no AI, no credits). Rows are duplicates when '
      + 'every listed column matches, ignoring upper/lower case and extra spaces. Each column can match as text '
      + '(default), email, domain, phone, company or person_name. One row of each group stays: '
      + 'keep first (default, the highest row), last, or most_complete (fills the most cells; the highest of a '
      + 'tie). Works on the whole sheet (filters do not apply). dry_run DEFAULTS TO '
      + 'TRUE: it changes nothing and returns how many rows would go, with sample groups (row ids and the key '
      + 'cells) and the largest group, so you can check what "duplicate" meant. Then call again with dry_run: '
      + 'false to remove. Removed rows go to the trash as one batch, kept for the days set in Settings (30 by '
      + 'default; 0 deletes at once): the answer gives its trash_id, and restore_from_trash puts them back. '
      + 'KEEP_DOING in place of columns keeps ONE row per key as rows arrive from now on (auto-dedupe): { column, '
      + 'match, keep: oldest (default: the new row is not kept) or newest (it replaces the older ones) }; rows '
      + 'already there stay, and false turns it off. '
      + 'Refused while a run is active on the sheet. Prefer it over read_rows plus '
      + `change_rows delete. ${GUIDE_POINTER}`,
    inputSchema: z.object({
      ...REMOVE_DUPLICATES_INPUT,
      columns: REMOVE_DUPLICATES_INPUT.columns.optional()
        .describe('The columns rows must all match on: names, or { column, match }; required unless keep_doing'),
      keep_doing: z.union([z.object(AUTO_DEDUPE_INPUT).strict(), lenientBoolean()]).optional()
        .describe('In place of columns: { column, match, keep } keeps one row per key as rows arrive (fields left '
          + 'out keep what the setting has); false turns it off'),
    }).strict(),
  }, async ({ sheet_id, keep_doing, ...a }) => {
    if (keep_doing !== undefined) return keepDoing(ctx, sheet_id, keep_doing, a);
    const denied = missingScope(ctx, dedupeDryRun(a.dry_run) === false ? 'write' : 'read');
    if (denied) return denied;
    const { columns } = a;
    if (!columns) return err('Pass columns to find duplicates now, or keep_doing to keep one row per key as rows '
      + 'arrive.');
    const out = await agentRemoveDuplicates(ctx.userId, sheet_id, { ...a, columns }, 'mcp');
    if (!('ok' in out)) return err(out.message);
    const removed = 'rows_removed' in out.ok ? out.ok.rows_removed : 0;
    return ok({ ...out.ok, changed: removed ? changedOf(ctx.userId, [{ sheetId: sheet_id, rows: removed }]) : [] });
  });
}

// Auto-dedupe: { column, match, phone_country, keep } turns it on or changes it, false turns it off.
type AutoDedupe = { column?: string; match?: DedupeMatch; phone_country?: string; keep?: AutoDedupeKeep };
function keepDoing(ctx: McpAuthCtx, sheetId: string, setting: AutoDedupe | boolean, others: Record<string, unknown>) {
  const extra = Object.keys(others).filter(k => others[k] !== undefined);
  if (extra.length) {
    return err(`${extra.join(' and ')} ${extra.length > 1 ? 'are' : 'is'} not for keep_doing: it sets auto-dedupe `
      + 'from now on, and rows already there stay. Call once with columns to remove those. Nothing was changed.');
  }
  const denied = missingScope(ctx, 'write');
  if (denied) return denied;
  if (setting === true) {
    return err('keep_doing takes the key: { column, match, keep }, or false to turn it off. Nothing was changed.');
  }
  if (setting === false) {
    const out = turnOffAutoDedupe(ctx.userId, sheetId);
    return 'ok' in out ? ok({ auto_dedupe: null, changed: changedOf(ctx.userId, [{ sheetId }]) })
      : err(out.message);
  }
  const out = setAutoDedupe(ctx.userId, sheetId, setting);
  if (!('ok' in out)) return err(out.message);
  // Rows already there stay; rows that arrived while its keys build are checked once they are.
  const { column, state, waiting_rows } = out.ok;
  return ok({ auto_dedupe: out.ok, changed: changedOf(ctx.userId, [{ sheetId, columns: [column],
    moreComing: state === 'building' && waiting_rows > 0 }]) });
}
