// How many rows of a run would reuse a found answer instead of calling treg,
// for the estimates ("312 rows reuse earlier answers, at no cost"): the rows
// the run takes, in row order with seeding's own check (lib/enrich-seed.ts),
// each row's lookup looked up in the index (services/enrich-reuse.ts). A pure
// read. A big run is counted for ENRICH_REUSE_COUNT_MS at most, a page at a
// time with other requests let in between; what it counted by then is a floor
// ("at least"), so an estimate that prices the other rows stays an upper bound.
import { db } from '../lib/db';
import { ENRICH_REUSE_COUNT_MS } from '../lib/constants';
import { parseRowData } from '../lib/sql-rows';
import { yieldToRequests } from '../lib/slices';
import { seedVerdict, type SeedPlan } from '../lib/enrich-seed';
import { answerPathsOf, readsRaw, reuseKeyOf } from '../lib/enrich-reuse-key';
import { getReuseDays, hasReusable, reuseSince } from './enrich-reuse';
import { rowRequest } from './enrich-row';
import { rowFilterSql, type RowFilterSql } from './enrich-rows-filter';
import { prepareEnrichmentStart, seedPlanFor, type PreparedStart } from './enrich-run-prepare';
import type { RunFail } from './run-shared';
import type { EnrichRunInput } from '../lib/enrich-run-input';

const PAGE = 500;

// rows: rows that would reuse an answer; checked: rows of the run looked at
// (all of them when complete); days: the account's setting.
export interface ReuseCount { rows: number; checked: number; complete: boolean; days: number }

export interface ReuseCountJob {
  sheetId: string; plan: SeedPlan; rowFilter: RowFilterSql;
  targets: number[] | null;   // selected rows
  limit: number;              // the most rows the run takes (its test rows, else the rows in scope)
}

// The rows a prepared start would take (services/enrich-run-prepare.ts).
export function reuseJobFor(
  userId: string, sheetId: string, input: EnrichRunInput, p: PreparedStart,
): ReuseCountJob {
  return {
    sheetId, plan: seedPlanFor(input, p), rowFilter: rowFilterSql(sheetId, userId, input.rows.mode),
    targets: input.rows.mode === 'selected' ? input.rows.rowIndexes : null, limit: p.upperBound,
  };
}

// stop: the asker has gone (the drawer moved on): no more pages.
export async function countReusable(
  userId: string, job: ReuseCountJob, budgetMs = ENRICH_REUSE_COUNT_MS, stop?: () => boolean,
): Promise<ReuseCount> {
  const days = getReuseDays(userId);
  const e = job.plan.config.enrichment;
  const since = e.fresh || e.noReuse ? null : reuseSince(days);
  const out: ReuseCount = { rows: 0, checked: 0, complete: true, days };
  if (!since || job.limit <= 0) return out;
  // A run reading the raw part only reuses an answer that kept it whole.
  const whole = readsRaw(answerPathsOf(job.plan.config));
  const f = job.rowFilter;
  // Selected rows are read by their numbers, the rest a page at a time from the top.
  const targets = job.targets ? [...new Set(job.targets)].sort((a, b) => a - b) : null;
  // The out-of-date flag, when the rows the run takes depend on it.
  const stale = job.plan.stale ?? null;
  const orStale = stale ? ` OR ${stale.sql} IS 1` : '';
  const sp = stale?.params ?? [];
  const byIndex = db.prepare(`SELECT row_index, data, (0${orStale}) AS stale FROM rows
    WHERE sheet_id = ? AND user_id = ?
    AND row_index IN (SELECT value FROM json_each(?))${f.clause} ORDER BY row_index`);
  const scan = db.prepare(`SELECT row_index, data, (0${orStale}) AS stale FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ?${f.clause}
    ORDER BY row_index LIMIT ${PAGE}`);
  const deadline = Date.now() + budgetMs;
  for (let at = 0, after = Number.MIN_SAFE_INTEGER; ;) {
    let rows: Array<{ row_index: number; data: string; stale: number }>;
    let last: boolean;
    if (targets) {
      rows = byIndex.all(...sp, job.sheetId, userId, JSON.stringify(targets.slice(at, at + PAGE)), ...f.params) as
        typeof rows;
      at += PAGE;
      last = at >= targets.length;
    } else {
      rows = scan.all(...sp, job.sheetId, userId, after, ...f.params) as typeof rows;
      last = rows.length < PAGE;
      if (rows.length) after = rows[rows.length - 1].row_index;
    }
    for (const r of rows) {
      if (out.checked >= job.limit) return out;
      const data = parseRowData(r.data);
      if (seedVerdict(data, job.plan, r.stale === 1) !== 'run') continue;
      out.checked++;
      const req = rowRequest(job.plan.config, { rowIndex: r.row_index, rowId: null, data }, job.plan.columns);
      if ('built' in req && hasReusable(userId, reuseKeyOf(job.plan.config, req.built), since, whole)) out.rows++;
    }
    if (last || out.checked >= job.limit) return out;
    if (Date.now() >= deadline || stop?.()) return { ...out, complete: false };
    await yieldToRequests();
  }
}

// The drawer's count, for a run as it would start now (the start's own checks).
export async function reuseCountFor(
  userId: string, sheetId: string, input: EnrichRunInput, stop?: () => boolean,
): Promise<{ ok: ReuseCount } | RunFail> {
  const prepared = await prepareEnrichmentStart(userId, sheetId, input);
  if ('fail' in prepared) return prepared;
  if (stop?.()) return { ok: { rows: 0, checked: 0, complete: false, days: getReuseDays(userId) } };
  return { ok: await countReusable(userId, reuseJobFor(userId, sheetId, input, prepared.ok), undefined, stop) };
}
