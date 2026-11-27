// Find posts on a social research table: one implementation for the app,
// /api/v1 and MCP. The estimate first (a pure read): each platform's search on
// every search row, and the most they can cost. Then, only when asked, each
// platform's search runs once on every row, keeping the posts found before
// (keep mode: only posts that platform's sheet never had are added, First seen
// this day), and the Top posts view's "posted since" moves to this day less
// the table's days. The start carries the most the asker was shown: worked
// out again, a higher most is refused with the new estimate, so Find posts
// never spends more than it showed. Running again later is "Check again": the
// same call. A platform's search already going is refused.
import { micro, moneyUp } from '../lib/cost-ceiling';
import { busyMessage, sheetFreeWithin } from '../lib/sheet-busy';
import { SOCIAL_START_WAIT_MS } from '../lib/constants';
import { nowDate } from '../lib/clock';
import { dayIn } from '../lib/ai-visibility/check';
import { countRows } from '../lib/sql-helpers';
import { recallChoices, rerunInput } from '../lib/enrich-run-recall';
import { POST_COLUMNS as P } from '../lib/social/names';
import { PLATFORM_SPECS, type Platform } from '../lib/social/platforms';
import { newestColumnRun } from './enrich-column';
import { rerunEnrichmentColumn, type RerunEstimate } from './enrich-rerun';
import { startEnrichmentRun } from './enrich-run-start';
import { updateView } from './views';
import { withoutChangeLog } from '../lib/change-log';
import { getSheetColumns } from '../lib/sql-helpers';
import { getColumnTypes } from '../lib/column-types';
import { postsSheetsOf, sheetLive, type SocialRecord } from './social-store';
import { sinceDay, TOP_POSTS_VIEW, topPostsWhere } from './social-write';
import type { RunFail } from './run-shared';

export interface FindPlatform { platform: Platform; column: string; rows: number; lowUsd: number; highUsd: number }
export interface FindEstimate {
  searches: number; postsUpTo: number; lowUsd: number; highUsd: number; priceKnown: boolean;
  platforms: FindPlatform[];
}
export type FindStartFail = RunFail & { estimate?: FindEstimate };

const ALL = { mode: 'all' as const, status: 'any' as const, test: null, rowIndexes: null };
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// The Searches columns that add rows to another sheet, with the tool each one's newest run asks.
function listColumns(userId: string, searches: string): Array<{ column: string; toolId: string; dest: string }> {
  const types = getColumnTypes(searches, userId);
  return getSheetColumns(searches, userId).flatMap(column => {
    if (types[column] !== 'enrich-status') return [];
    const e = newestColumnRun(searches, userId, column)?.config.enrichment;
    return e?.list?.destSheetId ? [{ column, toolId: e.toolId, dest: e.list.destSheetId }] : [];
  });
}

// Each platform's search column, still a search of this table; or why Find posts can't run. A platform's column
// is found by what fills it (a list adding rows to its Posts sheet, its own search first), not by its name, so a
// renamed column still searches.
function columnsOf(userId: string, r: SocialRecord): Array<{ platform: Platform; column: string }> | RunFail {
  if (!sheetLive(userId, r.searches_sheet_id)) return bad('This table no longer has its Searches sheet.');
  const lists = listColumns(userId, r.searches_sheet_id);
  const out: Array<{ platform: Platform; column: string }> = [];
  for (const [platform, sheet] of Object.entries(postsSheetsOf(r)) as Array<[Platform, string]>) {
    const into = lists.filter(l => l.dest === sheet);
    const column = (into.find(l => l.toolId === PLATFORM_SPECS[platform].search.toolId) ?? into[0])?.column;
    const run = column ? newestColumnRun(r.searches_sheet_id, userId, column) : null;
    if (!column || !run || !sheetLive(userId, sheet)) continue; // a platform deleted since: left out
    if (run.active) {
      return { fail: 'conflict', message: run.status === 'paused'
        ? `"${column}" is paused: resume or cancel it in Searches, then find posts again.`
        : `"${column}" is still searching: find posts again once it's done.` };
    }
    out.push({ platform, column });
  }
  if (out.length === 0) return bad('No platform of this table can search any more (its sheets or columns are gone).');
  if (countRows(r.searches_sheet_id, userId) === 0) return bad('Searches has no rows: add words to search for.');
  return out;
}

async function priceOf(userId: string, r: SocialRecord, column: string): Promise<RerunEstimate | RunFail> {
  const out = await rerunEnrichmentColumn(userId, r.searches_sheet_id, {
    column, rows: ALL, estimateOnly: true, spendLimitUsd: null, rowGeneration: null, callAgain: true,
  });
  if ('fail' in out) return out;
  return 'estimate' in out.ok ? out.ok.estimate : bad(`"${column}" can't be priced now.`);
}

