// How many open roles a hiring table's searches match, before paying for any:
// the free count of the job index the search runs on, where it has one (two
// of treg's job search providers do). Called with the person's own treg key,
// only while treg's catalog lists the count as free, and with a max cost of 0,
// so treg charges nothing whatever the catalog says; never recorded as a
// call. A routed search's place isn't counted (the counts take places in their
// own forms), so it's "about". A table with More filters searches the job
// index itself: its count is sent that search's own body, so it takes every
// filter the search does. Any failure means no count; nothing else changes.
import { v4 as uuidv4 } from 'uuid';
import { tregCall } from '../lib/treg-call';
import { getCatalogEndpoint } from '../lib/treg-catalog';
import { HIRING_COUNT_MAX_SEARCHES, HIRING_COUNT_TIMEOUT_MS } from '../lib/constants';
import { countryName } from '../lib/hiring/filters';
import { getTregToken } from './treg-key';

export interface SearchTerms { title: string; country: string; days: number | null }

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// Each count's tool, the body it takes for a search, and the number in its answer (capped: at its ceiling).
const COUNTS: Record<string, {
  toolId: string; body: (s: SearchTerms) => Json; read: (b: Json) => { n: number; capped: boolean } | null;
}> = {
  hirebase: {
    toolId: 'hirebase.jobs.search.count',
    body: s => ({
      job_titles: [s.title], ...(s.country ? { geo_locations: [{ country: countryName(s.country) }] } : {}),
      ...(s.days ? { days_ago: s.days } : {}), limit: 0,
    }),
    // With limit 0 it answers the total (its own example names it `cost`).
    read: b => {
      const n = num(b.total) ?? num(b.count) ?? num(b.cost);
      return n === null ? null : { n: Math.round(n), capped: false };
    },
  },
  jobspipe: {
    toolId: 'jobspipe.jobs.search.count',
    body: s => ({
      job_title_or: [s.title], ...(s.country ? { job_country_code_or: [s.country.toUpperCase()] } : {}),
      ...(s.days ? { posted_at_max_age_days: s.days } : {}),
    }),
    read: b => {
      const n = num(b.rows);
      const max = num(b.max_rows);
      return n === null ? null : { n, capped: max !== null && n >= max };
    },
  },
};

export const hasJobCount = (provider: string | null): boolean => !!provider && !!COUNTS[provider.toLowerCase()];

// Only while the catalog lists the count free.
async function countIsFree(toolId: string): Promise<boolean> {
  const read = await getCatalogEndpoint(toolId);
  if (!read.ok || !isObj(read.body.endpoint)) return false;
  const cost = (read.body.endpoint as Json).cost;
  return isObj(cost) && cost.type === 'free' && (cost.usd === undefined || cost.usd === 0);
}

async function countOne(token: string, c: (typeof COUNTS)[string], body: Json) {
  const ans = await tregCall(token, {
    method: 'POST', path: `/call/${encodeURIComponent(c.toolId)}`, query: '', body: JSON.stringify(body),
    idempotencyKey: uuidv4(), routed: false, maxCostUsd: 0,
  }, AbortSignal.timeout(HIRING_COUNT_TIMEOUT_MS)).catch(() => null);
  if (!ans || ans.status !== 200 || ans.meta.tregError || !isObj(ans.body)) return null;
  if (ans.meta.costMicro !== null && ans.meta.costMicro > 0) return null;
  return c.read(ans.body);
}

// about: the roles all counted searches match together (a role two searches
// find counts twice); counted: the searches it covers (the first
// HIRING_COUNT_MAX_SEARCHES); capped: some count stopped at its ceiling;
// leftOut: what the searches send that the count doesn't take. null: no count.
export interface JobCount { about: number; counted: number; capped: boolean; leftOut: Array<'place'> }

async function countAll(userId: string, c: (typeof COUNTS)[string] | undefined, bodies: Json[]):
  Promise<Omit<JobCount, 'leftOut'> | null> {
  const token = getTregToken(userId);
  if (!c || !token || bodies.length === 0) return null;
  if (!(await countIsFree(c.toolId))) return null;
  const first = bodies.slice(0, HIRING_COUNT_MAX_SEARCHES);
  const answers = await Promise.all(first.map(b => countOne(token, c, b)));
  if (answers.some(a => a === null)) return null;
  return {
    about: answers.reduce((sum, a) => sum + a!.n, 0), counted: first.length, capped: answers.some(a => a!.capped),
  };
}

export async function countJobs(userId: string, provider: string | null, searches: SearchTerms[]):
  Promise<JobCount | null> {
  const c = provider ? COUNTS[provider.toLowerCase()] : undefined;
  const n = c ? await countAll(userId, c, searches.map(c.body)) : null;
  return n && { ...n, leftOut: ['place'] };
}

// A direct search's body, as its count takes it: every filter, no page or
// order, and limit 0 (the total only).
export function directCountBody(search: Json): Json {
  const { limit: _limit, page: _page, sort_by: _by, sort_order: _order, ...rest } = search;
  return { ...rest, limit: 0 };
}

// The searches of a table with More filters (each its request body, in order):
// their count on the job index, which takes every filter they send.
export async function countDirectJobs(userId: string, searches: Json[]): Promise<JobCount | null> {
  const n = await countAll(userId, COUNTS.hirebase, searches.map(directCountBody));
  return n && { ...n, leftOut: [] };
}
