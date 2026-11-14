// The trash and a sheet's change log for agents: list_trash, restore_from_trash
// (services/trash-*.ts; GET /v1/trash and POST /v1/trash/restore are the same)
// and get_sheet_history (services/sheet-history.ts). Deleting for good is only
// in the app.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CHANGE_LOG_DAYS, CHANGE_LOG_PAGE_DEFAULT, CHANGE_LOG_PAGE_MAX, TRASH_IDS_MAX, TRASH_LIST_PAGE,
  TRASH_RESTORE_PICK_MAX, TRASH_ROWS_PAGE_MAX,
} from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { TRASH_HOWS, type TrashHow } from '../lib/trash/store';
import { getTrashEntry, listTrash, readTrashRows } from '../services/trash-read';
import { holdersFirst, restoreFromTrash } from '../services/trash-actions';
import { restoreRows } from '../services/trash-restore';
import { readSheetHistory } from '../services/sheet-history';
import { SHEET_ID, McpAuthCtx, err, lenientInt, missingScope, ok, registerTool } from './tool-helpers';
import { changedOf, type Touch } from './changed';
import type { RestoreResult } from '../services/trash-actions';
import type { RowsRestored } from '../services/trash-restore';

export function registerTrashTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'list_trash', {
    description:
      'What was deleted and can still be restored: batches of rows (delete_rows, remove_duplicates, auto-dedupe, '
      + 'a CSV import that replaced rows, transfer_rows moving rows out, a list job\'s rerun, the app), whole '
      + 'sheets, whole tables and columns (delete_column). Each item has its trash_id, what it was, how and by '
      + 'whom it was deleted, and expires_at (kept for kept_days, set in Settings; then deleted). Without '
      + 'trash_id: the list, newest first (how auto_dedupe with a sheet_id lists what auto-dedupe removed there, '
      + 'one batch a day). With trash_id: that item, and for a batch or a column its rows (cells as they were, '
      + 'seq, row_id, old_row_index) a page at a time, or only rows holding a text (a search reads part of a big '
      + 'batch per call; next_after goes on). A column in state "moving" is still getting its cells: restore it '
      + 'once it reads "kept". Read-only. Next: restore_from_trash.',
    inputSchema: {
      trash_id: lenientInt(1, Number.MAX_SAFE_INTEGER).optional().describe('One item, with its rows'),
      q: z.string().max(200).optional().describe('List: words in a table or sheet name, or the deleting token\'s'),
      kind: z.enum(['rows', 'sheet', 'table', 'column']).optional().describe('List: only this kind of item'),
      how: z.enum(TRASH_HOWS as [TrashHow, ...TrashHow[]]).optional()
        .describe('How it went: grid, api, duplicates, auto_dedupe, import, transfer, rerun, sheet, table or column'),
      sheet_id: z.string().optional().describe('Only batches of rows from this sheet, and the sheet'),
      before: lenientInt(1, Number.MAX_SAFE_INTEGER).optional().describe('List: the next page, below this id'),
      limit: lenientInt(1, TRASH_ROWS_PAGE_MAX).optional()
        .describe(`List: at most ${TRASH_LIST_PAGE} items; rows: at most ${TRASH_ROWS_PAGE_MAX}`),
      after: lenientInt(0, Number.MAX_SAFE_INTEGER).optional().describe('Rows: go on after this seq'),
      column: z.string().optional().describe('Rows: search this column only'),
      contains: z.string().max(500).optional().describe('Rows: only rows holding this text (any case)'),
    },
  }, async (a: {
    trash_id?: number; q?: string; kind?: 'rows' | 'sheet' | 'table' | 'column'; how?: TrashHow; sheet_id?: string;
    before?: number;
    limit?: number; after?: number; column?: string; contains?: string;
  }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (a.trash_id === undefined) {
      return ok(listTrash(ctx.userId, {
        q: a.q, kind: a.kind, how: a.how, sheetId: a.sheet_id, before: a.before,
        limit: Math.min(a.limit ?? TRASH_LIST_PAGE, TRASH_LIST_PAGE),
      }));
    }
    const entry = getTrashEntry(ctx.userId, a.trash_id);
    if (!entry) return err('Nothing in the trash with that trash_id. list_trash shows what is there.');
    if (entry.kind !== 'rows' && entry.kind !== 'column') return ok({ item: entry });
    const rows = readTrashRows(ctx.userId, a.trash_id, {
      after: a.after, limit: a.limit, column: a.column, contains: a.contains,
    });
    if ('fail' in rows) return err(rows.message);
    return ok({ item: entry, ...rows });
  });

  registerTool(server, 'restore_from_trash', {
    description:
      'Put deleted things back from the trash (list_trash shows them). trash_ids restores whole items, tables '
      + 'first, then sheets, then columns and batches of rows, the newest deletion first; trash_id with seqs '
      + `restores only those rows of one batch (at most ${TRASH_RESTORE_PICK_MAX}). A sheet or table comes back as `
      + 'it was (rows, columns, runs, views, webhook), renamed "<name> (restored)" if the name was taken. Rows go '
      + 'back to their old places when the sheet was not sorted, replaced or deduplicated since and the places are '
      + 'free, otherwise to the end in their old order; columns they need are added again (columns_added), and a '
      + 'sheet without room refuses the restore. Rows moved out with transfer_rows stay in their new sheet too. '
      + 'Auto-run does not run restored rows. A column comes back at its old place with its description and '
      + 'setup and auto-run off, renamed "<name> (restored)" if its name was taken (name, renamed): its cells go '
      + 'on the rows that still exist and are empty there (cells_kept counts rows holding a value now, '
      + 'cells_skipped rows that are gone; both stay in the item to restore later). An '
      + 'AI or HTTP API column can then be rerun with control_run and setup.run_id; a clean, formula or lookup '
      + 'column works its rows out again. references_dropped lists what other columns, views and settings said '
      + 'about it that did not come back, each with redo (the tool to set it up again). A column whose request '
      + 'reads saved API keys needs the secrets scope. A refused item is in results with its error; the others '
      + 'still go. Refused while a run is active on the sheet. A big batch answers state "restoring" and finishes '
      + 'in the background. Costs nothing.',
    inputSchema: {
      trash_ids: z.array(lenientInt(1, Number.MAX_SAFE_INTEGER)).min(1).max(TRASH_IDS_MAX).optional()
        .describe(`Whole items to restore, by trash_id (1-${TRASH_IDS_MAX})`),
      trash_id: lenientInt(1, Number.MAX_SAFE_INTEGER).optional().describe('With seqs: the batch to pick from'),
      seqs: z.array(lenientInt(1, Number.MAX_SAFE_INTEGER)).min(1).max(TRASH_RESTORE_PICK_MAX).optional()
        .describe('Rows of the batch, by their seq from list_trash'),
    },
  }, async (a: { trash_ids?: number[]; trash_id?: number; seqs?: number[] }) => {
    const denied = missingScope(ctx, 'write');
    if (denied) return denied;
    if (a.seqs) {
      if (a.trash_id === undefined) return err('seqs go with trash_id: the batch they are in.');
      const out = await restoreRows(ctx.userId, a.trash_id, a.seqs);
      return 'ok' in out ? ok({ ...out.ok, changed: changedOf(ctx.userId, [restoredTouch(out.ok)]) })
        : err(out.message);
    }
    const ids = a.trash_ids ?? (a.trash_id !== undefined ? [a.trash_id] : null);
    if (!ids) return err('Give trash_ids (or trash_id with seqs). list_trash shows what is in the trash.');
    const results = await restoreFromTrash(ctx.userId, holdersFirst(ctx.userId, ids),
      { surface: 'mcp', hasSecretsScope: ctx.scopes.has('secrets') });
    return ok({ results, changed: changedOf(ctx.userId, results.map(r => r.restored && restoredTouch(r.restored))) });
  });

  registerTool(server, 'get_sheet_history', {
    description:
      `A sheet's change log, newest first, kept ${CHANGE_LOG_DAYS} days: columns added, renamed and deleted, `
      + 'runs started and stopped, auto-run and "Only run if" changes, default model, clean, formula and lookup '
      + 'columns, views, its webhook, and rows deleted, restored, imported, sorted, moved and deduplicated. Each '
      + 'line has when (at, UTC), by (the app, an access token by name over the API or MCP, or Cubex itself), '
      + 'action, column, summary and detail; a line about rows or a column deleted to the trash has its trash_id '
      + 'and in_trash: true while that item is in the trash (also while a big column\'s cells are still moving in), '
      + 'false once it is restored or permanently deleted. Read-only. For what was deleted, list_trash.',
    inputSchema: {
      sheet_id: z.string().describe(SHEET_ID),
      column: z.string().optional().describe('Only lines about this column'),
      before: lenientInt(1, Number.MAX_SAFE_INTEGER).optional().describe('The next page, below this change id'),
      limit: lenientInt(1, CHANGE_LOG_PAGE_MAX).optional()
        .describe(`Lines, 1-${CHANGE_LOG_PAGE_MAX} (default ${CHANGE_LOG_PAGE_DEFAULT})`),
    },
  }, async ({ sheet_id, ...a }: { sheet_id: string; column?: string; before?: number; limit?: number }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (!verifySheetOwnership(sheet_id, ctx.userId)) return err('Sheet not found');
    return ok(readSheetHistory(sheet_id, ctx.userId, a));
  });
}

// Rows or a column back in a sheet. A sheet or table back from the trash changes its trash state only.
function restoredTouch(r: NonNullable<RestoreResult['restored']> | RowsRestored): Touch | null {
  if ('kind' in r) {
    if (r.kind !== 'column') return null;
    return { sheetId: r.sheet_id, columns: [r.name], rows: r.cells_restored, moreComing: r.state === 'restoring' };
  }
  return { sheetId: r.sheet_id, columns: r.columns_added, rows: r.rows, moreComing: r.state === 'restoring' };
}
