// Social research tables for agents: the answers /api/v1 and the MCP tool give
// (snake_case), over the same services as the app. Find posts is paid: it
// takes the token's run-start slot and stops at its spend cap; it's an
// estimate unless estimate_only is false, and then needs max_cost_usd (the
// estimate's high_usd), so it never spends more than the estimate showed.
import { socialInputOf } from '../lib/social/input';
import { timeZoneOf } from '../lib/ai-visibility/check';
import { usdLimitOf } from '../lib/cost-ceiling';
import { createSocialTable } from './social-create';
import { estimateFindPosts, startFindPosts, type FindEstimate } from './social-find';
import { loadSocial, socialView } from './social-store';
import { spendCapRefusal } from './token-spend';
import { startRefusalMessage, takeRunStart, type RunFail } from './run-shared';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const notFound: RunFail = { fail: 'not_found', message: 'Social research table not found' };
const idOf = (v: unknown) => (typeof v === 'string' ? v : '');

export const FIND_NEXT = 'Nothing was searched yet. social_research action "find_posts" gives the estimate; with '
  + 'estimate_only false and its high_usd as max_cost_usd, each platform searches every row of Searches.';

export async function agentCreateSocial(userId: string, body: unknown) {
  const b = isObj(body) ? { ...body } : {};
  delete b.action;
  const input = socialInputOf(b, 'v1');
  if ('error' in input) return bad(input.error);
  const made = await createSocialTable(userId, input.ok);
  if ('fail' in made) return made;
  const rec = loadSocial(userId, made.ok.id);
  if (!rec) return notFound;
  return { ok: { ...socialView(rec), table_name: made.ok.tableName, searches: made.ok.searches, next: FIND_NEXT } };
}

export function agentGetSocial(userId: string, id: unknown) {
  const rec = loadSocial(userId, idOf(id));
  return rec ? { ok: socialView(rec) as unknown as Json } : notFound;
}

const estimateJson = (e: FindEstimate) => ({
  searches: e.searches, posts_up_to: e.postsUpTo, low_usd: e.lowUsd, high_usd: e.highUsd, price_known: e.priceKnown,
  platforms: e.platforms.map(p => ({ platform: p.platform, column: p.column, searches: p.rows, low_usd: p.lowUsd,
    high_usd: p.highUsd })),
});

export type AgentFindFail = RunFail & { estimate?: Json };

const estimateOnlyOf = (v: unknown): boolean | null =>
  (v === undefined || v === null || v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

export async function agentFindPosts(userId: string, tokenId: string, id: unknown,
  opts: { estimateOnly: unknown; timeZone?: unknown; maxCostUsd?: unknown },
): Promise<{ ok: Json; sheetId?: string } | AgentFindFail> {
  const rec = loadSocial(userId, idOf(id));
  if (!rec) return notFound;
  const timeZone = timeZoneOf(opts.timeZone);
  if (opts.timeZone !== undefined && opts.timeZone !== null && !timeZone) {
    return bad('time_zone must be an IANA time zone, such as Europe/Berlin or America/New_York.');
  }
  const estimateOnly = estimateOnlyOf(opts.estimateOnly);
  if (estimateOnly === null) return bad('estimate_only must be true or false.');
  if (estimateOnly) {
    const out = await estimateFindPosts(userId, rec);
    return 'fail' in out ? out : { ok: { estimate_only: true, ...estimateJson(out.ok) } };
  }
  const most = usdLimitOf(opts.maxCostUsd, 'max_cost_usd');
  if ('error' in most) return bad(most.error);
  if (most.value === null) {
    return bad('Finding posts needs max_cost_usd: the most it may cost in dollars, the high end of its estimate '
      + '(ask for the estimate first). Nothing was searched.');
  }
  const capped = spendCapRefusal(userId, tokenId, null);
  if (capped) return { fail: 'forbidden', message: capped };
  const refuse = () => { const r = takeRunStart(userId, tokenId); return r ? startRefusalMessage(r) : null; };
  const out = await startFindPosts(userId, rec, { maxCostUsd: most.value, timeZone, refuse });
  if ('fail' in out) {
    const { estimate, ...fail } = out;
    return estimate ? { ...fail, estimate: estimateJson(estimate) } : fail;
  }
  return {
    ok: { day: out.ok.day, runs: out.ok.runs, ...estimateJson(out.ok.estimate),
      next: 'Follow each run with get_run_status (run_type enrichment). The posts land in each platform\'s sheet; '
        + 'then run the steps on the Top posts view\'s rows.' },
    sheetId: rec.searches_sheet_id,
  };
}
