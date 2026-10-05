import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { jsonPath } from './sql-helpers';
import { getDraft, computeConfigHash, computeInputHash, type DraftConfig } from './ai-drafts';
import { clampCellChars } from './csv-safety';
import { CELL_MAX_ENRICHMENT } from './constants';

// Credit reuse: when
// "Run All Rows" starts and a persisted preview is still valid, its results are
// PROMOTED into the new run up front — written into rows.data as the run's own
// output plus matching ai_results rows — so those rows are never re-billed.
//
// Mechanism (no target_rows / rerun special-casing): the run worker's row filter
// is placeholder-driven (rows.data[col] === '⏳ Processing...'), so run-start
// simply writes VALUES into promoted rows and placeholders into the rest. First
// dispatch, pause/resume (even at zero progress), boot re-enqueue and
// finalize's hasUnfinishedRow all then treat promoted rows as already done —
// they hold no placeholder and have an ai_results row. total_rows stays the
// full row set and processed_rows starts at the promoted count, so progress
// reads N-reused/N from the first tick.
//
// MUST be called inside run-start's .immediate() transaction: the generation
// check, per-row input-hash checks and the cell writes have to be atomic
// against sorts / CSV-replaces / cell edits on other connections. Run start
// then seeds the placeholder into every target row except the promoted ones
// (services/run-seed.ts).

export function promotePreviewReuse(args: {
  runId: string;
  userId: string;
  sheetId: string;
  // The /ai/run request's params in the SAME canonical form the preview stored
  // (clean columnName, bounded temperature/maxChars) — hashed like-for-like.
  runConfig: DraftConfig;
  // The run's output column ("name (Output)") — where promoted values land.
  outputColumn: string;
  // A subset run's rows; null for every row.
  targets: number[] | null;
}): number[] {
  const { runId, userId, sheetId, runConfig, outputColumn, targets } = args;

  // Web-SEARCH runs also own a "(Data)" citations column that must be freshly
  // populated per row; the preview persists no citations, so a promoted row
  // would leave its (Data) cell permanently stuck. No reuse for search runs.
  if (runConfig.useOpenRouterWebSearch) return [];

  const draft = getDraft(userId, sheetId);
  if (!draft?.previewResults?.length) return [];

  // Whole-preview validity: same column, identical config, unchanged physical
  // row order. Any miss ⇒ the run bills every row (correctness over savings).
  if (draft.config.columnName !== runConfig.columnName) return [];
  if (draft.configHash !== computeConfigHash(runConfig)) return [];
  const sheet = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { row_generation: number } | undefined;
  if (!sheet || draft.rowGeneration !== sheet.row_generation) return [];

  // Per-row validity: the row is a target and still exists (read below),
  // previewed cleanly, and its referenced cells are byte-identical to what the
  // preview's prompt saw (inputHash over the interpolated prompt). An edited
  // row simply falls back into the to-run set — only THAT row is re-billed.
  const inTargets = targets ? new Set(targets) : null;
  const candidates = draft.previewResults.filter(r =>
    !r.error && r.value !== '' && r.inputHash && (!inTargets || inTargets.has(r.rowIndex))
    // Never promote a value that IS the worker's placeholder sentinel. If a
    // model literally output '⏳ Processing...', writing it into the cell and
    // skipping placeholder-seeding would leave a cell the worker's row filter
    // (data[col] === '⏳ Processing...') re-runs — re-billing it and inserting a
    // duplicate ai_results row (no UNIQUE(run_id,row_index) on ai_results).
    && r.value !== '⏳ Processing...');
  if (candidates.length === 0) return [];

  const marks = candidates.map(() => '?').join(',');
  const current = db.prepare(`
    SELECT row_index, data FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index IN (${marks})
  `).all(sheetId, userId, ...candidates.map(c => c.rowIndex)) as Array<{ row_index: number; data: string }>;
  const currentData = new Map(current.map(r => [r.row_index, r.data]));

  const writeValue = db.prepare(`
    UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND row_index = ?
  `);
  const insertResult = db.prepare(`
    INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status)
    VALUES (?, ?, ?, ?, ?, ?, 'completed')
  `);

  const outputPath = jsonPath(outputColumn);
  const promoted: number[] = [];
  for (const c of candidates) {
    const dataJson = currentData.get(c.rowIndex);
    if (!dataJson) continue;
    let rowData: Record<string, string>;
    try { rowData = JSON.parse(dataJson) as Record<string, string>; } catch { continue; }
    if (computeInputHash(runConfig.prompt, rowData) !== c.inputHash) continue;

    // Enrichment cell cap (P2-8): clamp ONCE so the cell and the ai_results row
    // get the identical value (this path writes AI output directly, bypassing
    // ai-row.ts). Preview values are already length-bounded by the preview
    // runner; this is the storage backstop, consistent with the worker path.
    const value = clampCellChars(c.value, CELL_MAX_ENRICHMENT);
    writeValue.run(outputPath, value, sheetId, userId, c.rowIndex);
    // The ai_results row makes the promoted row indistinguishable from a
    // worker-processed one: getRun counts it, SSE replays it (same value the
    // cell already holds), and finalize's hasUnfinishedRow stays satisfied.
    insertResult.run(uuidv4(), runId, userId, c.rowIndex, dataJson, value);
    promoted.push(c.rowIndex);
  }
  return promoted;
}
