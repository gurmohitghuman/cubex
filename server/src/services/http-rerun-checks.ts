// What an HTTP column rerun (services/http-run-rerun.ts) refuses before it starts, in its order, up to the
// stored request it sends again, read without writing: a busy sheet, the sheet, a run still active on the
// column, its newest run, an enrichment or waterfall (they rerun their own way), then the stored request (a
// column it reads deleted since, or held by another run). A rerun by run id asks it ahead of its run-start
// slot too (services/run-rerun-by-id.ts rerunHeldFirst).
import { db } from '../lib/db';
import { getSheetColumns, sanitizeColumnName, verifySheetOwnership } from '../lib/sql-helpers';
import { type HTTPAPIConfig } from '../lib/http-request';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import { isWaterfallConfig } from '../lib/waterfall/config';
import { storedRequestRefusal } from '../lib/http-held-inputs';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { type HTTPRunRow } from './http-runner';
import { autorunFillingColumn } from './autorun-block';
import { type RunFail } from './run-shared';
import type { HttpRerunParams } from './http-run-rerun';

export interface HttpRerunBasis {
  cleanMaster: string; latestRun: HTTPRunRow; config: HTTPAPIConfig; extractedColumns: string[];
}

export function httpRerunChecks(userId: string, p: HttpRerunParams): RunFail | HttpRerunBasis {
  // A sheet busy sorting, importing or rewriting a column takes no run (lib/sheet-busy.ts).
  const busy = sheetBusyWith(p.sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  if (!verifySheetOwnership(p.sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };

  // Canonicalize to match how run-start stored the master column, so the
  // existing-run lookup resolves rather than 404ing on a whitespace variant.
  // An exact match on a registered column wins (named before a newer rule).
  const cleanMaster = getSheetColumns(p.sheetId, userId, false).includes(p.masterColumnName)
    ? p.masterColumnName : sanitizeColumnName(p.masterColumnName);

  const conflictingRun = db.prepare(`
    SELECT id FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
      -- A stopped run still clearing its ⏳ cells (migration 004) counts: its
      -- clear would wipe the new run's placeholders in rows it hasn't reached.
      AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL)
    LIMIT 1
  `).get(p.sheetId, userId, cleanMaster);
  if (conflictingRun) return {
    fail: 'conflict',
    message: autorunFillingColumn(p.sheetId, userId, cleanMaster) ?? 'A run on this column is still active, or still '
      + 'clearing the cells of a stopped run. Wait for it to finish, or stop it first.',
  };

  // rowid is monotonic insert order — a reliable "newest" tiebreaker when two
  // runs share a created_at second (uuid id ordering is random and would pick
  // an arbitrary run). run-rerun-by-id.ts's secrets-gate scan uses the SAME
  // ordering, so the run this clones is exactly the run the gate authorized —
  // no window where the gate checks one run and the worker executes another.
  const latestRun = db.prepare(`
    SELECT * FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(p.sheetId, userId, cleanMaster) as HTTPRunRow | undefined;
  if (!latestRun || !latestRun.config) {
    return { fail: 'not_found', message: 'No HTTP run found for this column' };
  }

  // Extracted columns come from the SHEET's current associations for this
  // master column (not the original run_id) — rename/delete keep these in sync
  // by name, so this reflects the columns that actually exist now.
  const extractedColumns = (db.prepare(`
    SELECT DISTINCT extracted_column_name FROM http_column_associations
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
  `).all(p.sheetId, userId, cleanMaster) as Array<{ extracted_column_name: string }>)
    .map(r => r.extracted_column_name);

  const config: HTTPAPIConfig = JSON.parse(latestRun.config);
  // An enrichment starts through services/enrich-run-start.ts (the live tool,
  // inputs, limits and which rows): a plain clone here would skip all that.
  if (isEnrichmentConfig(config)) {
    return { fail: 'bad_request', message: 'Run enrichments again from the Enrichment button.' };
  }
  // A waterfall runs again through its own setup (services/waterfall-rerun.ts).
  if (isWaterfallConfig(config)) {
    return { fail: 'bad_request', message: "Run waterfalls again from the column's Waterfall menu." };
  }
  // The stored request is checked again: a column it read may be gone since (no saved key of its name stands
  // in: lib/template-token-match.ts), or a key, and another run may hold one it reads (lib/http-held-inputs.ts).
  const refused = storedRequestRefusal(p.sheetId, userId, config, cleanMaster);
  if (refused) return refused;
  return { cleanMaster, latestRun, config, extractedColumns };
}
