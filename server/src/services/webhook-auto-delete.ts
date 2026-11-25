// Auto-delete on a webhook sheet (docs/webhooks.md#auto-delete): the sheet keeps its newest keep_rows rows (100
// unless told), and older rows the webhook added (its 📥 mark) leave once every auto-run column has run on them,
// deleted at once rather than put in the trash. Rows go on to other tools through the sheet's own columns: an
// HTTP API column with auto-run that sends each row, picked as the success column, so a row stays until it has
// sent it. Since no column sends rows to another sheet, copy_to_sheet_id copies them there first, in the same
// transaction. A second mode deletes rows once they pass rules (a where in read_rows' language, migration 074)
// instead of waiting for every auto-run column. The rows leave in
// services/webhook-auto-delete-sweep.ts. One per webhook (migration 073); it goes with the webhook.
// A change keeps what it leaves out, as auto-dedupe's does; null clears success_column or copy_to_sheet_id.
import { db } from '../lib/db';
import { AUTO_DELETE_KEEP_DEFAULT, AUTO_DELETE_KEEP_MAX } from '../lib/constants';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { countOf, logSheetChange } from '../lib/change-log';
import type { WebhookSourceFull } from '../lib/webhook-service';
import type { WhereItem } from '../lib/row-filter/where';
import { autoDeleteRulesWords, checkAutoDeleteRules } from './webhook-auto-delete-rules';

export interface AutoDeleteRow {
  source_id: string; user_id: string; sheet_id: string; mode: string; keep_rows: number;
  success_column: string | null; copy_to_sheet_id: string | null; row_generation_seen: number;
  where_json: string | null;
  paused_reason: string | null; paused_message: string | null; paused_at: string | null; rows_deleted: number;
  last_deleted_at: string | null; updated_at: string;
}

export type AutoDeleteMode = 'actions_finish' | 'rules';

export interface AutoDeleteView {
  // When rows leave: once every auto-run column has run on them (actions_finish), or once they pass `where`
  // (rules).
  mode: AutoDeleteMode;
  where: WhereItem[] | null;
  // The newest rows that always stay.
  keep_rows: number;
  // actions_finish: a row leaves only once this column holds a result (not empty, not ⏳, ❌ or ⏭️).
  success_column: string | null;
  // Rows are copied to this sheet before they leave; copy_to_sheet is its name.
  copy_to_sheet_id: string | null;
  copy_to_sheet: string | null;
  // Why no row leaves until the person acts (a success column or destination that is gone, a full destination,
  // rows moved by a sort or an import).
  paused: string | null;
  // What rows wait for now, when it is something the person may want to know (a paused auto-run or run).
  waiting: string | null;
  rows_deleted: number;
  last_deleted_at: string | null;
}

export type AutoDeleteFail = { fail: 'bad_request'; message: string };

export const autoDeleteOf = (sourceId: string): AutoDeleteRow | undefined =>
  db.prepare('SELECT * FROM webhook_auto_delete WHERE source_id = ?').get(sourceId) as AutoDeleteRow | undefined;

const sheetName = (sheetId: string, userId: string): string | null =>
  (db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').pluck()
    .get(sheetId, userId) as string | undefined) ?? null;

// A paused auto-run column holds the rows it hasn't run, and a paused run keeps auto-delete out of the sheet:
// rows wait with nothing wrong in auto-delete, so it isn't a pause of its own, but the panel says so.
function waitingFor(row: AutoDeleteRow): string | null {
  // In mode rules rows don't wait for auto-run.
  const paused = row.mode === 'rules' ? undefined : db.prepare(`SELECT status_column FROM autorun_columns
    WHERE sheet_id = ? AND user_id = ?
    AND enabled = 1 AND paused_reason IS NOT NULL ORDER BY status_column LIMIT 1`).pluck()
    .get(row.sheet_id, row.user_id) as string | undefined;
  if (paused !== undefined) return `Auto-run on "${paused}" is paused: rows wait until it has run them.`;
  const run = db.prepare(`SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ? AND status = 'paused'
    UNION ALL SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND status = 'paused' LIMIT 1`)
    .get(row.sheet_id, row.user_id, row.sheet_id, row.user_id);
  return run ? 'A run on this sheet is paused: no row leaves until it is resumed or cancelled.' : null;
}

