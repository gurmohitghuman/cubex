// A check of a hiring table: one implementation for the app, /api/v1 and MCP.
// The estimate first (a pure read, and free): the searches, the most they can
// cost, and the free count of roles they match where the job index has one.
// Then, only when asked, the search: one run of the Searches column on every
// search row, keeping the roles found before (keep mode: only roles Roles
// never had are added, First seen this check's day), its spend limit the
// estimate's most, so a check never spends more than its estimate showed.
// Once the run is over and its roles are in, the summary per company (free:
// services/hiring-check-watch.ts). Each stage is journaled (hiring_checks,
// migration 061): a restart waits for the run as before and then sums up; it
// never starts a search on its own. One check of a table at a time.
import { db } from '../lib/db';
import { countRows, getSheetColumns } from '../lib/sql-helpers';
import { getColumnTypes } from '../lib/column-types';
import { dayIn } from '../lib/ai-visibility/check';
import { nowDate } from '../lib/clock';
import { HIRING_COUNT_MAX_SEARCHES } from '../lib/constants';
import { recallChoices, rerunInput } from '../lib/enrich-run-recall';
import { HIRING_TOOL_ID, ROLE_COLUMNS, SEARCH_COLUMNS } from '../lib/hiring/names';
import { newestColumnRun } from './enrich-column';
import { rerunEnrichmentColumn, type RerunEstimate } from './enrich-rerun';
import { startEnrichmentRun } from './enrich-run-start';
import { countJobs, type JobCount, type SearchTerms } from './job-count';
import { watchHiringCheck } from './hiring-check-watch';
import {
  hiringCheckGoing, hiringCheckView, insertHiringCheck, lastSearchedDay, loadHiringCheck, sheetLive,
  updateHiringCheck, type HiringCheckView, type HiringRecord,
} from './hiring-store';
import type { RunFail } from './run-shared';

export interface HiringPlan {
  label: string; since: string | null; searches: number; column: string; provider: string | null; perSearch: number;
}
export interface HiringEstimate {
  searches: number; rolesUpTo: number; priceKnown: boolean; lowUsd: number; highUsd: number;
  dailyLimit: RerunEstimate['dailyLimit'];
  // The free count, "about" (null: none: the job index has none, or it didn't answer).
  matches: JobCount | null;
}
export interface CheckOpts { timeZone?: string | null }

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const ALL = { mode: 'all' as const, status: 'any' as const, test: null, rowIndexes: null };

// The Searches column: the one whose job search adds rows to Roles (found by what fills it, not by name).
export function searchColumnOf(userId: string, rec: HiringRecord): string | null {
  const s = rec.searches_sheet_id;
  if (!s) return null;
  const types = getColumnTypes(s, userId);
  return getSheetColumns(s, userId).find(c => {
    if (types[c] !== 'enrich-status') return false;
    const e = newestColumnRun(s, userId, c)?.config.enrichment;
    return e?.toolId === HIRING_TOOL_ID && e.list?.destSheetId === rec.roles_sheet_id;
  }) ?? null;
}

const today = (timeZone: string | null) => dayIn(nowDate().toISOString().replace('T', ' ').slice(0, 19), timeZone);

// What a check would do now, or why it can't (a pure read).
export function hiringPlan(userId: string, rec: HiringRecord, opts: CheckOpts = {}): HiringPlan | RunFail {
  if (!sheetLive(userId, rec.searches_sheet_id) || !sheetLive(userId, rec.roles_sheet_id)) {
    return bad('This table no longer has its Searches and Roles sheets.');
  }
  const column = searchColumnOf(userId, rec);
  if (!column) return bad(`Searches no longer has its "${SEARCH_COLUMNS.status}" column to search with.`);
  if (hiringCheckGoing(userId, rec.id)) return { fail: 'conflict', message: 'A check of this table is still going.' };
  const run = newestColumnRun(rec.searches_sheet_id!, userId, column)!;
  if (run.active) {
    return { fail: 'conflict', message: run.status === 'paused'
      ? `The last search is paused: resume or cancel "${column}" in Searches, then check again.`
      : `"${column}" is still searching: check again once it's done.` };
  }
  const searches = countRows(rec.searches_sheet_id!, userId);
  if (searches === 0) return bad('Searches has no rows: add a role title to search for.');
  const list = run.config.enrichment.list;
  return {
    label: today(opts.timeZone ?? null), since: lastSearchedDay(userId, rec.id), searches, column,
    provider: list?.provider ?? null, perSearch: list?.maxItems ?? 0,
  };
}

