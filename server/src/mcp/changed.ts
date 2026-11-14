// What a write changed: every MCP tool that writes a sheet's rows, cells or columns, or starts work that does,
// answers `changed` (outputs/shared.ts), one item per sheet it touched: the sheet, the columns and rows it
// touched, and the sheet's data_version and row_generation read right after the write. A run writing the same
// sheet at that moment can have raised them. [] when the call changed nothing: a preview, a dry run, an
// estimate, or a change to a sheet's or table's place, name or trash state, which the tool's other fields name.
// A keyed write stores its changed with the key, in its transaction, and a replay answers it as it was.
// tests/unit/mcp-changed-tools.test.ts holds every writing tool to either answering it or a place in
// WITHOUT_CHANGED.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { sheetEntries } from '../services/autorun-entry';
import type { AutoDedupeOutcome } from '../services/auto-dedupe-settle';
import { CHANGED_ROW_IDS } from './outputs/shared';

// The tools that write without answering `changed`, and why.
export const WITHOUT_CHANGED: Record<string, string> = {
  set_default_model: 'a model setting, no sheet data',
  manage_view: 'a saved view: filters and hidden columns, no data',
  manage_run_webhook: 'a webhook setting',
  save_setup: 'the setup library',
  delete_setup: 'the setup library',
  manage_setup_version: 'the setup library',
  create_upload_link: 'a link; the import happens later, over HTTP',
  create_download_link: 'a link',
  write_formula: 'writes no data: it answers a formula',
  write_run_condition: 'writes no data: it answers a rule',
};

// A sheet a write touched. columns: whose cells or setup changed, by name after the write. rows: how many it
// added, changed, removed or moved; rowIds: those rows, when the write names them. moreComing: work goes on.
export interface Touch {
  sheetId: string;
  columns?: readonly string[];
  rows?: number;
  rowIds?: readonly string[];
  moreComing?: boolean;
}

export interface Changed {
  sheet_id: string; sheet: string; columns: string[]; rows: number; row_ids?: string[];
  data_version: number; row_generation: number; more_coming?: true;
}

// One item per sheet, in the order first touched (two touches of one sheet are merged); a sheet that isn't
// the caller's, or is gone, is left out. Each sheet is read once, by its primary key.
export function changedOf(userId: string, touches: ReadonlyArray<Touch | null | undefined | false>): Changed[] {
  type At = { columns: string[]; rows: number; rowIds: string[]; known: boolean; more: boolean };
  const bySheet = new Map<string, At>();
  for (const t of touches) {
    if (!t) continue;
    const at = bySheet.get(t.sheetId) ?? { columns: [], rows: 0, rowIds: [], known: false, more: false };
    for (const c of t.columns ?? []) if (!at.columns.includes(c)) at.columns.push(c);
    at.rows += t.rows ?? 0;
    if (t.rowIds) { at.known = true; at.rowIds.push(...t.rowIds.slice(0, CHANGED_ROW_IDS - at.rowIds.length)); }
    at.more ||= !!t.moreComing;
    bySheet.set(t.sheetId, at);
  }
  const read = db.prepare('SELECT name, data_version, row_generation FROM sheets WHERE id = ? AND user_id = ?');
  const out: Changed[] = [];
  for (const [sheetId, at] of bySheet) {
    const s = read.get(sheetId, userId) as { name: string; data_version: number; row_generation: number } | undefined;
    if (!s) continue;
    out.push({
      sheet_id: sheetId, sheet: s.name, columns: at.columns, rows: at.rows,
      ...(at.known && at.rowIds.length ? { row_ids: at.rowIds } : {}),
      data_version: s.data_version, row_generation: s.row_generation, ...(at.more ? { more_coming: true } : {}),
    });
  }
  return out;
}

// A free fill column's answer (clean_column, formula_column, lookup_column): the column and the rows it wrote
// so far, more_coming while it still fills. [] for a preview.
interface FillAnswer {
  preview?: boolean; column?: string | null; status?: string;
  filled_rows?: number; error_rows?: number; cleaned_rows?: number; blank_rows?: number;
}
export function fillChanged(userId: string, sheetId: string, a: FillAnswer): Changed[] {
  if (a.preview || !a.column) return [];
  const rows = (a.filled_rows ?? 0) + (a.error_rows ?? 0) + (a.cleaned_rows ?? 0) + (a.blank_rows ?? 0);
  return changedOf(userId, [{ sheetId, columns: [a.column], rows, moreComing: a.status === 'filling' }]);
}

// A sheet the call made (or copied) whole: all its columns and rows.
export function madeSheet(userId: string, sheetId: string | null | undefined, moreComing = false): Touch | null {
  if (!sheetId) return null;
  const rows = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
    .get(sheetId, userId) as number;
  return { sheetId, columns: getSheetColumns(sheetId, userId, false), rows, moreComing };
}

// A run start: the columns the run fills and the rows it targets, more_coming (and, for a list job, the sheet
// its rows go to). The start service stores it with the key (services/run-start-token.ts).
export function runChanged(
  userId: string, sheetId: string, columns: readonly unknown[], rows = 0, also?: string | null,
): Changed[] {
  const named = [...new Set(columns.filter((c): c is string => typeof c === 'string' && !!c))];
  return changedOf(userId, [{ sheetId, columns: named, rows, moreComing: true },
    !!also && { sheetId: also, moreComing: true }]);
}

// changed as a keyed call stored it with its key; [] from an entry stored before keys kept it.
export const storedChanged = (v: unknown): Changed[] => (Array.isArray(v) ? v as Changed[] : []);

// The columns a write sets, in the order first named.
export const columnsOf = (cells: ReadonlyArray<Record<string, unknown>>): string[] =>
  [...new Set(cells.flatMap(c => Object.keys(c)))];

// Rows arriving set off the sheet's auto-runs: one on, or paused by the person (resumed, it runs them too).
export const autorunOn = (userId: string, sheetId: string): boolean =>
  sheetEntries(sheetId, userId).some(e => !!e.enabled);

// Rows a write added (append_rows, transfer_rows), as the sheet now holds them: the new rows auto-dedupe kept
// (one it didn't keep went straight to the trash) and the older rows they replaced, which left it. more_coming:
// an auto-run fills the new rows, or auto-dedupe checks some of them later.
export function arrivedTouch(
  userId: string, sheetId: string, columns: readonly string[], made: readonly string[], d: AutoDedupeOutcome | null,
): Touch {
  const gone = new Set((d?.removed ?? []).map(r => r.id));
  const kept = made.filter(id => !gone.has(id));
  const own = new Set(made);
  const rowIds = [...kept, ...[...gone].filter(id => !own.has(id))];
  const moreComing = !!d?.waiting || (kept.length > 0 && autorunOn(userId, sheetId));
  return { sheetId, columns, rows: rowIds.length, rowIds, moreComing };
}

// Rows a write edited (update_cells): each of them, one auto-dedupe then took out too, and the older rows it
// replaced with them, which left the sheet. replaced: its answer's list (the first AUTO_DEDUPE_LIST_IDS, 100).
export function editedTouch(
  sheetId: string, columns: readonly string[], edited: readonly string[],
  d?: { replaced: readonly string[]; replaced_count: number },
): Touch {
  return {
    sheetId, columns, rows: edited.length + (d?.replaced_count ?? 0),
    rowIds: [...edited, ...(d?.replaced ?? [])],
  };
}
