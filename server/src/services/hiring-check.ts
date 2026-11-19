// A check of a hiring table: one implementation for the app, /api/v1 and MCP.
// The estimate first (a pure read, and free): the searches, the most they can
// cost, and the free count of roles they match where the job index has one.
// Then, only when asked, the search: one run of the Searches column on every
// search row, keeping the roles found before (keep mode: only roles Roles
// never had are added, First seen this check's day), its spend limit the
// estimate's most, so a check never spends more than its estimate showed.
// Once the run is over and its roles are in, the summary per company (free,
// services/hiring-summarize.ts). Each stage is journaled (hiring_checks,
// migration 061): a restart waits for the run as before and then sums up; it
// never starts a search on its own. One check of a table at a time.
import { db } from '../lib/db';
import { countRows, getSheetColumns } from '../lib/sql-helpers';
import { getColumnTypes } from '../lib/column-types';
import { dayIn } from '../lib/ai-visibility/check';
import { nowDate } from '../lib/clock';
import { HIRING_CHECK_POLL_MS, HIRING_COUNT_MAX_SEARCHES } from '../lib/constants';
import { recallChoices, rerunInput } from '../lib/enrich-run-recall';
import { HIRING_TOOL_ID, ROLE_COLUMNS, SEARCH_COLUMNS } from '../lib/hiring/names';
import { newestColumnRun } from './enrich-column';
import { rerunEnrichmentColumn, type RerunEstimate } from './enrich-rerun';
import { startEnrichmentRun } from './enrich-run-start';
import { countJobs, type JobCount, type SearchTerms } from './job-count';
import { summarizeHiring } from './hiring-summarize';
import {
  hiringCheckGoing, hiringCheckView, insertHiringCheck, lastSearchedDay, loadHiringCheck, updateHiringCheck,
  type HiringCheckView, type HiringRecord,
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
const live = (userId: string, id: string | null) => !!id && !!db.prepare(`SELECT 1 FROM sheets WHERE id = ?
  AND user_id = ? AND trash_id IS NULL`).get(id, userId);

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
  if (!live(userId, rec.searches_sheet_id) || !live(userId, rec.roles_sheet_id)) {
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
  const started = await startEnrichmentRun(userId, rec.searches_sheet_id!, { ...input, noReuse: true });
  if ('fail' in started) {
    updateHiringCheck(userId, id, { stage: 'stopped', problems: [`The search didn't start: ${started.message}`] });
    return started;
  }
  updateHiringCheck(userId, id, { runId: started.ok.runId });
  watchHiringCheck(userId, id);
  return { ok: hiringCheckView(loadHiringCheck(userId, id)!) };
}

// The search's state: still going, or over (with what to say about it).
function searchState(userId: string, runId: string): { going: true } | { going: false; added: number;
  problems: string[] } {
  const run = db.prepare(`SELECT status, pause_reason, list_rows_added FROM http_runs WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as { status: string; pause_reason: string | null; list_rows_added: number } | undefined;
  if (!run) return { going: false, added: 0, problems: ['The search\'s run is gone.'] };
  if (run.status === 'pending' || run.status === 'running') return { going: true };
  const items = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(wait_reason IS NULL), 0) AS adding
    FROM enrichment_list_items WHERE run_id = ? AND user_id = ? AND status = 'pending'`)
    .get(runId, userId) as { n: number; adding: number };
  if (items.adding > 0) return { going: true };
  const problems: string[] = [];
  if (run.status === 'paused') {
    problems.push(`The search paused${run.pause_reason ? ` (${run.pause_reason})` : ''}: what it found so far is `
      + 'summed up. Check again to search every row.');
  }
  if (run.status === 'failed' || run.status === 'cancelled') problems.push(`The search ${run.status === 'failed'
    ? 'failed' : 'was cancelled'}: what it found so far is summed up.`);
  if (items.n > 0) problems.push(`Results of ${items.n} search${items.n === 1 ? '' : 'es'} are waiting to be added.`);
  return { going: false, added: run.list_rows_added, problems };
}

const watching = new Set<string>();

// Waits for the check's search, then sums it up. Each look is a short read; the summary runs once.
export function watchHiringCheck(userId: string, id: string): void {
  if (watching.has(id)) return;
  watching.add(id);
  const look = async (): Promise<void> => {
    const c = loadHiringCheck(userId, id);
    if (!c || c.stage === 'done' || c.stage === 'stopped') { watching.delete(id); return; }
    if (c.stage === 'searching') {
      const s = c.run_id ? searchState(userId, c.run_id) : { going: false as const, added: 0, problems: [] };
      if (s.going) { setTimeout(() => void look(), HIRING_CHECK_POLL_MS).unref(); return; }
      updateHiringCheck(userId, id, { stage: 'summarizing', rolesAdded: s.added, problems: s.problems });
    }
    try {
      await summarizeCheck(userId, id);
    } catch (error) {
      console.error(`Summing up hiring check ${id} stopped:`, error);
      updateHiringCheck(userId, id,
        { stage: 'stopped', problems: [`The summary stopped: ${(error as Error).message}`] });
    }
    watching.delete(id);
  };
  setTimeout(() => void look(), HIRING_CHECK_POLL_MS).unref();
}

async function summarizeCheck(userId: string, id: string): Promise<void> {
  const c = loadHiringCheck(userId, id)!;
  const rec = db.prepare('SELECT * FROM hiring_signals WHERE id = ? AND user_id = ?').get(c.signal_id, userId) as
    HiringRecord | undefined;
  if (!rec || !live(userId, rec.roles_sheet_id) || !live(userId, rec.companies_sheet_id)) {
    updateHiringCheck(userId, id, { stage: 'stopped', problems: ['The Roles or Companies sheet is no longer there.'] });
    return;
  }
  const done = await summarizeHiring(userId, { roles: rec.roles_sheet_id!, companies: rec.companies_sheet_id },
    { label: c.label, sinceLabel: c.since_label, runId: c.run_id });
  const searched = c.run_id ? searchState(userId, c.run_id) : null;
  const stopped = !c.run_id || (searched && !searched.going && searched.problems.length > 0);
  updateHiringCheck(userId, id, {
    stage: stopped ? 'stopped' : 'done', companiesNew: done.companiesNew, companiesHiringMore: done.companiesHiringMore,
    problems: done.problems,
  });
}

// At boot: a check a restart cut short waits for its search again (the run
// goes on by itself), then sums up. Nothing is searched here.
export function resumeHiringChecks(): void {
  const going = db.prepare(`SELECT id, user_id FROM hiring_checks WHERE stage IN ('searching', 'summarizing')`)
    .all() as Array<{ id: string; user_id: string }>;
  for (const c of going) watchHiringCheck(c.user_id, c.id);
}
