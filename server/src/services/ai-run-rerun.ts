// Over 200 lines: one rerun flow (checks, the cloned run, its placeholders); split, its transaction would scatter.
// AI column rerun — the flow behind POST /api/ai/rerun, shared by the UI route,
// /api/v1 and MCP; a structured run's goes on to ai-run-rerun-multi.ts. Clones
// the column's LATEST run config into a fresh ai_runs row, seeds placeholders on
// the target rows, persists target_rows (pause-before-first-completion resumes
// as a subset RERUN — migration 019), dispatches the
// rerun job. Choosing targets, the insert and the seeding all run in the
// sheet's busy window (services/run-seed.ts), the seeding after the rerun has
// answered; a failure there fails the run and clears its placeholders.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_AI_CONCURRENCY, MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { NO_MODEL_ERROR, resolveAiModel } from '../lib/ai-model-resolve';
import {
  appendColumnsToOrder, getSheetColumns, sanitizeColumnName, verifySheetOwnership,
} from '../lib/sql-helpers';
import { activeRunOnColumn } from './ai-run-start-checks';
import { ruleSeed, storedRule } from './run-rule';
import { asRunStart, seedThenEnqueue } from './run-seed';
import { columnReuseCollision } from '../lib/column-names';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { type AIRunRow } from './ai-runner';
import { enqueueAIRerun } from '../queue';
import { RunFail } from './run-shared';
import { AiRerunMode, DEFAULT_AI_RERUN_MODE, resolveRerunTargets } from './ai-rerun-modes';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { NO_TARGET_ROWS, type RerunScope } from './rerun-targets';
import { rerunAiMultiColumn, structuredRunByBase } from './ai-run-rerun-multi';
import { structuredRunOwning } from '../lib/structured-run-owner';
import { logRunStarted } from '../lib/change-log';
import { actorTokenId } from '../lib/actor';
import { dataColumnName } from './ai-row-writers';

export type { AiRerunMode } from './ai-rerun-modes';

export interface AiRerunParams extends RerunScope {
  sheetId: string;
  baseColumnName: string;
  // The exact column the user picked (the sheet menu sends the clicked header).
  // When given, the run that owns it is rerun: no guessing from the base name.
  columnName?: string;
  // rowIndices (explicit target row_index values) takes precedence over mode;
  // firstRows / withinRows narrow the rows mode picks from (rerun-targets.ts).
  // Which rows to target when rowIndices is absent. Defaults to 'missing' (the
  // historical behavior) so the UI route is unchanged; programmatic surfaces
  // require it explicitly. See ai-rerun-modes.ts for why the modes exist.
  mode?: AiRerunMode;
  // A setup carrying the column on: a row its rule kept out is taken only if the rule passes now.
  recheckKeptOut?: boolean;
  // Rows in parallel for the new run (1..MAX_AI_CONCURRENCY); absent keeps the
  // run it repeats. Lowering it is the fix for OpenRouter's in-flight budget 402.
  concurrency?: number;
}

// The new run's concurrency: the caller's, else the run it repeats.
export function rerunConcurrency(asked: number | undefined, previous: number): { value: number } | { error: string } {
  if (asked === undefined) return { value: previous };
  if (!Number.isInteger(asked) || asked < 1 || asked > MAX_AI_CONCURRENCY) {
    return { error: `concurrency must be a whole number from 1 to ${MAX_AI_CONCURRENCY}.` };
  }
  return { value: asked };
}

export type RerunOutcome = { ok: { runId: string; targetCount: number } } | RunFail;