// The first searches' terms, for the free count.
function searchTerms(userId: string, sheetId: string): SearchTerms[] {
  const rows = db.prepare(`SELECT json_extract(data, ?) AS t, json_extract(data, ?) AS c, json_extract(data, ?) AS d
    FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?`).all(
    `$."${SEARCH_COLUMNS.role}"`, `$."${SEARCH_COLUMNS.country}"`, `$."${SEARCH_COLUMNS.days}"`, sheetId, userId,
    HIRING_COUNT_MAX_SEARCHES) as Array<{ t: unknown; c: unknown; d: unknown }>;
  return rows.filter(r => String(r.t ?? '').trim()).map(r => {
    const days = Number(r.d);
    return { title: String(r.t).trim(), country: String(r.c ?? '').trim(),
      days: Number.isSafeInteger(days) && days > 0 ? days : null };
  });
}

async function searchEstimate(userId: string, rec: HiringRecord, plan: HiringPlan):
  Promise<RerunEstimate | RunFail> {
  const r = await rerunEnrichmentColumn(userId, rec.searches_sheet_id!, {
    column: plan.column, rows: ALL, estimateOnly: true, spendLimitUsd: null, rowGeneration: null, callAgain: true,
  });
  if ('fail' in r) return r;
  return 'estimate' in r.ok ? r.ok.estimate : bad("The search can't be estimated now.");
}

export async function estimateHiringCheck(userId: string, rec: HiringRecord, opts: CheckOpts = {}):
  Promise<{ plan: HiringPlan; estimate: HiringEstimate } | RunFail> {
  const plan = hiringPlan(userId, rec, opts);
  if ('fail' in plan) return plan;
  const [est, matches] = await Promise.all([searchEstimate(userId, rec, plan),
    countJobs(userId, plan.provider, searchTerms(userId, rec.searches_sheet_id!))]);
  if ('fail' in est) return est;
  return {
    plan,
    estimate: {
      searches: est.rows, rolesUpTo: est.addsRowsTo?.addUpTo ?? est.rows * plan.perSearch, priceKnown: est.priceKnown,
      lowUsd: est.lowUsd, highUsd: est.highUsd, dailyLimit: est.dailyLimit, matches,
    },
  };
}

// refuse: an agent's check before the search starts (its spend cap and run-start window).
export async function startHiringCheck(
  userId: string, rec: HiringRecord, opts: CheckOpts & { refuse?: () => string | null } = {},
): Promise<{ ok: HiringCheckView } | RunFail> {
  const plan = hiringPlan(userId, rec, opts);
  if ('fail' in plan) return plan;
  const est = await searchEstimate(userId, rec, plan);
  if ('fail' in est) return est;
  if (est.rows === 0) return bad('No search has a role title to search for.');
  const refused = opts.refuse?.() ?? null;
  if (refused) return { fail: 'forbidden', message: refused };
  const id = insertHiringCheck(userId, rec.id, plan.label, plan.since, est.rows);
  if (!id) return { fail: 'conflict', message: 'A check of this table is still going.' };
  const run = newestColumnRun(rec.searches_sheet_id!, userId, plan.column)!;
  const input = rerunInput(recallChoices(run.config, plan.column), ALL, est.priceKnown ? est.highUsd : null);
  const list = input.list!;
  // First seen: this check's day, in every role it adds.
  const copy = list.copy.filter(c => !(c.from === '' && c.to === ROLE_COLUMNS.firstSeen));
  input.list = { ...list, copy: [...copy, { from: '', to: ROLE_COLUMNS.firstSeen, value: plan.label }], keep: true };
  const started = await startEnrichmentRun(userId, rec.searches_sheet_id!, { ...input, noReuse: true })
    .catch((error: Error): RunFail => ({ fail: 'upstream', message: error.message }));
  if ('fail' in started) {
    updateHiringCheck(userId, id, { stage: 'stopped', problems: [`The search didn't start: ${started.message}`] });
    return started;
  }
  updateHiringCheck(userId, id, { runId: started.ok.runId });
  watchHiringCheck(userId, id);
  return { ok: hiringCheckView(loadHiringCheck(userId, id)!) };
}
