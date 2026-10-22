// Writing one enrichment row's result: its http_results row (the answer, the
// cell map, the row's cost) and its cells, in one transaction that first
// re-checks the run is still ours, so a pause or cancel that raced the call
// drops the write (the row stays ⏳ and the resume replays the paid answer
// for free). The ledger was written before this, call by call.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { touchSheet } from '../lib/sql-helpers';
import { enrichCellValues, failedCell, type RowCells } from '../lib/enrich-cells';
import { withFill } from '../lib/answer-store';
import { listCell } from '../lib/enrich-list';
import type { ResponseMapping } from '../lib/http-request-template';
import { shouldStopHttpRun, writeRowColumns } from './run-row-write';
import { answerTime, noteReusedRow } from './enrich-reuse';
import { nowDate } from '../lib/clock';
import type { HTTPRunRow } from './http-runner-status';
import type { RowStamp } from '../lib/run-inputs/stamp';

export interface EnrichWrite {
  run: HTTPRunRow;
  generation: number;
  rowIndex: number;
  cells: RowCells;
  stored: unknown;            // the answer as kept (trimmed raw); stored with the row's fill rule
  mapping: ResponseMapping[];
  costMicro: number;
  request: Record<string, unknown>;
  // The lookup a found answer from this row's own calls answers, for later
  // runs to reuse (lib/enrich-reuse-key.ts); null: nothing to reuse.
  reuseKey?: string | null;
  reused?: boolean;           // filled from an earlier run's answer (counted on the run)
  // A list job's results and the source row's copied cells: journaled here, in
  // the result's transaction, and added as rows by the API process
  // (services/enrich-list-drain.ts). Workers never append rows themselves.
  list?: { items: unknown[]; copy: Record<string, string>; rowId: string | null };
  stamp?: RowStamp;           // what the row's result is made from (lib/run-inputs)
}

const NO_DEST = 'Rows not added: the sheet for them was deleted.';

// The journal row for a list job's results, and the status cell it shows: the
// run's fields as they are now (a test's fields may be picked mid-run). An
// answer with no results is journaled only when the row added rows there
// before or has results on their way (queued behind them, so it replaces
// those too), and never by a test whose fields aren't picked (its results
// wait, so it removes nothing either); its status cell (Not found, No rows to
// add) is kept in the journal row as the words to end with. 'lost': nowhere
// to add them.
function journal(w: EnrichWrite, cells: Record<string, string>): 'journaled' | 'skipped' | 'lost' {
  const l = w.list!;
  const master = w.run.master_column_name;
  // Read now, not from the run the worker loaded: a deleted sheet nulls it.
  const now = db.prepare(`SELECT dest_sheet_id AS dest,
      IFNULL(json_array_length(config, '$.enrichment.list.fields'), 0) > 0 AS ready FROM http_runs
    WHERE id = ? AND user_id = ?`).get(w.run.id, w.run.user_id) as { dest: string | null; ready: number } | undefined;
  const dest = now?.dest ?? null;
  const empty = l.items.length === 0;
  const ready = now?.ready === 1;
  if (empty && (!dest || !l.rowId || !ready || !addedBefore(l.rowId, dest, w.run.user_id))) return 'skipped';
  if (!dest || !l.rowId) {
    if (master) cells[master] = failedCell(NO_DEST);
    return 'lost';
  }
  const done = empty && master ? cells[master] : null;
  if (master) {
    cells[master] = empty ? listCell.replacing
      : ready ? listCell.adding(l.items.length) : listCell.waitingFields(l.items.length);
  }
  db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
      dest_sheet_id, items_json, item_count, status, wait_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(uuidv4(), w.run.user_id, w.run.id, w.run.sheet_id, l.rowId, dest,
      JSON.stringify({ items: l.items, copy: l.copy, ...(done !== null ? { done } : {}) }), l.items.length,
      ready ? null : 'fields');
  return 'journaled';
}

// Whether the source row added rows to that sheet before, or has results on
// their way there (any column: the drain checks it was this one).
const addedBefore = (rowId: string, dest: string, userId: string): boolean => !!db.prepare(`SELECT 1
  FROM enrichment_list_rows WHERE source_row_id = ? AND dest_sheet_id = ? AND user_id = ?
  UNION ALL SELECT 1 FROM enrichment_list_items WHERE source_row_id = ? AND status = 'pending'
    AND dest_sheet_id = ? AND user_id = ? LIMIT 1`)
  .get(rowId, dest, userId, rowId, dest, userId);

// Returns false when the run was no longer ours (nothing written).
export function writeEnrichmentResult(w: EnrichWrite): boolean {
  const cells = enrichCellValues(w.cells, w.mapping, w.run.master_column_name);
  let written = false;
  db.transaction(() => {
    if (shouldStopHttpRun(w.run.id, w.generation)) return;
    const lost = !!w.list && journal(w, cells) === 'lost';
    db.prepare(`
      INSERT INTO http_results (id, run_id, user_id, row_index, request_config, response_data, extracted_fields,
        status, error_message, cost_usd, reuse_key, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, row_index) DO UPDATE SET
        request_config = excluded.request_config, response_data = excluded.response_data,
        extracted_fields = excluded.extracted_fields, status = excluded.status,
        error_message = excluded.error_message, cost_usd = excluded.cost_usd, reuse_key = excluded.reuse_key,
        answered_at = excluded.answered_at, updated_at = datetime('now')
    `).run(
      uuidv4(), w.run.id, w.run.user_id, w.rowIndex, JSON.stringify(w.request),
      w.stored === undefined ? null : JSON.stringify(withFill(w.stored, w.cells.fill)), JSON.stringify(cells),
      lost ? 'failed' : w.cells.status, lost ? NO_DEST : w.cells.reason?.slice(0, 500) ?? null, w.costMicro / 1e6,
      // A key only on a stored, completed answer (migration 032's rule).
      ...(w.reuseKey && !lost && w.stored !== undefined ? [w.reuseKey, answerTime(nowDate())] : [null, null]),
    );
    if (w.reused) noteReusedRow(w.run.id, w.run.user_id);
    writeRowColumns(w.run.id, w.run.sheet_id, w.run.user_id, w.rowIndex, Object.entries(cells), w.stamp);
    touchSheet(w.run.sheet_id, w.run.user_id);
    written = true;
  }).immediate();
  return written;
}
