// Starting an enrichment run: the flow behind POST /api/enrich/sheets/:id/runs,
// the column menu's reruns (services/enrich-rerun.ts), MCP run_enrichment and
// /api/v1 (services/enrich-token-run.ts). Checks the key, the tool and the
// request (services/enrich-run-prepare.ts), then in ONE immediate
// transaction inside the sheet's busy window: the column cap, the new columns
// (appendColumnsToOrder), the run row and its column associations. Seeding
// (only the rows the run takes) and queueing follow in the background
// (services/enrich-seed-run.ts); the start answers at once and the run shows
// as pending meanwhile.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { asRunStart } from './run-seed';
import { rowFilterSql } from './enrich-rows-filter';
import { seedEnrichmentThenEnqueue } from './enrich-seed-run';
import { getTregToken } from './treg-key';
import type { RunFail } from './run-shared';
import { applyListStart, listRowsBeingAdded } from './enrich-list-start';
import { activeRunOn, prepareEnrichmentStart, seedPlanFor } from './enrich-run-prepare';
import { logRunStarted } from '../lib/change-log';

// destSheetId: where a list job's rows go (a new sheet is made by the start).
// rowsInScope: the most rows the run can take (seeding skips rows missing an input).
export type EnrichStartOutcome = {
  ok: { runId: string; statusColumn: string; outputColumns: string[]; destSheetId: string | null; rowsInScope: number };
} | RunFail;

const ROLLBACK = new Error('rollback');

const generationOf = (sheetId: string, userId: string): number | undefined => db.prepare(
  'SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?',
).pluck().get(sheetId, userId) as number | undefined;

export async function startEnrichmentRun(
  userId: string, sheetId: string, input: EnrichRunInput,
): Promise<EnrichStartOutcome> {
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (!getTregToken(userId)) return { fail: 'conflict', message: 'Add your treg key in Settings first.' };
  const prepared = await prepareEnrichmentStart(userId, sheetId, input);
  if ('fail' in prepared) return prepared;
  const { statusColumn, outputNames, config, listPlan, columns, span, upperBound } = prepared.ok;
  const runId = uuidv4();
  const runColumns = [statusColumn, ...outputNames];

  return asRunStart(sheetId, async (): Promise<EnrichStartOutcome> => {
    let capNeeded = -1, raced: string | null = null, destSheetId: string | null = null, destRaced = false;
    try {
      db.transaction(() => {
        const current = new Set(getSheetColumns(sheetId, userId, false));
        // Again inside the write lock: the catalog read above awaited the network.
        if (input.continueColumn ? activeRunOn(sheetId, userId, statusColumn) : runColumns.some(c => current.has(c))) {
          raced = 'Another run just started on these columns. Try again in a moment.';
          return;
        }
        raced = input.continueColumn ? listRowsBeingAdded(sheetId, userId, statusColumn) : null;
        if (raced) return;
        // Selected rows go by row number: a sort since they were picked (even
        // during the catalog read) re-means them, so they'd run other rows.
        const moved = input.rowGeneration !== null && generationOf(sheetId, userId) !== input.rowGeneration;
        if (input.rows.mode === 'selected' && moved) {
          raced = 'This sheet was reordered elsewhere. Reload before running selected rows.';
          return;
        }
        const added = runColumns.filter(c => !current.has(c)).length;
        if (current.size + added > MAX_COLUMNS_PER_SHEET) { capNeeded = added; return; }
        // A list job's destination (a new sheet too) and columns: rolled back with the run.
        if (listPlan) {
          const dest = applyListStart(userId, sheetId, statusColumn, listPlan, config);
          if ('raced' in dest) { raced = dest.raced; destRaced = dest.field === 'destName'; throw ROLLBACK; }
          destSheetId = dest.destSheetId;
        }
        appendColumnsToOrder(sheetId, userId, runColumns);
        // allow_secrets 0: an enrichment never reads saved API keys.
        db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
            target_rows, allow_secrets, placeholder_work, dest_sheet_id)
          VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, 0, 'seeding', ?)`)
          .run(runId, sheetId, userId, JSON.stringify(config), statusColumn, destSheetId);
        // Every output is linked to THIS run, also on a column a run already made:
        // clearing a stopped run's ⏳ and the column delete/rename guards find a
        // run's columns through its own associations (as http-run-rerun.ts does).
        const assoc = db.prepare(`INSERT INTO http_column_associations
            (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id)
          VALUES (?, ?, ?, ?, ?, ?)`);
        for (const name of outputNames) assoc.run(uuidv4(), sheetId, userId, statusColumn, name, runId);
      }).immediate();
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }
    if (raced) return { fail: 'conflict', message: raced, ...(destRaced ? { field: 'destName' } : {}) };
    if (capNeeded >= 0) {
      return {
        fail: 'cap',
        message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This enrichment needs ${capNeeded} new `
          + 'columns. Delete unused columns first.',
      };
    }
    seedEnrichmentThenEnqueue({
      runId, sheetId, userId, columns: runColumns,
      plan: seedPlanFor(input, prepared.ok),
      rowFilter: rowFilterSql(sheetId, userId, input.rows.mode),
      targets: input.rows.mode === 'selected' ? input.rows.rowIndexes : null,
      lastRow: span.lastRow, test: input.rows.test,
    });
    logRunStarted(sheetId, userId, {
      kind: 'enrichment', column: statusColumn, runId, rows: upperBound, again: input.continueColumn,
      runIf: input.runIf,
    });
    return { ok: { runId, statusColumn, outputColumns: outputNames, destSheetId, rowsInScope: upperBound } };
  });
}
