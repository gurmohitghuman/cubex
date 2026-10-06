// Rerun for a STRUCTURED AI run (output_columns): clones the latest run on its
// status column into a fresh run that refills the same typed columns, and its
// "(Data)" column, on the chosen rows. One call per row, as at start. Reached
// from ai-run-rerun.ts (a column) and run-rerun-by-id.ts (a run id); the same
// busy window, placeholder seeding and rerun job as every run (the runner keys
// on column_name, the status column, and processRow hands structured rows to
// ai-row-multi.ts).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { NO_MODEL_ERROR, resolveAiModel } from '../lib/ai-model-resolve';
import { appendColumnsToOrder, getSheetColumns } from '../lib/sql-helpers';
import { existingRowIndexes } from '../lib/run-rows';
import { columnReuseCollision } from '../lib/column-names';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { getLockedRunColumns } from '../lib/run-locked-columns';
import { findStructuredRun, outputColumnNames } from '../lib/structured-run-owner';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import type { OutputColumnSpec } from '../lib/ai-multi-output';
import { asRunStart, seedThenEnqueue } from './run-seed';
import { type AIRunRow } from './ai-runner';
import { enqueueAIRerun } from '../queue';
import { DEFAULT_AI_RERUN_MODE, resolveRerunTargets } from './ai-rerun-modes';
import type { AiRerunParams, RerunOutcome } from './ai-run-rerun';

// For a caller holding only a base name (the sheet menu before it sent the
// exact header): the run whose status or "(Data)" column that base names.
export function structuredRunByBase(sheetId: string, userId: string, base: string, cleanBase: string): string | null {
  return findStructuredRun(sheetId, userId, r =>
    r.status_column === base || r.status_column === `${cleanBase} (Status)` || r.data_column === `${cleanBase} (Data)`);
}

export async function rerunAiMultiColumn(userId: string, p: AiRerunParams, statusColumn: string): Promise<RerunOutcome> {
  // A sheet busy sorting, importing or rewriting a column takes no run (lib/sheet-busy.ts).
  const busy = sheetBusyWith(p.sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };

  const latest = db.prepare(`
    SELECT * FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(p.sheetId, userId, statusColumn) as AIRunRow | undefined;
  if (!latest?.output_columns) return { fail: 'not_found', message: 'No AI run found for this column' };
  // Deleting the status column detaches the run (lib/ai-columns.ts): nothing to refill into.
  if (latest.status_column !== statusColumn) return {
    fail: 'not_found',
    message: "This run's status column was deleted, so it can't be rerun. Start a new run instead.",
  };

  // Deleting a typed column drops it from the run; a malformed entry counts as gone.
  const names = new Set(outputColumnNames(latest.output_columns));
  let specs: OutputColumnSpec[] = [];
  try { specs = (JSON.parse(latest.output_columns) as OutputColumnSpec[]).filter(s => names.has(s?.columnName)); } catch { /* none */ }
  if (specs.length === 0) return {
    fail: 'bad_request',
    message: "This run's output columns were all deleted, so there is nothing to refill. Start a new run instead.",
  };
  const dataColumn = latest.data_column || null;
  const columns = [...specs.map(s => s.columnName), statusColumn, ...(dataColumn ? [dataColumn] : [])];

  // Runs on a sheet are only created inside its busy window (run-seed.ts), so
  // none can appear between these checks and the insert below. A stopped run
  // still clearing its ⏳ cells counts: it would clear the new run's too.
  const locked = getLockedRunColumns(p.sheetId, userId);
  const clearing = db.prepare(`
    SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ? AND placeholder_work IS NOT NULL LIMIT 1
  `).get(p.sheetId, userId, statusColumn);
  if (clearing || columns.some(c => locked.has(c))) return {
    fail: 'conflict',
    message: 'A run on these columns is still active, or still clearing the cells of a stopped run. Wait for it to finish, or stop it first.',
  };

  const model = latest.model || resolveAiModel(undefined, p.sheetId, userId);
  if (!model) return { fail: 'no_model', message: NO_MODEL_ERROR };

  // A column gone from the sheet (a CSV replace drops it, but not the run) is
  // recreated, unless a DIFFERENT column now holds its name (case/token).
  const current = getSheetColumns(p.sheetId, userId, false);
  for (const column of columns) {
    const clash = columnReuseCollision(column, current);
    if (clash) return { fail: 'conflict', message: clash };
  }

  // The prompt's /references may name columns renamed or deleted since.
  const refsError = unknownPromptRefsError(p.sheetId, userId, latest.prompt);
  if (refsError) return { fail: 'bad_request', message: refsError };

  const runId = uuidv4();
  return asRunStart(p.sheetId, async (): Promise<RerunOutcome> => {
    // Modes read the status cell: ❌ errored, blank never run, ⏳ unfinished.
    const targets = Array.isArray(p.rowIndices) && p.rowIndices.length > 0
      ? existingRowIndexes(p.sheetId, userId, p.rowIndices)
      : await resolveRerunTargets(p.sheetId, userId, statusColumn, p.mode ?? DEFAULT_AI_RERUN_MODE);
    if (targets.length === 0) return { fail: 'bad_request', message: 'No target rows found to re-run' };

    let capExceeded = false;
    db.transaction(() => {
      const have = new Set(getSheetColumns(p.sheetId, userId, false));
      if (have.size + columns.filter(c => !have.has(c)).length > MAX_COLUMNS_PER_SHEET) { capExceeded = true; return; }
      appendColumnsToOrder(p.sheetId, userId, columns);
      // target_rows lets a resume re-dispatch this as a rerun (run-lifecycle.ts).
      db.prepare(`
        INSERT INTO ai_runs (
          id, sheet_id, user_id, column_name, prompt, system_prompt, model, temperature,
          use_openrouter_web_search, use_web_fetch, max_chars, concurrency, status, total_rows,
          processed_rows, target_rows, output_columns, status_column, data_column, placeholder_work,
          web_search_engine, web_search_engine_used, web_search_mode, web_search_max_per_row
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, 'seeding', ?, ?, ?, ?)
      `).run(
        runId, p.sheetId, userId, statusColumn, latest.prompt, latest.system_prompt, model, latest.temperature,
        latest.use_openrouter_web_search, latest.use_web_fetch, latest.max_chars, latest.concurrency,
        targets.length, JSON.stringify(targets), JSON.stringify(specs), statusColumn, dataColumn,
        latest.web_search_engine ?? null, latest.web_search_engine_used ?? null,
        latest.web_search_mode ?? null, latest.web_search_max_per_row ?? null,
      );
    }).immediate();
    if (capExceeded) return {
      fail: 'cap',
      message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). Re-running would recreate this run's missing columns; delete an unused column first.`,
    };

    // Every column of the run carries the placeholder, as at start
    // (ai-run-start-multi.ts); a failure fails the run and clears them.
    seedThenEnqueue({
      kind: 'ai', runId, sheetId: p.sheetId, userId, columns,
      targets, lastRow: Number.MAX_SAFE_INTEGER,
      enqueue: () => enqueueAIRerun(runId, targets),
    });
    return { ok: { runId, targetCount: targets.length } };
  });
}
