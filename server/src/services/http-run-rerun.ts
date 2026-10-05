// HTTP column rerun — the flow behind POST /api/http/rerun, extracted verbatim
// so the UI route, /api/v1 and MCP share one implementation. Inherits the
// latest run's config + the sheet's CURRENT column associations for the master
// (rename/delete keep those truthful), seeds placeholders on the target rows,
// persists target_rows (migration 024), and copies allow_secrets (migration
// 034) — a rerun of a no-secrets PAT run must stay locked out of saved keys.
//
// Target modes (keyed on the master/status column):
//   rowIndices[]      → exactly those rows
//   mode = 'missing'  → rows whose master cell is empty / ❌ Failed / still ⏳
//   otherwise         → every existing row
// Targets are chosen, the run inserted and its placeholders seeded inside the
// sheet's busy window (services/run-seed.ts).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import {
  appendColumnsToOrder, getSheetColumns, sanitizeColumnName, verifySheetOwnership,
} from '../lib/sql-helpers';
import { existingRowIndexes, rowsWhere } from '../lib/run-rows';
import { asRunStart, seedThenEnqueue } from './run-seed';
import { type HTTPAPIConfig } from '../lib/http-request';
import { type HTTPRunRow } from './http-runner';
import { enqueueHTTPRerun } from '../queue';
import { RunFail } from './run-shared';
import { RerunOutcome } from './ai-run-rerun';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';

export interface HttpRerunParams {
  sheetId: string;
  masterColumnName: string;
  mode?: string;          // 'missing' narrows to empty/failed/processing rows
  rowIndices?: number[];  // explicit subset; wins over mode
  // Override the cloned run's allow_secrets policy instead of copying the
  // parent's. rerunHttpRunById passes false when a no-'secrets' caller reruns a
  // permissive run: the clone is then FROZEN (allow_secrets=0), so even a
  // saved key created between the gate check and the worker's substitution can
  // never be resolved (closes the residual TOCTOU — strict invariant: a
  // no-secrets caller must never cause saved-key fallback). undefined = copy
  // the parent (UI/cookie reruns, which carry full owner authority).
  forceAllowSecrets?: boolean;
}

export async function rerunHttpColumn(userId: string, p: HttpRerunParams): Promise<RerunOutcome> {
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
    message: 'A run on this column is still active, or still clearing the cells of a stopped run. Wait for it to finish, or stop it first.',
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

  const allColumns = [cleanMaster, ...extractedColumns];

  const config: HTTPAPIConfig = JSON.parse(latestRun.config);

  const newRunId = uuidv4();

  return asRunStart(p.sheetId, async (): Promise<RerunOutcome> => {
    // Resolve target rows — always intersect with real row_index values so we
    // never write to (or bill for) rows that don't exist. Read in pages.
    let targets: number[];
    if (Array.isArray(p.rowIndices) && p.rowIndices.length > 0) {
      targets = existingRowIndexes(p.sheetId, userId, p.rowIndices);
    } else if (p.mode === 'missing') {
      targets = await rowsWhere(p.sheetId, userId, cleanMaster, value => {
        const v = ((value as string | null) || '').toString();
        return v.trim() === '' || v.includes('⏳') || v.startsWith('❌');
      });
    } else {
      targets = await rowsWhere(p.sheetId, userId, cleanMaster, () => true);
    }
    if (targets.length === 0) return { fail: 'bad_request', message: 'No target rows found to re-run' };

    // A rerun whose master/extracted columns were deleted since the original run
    // recreates them below (appendColumnsToOrder) — the start path enforces
    // MAX_COLUMNS_PER_SHEET, so the rerun path must too.
    let capExceeded = false;
    db.transaction(() => {
      const currentCols = new Set(getSheetColumns(p.sheetId, userId));
      const newColsNeeded = allColumns.filter(c => !currentCols.has(c)).length;
      if (currentCols.size + newColsNeeded > MAX_COLUMNS_PER_SHEET) { capExceeded = true; return; }

      // Rerun is always on an existing column, but self-heal column_order in case
      // it drifted (mirrors the AI rerun's defensive appendColumnsToOrder).
      appendColumnsToOrder(p.sheetId, userId, allColumns);

      // Persist target_rows (JSON) so a PAUSED rerun resumes as a RERUN, not a
      // full-sheet run (see migration 024). Persist the PARSED config
      // (re-serialized), not latestRun.config verbatim, so a future reconcile
      // step here can't silently drift from what the worker will read.
      // allow_secrets: use the caller's override when given (a no-secrets rerun
      // freezes the clone off), else copy the parent's policy (UI/owner reruns).
      const cloneAllowSecrets = p.forceAllowSecrets !== undefined
        ? (p.forceAllowSecrets ? 1 : 0)
        : (latestRun.allow_secrets ?? 1);
      db.prepare(`
        INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name, target_rows, allow_secrets, placeholder_work)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 'seeding')
      `).run(
        newRunId, p.sheetId, userId, JSON.stringify(config), targets.length,
        cleanMaster, JSON.stringify(targets), cloneAllowSecrets,
      );

      // Re-insert associations under the NEW run_id so the cancel/fail clear
      // (keyed on run_id) cleans the extracted columns, matching how run-start
      // seeds them.
      const insertAssoc = db.prepare(`
        INSERT INTO http_column_associations (
          id, sheet_id, user_id, master_column_name, extracted_column_name, run_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const extracted of extractedColumns) {
        insertAssoc.run(uuidv4(), p.sheetId, userId, cleanMaster, extracted, newRunId);
      }
    }).immediate();

    if (capExceeded) return {
      fail: 'cap',
      message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This run's column(s) were deleted; re-running would recreate them — delete an unused column first.`,
    };

    // A failure fails the run and clears its placeholders, so the user isn't
    // left with stuck ⏳ cells or a pending run that trips the 409 guard.
    seedThenEnqueue({
      kind: 'http', runId: newRunId, sheetId: p.sheetId, userId, columns: allColumns,
      targets, lastRow: Number.MAX_SAFE_INTEGER,
      enqueue: () => enqueueHTTPRerun(newRunId, targets),
    });
    return { ok: { runId: newRunId, targetCount: targets.length } };
  });
}
