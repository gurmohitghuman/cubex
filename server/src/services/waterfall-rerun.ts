// Running a waterfall column again from its menu (and run_type 'waterfall'
// reruns over REST and MCP): the column's newest setup recalled
// (services/waterfall-column.ts) and started on the rows asked for: the ones
// not run yet, the ones without a result, the failed ones, chosen rows, or
// all of them. With estimateOnly, the confirm's figures (a pure read).
import type { EnrichRowsStatus } from '../lib/enrich-run-config';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import { newestWaterfallRun, recallInput } from './waterfall-column';
import { estimateWaterfall, type WaterfallEstimate } from './waterfall-estimate';
import { startWaterfallRun, type WaterfallStarted } from './waterfall-run-start';
import type { RunFail } from './run-shared';

export interface WaterfallRerun {
  column: string;
  status: EnrichRowsStatus;               // which rows of the column, by their result cell
  rowIndexes: number[] | null;            // chosen rows (status then applies within them)
  test: number | null;                    // only the first rows that fit
  rowGeneration: number | null;
  fresh: boolean;                         // "always call again": no reuse, no dry-run answers
  noReuse: boolean;                       // this run only
  spendLimitUsd: number | null;
}

export function rerunInput(base: WaterfallRunInput, r: WaterfallRerun): WaterfallRunInput {
  return {
    ...base, continueColumn: true,
    rows: { mode: r.rowIndexes ? 'selected' : 'all', status: r.status, test: r.test, rowIndexes: r.rowIndexes },
    rowGeneration: r.rowGeneration, fresh: r.fresh || base.fresh, noReuse: r.noReuse,
    spendLimitUsd: r.spendLimitUsd,
  };
}

export async function rerunWaterfallColumn(
  userId: string, sheetId: string, r: WaterfallRerun, opts: { estimateOnly: boolean; hasSecretsScope: boolean },
): Promise<{ ok: { estimate: WaterfallEstimate } | { started: WaterfallStarted } } | RunFail> {
  const run = newestWaterfallRun(sheetId, userId, r.column);
  if (!run) return { fail: 'not_found', message: `"${r.column}" isn't a waterfall column.` };
  const input = rerunInput(recallInput(run.config, r.column), r);
  if (opts.estimateOnly) {
    const est = await estimateWaterfall(userId, sheetId, input);
    return 'fail' in est ? est : { ok: { estimate: est.ok } };
  }
  const out = await startWaterfallRun(userId, sheetId, input, { hasSecretsScope: opts.hasSecretsScope });
  return 'fail' in out ? out : { ok: { started: out.ok } };
}

const STATUSES = new Set(['any', 'not_enriched', 'no_result', 'failed']);
const RERUN_KEYS = ['column', 'status', 'rowIndexes', 'test', 'rowGeneration', 'fresh', 'noReuse', 'spendLimitUsd',
  'estimateOnly'];

// The app's rerun body, strictly (pure).
export function parseWaterfallRerun(
  body: unknown,
): { ok: WaterfallRerun & { estimateOnly: boolean } } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the rerun as a JSON object.' };
  const b = body as Record<string, unknown>;
  const stray = Object.keys(b).find(k => !RERUN_KEYS.includes(k));
  if (stray) return { error: `Unknown field ${stray}.` };
  if (typeof b.column !== 'string' || !b.column) return { error: 'column is required.' };
  const status = b.status ?? 'not_enriched';
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    return { error: 'status is any, not_enriched, no_result or failed.' };
  }
  const idx = b.rowIndexes;
  if (idx !== undefined && idx !== null && (!Array.isArray(idx) || idx.length === 0
    || !idx.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0))) {
    return { error: 'rowIndexes must list row numbers.' };
  }
  const test = b.test ?? null;
  if (test !== null && !(typeof test === 'number' && Number.isInteger(test) && test >= 1)) {
    return { error: 'test must be a number of rows.' };
  }
  const limit = b.spendLimitUsd ?? null;
  if (limit !== null && !(typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) {
    return { error: 'spendLimitUsd must be more than 0.' };
  }
  const gen = b.rowGeneration ?? null;
  if (gen !== null && !(typeof gen === 'number' && Number.isInteger(gen))) {
    return { error: 'rowGeneration must be a number.' };
  }
  return {
    ok: {
      column: b.column, status: status as EnrichRowsStatus, rowIndexes: (idx as number[] | null | undefined) ?? null,
      test: test as number | null, rowGeneration: gen as number | null, fresh: b.fresh === true,
      noReuse: b.noReuse === true,
      spendLimitUsd: limit as number | null, estimateOnly: b.estimateOnly === true,
    },
  };
}
