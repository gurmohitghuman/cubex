// What the column, table, sheet and view tools answer (tools-columns.ts, tools-structure.ts, tools-views.ts).
import { z } from 'zod';
import { obj, open } from '../output-schema';
import { bool, changed, info, nul, num, opt, str, strs, trash } from './shared';

export const addColumn = obj({ name: str, description: opt(str), changed });
export const setDescription = obj({
  column: opt(str).describe('Left out for the sheet\'s own'), description: nul(str).describe('null: cleared'),
  changed,
});
export const renameColumn = obj({ name: str, changed });
export const deleteColumn = obj({ deleted: bool, trash, changed });
export const sortSheet = obj({ rows_reordered: num, changed });
export const setColumnOrder = obj({ order: strs, changed });

const sheetRef = obj({ id: str, name: str, position: opt(num), row_count: opt(num) });
// A sheet's incoming webhook (services/sheet-webhook.ts sheetWebhookView).
const sheetWebhook = obj({
  id: str, sheet_id: str, enabled: bool,
  url: nul(str).describe('Where senders POST; null after the first event, or for a key without write'),
  url_hidden: bool, token_required: bool, token_set_at: nul(str),
  column: str, events_received: num, last_event_at: nul(str), last_error: nul(str),
  last_error_at: nul(str), created_at: str, rotated_at: nul(str),
  fields: z.array(obj({ id: str, json_path: str, column: str, as: z.enum(['text', 'json']), created_at: str })),
  auto_delete: nul(obj({
    mode: z.enum(['actions_finish', 'rules']), where: nul(z.array(z.unknown())), keep_rows: num,
    success_column: nul(str), copy_to_sheet_id: nul(str),
    copy_to_sheet: nul(str), paused: nul(str).describe('Why no row leaves until you act'),
    waiting: nul(str).describe('What rows wait for now: a paused auto-run or run'),
    rows_deleted: num, last_deleted_at: nul(str),
  })).describe('null: off'),
});
const madeWebhook = {
  webhook: opt(info('webhook true: the new sheet\'s webhook with its url, as manage_sheet_webhook answers')),
  webhook_error: opt(str).describe('webhook true: why it was not added; the sheet is there'),
};
export const manageSheetWebhook = obj({
  webhook: opt(nul(sheetWebhook)).describe('null: the sheet has none'),
  token: opt(str).describe('new_token: shown once; senders put it in Authorization: Bearer <token>'),
  deleted: opt(bool), changed,
});
// create, rename, star, unstar, delete or create_sample: the fields of that action.
export const manageTable = obj({
  id: opt(str), name: opt(str), starred: opt(bool), sheets: opt(z.array(sheetRef)), deleted: opt(bool),
  trash: opt(trash),
  table: opt(obj({ id: str, name: str })), sheet: opt(sheetRef),
  fictional: opt(str), filled_free: opt(strs),
  duplicates: opt(nul(info('What remove_duplicates would find'))),
  ai_column: opt(info('The AI column made, and how to run it')),
  problems: opt(strs).describe('create_sample: a free step that did not finish; the table is there all the same'),
  ...madeWebhook, changed,
});

// The table's sheets in order: other fields of the sheet too.
const sheetRow = open({ id: str, name: str, position: num });
// A test of the sheet's column changes (manage_sheet's test actions; get_sheet's test).
export const sheetTest = obj({ test_id: str, sheet_id: str, test_sheet_id: str, table_id: str, sheet_name: str,
  rows: num, started_at: str, state: z.enum(['open', 'ending']) });
export const manageSheet = obj({
  sheet: opt(sheetRef), sheets: opt(z.array(sheetRow)).describe('Not for the test actions'), deleted: opt(bool),
  trash: opt(trash), test: opt(sheetTest), added: opt(num).describe('test_add_rows'),
  apply: opt(info('apply_test: what it did or would do')),
  rows_copied: opt(num), columns: opt(strs), list_results_dropped: opt(info('List results that were not added')),
  ...madeWebhook, changed,
});

const view = obj({
  id: str, name: str, description: z.string().nullable(), is_default: bool, active: bool, hidden_columns: strs,
  where: z.array(info('A where item')),
});
export const manageView = obj({ view: opt(view), ok: opt(bool) });