export function autoDeleteView(sourceId: string): AutoDeleteView | null {
  const row = autoDeleteOf(sourceId);
  if (!row) return null;
  return {
    mode: row.mode === 'rules' ? 'rules' : 'actions_finish',
    where: row.where_json === null ? null : JSON.parse(row.where_json) as WhereItem[],
    keep_rows: row.keep_rows,
    success_column: row.success_column,
    copy_to_sheet_id: row.copy_to_sheet_id,
    copy_to_sheet: row.copy_to_sheet_id ? sheetName(row.copy_to_sheet_id, row.user_id) : null,
    paused: row.paused_message,
    waiting: row.paused_message ? null : waitingFor(row),
    rows_deleted: row.rows_deleted,
    last_deleted_at: row.last_deleted_at,
  };
}

export interface AutoDeleteInput {
  mode?: unknown; where?: unknown; keep_rows?: unknown; success_column?: unknown; copy_to_sheet_id?: unknown;
}
const FIELDS = new Set(['mode', 'where', 'keep_rows', 'success_column', 'copy_to_sheet_id']);

interface Checked {
  mode: AutoDeleteMode; where: WhereItem[] | null; keep: number; success: string | null; copyTo: string | null;
}

// Where copy_to_sheet_id leads, following each sheet's own auto-delete: back to `sheetId` is a loop.
function copiesBack(sheetId: string, copyTo: string, userId: string): boolean {
  const next = db.prepare('SELECT copy_to_sheet_id FROM webhook_auto_delete WHERE sheet_id = ? AND user_id = ?')
    .pluck();
  let at: string | null = copyTo;
  for (let hops = 0; at !== null && hops < 50; hops++) {
    if (at === sheetId) return true;
    at = (next.get(at, userId) as string | null | undefined) ?? null;
  }
  return false;
}

function check(
  src: WebhookSourceFull, input: AutoDeleteInput, was: AutoDeleteRow | undefined,
): Checked | AutoDeleteFail {
  const bad = (message: string): AutoDeleteFail => ({ fail: 'bad_request', message });
  const unknown = Object.keys(input).filter(k => !FIELDS.has(k));
  if (unknown.length) return bad(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
  if (input.mode !== undefined && input.mode !== 'actions_finish' && input.mode !== 'rules') {
    return bad('mode is "actions_finish" or "rules".');
  }
  const mode: AutoDeleteMode = (input.mode as AutoDeleteMode | undefined) ?? (was?.mode === 'rules' ? 'rules'
    : 'actions_finish');
  let where: WhereItem[] | null = null;
  if (mode === 'rules') {
    const rules = checkAutoDeleteRules(src.sheet_id, src.user_id, input.where !== undefined ? input.where
      : was?.where_json ? JSON.parse(was.where_json) : undefined);
    if ('error' in rules) return bad(rules.error);
    where = rules.where;
  } else if (input.where !== undefined && input.where !== null) {
    return bad('where is for mode "rules".');
  }
  const keep = input.keep_rows ?? was?.keep_rows ?? AUTO_DELETE_KEEP_DEFAULT;
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0 || keep > AUTO_DELETE_KEEP_MAX) {
    return bad(`keep_rows is a whole number from 0 to ${AUTO_DELETE_KEEP_MAX.toLocaleString('en-US')}.`);
  }
  const success = input.success_column === undefined ? was?.success_column ?? null
    : input.success_column === null || input.success_column === '' ? null : input.success_column;
  // In mode rules a has_result rule says it. One set for the other mode isn't dropped quietly: without it rows
  // stop waiting for that column, so a switch to rules clears it on purpose.
  if (success !== null && mode === 'rules') {
    return bad(input.success_column === undefined
      ? `Rows now wait for "${success}" to have a result, which rules don't. Send success_column: null with mode `
        + `"rules", and a has_result rule on "${success}" to keep waiting for it.`
      : 'success_column is for mode "actions_finish". In rules, add a has_result rule on that column.');
  }
  if (success !== null) {
    if (typeof success !== 'string') return bad('success_column is a column name.');
    if (success === src.raw_column_name) return bad('The webhook\'s own column can\'t be the success column.');
    if (!getSheetColumns(src.sheet_id, src.user_id).includes(success)) {
      return bad(`No column "${success}" in this sheet.`);
    }
  }
  const copyTo = input.copy_to_sheet_id === undefined ? was?.copy_to_sheet_id ?? null
    : input.copy_to_sheet_id === null || input.copy_to_sheet_id === '' ? null : input.copy_to_sheet_id;
  if (copyTo !== null) {
    if (typeof copyTo !== 'string') return bad('copy_to_sheet_id is a sheet id.');
    if (copyTo === src.sheet_id) return bad('Rows can\'t be copied to the sheet they leave.');
    if (!verifySheetOwnership(copyTo, src.user_id)) return bad('The sheet to copy rows to was not found.');
    if (copiesBack(src.sheet_id, copyTo, src.user_id)) {
      return bad(`"${sheetName(copyTo, src.user_id)}" has auto-delete copying its rows back here.`);
    }
  }
  return { mode, where, keep, success, copyTo };
}

