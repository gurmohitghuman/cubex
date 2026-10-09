// Run control for enrichment runs on the agent surfaces (MCP control_run and
// /api/v1/http-runs/:id/{resume,rerun}). An enrichment is an HTTP run, but
// the plain HTTP rerun refuses it: its reruns go through the column's own
// setup (services/enrich-rerun.ts, the column menu's actions), and a resume
// can raise its run limit (services/enrich-run-status.ts).
import { db } from '../lib/db';
import { ENRICH_DAILY_LIMIT_MAX_USD } from '../lib/constants';
import type { EnrichRowsStatus } from '../lib/enrich-run-config';
import { enrichConfigOf } from './run-status-enrich';
import { rerunEnrichmentColumn } from './enrich-rerun';
import { appendAutorunNotice } from './enrich-agent-autorun';
import { resolveRowIdsToIndexes, type RunFail } from './run-shared';

export const isEnrichmentRun = (runId: string, userId: string): boolean => enrichConfigOf(db.prepare(
  'SELECT config FROM http_runs WHERE id = ? AND user_id = ?',
).pluck().get(runId, userId) as string | null ?? null) !== null;

// The agent modes, in the words AI reruns use, as the rows a rerun takes.
export const ENRICH_RERUN_MODES: Record<string, EnrichRowsStatus> = {
  errored: 'failed', empty: 'not_enriched', missing: 'no_result', all: 'any',
};

export async function rerunEnrichmentRunById(
  userId: string, runId: string,
  opts: { rowIds?: string[]; mode?: string; spendLimitUsd?: number | null },
): Promise<{ ok: { runId: string; rowsInScope: number; destinationAutoRun?: unknown[] } } | RunFail> {
  const limit = opts.spendLimitUsd;
  if (limit !== undefined && limit !== null
    && (!Number.isFinite(limit) || limit <= 0 || limit > ENRICH_DAILY_LIMIT_MAX_USD)) {
    const max = ENRICH_DAILY_LIMIT_MAX_USD.toLocaleString('en-US');
    return { fail: 'bad_request', message: `The run limit must be more than $0 and at most $${max}.` };
  }
  const run = db.prepare('SELECT sheet_id, master_column_name FROM http_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { sheet_id: string; master_column_name: string | null } | undefined;
  if (!run?.master_column_name) return { fail: 'not_found', message: 'Enrichment run not found' };
  const latest = db.prepare(`SELECT id FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck().get(run.sheet_id, userId, run.master_column_name) as string;
  if (latest !== runId) {
    return {
      fail: 'conflict',
      message: `This run has been superseded by a newer run on the same column. Rerun the latest run instead: `
        + `${latest}.`,
    };
  }
  // Rows by number, fenced: a sort before the start would re-mean them.
  const generation = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(run.sheet_id, userId) as number;
  let rowIndexes: number[] | null = null;
  if (opts.rowIds) {
    const r = resolveRowIdsToIndexes(run.sheet_id, userId, opts.rowIds);
    if ('error' in r) return { fail: 'bad_request', message: r.error };
    rowIndexes = [...new Set(r.indexes)].sort((a, b) => a - b);
  }
  const status: EnrichRowsStatus = rowIndexes ? 'any' : ENRICH_RERUN_MODES[opts.mode ?? ''];
  if (!status) {
    return {
      fail: 'bad_request',
      message: 'An enrichment rerun needs row_ids or mode (errored, empty, missing, all).',
    };
  }
  const out = await rerunEnrichmentColumn(userId, run.sheet_id, {
    column: run.master_column_name, estimateOnly: false, spendLimitUsd: opts.spendLimitUsd ?? null,
    rowGeneration: rowIndexes ? generation : null,
    rows: { mode: rowIndexes ? 'selected' : 'all', status, test: null, rowIndexes },
  });
  if ('fail' in out) return out;
  if (!('runId' in out.ok)) return { fail: 'bad_request', message: 'Nothing was started.' };
  // A list job's rows set off the destination's own auto-runs.
  const config = enrichConfigOf(db.prepare('SELECT config FROM http_runs WHERE id = ? AND user_id = ?')
    .pluck().get(out.ok.runId, userId) as string | null ?? null);
  const list = config?.enrichment.list;
  const notice = out.ok.destSheetId && list
    ? await appendAutorunNotice(userId, out.ok.destSheetId, out.ok.rowsInScope * list.maxItems) : {};
  return {
    ok: {
      runId: out.ok.runId, rowsInScope: out.ok.rowsInScope,
      ...(notice.auto_run ? { destinationAutoRun: notice.auto_run } : {}),
    },
  };
}
