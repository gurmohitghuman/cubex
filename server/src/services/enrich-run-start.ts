// Starting an enrichment run: the flow behind POST /api/enrich/sheets/:id/runs
// and the column menu's reruns (services/enrich-rerun.ts; MCP and /api/v1 will
// call it too). Checks the key, the tool and the request, then in ONE immediate
// transaction inside the sheet's busy window: the column cap, the new columns
// (appendColumnsToOrder), the run row and its column associations. Seeding
// (only the rows the run takes) and queueing follow in the background
// (services/enrich-seed-run.ts); the start answers at once and the run shows
// as pending meanwhile.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { findColumnNameCollision, columnCollisionMessage } from '../lib/column-names';
import { validateHttpRunColumns } from '../lib/http-run-validate';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { asRunStart, sheetRowSpan } from './run-seed';
import { buildEnrichmentConfig } from './enrich-run-build';
import { rowFilterSql } from './enrich-rows-filter';
import { countFor, enrichRowCounts } from './enrich-row-count';
import { seedEnrichmentThenEnqueue } from './enrich-seed-run';
import { getTregToken } from './treg-key';
import type { RunFail } from './run-shared';

export type EnrichStartOutcome = { ok: { runId: string; statusColumn: string; outputColumns: string[] } } | RunFail;

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// The enrichment that owns `name` as its status column, if any.
function enrichmentColumnOwner(sheetId: string, userId: string, name: string): boolean {
  const runs = db.prepare(`SELECT config FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).all(sheetId, userId, name) as Array<{ config: string | null }>;
  return runs.some(r => { try { return isEnrichmentConfig(JSON.parse(r.config ?? 'null')); } catch { return false; } });
}

function activeRunOn(sheetId: string, userId: string, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL) LIMIT 1`).get(sheetId, userId, name);
}

const ownOutputs = (sheetId: string, userId: string, statusColumn: string): Set<string> => new Set(db.prepare(
  `SELECT extracted_column_name FROM http_column_associations
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?`,
).pluck().all(sheetId, userId, statusColumn) as string[]);

// Adding to a column a run already made: it must be an enrichment column with
// no run active on it, and new output names may only clash with its own.
function continueProblem(
  sheetId: string, userId: string, statusColumn: string, outputNames: string[], columns: string[],
): RunFail | null {
  if (!enrichmentColumnOwner(sheetId, userId, statusColumn)) {
    return bad(`"${statusColumn}" isn't an enrichment column.`);
  }
  if (activeRunOn(sheetId, userId, statusColumn)) {
    return {
      fail: 'conflict', message: 'A run on this column is still active. Wait for it to finish, or stop it first.',
    };
  }
  const own = ownOutputs(sheetId, userId, statusColumn);
  const others = columns.filter(c => c !== statusColumn && !own.has(c));
  for (const name of outputNames) {
    const clash = findColumnNameCollision(name, others);
    if (clash) return bad(columnCollisionMessage(name, clash));
  }
  return null;
}

const generationOf = (sheetId: string, userId: string): number | undefined => db.prepare(
  'SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?',
).pluck().get(sheetId, userId) as number | undefined;

const NOTHING_TO_RUN: Record<string, string> = {
  not_enriched: 'Every row here is enriched already. Pick other rows to run.',
  no_result: 'Every row here has a result already.',
  failed: 'No rows here failed.',
};

// How many rows the run can take at most (it sizes the default run limit):
// the test rows, else the rows in scope, counted by status on a column a run
// already made. Rows missing an input still count; seeding skips them.
async function rowsToRun(
  sheetId: string, userId: string, input: EnrichRunInput, statusColumn: string, all: number,
): Promise<number> {
  const { mode, status, rowIndexes } = input.rows;
  const byStatus = input.continueColumn && status !== 'any';
  if (!byStatus && mode !== 'filter') return mode === 'selected' ? rowIndexes?.length ?? 0 : all;
  const counts = await enrichRowCounts(sheetId, userId, byStatus ? statusColumn : null, { mode, rowIndexes });
  return byStatus ? countFor(counts, status) : counts.total;
}

