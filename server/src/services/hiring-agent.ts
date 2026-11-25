// Hiring tables for agents: the answers /api/v1 and the MCP tool give
// (snake_case), over the same services as the app. A check is paid: it takes
// the token's run-start slot and stops at its spend cap.
import { checkMostOf, parseHiringInput } from '../lib/hiring/input';
import { FILTER_KEYS, FILTER_NAMES, type HiringFilters } from '../lib/hiring/filters';
import { COMPANY_FILTER_NAMES, hasCompanyFilters } from '../lib/hiring/company-filters';
import type { JobCount } from './job-count';
import { timeZoneOf } from '../lib/ai-visibility/check';
import { createHiringTable } from './hiring-create';
import { estimateHiringCheck, startHiringCheck, type HiringEstimate, type HiringStartFail } from './hiring-check';
import { companyFiltersOf, hiringFor, hiringView, type HiringCheckView, type HiringView } from './hiring-store';
import { setHiringCompanyFilters } from './hiring-filters-set';
import { spendCapRefusal } from './token-spend';
import { startRefusalMessage, takeRunStart, type RunFail } from './run-shared';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const notFound: RunFail = { fail: 'not_found', message: 'Hiring table not found' };

// filtered: the table has filters on Companies, so a check says how many companies they kept off.
export const hiringCheckJson = (c: HiringCheckView, filtered: boolean) => ({
  id: c.id, day: c.label, new_since: c.since, stage: c.stage, checked_at: c.checkedAt, run_id: c.runId,
  searches: c.searches, roles_added: c.rolesAdded, companies_new: c.companiesNew,
  companies_hiring_more: c.companiesHiringMore, ...(filtered ? { companies_kept_off: c.companiesKeptOff } : {}),
  problems: c.problems,
});

// Its filters on Companies only when it has any, so a table without them answers as before.
export const hiringJson = (v: HiringView) => {
  const filtered = hasCompanyFilters(v);
  return {
    id: v.id, table_id: v.tableId, companies_sheet_id: v.companiesSheetId, roles_sheet_id: v.rolesSheetId,
    searches_sheet_id: v.searchesSheetId, roles: v.roles, country: v.country, place: v.place,
    posted_within_days: v.postedWithinDays,
    ...(filtered ? { min_roles: v.minRoles, leave_out_companies: v.leaveOutCompanies } : {}),
    created_at: v.createdAt, checks: v.checks.map(c => hiringCheckJson(c, filtered)),
  };
};

export async function agentCreateHiring(userId: string, body: unknown) {
  const b = isObj(body) ? body : {};
  // Description words, seniority and the rest, and the filters on Companies, by their snake_case names
  // (lib/hiring/filters.ts, company-filters.ts).
  const names = [...Object.values(FILTER_NAMES.snake), ...Object.values(COMPANY_FILTER_NAMES.snake)];
  const filters = Object.fromEntries(names.map(k => [k, b[k]]));
  const input = parseHiringInput({
    roles: b.roles, country: b.country, place: b.place, postedWithinDays: b.posted_within_days,
    perSearch: b.per_search, ...filters,
  }, 'snake');
  if (typeof input === 'string') return bad(input);
  const made = await createHiringTable(userId, input);
  if ('fail' in made) return made;
  const rec = hiringFor(userId, made.ok.id);
  if (!rec) return notFound;
  return {
    ok: {
      ...hiringJson(hiringView(rec)), table_name: made.ok.tableName, searches: made.ok.searches,
      per_search: made.ok.perSearch, ...searchOptionsJson(input.filters),
      next: 'Nothing was searched yet. hiring_signals action "check" gives the estimate; with estimate_only false '
        + 'and its high_usd as max_cost_usd, it runs every search.',
    },
  };
}

export function agentGetHiring(userId: string, id: unknown) {
  const rec = hiringFor(userId, id);
  return rec ? { ok: hiringJson(hiringView(rec)) } : notFound;
}

