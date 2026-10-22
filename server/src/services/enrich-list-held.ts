// A list job's test run, before anyone picked the fields to keep: its results
// wait in the journal ('fields'). The fields come from those very results, so
// picking them (by starting the next run, or with "Add these rows") gives
// every such run of the column the same fields, and its results are added.
import { db } from '../lib/db';
import { appendColumnsToOrder, getSheetColumns } from '../lib/sql-helpers';
import { getColumnTypes } from '../lib/column-types';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { listOf } from '../lib/enrich-run-config';
import { listCell, type ListField } from '../lib/enrich-list';
import { destColumns } from './enrich-list-dest';
import { releasedCells } from './enrich-list-source';
import type { RunFail } from './run-shared';

interface RunRow { id: string; sheet_id: string; config: string; dest_sheet_id: string | null; column: string | null }

// The column's runs without fields: those whose results wait for them, and
// its newest run (a test that found nothing still needs fields for the next).
export function fieldlessRuns(sheetId: string, userId: string, column: string): RunRow[] {
  const waiting = db.prepare(`SELECT id, sheet_id, config, dest_sheet_id, master_column_name AS column FROM http_runs
    WHERE id IN (SELECT DISTINCT run_id FROM enrichment_list_items
      WHERE source_sheet_id = ? AND status = 'pending' AND wait_reason = 'fields' AND user_id = ?)
      AND sheet_id = ? AND user_id = ? AND master_column_name = ?`)
    .all(sheetId, userId, sheetId, userId, column) as RunRow[];
  const newest = db.prepare(`SELECT id, sheet_id, config, dest_sheet_id, master_column_name AS column FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(sheetId, userId, column) as RunRow | undefined;
  const runs = newest && !waiting.some(r => r.id === newest.id) ? [...waiting, newest] : waiting;
  return runs.filter(r => {
    try { const l = listOf(JSON.parse(r.config)); return !!l && !l.fields?.length; } catch { return false; }
  });
}

// Inside the caller's transaction: each run gets the fields (named as its
// destination has them, new columns added there) and its results go on.
export function giveFields(
  userId: string, runs: RunRow[], fields: ListField[], dedupePath: string | null,
): { released: number } | RunFail {
  let released = 0;
  for (const run of runs) {
    const config = JSON.parse(run.config);
    const list = listOf(config);
    const dest = run.dest_sheet_id;
    if (!list || !dest) continue;
    const name = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck().get(dest, userId) as
      string | undefined;
    if (!name) continue;
    // Its columns change: not while a sort, an import or a column change runs there.
    const busy = sheetBusyWith(dest);
    if (busy) return { fail: 'conflict', message: `${name}: ${busyMessage(busy)}` };
    const cols = destColumns({ copy: list.copy.map(c => ({ ...c })), fields },
      getSheetColumns(dest, userId, false), getColumnTypes(dest, userId), name);
    if ('fail' in cols) return cols;
    appendColumnsToOrder(dest, userId, cols.newColumns);
    list.fields = cols.fields;
    list.dedupe = dedupePath ? { path: dedupePath } : null;
    db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(JSON.stringify(config), run.id);
    // Their rows now say the results are on their way.
    releasedCells(run, userId, listCell.adding);
    released += db.prepare(`UPDATE enrichment_list_items SET wait_reason = NULL, updated_at = datetime('now')
      WHERE run_id = ? AND status = 'pending' AND wait_reason = 'fields' AND user_id = ?`)
      .run(run.id, userId).changes;
  }
  return { released };
}
