// Run control for waterfall runs on the agent surfaces (MCP control_run and
// /api/v1/http-runs/:id/{resume,rerun}). A waterfall is an HTTP run, but the
// plain HTTP rerun can't clone it: its reruns go through the column's own
// setup (services/waterfall-rerun.ts), and a resume can raise its run limit.
import { db } from '../lib/db';
import { ENRICH_DAILY_LIMIT_MAX_USD } from '../lib/constants';
import type { EnrichRowsStatus } from '../lib/enrich-run-config';
import { waterfallConfigOf } from '../lib/waterfall/config';
import { httpRunSecretRefsRequiringScope } from '../lib/http-secrets-scan';
import { resolveRowIdsToIndexes, type RunFail } from './run-shared';
import { resumeCapRefusal, resumeRun, type ControlOutcome } from './run-lifecycle';
import { rerunWaterfallColumn } from './waterfall-rerun';

export const isWaterfallRun = (runId: string, userId: string): boolean => waterfallConfigOf(db.prepare(
  'SELECT config FROM http_runs WHERE id = ? AND user_id = ?',
).pluck().get(runId, userId) as string | null ?? null) !== null;

// The agent modes, in the words AI reruns use, as the rows a rerun takes.
export const WATERFALL_RERUN_MODES: Record<string, EnrichRowsStatus> = {
  errored: 'failed', empty: 'not_enriched', missing: 'no_result', all: 'any',
  out_of_date: 'out_of_date', empty_or_out_of_date: 'empty_or_out_of_date',
};

const limitProblem = (limit: number | null | undefined): string | null => {
  if (limit === undefined || limit === null) return null;
  if (Number.isFinite(limit) && limit > 0 && limit <= ENRICH_DAILY_LIMIT_MAX_USD) return null;
  return `The run limit must be more than $0 and at most $${ENRICH_DAILY_LIMIT_MAX_USD.toLocaleString('en-US')}.`;
};

export async function rerunWaterfallRunById(
  userId: string, runId: string,
  opts: { rowIds?: string[]; mode?: string; spendLimitUsd?: number | null; hasSecretsScope: boolean },
): Promise<{ ok: { runId: string; rowsInScope: number } } | RunFail> {
  const bad = limitProblem(opts.spendLimitUsd);
  if (bad) return { fail: 'bad_request', message: bad };
  const run = db.prepare('SELECT sheet_id, master_column_name FROM http_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { sheet_id: string; master_column_name: string | null } | undefined;
  if (!run?.master_column_name) return { fail: 'not_found', message: 'Waterfall run not found' };
  const latest = db.prepare(`SELECT id FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck().get(run.sheet_id, userId, run.master_column_name) as string;
  if (latest !== runId) {
    return {
      fail: 'conflict',
      message: 'This run has been superseded by a newer run on the same column. Rerun the latest run instead: '
        + `${latest}.`,
    };
  }
  let rowIndexes: number[] | null = null;
  if (opts.rowIds) {
    const r = resolveRowIdsToIndexes(run.sheet_id, userId, opts.rowIds);
    if ('error' in r) return { fail: 'bad_request', message: r.error };
    rowIndexes = [...new Set(r.indexes)].sort((a, b) => a - b);
  }
  const status: EnrichRowsStatus | undefined = rowIndexes ? 'any' : WATERFALL_RERUN_MODES[opts.mode ?? ''];
  if (!status) {
    return {
      fail: 'bad_request',
      message: "A waterfall rerun needs row_ids or mode: 'errored', 'empty' (not run yet), 'missing' (no result) "
        + "or 'all' (runs every row again).",
    };
  }
  // Rows by number, fenced: a sort before the start would re-mean them.
  const generation = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(run.sheet_id, userId) as number;
  const out = await rerunWaterfallColumn(userId, run.sheet_id, {
    column: run.master_column_name, status, rowIndexes, test: null, rowGeneration: rowIndexes ? generation : null,
    fresh: false, noReuse: false, spendLimitUsd: opts.spendLimitUsd ?? null,
  }, { estimateOnly: false, hasSecretsScope: opts.hasSecretsScope });
  if ('fail' in out) return out;
  if (!('started' in out.ok)) return { fail: 'bad_request', message: 'Nothing was started.' };
  return { ok: { runId: out.ok.started.runId, rowsInScope: out.ok.started.rowsInScope } };
}

// Resume, optionally with a higher run limit (a run its limit paused), written
// before the resume's own compare-and-set, only while the run is still paused.
export async function resumeWaterfallRun(
  runId: string, userId: string, spendLimitUsd: number | null | undefined, hasSecretsScope: boolean,
): Promise<ControlOutcome | { fail: 'bad_request'; message: string }> {
  const bad = limitProblem(spendLimitUsd);
  if (bad) return { fail: 'bad_request', message: bad };
  // A resume refused at a spend cap changes nothing (run-lifecycle.ts).
  const capped = resumeCapRefusal('http', runId, userId);
  if (capped) return { fail: 'spend_cap', message: capped };
  if (spendLimitUsd !== undefined && spendLimitUsd !== null) {
    // The resume's own secrets check first: a caller it refuses changes nothing.
    const run = db.prepare('SELECT config, allow_secrets FROM http_runs WHERE id = ? AND user_id = ?')
      .get(runId, userId) as { config: string | null; allow_secrets: number | null } | undefined;
    const refs = run ? httpRunSecretRefsRequiringScope(userId, run, hasSecretsScope) : [];
    if (refs.length > 0) {
      return {
        fail: 'secrets_required',
        message: `This run references saved API key(s): ${refs.join(', ')}. Resuming it requires the 'secrets' scope.`,
      };
    }
    const r = db.prepare(`UPDATE http_runs SET config = json_set(config, '$.waterfall.spendLimitUsd', ?)
      WHERE id = ? AND user_id = ? AND status = 'paused' AND json_type(config, '$.waterfall') = 'object'`)
      .run(spendLimitUsd, runId, userId);
    if (r.changes === 0) return { fail: 'not_paused', message: 'Run is not paused' };
  }
  return resumeRun('http', runId, userId, hasSecretsScope);
}
