// Writing one enrichment row's result: its http_results row (the answer, the
// cell map, the row's cost) and its cells, in one transaction that first
// re-checks the run is still ours, so a pause or cancel that raced the call
// drops the write (the row stays ⏳ and the resume replays the paid answer
// for free). The ledger was written before this, call by call.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { touchSheet } from '../lib/sql-helpers';
import { enrichCellValues, type RowCells } from '../lib/enrich-cells';
import type { ResponseMapping } from '../lib/http-request-template';
import { shouldStopHttpRun, writeRowColumns } from './run-row-write';
import type { HTTPRunRow } from './http-runner-status';

export interface EnrichWrite {
  run: HTTPRunRow;
  generation: number;
  rowIndex: number;
  cells: RowCells;
  stored: unknown;            // the answer as kept (trimmed raw)
  mapping: ResponseMapping[];
  costMicro: number;
  request: Record<string, unknown>;
}

// Returns false when the run was no longer ours (nothing written).
export function writeEnrichmentResult(w: EnrichWrite): boolean {
  const cells = enrichCellValues(w.cells, w.mapping, w.run.master_column_name);
  let written = false;
  db.transaction(() => {
    if (shouldStopHttpRun(w.run.id, w.generation)) return;
    db.prepare(`
      INSERT INTO http_results (id, run_id, user_id, row_index, request_config, response_data, extracted_fields, status, error_message, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, row_index) DO UPDATE SET
        request_config = excluded.request_config, response_data = excluded.response_data,
        extracted_fields = excluded.extracted_fields, status = excluded.status,
        error_message = excluded.error_message, cost_usd = excluded.cost_usd, updated_at = datetime('now')
    `).run(
      uuidv4(), w.run.id, w.run.user_id, w.rowIndex, JSON.stringify(w.request),
      w.stored === undefined ? null : JSON.stringify(w.stored), JSON.stringify(cells),
      w.cells.status, w.cells.reason ? w.cells.reason.slice(0, 500) : null, w.costMicro / 1e6,
    );
    writeRowColumns(w.run.sheet_id, w.run.user_id, w.rowIndex, Object.entries(cells));
    touchSheet(w.run.sheet_id, w.run.user_id);
    written = true;
  }).immediate();
  return written;
}
