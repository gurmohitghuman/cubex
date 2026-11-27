// Open roles at the companies on a sheet, for agents (/api/v1 and the MCP tool, snake_case), over the same service as
// the app (services/open-roles.ts). The estimate is the default; the run is paid: it needs max_cost_usd (the
// estimate's high_usd), takes the token's run-start slot and stops at its spend cap.
import { checkMostOf } from '../lib/hiring/input';
import { parseOpenRoles } from '../lib/hiring/open-roles-input';
import { timeZoneOf } from '../lib/ai-visibility/check';
import { UUID_PATTERN } from '../lib/constants';
import { openRoles, type OpenRolesEstimate } from './open-roles';
import { spendCapRefusal } from './token-spend';
import { startRefusalMessage, takeRunStart, type RunFail } from './run-shared';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

export const openRolesEstimateJson = (e: OpenRolesEstimate) => ({
  companies: e.companies, roles_up_to: e.rolesUpTo, low_usd: e.lowUsd, high_usd: e.highUsd,
  price_known: e.priceKnown,
  matches: e.matches ? { about: e.matches.about, companies_counted: e.matches.counted, at_least: e.matches.capped,
    note: 'The job index\'s free count, over the first companies with a website.' } : null,
  ...(e.dailyLimit ? { daily_limit: e.dailyLimit } : {}),
});

// A start refused over max_cost_usd carries the estimate now (snake_case).
export type AgentOpenRolesFail = RunFail & { estimate?: Json };

// estimate_only as MCP takes it (lenientBoolean): true, false or their text; left out, true.
const estimateOnlyOf = (v: unknown): boolean | null =>
  (v === undefined || v === null || v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

export async function agentOpenRoles(userId: string, tokenId: string, sheetId: unknown, body: unknown):
  Promise<{ ok: Json; sheetId?: string } | AgentOpenRolesFail> {
  if (typeof sheetId !== 'string' || !UUID_PATTERN.test(sheetId)) {
    return { fail: 'not_found', message: 'Sheet not found' };
  }
  const b = isObj(body) ? body : {};
  const o = parseOpenRoles({ websiteColumn: b.website_column, roles: b.roles, country: b.country, place: b.place,
    postedWithinDays: b.posted_within_days, perCompany: b.per_company }, 'snake');
  if (typeof o === 'string') return bad(o);
  const timeZone = timeZoneOf(b.time_zone);
  if (b.time_zone !== undefined && b.time_zone !== null && !timeZone) {
    return bad('time_zone must be an IANA time zone, such as Europe/Berlin or America/New_York.');
  }
  const estimateOnly = estimateOnlyOf(b.estimate_only);
  if (estimateOnly === null) return bad('estimate_only must be true or false.');
  if (estimateOnly) {
    const out = await openRoles(userId, sheetId, { ...o, estimateOnly: true, maxCostUsd: null, timeZone });
    if ('fail' in out) return { fail: out.fail, message: out.message };
    if (!('estimate' in out.ok)) return bad('The estimate could not be worked out.');
    return { ok: { estimate_only: true, ...openRolesEstimateJson(out.ok.estimate),
      next: 'Nothing was searched. To run it, send the same with estimate_only false and high_usd as max_cost_usd.' } };
  }
  const most = checkMostOf(b.max_cost_usd, 'max_cost_usd');
  if ('error' in most) return bad(most.error);
  const capped = spendCapRefusal(userId, tokenId, null);
  if (capped) return { fail: 'forbidden', message: capped };
  const refuse = () => { const r = takeRunStart(userId, tokenId); return r ? startRefusalMessage(r) : null; };
  const out = await openRoles(userId, sheetId, { ...o, estimateOnly: false, maxCostUsd: most.value, timeZone,
    refuse });
  if ('fail' in out) {
    const { estimate, ...fail } = out;
    return estimate ? { ...fail, estimate: openRolesEstimateJson(estimate) } : fail;
  }
  if (!('started' in out.ok)) return bad('The run did not start.');
  const s = out.ok.started;
  return {
    sheetId,
    ok: {
      run_id: s.runId, column: s.column, roles_sheet_id: s.rolesSheetId, roles_sheet_name: s.rolesSheetName,
      lookup_columns: s.lookups, ...(s.lookupsLeft ? { lookups_left: s.lookupsLeft } : {}),
      next: `The search is an enrichment run on "${s.column}": follow it with get_run (action status, run_type `
        + `enrichment). Each role goes into "${s.rolesSheetName}"; the lookup column counts each company's roles `
        + 'once the run is done. Run it again later to add only roles not seen before.',
    },
  };
}