// The History line: what it now does, in words, the rules included, and the rules a switch back cleared.
function describe(c: Checked, userId: string, was: AutoDeleteRow | undefined): string {
  const after = c.success ? ` and "${c.success}" has a result` : '';
  const copy = c.copyTo ? `, copied to "${sheetName(c.copyTo, userId)}" first` : '';
  const when = c.mode === 'rules' ? `once they pass its rules: ${autoDeleteRulesWords(c.where ?? [])}`
    : `once every column with auto-run on has run on them${after}`;
  const cleared = c.mode !== 'rules' && was?.mode === 'rules' ? ' (its rules are cleared)' : '';
  return `keeps the newest ${countOf(c.keep, 'row')}; older rows the webhook added are deleted ${when}${copy}, `
    + `and can't be restored${cleared}`;
}

// Turns auto-delete on, or changes it. A pause clears, a sort's too: the next sweep checks again, with the sheet's
// rows as they are now taken as the order to keep.
export function setAutoDelete(src: WebhookSourceFull, input: AutoDeleteInput): { ok: true } | AutoDeleteFail {
  const was = autoDeleteOf(src.id);
  const c = check(src, input, was);
  if ('fail' in c) return c;
  db.prepare(`INSERT INTO webhook_auto_delete (source_id, user_id, sheet_id, mode, where_json, keep_rows,
      success_column, copy_to_sheet_id, row_generation_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT row_generation FROM sheets WHERE id = ?))
    ON CONFLICT (source_id) DO UPDATE SET mode = excluded.mode, where_json = excluded.where_json,
      keep_rows = excluded.keep_rows, success_column = excluded.success_column,
      copy_to_sheet_id = excluded.copy_to_sheet_id, row_generation_seen = excluded.row_generation_seen,
      paused_reason = NULL, paused_message = NULL, paused_at = NULL, updated_at = datetime('now')`)
    .run(src.id, src.user_id, src.sheet_id, c.mode, c.where && JSON.stringify(c.where), c.keep, c.success, c.copyTo,
      src.sheet_id);
  logSheetChange(src.sheet_id, src.user_id, 'webhook',
    `${was ? 'Changed auto-delete' : 'Turned on auto-delete'}: it ${describe(c, src.user_id, was)}`);
  return { ok: true };
}

// Turns auto-delete off. Rows already gone stay gone. Nothing to do when it is off.
export function removeAutoDelete(src: WebhookSourceFull): void {
  const r = db.prepare('DELETE FROM webhook_auto_delete WHERE source_id = ?').run(src.id);
  if (r.changes > 0) logSheetChange(src.sheet_id, src.user_id, 'webhook', 'Turned off auto-delete');
}
