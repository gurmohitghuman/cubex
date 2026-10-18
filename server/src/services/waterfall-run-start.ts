// Starting a waterfall run: the flow behind the app's Run, the column menu's
// reruns, MCP waterfall_column and /api/v1. Checks the keys its steps need
// (treg for enrichment steps, OpenRouter for AI steps, the 'secrets' scope
// for an HTTP step reading a saved key), prepares the config
// (services/waterfall-run-prepare.ts), then in ONE immediate transaction inside
// the sheet's busy window: the column cap, the new columns, the run row, its
// column associations, and new step columns hidden in every view. Seeding the
// ⏳ (only into the result and "answered by" columns, only on the rows the run
// takes) and queueing follow in the background, as an enrichment's do
// (services/enrich-seed-run.ts); the start answers at once.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { savedKeyRefsInRun } from '../lib/http-secrets-scan';
import { ANSWERED_BY_PATH, rowSteps } from '../lib/waterfall/config';
import { usesTreg } from '../lib/waterfall/caps';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import { asRunStart } from './run-seed';
import { rowFilterSql } from './enrich-rows-filter';
import { seedEnrichmentThenEnqueue } from './enrich-seed-run';
import { getTregToken } from './treg-key';
import { getOpenRouterApiKey } from './openrouter';
import type { RunFail } from './run-shared';
import { activeRunOn, prepareWaterfallStart, seedPlanFor, type PreparedWaterfall } from './waterfall-run-prepare';
import { hideInViews } from './waterfall-views';

export interface WaterfallStarted {
  runId: string; resultColumn: string; outputColumns: string[]; rowsInScope: number;
}
export type WaterfallStartOutcome = { ok: WaterfallStarted } | RunFail;

const generationOf = (sheetId: string, userId: string): number | undefined => db.prepare(
  'SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?',
).pluck().get(sheetId, userId) as number | undefined;

// What the steps the run walks need before it can start (a dry run of one
// step: that step's), or why it can't.
export function keysProblem(
  userId: string, p: Pick<PreparedWaterfall, 'config'>, hasSecretsScope: boolean,
): RunFail | { allowSecrets: number } {
  const on = rowSteps(p.config);
  if (on.some(usesTreg) && !getTregToken(userId)) {
    return { fail: 'conflict', message: 'Add your treg key in Settings first: an enrichment step needs it.' };
  }
  if (on.some(s => s.built.kind === 'ai') && !getOpenRouterApiKey(userId)) {
    return { fail: 'conflict', message: 'Add your OpenRouter key in Settings first: an AI step needs it.' };
  }
  const keys = savedKeyRefsInRun(userId, p.config);
  if (keys.length && !hasSecretsScope) {
    return {
      fail: 'forbidden',
      message: `An HTTP step reads the saved key ${keys.map(k => `/${k}`).join(', ')}: this needs the 'secrets' scope.`,
    };
  }
  // A run that reads no saved key can never read one (a key made later included).
  return { allowSecrets: keys.length ? 1 : 0 };
}

export async function startWaterfallRun(
  userId: string, sheetId: string, input: WaterfallRunInput, opts: { hasSecretsScope: boolean },
): Promise<WaterfallStartOutcome> {
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const prepared = await prepareWaterfallStart(userId, sheetId, input);
  if ('fail' in prepared) return prepared;
  const p = prepared.ok;
  const keys = keysProblem(userId, p, opts.hasSecretsScope);
  if ('fail' in keys) return keys;
  const runId = uuidv4();
  const outputNames = p.outputs.map(o => o.columnName);
  const placeholderColumns = [p.resultColumn,
    ...p.outputs.filter(o => o.jsonPath === ANSWERED_BY_PATH).map(o => o.columnName)];

  return asRunStart(sheetId, async (): Promise<WaterfallStartOutcome> => {
    let capNeeded = -1, raced: string | null = null;
    db.transaction(() => {
      const current = new Set(getSheetColumns(sheetId, userId, false));
      // Again inside the write lock: the catalog and price reads above awaited the network.
      if (input.continueColumn ? activeRunOn(sheetId, userId, p.resultColumn)
        : [p.resultColumn, ...outputNames].some(c => current.has(c))) {
        raced = 'Another run just started on these columns. Try again in a moment.';
        return;
      }
      const moved = input.rowGeneration !== null && generationOf(sheetId, userId) !== input.rowGeneration;
      if (input.rows.mode === 'selected' && moved) {
        raced = 'This sheet was reordered elsewhere. Reload before running selected rows.';
        return;
      }
      const added = p.newColumns.filter(c => !current.has(c));
      if (current.size + added.length > MAX_COLUMNS_PER_SHEET) { capNeeded = added.length; return; }
      appendColumnsToOrder(sheetId, userId, p.newColumns);
      db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
          target_rows, allow_secrets, placeholder_work)
        VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, 'seeding')`)
        .run(runId, sheetId, userId, JSON.stringify(p.config), p.resultColumn, keys.allowSecrets);
      // Every output is linked to THIS run: clearing a stopped run's ⏳ and the
      // column delete/rename guards find a run's columns through its associations.
      const assoc = db.prepare(`INSERT INTO http_column_associations
          (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const name of outputNames) assoc.run(uuidv4(), sheetId, userId, p.resultColumn, name, runId);
      hideInViews(sheetId, userId, p.hideColumns.filter(c => !current.has(c)));
    }).immediate();
    if (raced) return { fail: 'conflict', message: raced };
    if (capNeeded >= 0) {
      return {
        fail: 'cap',
        message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This waterfall needs ${capNeeded} new `
          + 'columns. Delete unused columns first.',
      };
    }
    seedEnrichmentThenEnqueue({
      runId, sheetId, userId, columns: placeholderColumns, plan: seedPlanFor(input, p),
      rowFilter: rowFilterSql(sheetId, userId, input.rows.mode),
      targets: input.rows.mode === 'selected' ? input.rows.rowIndexes : null,
      lastRow: p.span.lastRow, test: input.rows.test,
    });
    return { ok: { runId, resultColumn: p.resultColumn, outputColumns: outputNames, rowsInScope: p.upperBound } };
  });
}