export async function estimateFindPosts(userId: string, r: SocialRecord): Promise<{ ok: FindEstimate } | RunFail> {
  const cols = columnsOf(userId, r);
  if ('fail' in cols) return cols;
  const platforms: FindPlatform[] = [];
  let postsUpTo = 0, priceKnown = true;
  for (const c of cols) {
    const e = await priceOf(userId, r, c.column);
    if ('fail' in e) return e;
    priceKnown &&= e.priceKnown;
    postsUpTo += e.addsRowsTo?.addUpTo ?? 0;
    platforms.push({ ...c, rows: e.rows, lowUsd: round6(e.lowUsd), highUsd: round6(e.highUsd) });
  }
  const sum = (k: 'lowUsd' | 'highUsd') => round6(platforms.reduce((s, p) => s + p[k], 0));
  return {
    ok: { searches: countRows(r.searches_sheet_id, userId), postsUpTo, lowUsd: sum('lowUsd'), highUsd: sum('highUsd'),
      priceKnown, platforms },
  };
}

// maxCostUsd: the most the asker was shown (the estimate's highUsd). timeZone: the asker's, for First seen's day
// (null: UTC). refuse: an agent's start before the searches begin (its run-start window).
export async function startFindPosts(userId: string, r: SocialRecord,
  opts: { maxCostUsd: number; timeZone?: string | null; refuse?: () => string | null }):
  Promise<{ ok: { day: string; runs: Array<{ platform: Platform; run_id: string }>; estimate: FindEstimate } }
    | FindStartFail> {
  const { maxCostUsd } = opts;
  const est = await estimateFindPosts(userId, r);
  if ('fail' in est) return est;
  if (!est.ok.priceKnown) return bad("treg doesn't say what a search costs now, so Find posts can't keep to a most. "
    + 'Try again later.');
  const sent = Number.isFinite(maxCostUsd) ? maxCostUsd : 0;
  if (micro(est.ok.highUsd) > micro(sent)) {
    return { fail: 'over_ceiling', estimate: est.ok, message: `Finding posts could now cost up to `
      + `${moneyUp(est.ok.highUsd)}, more than the ${moneyUp(sent)} it was sent. Nothing was searched: confirm the `
      + 'new most to find posts.' };
  }
  const refused = opts.refuse?.() ?? null;
  if (refused) return { fail: 'forbidden', message: refused };
  const today = dayIn(nowDate().toISOString().replace('T', ' ').slice(0, 19), opts.timeZone ?? null);
  const runs: Array<{ platform: Platform; run_id: string }> = [];
  for (const p of est.ok.platforms) {
    // The start before this one may still hold the sheet while it sets up its rows.
    const busy = await sheetFreeWithin(r.searches_sheet_id, SOCIAL_START_WAIT_MS);
    if (busy) {
      return { fail: 'conflict', message: `${PLATFORM_SPECS[p.platform].label}: ${busyMessage(busy)}`
        + (runs.length ? ` (${runs.map(x => PLATFORM_SPECS[x.platform].label).join(', ')} started.)` : '') };
    }
    const recalled = recallChoices(newestColumnRun(r.searches_sheet_id, userId, p.column)!.config, p.column);
    const input = rerunInput(recalled, ALL, p.highUsd);
    const list = input.list!;
    // First seen: this day, in every post it adds; the posts found before stay.
    const copy = list.copy.filter(c => !(c.from === '' && c.to === P.firstSeen));
    input.list = { ...list, copy: [...copy, { from: '', to: P.firstSeen, value: today }], keep: true };
    const started = await startEnrichmentRun(userId, r.searches_sheet_id, { ...input, noReuse: true })
      .catch((error: Error): RunFail => ({ fail: 'upstream', message: error.message }));
    if ('fail' in started) {
      return { ...started, message: `${PLATFORM_SPECS[p.platform].label}: ${started.message}`
        + (runs.length ? ` (${runs.map(x => PLATFORM_SPECS[x.platform].label).join(', ')} started.)` : '') };
    }
    runs.push({ platform: p.platform, run_id: started.ok.runId });
  }
  moveSince(userId, r, today);
  return { ok: { day: today, runs, estimate: est.ok } };
}

// The Top posts views keep to posts from the last N days of this day.
function moveSince(userId: string, r: SocialRecord, today: string): void {
  if (r.posted_within_days === null) return;
  const since = sinceDay(today, r.posted_within_days);
  for (const sheet of Object.values(postsSheetsOf(r))) {
    if (!sheet || !sheetLive(userId, sheet)) continue;
    const where = topPostsWhere({ minViews: r.min_views, minComments: r.min_comments, since },
      getSheetColumns(sheet, userId, false));
    // A view renamed or deleted by the person stays as they left it.
    withoutChangeLog(() => updateView(sheet, userId, TOP_POSTS_VIEW, { where }));
  }
}