export async function rerunAiColumn(userId: string, p: AiRerunParams): Promise<RerunOutcome> {
  // A sheet busy sorting, importing or rewriting a column takes no run (lib/sheet-busy.ts).
  const busy = sheetBusyWith(p.sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  if (!verifySheetOwnership(p.sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };

  // Canonicalize to match how run-start stored the column (collapse \s+ etc.),
  // so the existing-run lookup by "(Output)" name resolves rather than 404ing
  // on a whitespace-variant the client happened to send (M6). An exact match
  // on a registered column wins: one named before a newer sanitizing rule
  // (say, holding a zero-width space) must stay rerunnable.
  const registered = new Set(getSheetColumns(p.sheetId, userId, false));
  const cleanBase = registered.has(`${p.baseColumnName} (Output)`) || registered.has(`${p.baseColumnName} (Status)`)
    ? p.baseColumnName : sanitizeColumnName(p.baseColumnName);
  // The exact column a single-column run fills wins: one renamed without its " (Output)" ends otherwise.
  const owned = p.columnName && db.prepare(`SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ?
    AND column_name = ? AND output_columns IS NULL LIMIT 1`).get(p.sheetId, userId, p.columnName);
  const outputCol = owned ? p.columnName! : `${cleanBase} (Output)`;
  const dataCol = owned ? dataColumnName(outputCol) : `${cleanBase} (Data)`;

  // A structured run (several typed columns from one call per row) anchors on
  // its "(Status)" column, not the "(Output)" naming below: its own path. With
  // the exact column, the run owning it; with only a base name, a run whose
  // status or "(Data)" column that base names.
  const structuredStatus = p.columnName
    ? structuredRunOwning(p.sheetId, userId, p.columnName)
    : structuredRunByBase(p.sheetId, userId, p.baseColumnName, cleanBase);
  if (structuredStatus) return rerunAiMultiColumn(userId, p, structuredStatus);

  // Runs on a sheet are only created inside its busy window (services/run-seed.ts),
  // so no new one can appear between this check and the insert below.
  if (activeRunOnColumn(p.sheetId, userId, outputCol)) return {
    fail: 'conflict',
    message: 'A run on this column is still active, or still clearing the cells of a stopped run. Wait for it to finish, or stop it first.',
  };

  const latestRun = db.prepare(`
    SELECT * FROM ai_runs WHERE sheet_id = ? AND column_name = ? AND user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(p.sheetId, outputCol, userId) as AIRunRow | undefined;
  if (!latestRun) return { fail: 'not_found', message: 'No AI run found for this column' };
  // A structured run whose status column was renamed "<base> (Output)" is still
  // structured: cloning it as a single-column run would write prose into it.
  if (latestRun.output_columns) return rerunAiMultiColumn(userId, p, latestRun.column_name);

  // A rerun reuses the original run's model — that's what the user chose for
  // this column. Legacy runs (pre account-defaults) can carry NULL: resolve
  // through sheet/account defaults, never a hardcoded fallback.
  const model = latestRun.model || resolveAiModel(undefined, p.sheetId, userId);
  if (!model) return { fail: 'no_model', message: NO_MODEL_ERROR };

  // Inherit Data-column behavior from the original run. If the user enabled
  // web search the first time, the (Data) column already exists and rerun
  // should refresh it; otherwise there's no Data column to touch.
  const needsDataColumn = !!latestRun.use_openrouter_web_search;

  // If the column was deleted since the original run, this rerun RECREATES it.
  // Reject a case/token collision with a DIFFERENT existing column (same rule as
  // start). columnReuseCollision fast-paths self-reuse (the run's own column
  // still exists → refresh it). Non-self-healing read (the txn re-reads for cap).
  const currentColumns = getSheetColumns(p.sheetId, userId, false);
  for (const candidate of needsDataColumn ? [outputCol, dataCol] : [outputCol]) {
    const conflictMsg = columnReuseCollision(candidate, currentColumns);
    if (conflictMsg) return { fail: 'conflict', message: conflictMsg };
  }

  // A rerun clones the ORIGINAL prompt, whose /column references may have been
  // renamed or deleted since that run — without this gate the rerun bills every
  // target row producing "[MISSING: /old_name]" (same rationale as
  // the start-time gate in lib/prompt-ref-validate.ts).
  const refsError = unknownPromptRefsError(p.sheetId, userId, latestRun.prompt);
  if (refsError) return { fail: 'bad_request', message: refsError };
  // The column's "Only run if" rule applies to its reruns too.
  const rule = storedRule(p.sheetId, userId, latestRun.run_if);
  if ('error' in rule) return { fail: 'bad_request', message: rule.error };
  const concurrency = rerunConcurrency(p.concurrency, latestRun.concurrency);
  if ('error' in concurrency) return { fail: 'bad_request', message: concurrency.error };

  const newRunId = uuidv4();
  const wantCols = needsDataColumn ? [outputCol, dataCol] : [outputCol];

  return asRunStart(p.sheetId, async (): Promise<RerunOutcome> => {
    // Explicit indices are intersected with rows that actually EXIST: targeting
    // only nonexistent ones once left total_rows counting them while the worker
    // had nothing to process. Otherwise mode-driven selection over the (Output)
    // cell; a NULL cell means the row never had this column populated (empty).
    const targets = await resolveRerunTargets(p.sheetId, userId, outputCol, p.mode ?? DEFAULT_AI_RERUN_MODE, p,
      p.recheckKeptOut ? rule.ok : null);
    if (targets.length === 0) return NO_TARGET_ROWS;

    // A rerun whose column was deleted since the original run RECREATES it (the
    // appendColumnsToOrder below). Without a cap check that recreation can push
    // the sheet past MAX_COLUMNS_PER_SHEET — the start path checks the cap, so
    // the rerun path must too. Count how many of the rerun's columns are absent.
    let capExceeded = false;
    db.transaction(() => {
      // Fresh read under the writer lock for the cap count (TOCTOU-safe);
      // persist=false keeps getSheetColumns from writing inside this open txn.
      const currentCols = new Set(getSheetColumns(p.sheetId, userId, false));
      const newColsNeeded = wantCols.filter(c => !currentCols.has(c)).length;
      if (currentCols.size + newColsNeeded > MAX_COLUMNS_PER_SHEET) { capExceeded = true; return; }

      // Defensive: rerun should always be on an existing column, but if the user
      // previously deleted-and-recreated this column the order might be missing.
      appendColumnsToOrder(p.sheetId, userId, wantCols);
      // target_rows is persisted so resume can re-dispatch this as a RERUN.
      // Without it, the resume handler can't tell a rerun from a full run and
      // would re-run the whole sheet (see run-lifecycle.ts resume).
      db.prepare(`
        INSERT INTO ai_runs (
          id, sheet_id, user_id, column_name, prompt, system_prompt, model, temperature,
          use_openrouter_web_search, use_web_fetch, max_chars, concurrency,
          status, total_rows, processed_rows, target_rows, placeholder_work,
          web_search_engine, web_search_engine_used, web_search_mode, web_search_max_per_row, run_if, access_token_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, 'seeding', ?, ?, ?, ?, ?, ?)
      `).run(
        newRunId, p.sheetId, userId, outputCol, latestRun.prompt, latestRun.system_prompt,
        model, latestRun.temperature,
        latestRun.use_openrouter_web_search, latestRun.use_web_fetch,
        latestRun.max_chars, concurrency.value, targets.length,
        JSON.stringify(targets),
        // The same search engine, mode and cap as the run it repeats.
        latestRun.web_search_engine ?? null, latestRun.web_search_engine_used ?? null,
        latestRun.web_search_mode ?? null, latestRun.web_search_max_per_row ?? null, rule.ok?.rule ?? null,
        // A rerun is done for whoever asks for it (lib/actor.ts), not the run it repeats.
        actorTokenId(),
      );
    }).immediate(); // read-then-write (cap count) + writer lock: avoids TOCTOU + BUSY_SNAPSHOT

    if (capExceeded) return {
      fail: 'cap',
      message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This column was deleted; re-running would recreate it — delete an unused column first.`,
    };

    // A failure fails the run and clears its placeholders, so the user isn't
    // left with stuck ⏳ cells or a pending run that trips the 409 guard.
    seedThenEnqueue({
      kind: 'ai', runId: newRunId, sheetId: p.sheetId, userId, columns: wantCols,
      targets, lastRow: Number.MAX_SAFE_INTEGER, rule: ruleSeed(rule.ok, outputCol),
      enqueue: () => enqueueAIRerun(newRunId, targets),
    });
    logRunStarted(p.sheetId, userId, { kind: 'ai', column: outputCol, runId: newRunId, rows: targets.length,
      again: true, model });
    return { ok: { runId: newRunId, targetCount: targets.length } };
  });
}
