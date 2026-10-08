// Starting an enrichment run: the flow behind POST /api/enrich/sheets/:id/runs
// (MCP and /api/v1 will call it too). Checks the key, the tool and the
// request, then in ONE immediate transaction inside the sheet's busy window:
// the column cap, the new columns (appendColumnsToOrder), the run row and its
// column associations. Seeding (only the rows the run takes) and queueing
// follow in the background (services/enrich-seed-run.ts); the start answers
// at once and the run shows as pending meanwhile.
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
import { enrichRowFilter } from './enrich-rows-filter';
import { seedEnrichmentThenEnqueue } from './enrich-seed-run';
import { getTregToken } from './treg-key';
import type { RunFail } from './run-shared';

export type EnrichStartOutcome = { ok: { runId: string; statusColumn: string; outputColumns: string[] } } | RunFail;

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

export async function startEnrichmentRun(userId: string, sheetId: string, input: EnrichRunInput): Promise<EnrichStartOutcome> {
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (!getTregToken(userId)) return { fail: 'conflict', message: 'Add your treg key in Settings first.' };
  const columns = getSheetColumns(sheetId, userId, false);
  const span = sheetRowSpan(sheetId, userId);
  if (span.count === 0) return { fail: 'bad_request', message: 'There are no rows to run on.' };

  // Names: a new status column, or an existing enrichment column to add to.
  const mapping = input.outputs.map(o => ({ columnName: o.columnName, jsonPath: '$.x' }));
  const v = validateHttpRunColumns(sheetId, userId, mapping, input.columnName, !input.continueColumn);
  if (!v.ok) return { fail: 'bad_request', message: v.error! };
  const statusColumn = v.sanitizedMaster!;
  const outputNames = v.sanitizedMappingColumns!;
  if (input.continueColumn) {
    if (!enrichmentColumnOwner(sheetId, userId, statusColumn)) return { fail: 'bad_request', message: `"${statusColumn}" isn't an enrichment column.` };
    if (activeRunOn(sheetId, userId, statusColumn)) return { fail: 'conflict', message: 'A run on this column is still active. Wait for it to finish, or stop it first.' };
    const own = new Set((db.prepare(`SELECT extracted_column_name FROM http_column_associations WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?`)
      .pluck().all(sheetId, userId, statusColumn) as string[]));
    const others = columns.filter(c => c !== statusColumn && !own.has(c));
    for (const name of outputNames) {
      const clash = findColumnNameCollision(name, others);
      if (clash) return { fail: 'bad_request', message: columnCollisionMessage(name, clash) };
    }
  }
  if (input.rows.mode === 'selected' && !input.rows.rowIndexes?.length) return { fail: 'bad_request', message: 'Select some rows first.' };
  const filter = enrichRowFilter(sheetId, userId, input.rows.mode);
  const upperBound = input.rows.test ?? (input.rows.rowIndexes?.length ?? filter.count ?? span.count);

  const built = await buildEnrichmentConfig({ ...input, outputs: input.outputs.map((o, i) => ({ ...o, columnName: outputNames[i] })) }, columns, upperBound);
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
      const added = runColumns.filter(c => !current.has(c)).length;
      if (current.size + added > MAX_COLUMNS_PER_SHEET) { capNeeded = added; return; }
      appendColumnsToOrder(sheetId, userId, runColumns);
      // allow_secrets 0: an enrichment never reads saved API keys.
      db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name, target_rows, allow_secrets, placeholder_work)
        VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, 0, 'seeding')`).run(runId, sheetId, userId, JSON.stringify(config), statusColumn);
      const assoc = db.prepare(`INSERT INTO http_column_associations (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const name of outputNames) assoc.run(uuidv4(), sheetId, userId, statusColumn, name, runId);
    }).immediate();
    if (raced) return { fail: 'conflict', message: raced };
    if (capNeeded >= 0) {
      return { fail: 'cap', message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This enrichment needs ${capNeeded} new columns. Delete unused columns first.` };
    }
    seedEnrichmentThenEnqueue({
      runId, sheetId, userId, columns: runColumns,
      plan: { statusColumn: input.continueColumn || input.rows.mode === 'not_enriched' ? statusColumn : null, where: input.conditions, config, columns },
      rowFilter: filter.sql, targets: input.rows.mode === 'selected' ? input.rows.rowIndexes : null,
      lastRow: span.lastRow, test: input.rows.test,
    });
    return { ok: { runId, statusColumn, outputColumns: outputNames } };
  });
}
