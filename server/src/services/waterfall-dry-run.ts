// A dry run (#14): the waterfall on a few rows for real (its calls cost what
// they cost, within today's limit and its own), writing nothing to the sheet.
// Each row's trace stays with the run (http_results); every answer it bought is
// kept WATERFALL_ANSWER_KEEP_DAYS so the real run replays it at $0
// (waterfall-journal.ts, scope 'dry'). "Test this step" is a dry run of one
// step (dry.only). It has no result column, no placeholders and makes no
// column: http_runs.master_column_name is NULL and target_rows lists its rows,
// so the worker walks exactly those (a resume skips the ones already done).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { WATERFALL_DRY_MAX_ROWS, WATERFALL_DRY_ROWS } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { parseRowData } from '../lib/sql-rows';
import { statusMatches } from '../lib/enrich-seed';
import { rulePasses } from '../lib/run-condition';
import { rowSteps, type WaterfallRunConfig } from '../lib/waterfall/config';
import { rowCaps } from '../lib/waterfall/caps';
import { waterfallRowCanRun } from '../lib/waterfall/rows';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import { enqueueHTTPRerun } from '../queue';
import { rowFilterSql } from './enrich-rows-filter';
import { resolveRowIdsToIndexes, type RunFail } from './run-shared';
import { prepareWaterfallStart, type PreparedWaterfall } from './waterfall-run-prepare';
import { keysProblem } from './waterfall-run-start';
import { LOOKUP_MOVED, lookupStepsMoved } from './waterfall-build-lookup';

export interface DryRunStarted { runId: string; rowIndexes: number[] }

const SCAN_PAGE = 500;
const SCAN_MAX = 5_000;            // rows read looking for ones the run would take
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// The first WATERFALL_DRY_ROWS rows the real run would take (its rows choice,
// a continued column's status, Only run if) on which a step it walks can run.
function firstRows(
  sheetId: string, userId: string, input: WaterfallRunInput, p: PreparedWaterfall, walk: WaterfallRunConfig,
): number[] {
  const f = rowFilterSql(sheetId, userId, input.rows.mode === 'filter' ? 'filter' : 'all');
  const page = db.prepare(`SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?${
    f.clause} ORDER BY row_index LIMIT ${SCAN_PAGE}`);
  const picked: number[] = [];
  let read = 0;
  for (let after = Number.MIN_SAFE_INTEGER; picked.length < WATERFALL_DRY_ROWS && read < SCAN_MAX;) {
    const rows = page.all(sheetId, userId, after, ...f.params) as Array<{ row_index: number; data: string }>;
    if (rows.length === 0) break;
    read += rows.length;
    after = rows[rows.length - 1].row_index;
    for (const r of rows) {
      const data = parseRowData(r.data);
      if (input.continueColumn && !statusMatches(data[p.resultColumn], input.rows.status)) continue;
      if (p.rule && !rulePasses(p.rule.tree, data)) continue;
      if (!waterfallRowCanRun(walk, data, p.columns)) continue;
      picked.push(r.row_index);
      if (picked.length >= WATERFALL_DRY_ROWS) break;
    }
  }
  return picked;
}

function rowsFor(
  sheetId: string, userId: string, input: WaterfallRunInput, p: PreparedWaterfall, walk: WaterfallRunConfig,
): { rows: number[] } | RunFail {
  const ids = input.dry?.rowIds ?? null;
  const picked = ids ? resolveRowIdsToIndexes(sheetId, userId, ids)
    : input.rows.mode === 'selected' && input.rows.rowIndexes?.length ? { indexes: input.rows.rowIndexes }
      : { indexes: firstRows(sheetId, userId, input, p, walk) };
  if ('error' in picked) return bad(picked.error);
  const rows = [...new Set(picked.indexes)].sort((a, b) => a - b);
  if (rows.length > WATERFALL_DRY_MAX_ROWS) return bad(`A dry run takes at most ${WATERFALL_DRY_MAX_ROWS} rows.`);
  if (rows.length === 0) {
    return { ...bad('No row here has the inputs any step needs (or passes "Only run if").'), nothingToRun: true };
  }
  return { rows };
}

// The run's config: no columns of its own, the steps it walks, their caps.
const walkConfig = (p: PreparedWaterfall, only: string | null): WaterfallRunConfig => ({
  ...p.config, responseMapping: [], waterfall: { ...p.config.waterfall, dry: { column: p.resultColumn, only } },
});

function dryConfig(base: WaterfallRunConfig, rows: number, limit: number | null): WaterfallRunConfig {
  const walked = rowSteps(base);
  const { most, treg } = rowCaps(walked);
  return {
    ...base,
    waterfall: {
      ...base.waterfall, maxCostPerRowUsd: most, tregCapPerRowUsd: treg,
      spendLimitUsd: limit ?? (most > 0 ? round6(rows * most) : null),
    },
  };
}

export async function startWaterfallDryRun(
  userId: string, sheetId: string, input: WaterfallRunInput, opts: { hasSecretsScope: boolean },
): Promise<{ ok: DryRunStarted } | RunFail> {
  if (!input.dry) return bad('Not a dry run.');
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const prepared = await prepareWaterfallStart(userId, sheetId, input);
  if ('fail' in prepared) return prepared;
  const p = prepared.ok;
  const walk = walkConfig(p, input.dry.only);
  const picked = rowsFor(sheetId, userId, input, p, walk);
  if ('fail' in picked) return picked;
  const config = dryConfig(walk, picked.rows.length, input.spendLimitUsd);
  const keys = keysProblem(userId, { config }, opts.hasSecretsScope);
  if ('fail' in keys) return keys;
  // Nothing awaited between this check and the insert: a rename there can't land in between.
  if (lookupStepsMoved(config, userId)) return { fail: 'conflict', message: LOOKUP_MOVED };
  const runId = uuidv4();
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
      target_rows, allow_secrets) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`)
    .run(runId, sheetId, userId, JSON.stringify(config), picked.rows.length, JSON.stringify(picked.rows),
      keys.allowSecrets);
  await enqueueHTTPRerun(runId, picked.rows);
  return { ok: { runId, rowIndexes: picked.rows } };
}
