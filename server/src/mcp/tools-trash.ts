// The trash and a sheet's change log for agents: list_trash, restore_from_trash
// (services/trash-*.ts; GET /v1/trash and POST /v1/trash/restore are the same)
// and get_sheet_history (services/sheet-history.ts). Deleting for good is only
// in the app.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CHANGE_LOG_DAYS, CHANGE_LOG_PAGE_MAX, TRASH_IDS_MAX, TRASH_LIST_PAGE, TRASH_RESTORE_PICK_MAX, TRASH_ROWS_PAGE_MAX,
} from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { TRASH_HOWS, type TrashHow } from '../lib/trash/store';
import { getTrashEntry, listTrash, readTrashRows } from '../services/trash-read';
import { holdersFirst, restoreFromTrash } from '../services/trash-actions';
import { restoreRows } from '../services/trash-restore';
import { readSheetHistory } from '../services/sheet-history';
import { McpAuthCtx, err, lenientInt, missingScope, ok, registerTool } from './tool-helpers';

export function registerTrashTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'list_trash', {
    description:
      'What was deleted and can still be restored: batches of rows (from delete_rows, remove_duplicates, '
      + 'auto-dedupe, a CSV import that replaced the rows, transfer_rows moving rows out, or the app), whole '
      + 'sheets and whole tables. '
      + 'Each item has its trash_id, what it was (table_name, sheet_name, rows), how and by whom it was deleted, '
      + 'and expires_at (kept for kept_days, set in Settings; then deleted). Without trash_id: the list, '
      + 'newest first (q finds words in a table or sheet name or the token that deleted it; kind, how and '
      + 'sheet_id narrow it: how auto_dedupe with a sheet_id lists the rows auto-dedupe removed there, one '
      + 'batch a day; before pages on). With trash_id: that item, and for a batch its rows (cells as they were, seq, '
      + 'row_id, old_row_index), a page at a time (after), or only rows whose column (or any cell, without one) '
      + 'contains a text: a search reads part of a big batch per call and next_after goes on. Read-only.',
    inputSchema: {
      trash_id: lenientInt(1, Number.MAX_SAFE_INTEGER).optional().describe('One item, with its rows'),
      q: z.string().max(200).optional(),
      kind: z.enum(['rows', 'sheet', 'table']).optional(),
      how: z.enum(TRASH_HOWS as [TrashHow, ...TrashHow[]]).optional()
        .describe('How it went: grid, api, duplicates, auto_dedupe, import, transfer, sheet or table'),
      sheet_id: z.string().optional().describe('Only batches of rows from this sheet, and the sheet'),
      before: lenientInt(1, Number.MAX_SAFE_INTEGER).optional().describe('List: the next page, below this id'),
      limit: lenientInt(1, TRASH_ROWS_PAGE_MAX).optional()
        .describe(`List: at most ${TRASH_LIST_PAGE} items; rows: at most ${TRASH_ROWS_PAGE_MAX}`),
      after: lenientInt(0, Number.MAX_SAFE_INTEGER).optional().describe('Rows: go on after this seq'),
      column: z.string().optional().describe('Rows: search this column only'),
      contains: z.string().max(500).optional().describe('Rows: only rows holding this text (any case)'),
    },
  }, async (a: {
    trash_id?: number; q?: string; kind?: 'rows' | 'sheet' | 'table'; how?: TrashHow; sheet_id?: string;
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
    if (entry.kind !== 'rows') return ok({ item: entry });
    const rows = readTrashRows(ctx.userId, a.trash_id, {
      after: a.after, limit: a.limit, column: a.column, contains: a.contains,
    });
    if ('fail' in rows) return err(rows.message);
    return ok({ item: entry, ...rows });
  });

  registerTool(server, 'restore_from_trash', {
    description:
      'Puts deleted things back from the trash (list_trash shows them): trash_ids restores whole items, tables '
      + 'first, then sheets, then batches of rows. A sheet or table comes back as it was (rows, columns, runs, '
      + 'views, webhook), renamed "<name> (restored)" if its name was taken meanwhile. A batch of rows goes back '
      + 'to the old places when the sheet was not sorted, replaced or deduplicated since and those places are '
      + 'free, otherwise to the end of the sheet in the order they had; columns they need that the sheet lost are '
      + 'added again (columns_added), and a sheet without room for them refuses the restore (no cell is left out). '
      + 'Rows moved out with transfer_rows are still in their new sheet: restoring them keeps both (the item\'s '
      + 'note says so). Auto-run does not run restored rows. With trash_id and seqs: only those '
      + `rows of one batch (at most ${TRASH_RESTORE_PICK_MAX}). Refused while a run is active on the sheet. A big `
      + 'batch answers state "restoring" and finishes in the background. Costs nothing.',
    inputSchema: {
      trash_ids: z.array(lenientInt(1, Number.MAX_SAFE_INTEGER)).min(1).max(TRASH_IDS_MAX).optional(),
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
      return 'ok' in out ? ok(out.ok) : err(out.message);
    }
    const ids = a.trash_ids ?? (a.trash_id !== undefined ? [a.trash_id] : null);
    if (!ids) return err('Give trash_ids (or trash_id with seqs). list_trash shows what is in the trash.');
    return ok({ results: await restoreFromTrash(ctx.userId, holdersFirst(ctx.userId, ids)) });
  });

  registerTool(server, 'get_sheet_history', {
    description:
      `A sheet's change log, newest first, kept ${CHANGE_LOG_DAYS} days: columns added, renamed and deleted, `
      + 'runs started and stopped, auto-run and "Only run if" changes, default model, clean, formula and lookup '
      + 'columns, views, its webhook, and rows deleted, restored, imported, sorted, moved and deduplicated. Each '
      + 'line has when (at, UTC), by (the app, an access token by name over the API or MCP, or Cubex itself), '
      + 'action, column, summary and detail; a line about rows in the trash has in_trash and its trash_id. '
      + 'column narrows to one column; before pages on. Read-only.',
    inputSchema: {
      sheet_id: z.string(),
      column: z.string().optional(),
      before: lenientInt(1, Number.MAX_SAFE_INTEGER).optional().describe('The next page, below this change id'),
      limit: lenientInt(1, CHANGE_LOG_PAGE_MAX).optional(),
    },
  }, async ({ sheet_id, ...a }: { sheet_id: string; column?: string; before?: number; limit?: number }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (!verifySheetOwnership(sheet_id, ctx.userId)) return err('Sheet not found');
    return ok(readSheetHistory(sheet_id, ctx.userId, a));
  });
}