// Its filters on Companies changed (services/hiring-filters-set.ts): only those two, the rest is set at create. The
// answer always names both, so an update back to every company says so.
const UPDATABLE: readonly string[] = Object.values(COMPANY_FILTER_NAMES.snake);
export function agentUpdateHiring(userId: string, id: unknown, body: Json) {
  const other = Object.keys(body).filter(k => body[k] !== undefined && !UPDATABLE.includes(k));
  if (other.length) {
    return bad(`Only ${UPDATABLE.join(' and ')} change after create (not ${other.join(', ')}): make another table `
      + 'for other roles or search filters.');
  }
  const out = setHiringCompanyFilters(userId, id, body, 'snake');
  if ('fail' in out) return out;
  return { ok: { ...hiringJson(out.ok), min_roles: out.ok.minRoles, leave_out_companies: out.ok.leaveOutCompanies,
    next: 'They apply from the next check: hiring_signals action "check".' } };
}

// What a table made with description words, seniority and the rest was made with (none: nothing).
const searchOptionsJson = (f: HiringFilters | null) => (f
  ? Object.fromEntries(FILTER_KEYS.map(k => [FILTER_NAMES.snake[k], f[k]])) : {});

// What the free count leaves out of what the searches send.
const countNote = (leftOut: JobCount['leftOut']) => `The job index's free count${leftOut.includes('place')
  ? ', before the place filter' : ''}.`;

const estimateJson = (e: HiringEstimate) => ({
  searches: e.searches, roles_up_to: e.rolesUpTo, low_usd: e.lowUsd, high_usd: e.highUsd, price_known: e.priceKnown,
  matches: e.matches ? { about: e.matches.about, searches_counted: e.matches.counted,
    at_least: e.matches.capped, note: countNote(e.matches.leftOut) } : null,
  ...(e.dailyLimit ? { daily_limit: e.dailyLimit } : {}),
});

// A start refused over max_cost_usd carries the estimate now (snake_case).
export type AgentCheckFail = Omit<HiringStartFail, 'estimate'> & { estimate?: Json };

// estimate_only as MCP takes it (lenientBoolean): true, false or their text; left out, true.
const estimateOnlyOf = (v: unknown): boolean | null =>
  (v === undefined || v === null || v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

// The cost and the free count (the default), or the check itself, which needs
// max_cost_usd (the estimate's high_usd). time_zone: the check's day (First
// seen) is the asker's (UTC without it).
export async function agentCheckHiring(userId: string, tokenId: string, id: unknown,
  opts: { estimateOnly: unknown; timeZone?: unknown; maxCostUsd?: unknown },
): Promise<{ ok: Json; sheetId?: string | null } | AgentCheckFail> {
  const rec = hiringFor(userId, id);
  if (!rec) return notFound;
  const timeZone = timeZoneOf(opts.timeZone);
  if (opts.timeZone !== undefined && opts.timeZone !== null && !timeZone) {
    return bad('time_zone must be an IANA time zone, such as Europe/Berlin or America/New_York.');
  }
  const estimateOnly = estimateOnlyOf(opts.estimateOnly);
  if (estimateOnly === null) return bad('estimate_only must be true or false.');
  if (estimateOnly) {
    const out = await estimateHiringCheck(userId, rec, { timeZone });
    if ('fail' in out) return out;
    const { plan, estimate } = out;
    return { ok: { estimate_only: true, day: plan.label, new_since: plan.since, ...estimateJson(estimate) } };
  }
  const most = checkMostOf(opts.maxCostUsd, 'max_cost_usd');
  if ('error' in most) return bad(most.error);
  const capped = spendCapRefusal(userId, tokenId, null);
  if (capped) return { fail: 'forbidden' as const, message: capped };
  const refuse = () => { const r = takeRunStart(userId, tokenId); return r ? startRefusalMessage(r) : null; };
  const out = await startHiringCheck(userId, rec, { timeZone, refuse, maxCostUsd: most.value });
  if ('fail' in out) {
    const { estimate, ...fail } = out;
    return estimate ? { ...fail, estimate: estimateJson(estimate) } : fail;
  }
  return {
    sheetId: rec.searches_sheet_id,
    ok: {
      ...hiringCheckJson(out.ok, hasCompanyFilters(companyFiltersOf(rec))),
      next: 'The search is an enrichment run: follow it with get_run_status (run type enrichment), then '
        + 'hiring_signals action "get" shows the check done. Read Companies with read_rows (New roles > 0).',
    },
  };
}
