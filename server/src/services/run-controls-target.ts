// Which rows a run control takes (pure): the column menu's "empty or out of
// date", "all" and "failed", or one row (a cell's play button), as each run
// kind's rerun names them: an AI or HTTP API rerun's mode, an enrichment's or
// a waterfall's row status.
import type { EnrichRunInput } from '../lib/enrich-run-input';
import type { EnrichRowsStatus } from '../lib/enrich-run-config';
import type { RerunMode } from './ai-rerun-modes';
import type { RunFail } from './run-shared';

export type RunRows = 'empty_or_out_of_date' | 'all' | 'failed';
export type RunTarget = { rows: RunRows } | { row: number };

const MODE: Record<RunRows, RerunMode> = {
  empty_or_out_of_date: 'empty_or_out_of_date', all: 'all', failed: 'errored',
};
const STATUS: Record<RunRows, EnrichRowsStatus> = {
  empty_or_out_of_date: 'empty_or_out_of_date', all: 'any', failed: 'failed',
};

export const modeOf = (t: { rows: RunRows }): RerunMode => MODE[t.rows];

export function enrichRowsOf(t: RunTarget): EnrichRunInput['rows'] {
  return 'row' in t
    ? { mode: 'selected', status: 'any', test: null, rowIndexes: [t.row] }
    : { mode: 'all', status: STATUS[t.rows], test: null, rowIndexes: null };
}

export const NOTHING: RunFail = { fail: 'bad_request', message: 'There are no rows to run.', nothingToRun: true };

// The app's body: { column, rows } or { column, row, rowGeneration? }, plus a
// run limit the confirm quoted (spendLimitUsd) when it starts.
export interface RunControlBody {
  column: string; target: RunTarget; rowGeneration: number | null; spendLimitUsd: number | null;
}

export function parseRunControl(body: unknown): { ok: RunControlBody } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send a JSON object.' };
  const b = body as Record<string, unknown>;
  const stray = Object.keys(b).find(k => !['column', 'rows', 'row', 'rowGeneration', 'spendLimitUsd'].includes(k));
  if (stray) return { error: `Unknown field ${stray}.` };
  if (typeof b.column !== 'string' || !b.column) return { error: 'column is required.' };
  let target: RunTarget;
  if (b.row !== undefined) {
    if (b.rows !== undefined) return { error: 'Send rows or row, not both.' };
    if (typeof b.row !== 'number' || !Number.isInteger(b.row) || b.row < 0) {
      return { error: 'row must be a row number.' };
    }
    target = { row: b.row };
  } else if (b.rows === 'empty_or_out_of_date' || b.rows === 'all' || b.rows === 'failed') {
    target = { rows: b.rows };
  } else {
    return { error: 'rows is empty_or_out_of_date, all or failed (or send row).' };
  }
  const gen = b.rowGeneration ?? null;
  if (gen !== null && !(typeof gen === 'number' && Number.isInteger(gen))) {
    return { error: 'rowGeneration must be a number.' };
  }
  const limit = b.spendLimitUsd ?? null;
  if (limit !== null && !(typeof limit === 'number' && Number.isFinite(limit) && limit > 0)) {
    return { error: 'spendLimitUsd must be more than 0.' };
  }
  return {
    ok: { column: b.column, target, rowGeneration: gen as number | null, spendLimitUsd: limit as number | null },
  };
}
