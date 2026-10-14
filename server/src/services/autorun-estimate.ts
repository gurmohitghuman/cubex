// What adding N rows to a sheet sets off through auto-run (a pure read): the
// CSV import's notice ("Work email runs on new rows automatically. These 300
// rows could cost about $1.44 to $45.00"). Each auto-run that would pick the
// rows up is listed: an enrichment with the range all N rows could cost and its
// daily cap (the notice says the cap stops it), an HTTP API column with how
// many of the N its row cap leaves room for today. MCP and /api/v1 appends
// return the same list as auto_run (services/enrich-agent-autorun.ts).
// `afterWriting`: what a run that writes these columns sets off on its rows
// instead (the drawer's Run confirm, an agent's run start): the auto-runs that
// read one of them, then the ones those set off in turn.
import { AUTORUN_HTTP_DEFAULT_DAILY_ROWS } from '../lib/constants';
import type { CatalogFailure } from './enrich-catalog';
import type { EnrichEstimateView } from './enrich-setup';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import { estimateListOf, recallChoices } from '../lib/enrich-run-recall';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { estimateEnrichment } from './enrich-setup';
import {
  columnOutputs, inputColumnsOf, newestRunOf, sheetEntries, usageToday, type AutorunEntry,
} from './autorun-entry';

export interface AutorunRowsEstimate {
  column: string;
  kind: 'enrichment' | 'http';
  rows: number;                  // HTTP: what today's row cap leaves room for; enrichment: all N
  lowUsd: number | null;         // enrichments with known prices
  highUsd: number | null;
  dailyCapUsd: number | null;
  dailyRowCap: number | null;
  // Paused by the person (it runs these rows when resumed) or by a stop that lifts on its own.
  pausedBy: 'user' | 'system' | null;
  // An enrichment whose price treg's catalog didn't give in time (priceWithinMs).
  priceTimedOut?: boolean;
}

const TIMED_OUT = Symbol('timed out');
type Estimated = { ok: EnrichEstimateView } | CatalogFailure;

function within(p: Promise<Estimated>, ms: number | undefined): Promise<Estimated | typeof TIMED_OUT> {
  if (ms === undefined) return p;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// The entries that read a written column, in chain order (each one's status
// column and outputs count as written next). The writing column's own entry
// is left out: auto-run never fills a row a run just filled.
function chained(sheetId: string, userId: string, entries: AutorunEntry[], columns: string[]): AutorunEntry[] {
  const written = new Set(columns);
  const picked: AutorunEntry[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const e of entries) {
      if (picked.includes(e) || written.has(e.status_column)) continue;
      if (!inputColumnsOf(e).some(c => written.has(c))) continue;
      picked.push(e);
      grew = true;
      for (const c of [e.status_column, ...columnOutputs(sheetId, userId, e.status_column)]) written.add(c);
    }
  }
  return picked;
}

// priceWithinMs: an answer that can't wait on treg (an agent's append) prices
// each enrichment from the catalog within this long, else says it couldn't.
export async function estimateAutorunRows(
  userId: string, sheetId: string, rows: number, opts: { priceWithinMs?: number; afterWriting?: string[] } = {},
): Promise<AutorunRowsEstimate[] | null> {
  if (!verifySheetOwnership(sheetId, userId)) return null;
  const out: AutorunRowsEstimate[] = [];
  // An auto-run paused by the person still counts: resumed, it runs these rows too.
  const on = sheetEntries(sheetId, userId).filter(e => e.enabled);
  // Each entry is priced at once (in parallel), so a slow catalog costs the
  // answer one wait, not one per auto-run.
  const picked = opts.afterWriting ? chained(sheetId, userId, on, opts.afterWriting) : on;
  const priced = picked.map(async (e): Promise<AutorunRowsEstimate | null> => {
    // A clean column costs nothing and sends nothing; it still counts in a chain (chained above).
    if (e.kind === 'clean') return null;
    let config: unknown = null;
    try { config = JSON.parse(newestRunOf(sheetId, userId, e.status_column)?.config ?? 'null'); } catch { /* skip */ }
    if (!config) return null;
    const used = usageToday(e.id);
    const base = {
      column: e.status_column,
      pausedBy: e.paused_reason === null ? null : e.paused_reason === 'user' ? 'user' as const : 'system' as const,
      dailyCapUsd: e.daily_cap_micro === null ? null : e.daily_cap_micro / 1e6, dailyRowCap: e.daily_row_cap,
    };
    if (!isEnrichmentConfig(config)) {
      const left = Math.max(0, (e.daily_row_cap ?? AUTORUN_HTTP_DEFAULT_DAILY_ROWS) - used.rows);
      return { ...base, kind: 'http', rows: Math.min(rows, left), lowUsd: null, highUsd: null };
    }
    const c = recallChoices(config, e.status_column);
    const est = await within(estimateEnrichment(userId, {
      toolId: c.toolId, rows, preset: c.preset, given: Object.keys(c.inputs).sort(), skip: c.skipProviders,
      order: c.providerOrder, stopAtFirst: c.stopAtFirst, maxCostPerRowUsd: c.maxCostPerRowUsd, limit: null,
      list: estimateListOf(c),
    }), opts.priceWithinMs);
    if (est === TIMED_OUT) {
      return { ...base, kind: 'enrichment', rows, lowUsd: null, highUsd: null, priceTimedOut: true };
    }
    const range = 'ok' in est && est.ok.priceKnown ? est.ok.estimate : null;
    return { ...base, kind: 'enrichment', rows, lowUsd: range?.lowUsd ?? null, highUsd: range?.highUsd ?? null };
  });
  for (const r of await Promise.all(priced)) if (r) out.push(r);
  return out;
}
