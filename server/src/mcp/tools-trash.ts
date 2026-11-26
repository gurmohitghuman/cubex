// The trash and a sheet's change log for agents: list_trash, restore_from_trash
// (services/trash-*.ts; GET /v1/trash and POST /v1/trash/restore are the same)
// and get_sheet's history (services/sheet-history.ts). Deleting permanently is only
// in the app.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  TRASH_IDS_MAX, TRASH_LIST_PAGE,
  TRASH_RESTORE_PICK_MAX, TRASH_ROWS_PAGE_MAX,
} from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { TRASH_HOWS, type TrashHow } from '../lib/trash/store';
import { getTrashEntry, listTrash, readTrashRows } from '../services/trash-read';
import { holdersFirst, restoreFromTrash } from '../services/trash-actions';
import { restoreRows } from '../services/trash-restore';
import { SHEET_ID, McpAuthCtx, err, lenientInt, missingScope, ok, registerTool } from './tool-helpers';
import { changedOf, type Touch } from './changed';
import { GUIDE_POINTER } from './guides/guide';
import type { RestoreResult } from '../services/trash-actions';
import type { RowsRestored } from '../services/trash-restore';

export function registerTrashTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'list_trash', {
    description:
      'What was deleted and can still be restored: batches of rows (change_rows delete, remove_duplicates, '
      + 'auto-dedupe, a CSV import that replaced rows, transfer_rows moving rows out, a list job\'s rerun, the '
      + 'app), whole sheets, whole tables and columns (manage_column delete). Each item has its trash_id, what it '
      + 'was, how and by whom it was deleted, and expires_at (kept for kept_days, set in Settings; then deleted). '
      + 'Without trash_id it lists the items, newest first; with one, that item and its rows. '
      + `Read-only. Next: restore_from_trash. ${GUIDE_POINTER}`,
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
      'Put deleted things back from the trash (list_trash shows them). Costs nothing. trash_ids restores whole '
      + 'items (tables, then sheets, then columns and row batches, newest deletion first); trash_id with seqs '
      + `restores only those rows of one batch (at most ${TRASH_RESTORE_PICK_MAX}). Rows go back to their old places `
      + 'when they can, else to the end; a column comes back with its setup and auto-run off. A column '
      + 'whose request reads saved API keys needs the secrets scope. Refused while a run is active on the sheet. '
      + GUIDE_POINTER,
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
}

// Rows or a column back in a sheet. A sheet or table back from the trash changes its trash state only.
function restoredTouch(r: NonNullable<RestoreResult['restored']> | RowsRestored): Touch | null {
  if ('kind' in r) {
    if (r.kind !== 'column') return null;
    return { sheetId: r.sheet_id, columns: [r.name], rows: r.cells_restored, moreComing: r.state === 'restoring' };
  }
  return { sheetId: r.sheet_id, columns: r.columns_added, rows: r.rows, moreComing: r.state === 'restoring' };
}
