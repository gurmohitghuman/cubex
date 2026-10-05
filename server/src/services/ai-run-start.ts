// AI run start — the flow behind POST /api/ai/run, extracted so the UI route,
// /api/v1 and the MCP tools share ONE implementation (same pattern as
// services/rows-write.ts). Behavior is verbatim from the old route; the only
// addition is optional row-subset targeting for the programmatic surfaces.
//
// Load-bearing: NO await between the concurrency check and the run insert
// (limits.ts TOCTOU note — the whole span is synchronous); cap check +
// preview promotion + column_order append stay in ONE immediate txn, inside
// the sheet's busy window (services/run-seed.ts), which then seeds the
// placeholders in slices and queues the run, after the start has answered. A
// failure there fails the run and clears them, but keeps promoted cell values
// and does NOT consume the draft.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_AI_CONCURRENCY, MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { NO_MODEL_ERROR, resolveAiModel, resolveAiConcurrency } from '../lib/ai-model-resolve';
import {
  appendColumnsToOrder, countColumnsAndRows, getSheetColumns, verifySheetOwnership,
} from '../lib/sql-helpers';
import { existingRowIndexes } from '../lib/run-rows';
import { runColumnConflict } from './ai-run-start-checks';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { promotePreviewReuse } from '../lib/ai-run-promote';
import { deleteDraftForColumn } from '../lib/ai-drafts';
import { enqueueAIRun, enqueueAIRerun } from '../queue';
import { asRunStart, seedThenEnqueue, sheetRowSpan } from './run-seed';
import { AiRunStartParams, AiRunStartOutcome } from './ai-run-start-types';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';

export type { AiRunStartParams, AiRunStartOutcome };

