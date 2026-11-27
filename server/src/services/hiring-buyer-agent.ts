// Find buyers for agents (services/hiring-buyer.ts): the answers /api/v1 and MCP's hiring_signals find_buyers give
// (snake_case). The estimate is the default and a pure read; the run needs max_cost_usd, and saves the columns the
// first time (or new titles), which needs the write scope too.
import { hiringFor } from './hiring-store';
import { buyerOf, findBuyers, type BuyerView } from './hiring-buyer';
import type { AgentCheckFail } from './hiring-agent';
import { parseBuyerTitles } from '../lib/hiring/buyer';
import { BUYER_COLUMNS } from '../lib/hiring/names';
import { usdLimitOf } from '../lib/cost-ceiling';
import type { RunFail } from './run-shared';

type Json = Record<string, unknown>;
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const notFound: RunFail = { fail: 'not_found', message: 'Hiring table not found' };
// estimate_only as hiring_signals' check takes it (hiring-agent.ts): true, false or their text; left out, true.
const estimateOnlyOf = (v: unknown): boolean | null =>
  (v === undefined || v === null || v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

// The buyer columns (services/hiring-buyer.ts): there or not, the titles they search, the titles a first find starts
// with.
export const buyerJson = (b: BuyerView) => ({
  added: b.added, titles: b.titles, starting_titles: b.starting, catch_all_emails: b.catchAll,
  columns: [BUYER_COLUMNS.name, BUYER_COLUMNS.title, BUYER_COLUMNS.linkedin, BUYER_COLUMNS.email,
    BUYER_COLUMNS.emailStatus],
});

// The estimate, or the run, which needs max_cost_usd (the estimate's high_usd). canSave: the token has the write
// scope (the run saving a column setup is a write).
export async function agentFindBuyers(userId: string, id: unknown, b: Json, canSave: boolean):
  Promise<{ ok: Json; companiesSheetId: string; added: string[]; started: boolean } | AgentCheckFail> {
  const rec = hiringFor(userId, id);
  if (!rec) return notFound;
  const estimateOnly = estimateOnlyOf(b.estimate_only);
  if (estimateOnly === null) return bad('estimate_only must be true or false.');
  const titles = b.buyer_titles === undefined || b.buyer_titles === null ? null
    : parseBuyerTitles(b.buyer_titles, 'buyer_titles');
  if (typeof titles === 'string') return bad(titles);
  const catchAll = b.catch_all_emails;
  if (catchAll !== undefined && catchAll !== null && typeof catchAll !== 'boolean') {
    return bad('catch_all_emails must be true or false.');
  }
  let maxCostUsd: number | null = null;
  if (!estimateOnly) {
    const most = usdLimitOf(b.max_cost_usd, 'max_cost_usd');
    if ('error' in most) return bad(most.error);
    if (most.value === null) {
      return bad('Finding buyers needs max_cost_usd: the most it may cost in dollars, the high end of its estimate '
        + '(ask for the estimate first). Nothing was searched.');
    }
    maxCostUsd = most.value;
  }
  const out = await findBuyers(userId, rec, {
    titles, estimateOnly, maxCostUsd, canSave, catchAll: typeof catchAll === 'boolean' ? catchAll : null,
  });
  if ('fail' in out) {
    const { estimate, ...fail } = out;
    return estimate ? { ...fail, estimate: { ...estimate } } : fail;
  }
  const { saved, added, titles: used, ...run } = out.ok;
  const started = 'setup_run' in run;
  return {
    companiesSheetId: rec.companies_sheet_id, added, started,
    ok: {
      estimate_only: !started, buyer_titles: used, saved_columns: saved, ...run,
      next: started
        ? 'Follow it with get_run (action setup, its setup_run_id); then read Companies with read_rows (Buyer, Buyer '
          + 'title, Buyer LinkedIn, Buyer email). A company with no one holding these titles has an empty Buyer.'
        : 'Nothing was searched or saved. Tell the user the cost; then hiring_signals action "find_buyers" with '
          + 'estimate_only false and the estimate\'s high_usd as max_cost_usd (the first time it adds the buyer '
          + 'columns to Companies, which needs the write scope too).',
    },
  };
}


export const agentBuyerOf = (userId: string, id: unknown) => {
  const rec = hiringFor(userId, id);
  return rec ? { ok: buyerJson(buyerOf(userId, rec)) } : notFound;
};
