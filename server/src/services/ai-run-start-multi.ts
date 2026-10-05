// Structured multi-column AI run start. Sibling of ai-run-start.ts: ONE AI call
// per row returns a JSON object; the runner writes N typed columns + a status
// column. Design choices vs the single-column path:
//   - ai_runs.column_name = the STATUS column (the run's anchor, like HTTP's
//     master_column_name). getLockedRunColumns, the resume placeholder filter,
//     finalizeStatus, and rename/delete all key off column_name, so the status
//     column carries the '⏳ Processing...' lifecycle; output_columns lists the
//     N typed columns for locking/clearing/reconcile.
//   - No preview-reuse promotion (v1): reuse is single-column only.
//   - Web search and web fetch are allowed. Either one adds a "(Data)" column,
//     stored in ai_runs.data_column, for the sources behind each row's answer:
//     search citations plus the URLs the model lists (fetch has no citations).
//   - Rerun is deferred (ai-run-rerun rejects structured runs); start +
//     pause/resume/cancel are fully supported.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_AI_CONCURRENCY, MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { NO_MODEL_ERROR, resolveAiModel, resolveAiConcurrency } from '../lib/ai-model-resolve';
import {
  appendColumnsToOrder, countColumnsAndRows, getSheetColumns, verifySheetOwnership,
} from '../lib/sql-helpers';
import { existingRowIndexes } from '../lib/run-rows';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { findColumnNameCollision } from '../lib/column-names';
import { enqueueAIRun, enqueueAIRerun } from '../queue';
import { asRunStart, seedThenEnqueue, sheetRowSpan } from './run-seed';
import { AiRunStartParams, AiRunStartOutcome } from './ai-run-start-types';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';