export async function startEnrichmentRun(
  userId: string, sheetId: string, input: EnrichRunInput,
): Promise<EnrichStartOutcome> {
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (!getTregToken(userId)) return { fail: 'conflict', message: 'Add your treg key in Settings first.' };
  const columns = getSheetColumns(sheetId, userId, false);
  const span = sheetRowSpan(sheetId, userId);
  if (span.count === 0) return bad('There are no rows to run on.');

  // Names: a new status column, or an existing enrichment column to add to.
  const mapping = input.outputs.map(o => ({ columnName: o.columnName, jsonPath: '$.x' }));
  const v = validateHttpRunColumns(sheetId, userId, mapping, input.columnName, !input.continueColumn);
  if (!v.ok) return bad(v.error!);
  const statusColumn = v.sanitizedMaster!;
  const outputNames = v.sanitizedMappingColumns!;
  if (input.continueColumn) {
    const problem = continueProblem(sheetId, userId, statusColumn, outputNames, columns);
    if (problem) return problem;
  }
  if (input.rows.mode === 'selected' && !input.rows.rowIndexes?.length) return bad('Select some rows first.');
  const inScope = await rowsToRun(sheetId, userId, input, statusColumn, span.count);
  if (inScope === 0) return bad(NOTHING_TO_RUN[input.rows.status] ?? 'There are no rows to run on.');
  const upperBound = Math.min(input.rows.test ?? inScope, inScope);

  const named = { ...input, outputs: input.outputs.map((o, i) => ({ ...o, columnName: outputNames[i] })) };
  const built = await buildEnrichmentConfig(named, columns, upperBound);
  if ('fail' in built) return built;
  const config = built.ok;
  const runId = uuidv4();
  const runColumns = [statusColumn, ...outputNames];

  return asRunStart(sheetId, async (): Promise<EnrichStartOutcome> => {
    let capNeeded = -1, raced: string | null = null;
    db.transaction(() => {
      const current = new Set(getSheetColumns(sheetId, userId, false));
      // Again inside the write lock: the catalog read above awaited the network.
      if (input.continueColumn ? activeRunOn(sheetId, userId, statusColumn) : runColumns.some(c => current.has(c))) {
        raced = 'Another run just started on these columns. Try again in a moment.';
        return;
      }
      // Selected rows go by row number: a sort since they were picked (even
      // during the catalog read) re-means them, so they'd run other rows.
      const moved = input.rowGeneration !== null && generationOf(sheetId, userId) !== input.rowGeneration;
      if (input.rows.mode === 'selected' && moved) {
        raced = 'This sheet was reordered elsewhere. Reload before running selected rows.';
        return;
      }
      const added = runColumns.filter(c => !current.has(c)).length;
      if (current.size + added > MAX_COLUMNS_PER_SHEET) { capNeeded = added; return; }
      appendColumnsToOrder(sheetId, userId, runColumns);
      // allow_secrets 0: an enrichment never reads saved API keys.
      db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
          target_rows, allow_secrets, placeholder_work)
        VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, 0, 'seeding')`)
        .run(runId, sheetId, userId, JSON.stringify(config), statusColumn);
      // Every output is linked to THIS run, also on a column a run already made:
      // clearing a stopped run's ⏳ and the column delete/rename guards find a
      // run's columns through its own associations (as http-run-rerun.ts does).
      const assoc = db.prepare(`INSERT INTO http_column_associations
          (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const name of outputNames) assoc.run(uuidv4(), sheetId, userId, statusColumn, name, runId);
    }).immediate();
    if (raced) return { fail: 'conflict', message: raced };
    if (capNeeded >= 0) {
      return {
        fail: 'cap',
        message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This enrichment needs ${capNeeded} new `
          + 'columns. Delete unused columns first.',
      };
    }
    seedEnrichmentThenEnqueue({
      runId, sheetId, userId, columns: runColumns,
      plan: {
        statusColumn: input.continueColumn ? statusColumn : null, status: input.rows.status,
        where: input.conditions, config, columns,
      },
      rowFilter: rowFilterSql(sheetId, userId, input.rows.mode),
      targets: input.rows.mode === 'selected' ? input.rows.rowIndexes : null,
      lastRow: span.lastRow, test: input.rows.test,
    });
    return { ok: { runId, statusColumn, outputColumns: outputNames } };
  });
}
