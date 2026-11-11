// HTTP column rerun — the flow behind POST /api/http/rerun, extracted verbatim
// so the UI route, /api/v1 and MCP share one implementation. Inherits the
// latest run's config + the sheet's CURRENT column associations for the master
// (rename/delete keep those truthful), seeds placeholders on the target rows,
// persists target_rows (migration 024), and copies allow_secrets (migration
// 034) — a rerun of a no-secrets PAT run must stay locked out of saved keys.
//
// Target modes (keyed on the master/status column):
//   rowIndices[]      → exactly those rows
//   mode              → the AI column's modes over the master cell
//                       (services/ai-rerun-modes.ts): 'missing' is empty / ❌
//                       Failed / still ⏳ / ⏭️ Condition not met, 'errored',
//                       'empty', 'out_of_date', 'empty_or_out_of_date'
//   otherwise         → every existing row
// firstRows / withinRows: only among the sheet's first rows, or those rows.
// Targets are chosen, the run inserted and its placeholders seeded inside the
// sheet's busy window (services/run-seed.ts).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns } from '../lib/sql-helpers';
import { asRunStart, seedThenEnqueue } from './run-seed';
import { ruleSeed, startRunRule } from './run-rule';
import { enqueueHTTPRerun } from '../queue';
import { RunFail } from './run-shared';
import { RerunOutcome } from './ai-run-rerun';
import { httpRerunChecks } from './http-rerun-checks';
import { NO_TARGET_ROWS, type RerunScope } from './rerun-targets';
import { resolveRerunTargets, type RerunMode } from './ai-rerun-modes';
import { logRunStarted } from '../lib/change-log';
import { actorTokenId } from '../lib/actor';

// rowIndices: an explicit subset, which wins over mode; firstRows / withinRows
// narrow the rows mode picks from (rerun-targets.ts).
export interface HttpRerunParams extends RerunScope {
  sheetId: string;
  masterColumnName: string;
  mode?: RerunMode;       // which rows by their status cell (services/ai-rerun-modes.ts); absent: all
  // A setup carrying the column on: a row its rule kept out is taken only if the rule passes now.
  recheckKeptOut?: boolean;
  // Override the cloned run's allow_secrets policy instead of copying the
  // parent's. rerunHttpRunById passes false when a no-'secrets' caller reruns a
  // permissive run: the clone is then FROZEN (allow_secrets=0), so even a
  // saved key created between the gate check and the worker's substitution can
  // never be resolved (closes the residual TOCTOU — strict invariant: a
  // no-secrets caller must never cause saved-key fallback). undefined = copy
  // the parent (UI/cookie reruns, which carry full owner authority).
  forceAllowSecrets?: boolean;
  // Requests at once for the new run (control_run's and the REST rerun's concurrency): its config keeps it.
  batchSize?: number;
}

export async function rerunHttpColumn(userId: string, p: HttpRerunParams): Promise<RerunOutcome> {
  // Everything it refuses up to the stored request it sends again (services/http-rerun-checks.ts).
  const basis = httpRerunChecks(userId, p);
  if ('fail' in basis) return basis;
  const { cleanMaster, latestRun, config, extractedColumns } = basis;
  // control_run's and the REST rerun's concurrency: the new run's requests at once, kept in its config.
  if (p.batchSize !== undefined) config.batchSize = p.batchSize;
  const allColumns = [cleanMaster, ...extractedColumns];
  // The column's "Only run if" rule applies to its reruns too.
  const rule = startRunRule(p.sheetId, userId, config.runIf, { stored: true });
  if ('fail' in rule) return rule;

  const newRunId = uuidv4();

  return asRunStart(p.sheetId, userId, async (): Promise<RerunOutcome> => {
    // Resolve target rows — always intersect with real row_index values so we
    // never write to (or bill for) rows that don't exist. Read in pages.
    const targets = await resolveRerunTargets(p.sheetId, userId, cleanMaster, p.mode ?? 'all', p,
      p.recheckKeptOut ? rule.ok : null);
    if (targets.length === 0) return NO_TARGET_ROWS;

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
        INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name, target_rows,
          allow_secrets, placeholder_work, access_token_id)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 'seeding', ?)
      `).run(
        newRunId, p.sheetId, userId, JSON.stringify(config), targets.length,
        cleanMaster, JSON.stringify(targets), cloneAllowSecrets,
        // A rerun is done for whoever asks for it (lib/actor.ts), not the run it repeats.
        actorTokenId(),
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
      message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This run's column(s) were deleted; `
        + 're-running would recreate them, so delete an unused column first.',
    };

    // A failure fails the run and clears its placeholders, so the user isn't
    // left with stuck ⏳ cells or a pending run that trips the 409 guard.
    seedThenEnqueue({
      kind: 'http', runId: newRunId, sheetId: p.sheetId, userId, columns: allColumns,
      targets, lastRow: Number.MAX_SAFE_INTEGER, rule: ruleSeed(rule.ok, cleanMaster),
      enqueue: () => enqueueHTTPRerun(newRunId, targets),
    });
    logRunStarted(p.sheetId, userId, { kind: 'http', column: cleanMaster, runId: newRunId, rows: targets.length,
      again: true });
    return { ok: { runId: newRunId, targetCount: targets.length } };
  });
}