export async function startAiRun(userId: string, p: AiRunStartParams): Promise<AiRunStartOutcome> {
  // A sheet busy sorting, importing or rewriting a column takes no run (lib/sheet-busy.ts).
  const busy = sheetBusyWith(p.sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  // Structured multi-column output takes a separate path (writes N typed columns
  // + a status column from ONE call/row). Delegated whole so this file stays the
  // single-column flow.
  if (p.outputColumns && p.outputColumns.length > 0) {
    const { startAiMultiRun } = await import('./ai-run-start-multi');
    return startAiMultiRun(userId, p);
  }
  if (!verifySheetOwnership(p.sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };

  // Explicit choice > sheet default > account default. No hardcoded fallback:
  // an AI column only ever runs on a model the user chose.
  const resolvedModel = resolveAiModel(p.model, p.sheetId, userId);
  if (!resolvedModel) return { fail: 'no_model', message: NO_MODEL_ERROR };

  // Explicit choice > sheet default_ai_concurrency > DEFAULT_AI_CONCURRENCY.
  // Resolved HERE, not in parseRunRequest: this is after verifySheetOwnership,
  // so the sheet read can't be used to probe another user's sheets. Clamped
  // again because the stored value is only bounded by the route that wrote it.
  const resolvedConcurrency = Math.max(1, Math.min(
    Math.floor(resolveAiConcurrency(p.safeConcurrency, p.sheetId, userId)),
    MAX_AI_CONCURRENCY,
  ));

  // Every existing row (a count and the last row_index, never the list: the
  // placeholders go in by range), or exactly the caller's rows, all of which
  // must exist. Deleted rows never resurrect and never burn AI credits. Subset
  // runs get placeholders, promotion, and dispatch scoped to exactly the
  // caller's rows; total_rows means "rows this run is responsible for".
  const span = sheetRowSpan(p.sheetId, userId);
  if (span.count === 0) return { fail: 'bad_request', message: 'No data available to process' };
  const isSubset = p.targetRowIndexes !== undefined;
  let targets: number[] | null = null;
  if (p.targetRowIndexes !== undefined) {
    targets = Array.from(new Set(p.targetRowIndexes)).sort((a, b) => a - b);
    if (targets.length === 0 || existingRowIndexes(p.sheetId, userId, targets).length !== targets.length) {
      return { fail: 'bad_request', message: 'Target rows resolved to no existing rows' };
    }
  }
  const targetCount = targets ? targets.length : span.count;

  const outputCol = `${p.cleanColumnName} (Output)`;
  const dataCol = `${p.cleanColumnName} (Data)`;

  // Reject submitting a second run on the same column while one is still active.
  // Without this, both runs race over the same cells and progress goes haywire.
  const conflictingRun = db.prepare(`
    SELECT id FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      -- A stopped run still clearing its ⏳ cells (migration 004) counts: its
      -- clear would wipe the new run's placeholders in rows it hasn't reached.
      AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL)
    LIMIT 1
  `).get(p.sheetId, userId, outputCol);
  if (conflictingRun) return {
    fail: 'conflict',
    message: `An AI run on column "${p.cleanColumnName}" is still active, or still clearing the cells of a stopped run. Wait for it to finish, or stop it first.`,
  };

  // (Data) column only exists for runs that use web SEARCH — search returns
  // url_citation annotations we display there. Web FETCH returns no caller-
  // visible breadcrumb on the chat-completions API, so a Data column for
  // fetch-only runs would always be empty.
  const needsDataColumn = !!p.useOpenRouterWebSearch;

  const columnConflict = runColumnConflict(p.sheetId, userId, outputCol, needsDataColumn ? dataCol : null);
  if (columnConflict) return { fail: 'conflict', message: columnConflict };

  // Reject unresolvable /column references up front — unknown refs substitute
  // "[MISSING: /token]" on EVERY row and burn the run's whole model budget on
  // garbage (incident + rationale in lib/prompt-ref-validate.ts).
  const refsError = unknownPromptRefsError(p.sheetId, userId, p.prompt);
  if (refsError) return { fail: 'bad_request', message: refsError };

  const runId = uuidv4();
  const columns = needsDataColumn ? [outputCol, dataCol] : [outputCol];

  const insertRun = db.prepare(`
    INSERT INTO ai_runs (
      id, sheet_id, user_id, column_name, prompt, system_prompt, model, temperature,
      use_openrouter_web_search, use_web_fetch, max_chars, concurrency,
      status, total_rows, processed_rows, target_rows, placeholder_work
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, 'seeding')
  `);

  // Cap check + mutation in ONE immediate() txn — otherwise two concurrent
  // starts could both pass the cap check and both insert new columns.
  return asRunStart(p.sheetId, async (): Promise<AiRunStartOutcome> => {
    let capExceeded = false;
    let capColsNeeded = 0;
    let promotedRows: number[] = [];
    db.transaction(() => {
      const { columns: currentCols } = countColumnsAndRows(p.sheetId, userId);
      const listed = new Set(getSheetColumns(p.sheetId, userId, false));
      const newColsNeeded = columns.filter(c => !listed.has(c)).length;
      capColsNeeded = newColsNeeded;
      if (currentCols + newColsNeeded > MAX_COLUMNS_PER_SHEET) { capExceeded = true; return; }

      // The run row must exist BEFORE promotion: promoted rows insert ai_results,
      // whose run_id FK (enforced) checks immediately. processed_rows starts at 0
      // and is bumped to the promoted count below, inside this same transaction.
      insertRun.run(
        runId, p.sheetId, userId, outputCol, p.prompt, p.systemPrompt || null,
        resolvedModel, p.safeTemperature,
        p.useOpenRouterWebSearch ? 1 : 0,
        p.useWebFetch ? 1 : 0,
        p.safeMaxChars, resolvedConcurrency, targetCount,
        targets ? JSON.stringify(targets) : null,
      );
      // Credit reuse: promote still-valid persisted preview results into this
      // run's cells + ai_results, BEFORE placeholder seeding, so the worker's
      // placeholder-driven row filter naturally skips them (never re-billed).
      // Scoped to the targets: a subset start must not mutate non-target rows.
      promotedRows = promotePreviewReuse({
        runId, userId, sheetId: p.sheetId, outputColumn: outputCol, targets,
        runConfig: {
          columnName: p.cleanColumnName, prompt: p.prompt, systemPrompt: p.systemPrompt || null,
          model: resolvedModel, temperature: p.safeTemperature,
          useOpenRouterWebSearch: !!p.useOpenRouterWebSearch, useWebFetch: !!p.useWebFetch,
          maxChars: p.safeMaxChars, concurrency: resolvedConcurrency,
        },
      });
      if (promotedRows.length > 0) {
        db.prepare('UPDATE ai_runs SET processed_rows = ? WHERE id = ?')
          .run(promotedRows.length, runId);
      }
      appendColumnsToOrder(p.sheetId, userId, columns);
    }).immediate();

    if (capExceeded) return {
      fail: 'cap',
      message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This AI column needs ${capColsNeeded} slot${capColsNeeded === 1 ? '' : 's'} — delete unused columns first.`,
    };

    // Promoted rows hold their reused value, not a placeholder. A subset start
    // dispatches as a RERUN job: the rerun runner iterates exactly target_rows
    // and scopes its stuck-row finalize check to them. A failure fails the run;
    // promoted values stay (they're the user's data, same as a preview-commit)
    // and the draft is not consumed, so a retry promotes again.
    seedThenEnqueue({
      kind: 'ai', runId, sheetId: p.sheetId, userId, columns,
      targets, lastRow: span.lastRow, skip: new Set(promotedRows),
      enqueue: () => (targets ? enqueueAIRerun(runId, targets) : enqueueAIRun(runId)),
      // Consume the draft only AFTER the run is durably enqueued (owner decision:
      // Run All Rows deletes the preview — its values now live in the rows), and
      // only for FULL runs: a subset start must not destroy draft rows it didn't run.
      queued: () => { if (!isSubset) deleteDraftForColumn(userId, p.sheetId, p.cleanColumnName); },
    });

    return {
      ok: {
        runId, outputColumn: outputCol, dataColumn: needsDataColumn ? dataCol : null,
        reusedRows: promotedRows.length, targetCount,
      },
    };
  });
}