export async function startAiMultiRun(userId: string, p: AiRunStartParams): Promise<AiRunStartOutcome> {
  // A sheet busy sorting, importing or rewriting a column takes no run (lib/sheet-busy.ts).
  const busy = sheetBusyWith(p.sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const specs = p.outputColumns!;
  if (!verifySheetOwnership(p.sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };

  const resolvedModel = resolveAiModel(p.model, p.sheetId, userId);
  if (!resolvedModel) return { fail: 'no_model', message: NO_MODEL_ERROR };

  // Same resolution as the single-column path: explicit > sheet default >
  // DEFAULT_AI_CONCURRENCY, after the ownership check, re-clamped to the cap.
  const resolvedConcurrency = Math.max(1, Math.min(
    Math.floor(resolveAiConcurrency(p.safeConcurrency, p.sheetId, userId)),
    MAX_AI_CONCURRENCY,
  ));

  // Every existing row, or exactly the caller's rows (same rule as ai-run-start.ts).
  const span = sheetRowSpan(p.sheetId, userId);
  if (span.count === 0) return { fail: 'bad_request', message: 'No data available to process' };
  let targets: number[] | null = null;
  if (p.targetRowIndexes !== undefined) {
    targets = Array.from(new Set(p.targetRowIndexes)).sort((a, b) => a - b);
    if (targets.length === 0 || existingRowIndexes(p.sheetId, userId, targets).length !== targets.length) {
      return { fail: 'bad_request', message: 'Target rows resolved to no existing rows' };
    }
  }
  const targetCount = targets ? targets.length : span.count;

  const statusColumn = `${p.cleanColumnName} (Status)`;
  const dataColumn = p.useOpenRouterWebSearch || p.useWebFetch ? `${p.cleanColumnName} (Data)` : null;
  const outputNames = specs.map(s => s.columnName);
  const allColumns = [...outputNames, statusColumn, ...(dataColumn ? [dataColumn] : [])];

  // Every column this run creates must be NEW: no reuse for structured runs in
  // v1. Use the SHARED collision helper, not a hand-rolled lowercase compare —
  // it also rejects the normalized-TOKEN axis ("Fit Score" vs "Fit-Score" both
  // normalize to /fit_score), which is the axis /column prompt references
  // resolve on. A lowercase-only check let two columns coexist that make every
  // later /fit_score reference non-deterministic — the exact hazard
  // findColumnNameCollision exists to prevent, and what the single-column start
  // path already uses.
  const existing = getSheetColumns(p.sheetId, userId, false);
  const seen: string[] = [];
  for (const name of allColumns) {
    const existingClash = findColumnNameCollision(name, existing);
    if (existingClash) {
      return {
        fail: 'conflict',
        message: `Column "${name}" collides with the existing column "${existingClash.clash}". `
          + 'Use a different output column name, or delete that column first.',
      };
    }
    const selfClash = findColumnNameCollision(name, seen);
    if (selfClash) {
      return {
        fail: 'conflict',
        message: `Output column "${name}" collides with "${selfClash.clash}" in the same run. Rename it.`,
      };
    }
    seen.push(name);
  }

  // Reject a second active run writing the same status column (its anchor).
  const conflictingRun = db.prepare(`
    SELECT id FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      -- A stopped run still clearing its ⏳ cells (migration 004) counts: its
      -- clear would wipe the new run's placeholders in rows it hasn't reached.
      AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL)
    LIMIT 1
  `).get(p.sheetId, userId, statusColumn);
  if (conflictingRun) return {
    fail: 'conflict',
    message: `A structured run for "${p.cleanColumnName}" is still active, or still clearing the cells of a stopped run. Wait for it to finish, or stop it first.`,
  };

  const refsError = unknownPromptRefsError(p.sheetId, userId, p.prompt);
  if (refsError) return { fail: 'bad_request', message: refsError };

  const runId = uuidv4();
  const insertRun = db.prepare(`
    INSERT INTO ai_runs (
      id, sheet_id, user_id, column_name, prompt, system_prompt, model, temperature,
      use_openrouter_web_search, use_web_fetch, max_chars, concurrency,
      status, total_rows, processed_rows, target_rows, output_columns, status_column, data_column, placeholder_work
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, 'seeding')
  `);

  // Cap check + run row + column_order append in ONE immediate txn (two
  // concurrent starts must not both pass the cap and both create columns).
  // All-or-nothing: a run that would cross the cap creates NOTHING (risk B2).
  return asRunStart(p.sheetId, async (): Promise<AiRunStartOutcome> => {
    let capExceeded = false;
    let capColsNeeded = 0;
    db.transaction(() => {
      const { columns: currentCols } = countColumnsAndRows(p.sheetId, userId);
      capColsNeeded = allColumns.length;
      if (currentCols + capColsNeeded > MAX_COLUMNS_PER_SHEET) { capExceeded = true; return; }
      insertRun.run(
        runId, p.sheetId, userId, statusColumn, p.prompt, p.systemPrompt || null,
        resolvedModel, p.safeTemperature, p.useOpenRouterWebSearch ? 1 : 0, p.useWebFetch ? 1 : 0,
        p.safeMaxChars, resolvedConcurrency,
        targetCount, targets ? JSON.stringify(targets) : null,
        JSON.stringify(specs), statusColumn, dataColumn,
      );
      appendColumnsToOrder(p.sheetId, userId, allColumns);
    }).immediate();

    if (capExceeded) return {
      fail: 'cap',
      message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This run needs ${capColsNeeded} columns — delete unused columns first.`,
    };

    // Every column of a structured run carries the placeholder: the status column
    // drives resume, and the outputs (and "(Data)") render "Loading…" and clear
    // together on cancel/fail (run-placeholders.aiRunColumns).
    seedThenEnqueue({
      kind: 'ai', runId, sheetId: p.sheetId, userId, columns: allColumns,
      targets, lastRow: span.lastRow,
      enqueue: () => (targets ? enqueueAIRerun(runId, targets) : enqueueAIRun(runId)),
    });

    return {
      ok: { runId, statusColumn, outputColumns: outputNames, dataColumn, reusedRows: 0, targetCount },
    };
  });
}
