// What adding N rows to a sheet sets off through auto-run (a pure read): the
// CSV import's notice ("Work email runs on new rows automatically. These 300
// rows could cost about $1.44 to $45.00"). Each auto-run that would pick the
// rows up is listed: an enrichment with the range all N rows could cost and its
// daily cap (the notice says the cap stops it), an HTTP API column with how
// many of the N its row cap leaves room for today. MCP and /api/v1 appends
// will return the same list as auto_run (M3).
import { AUTORUN_HTTP_DEFAULT_DAILY_ROWS } from '../lib/constants';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import { estimateListOf, recallChoices } from '../lib/enrich-run-recall';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { estimateEnrichment } from './enrich-setup';
import { newestRunOf, sheetEntries, usageToday } from './autorun-entry';

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
}

export async function estimateAutorunRows(
  userId: string, sheetId: string, rows: number,
): Promise<AutorunRowsEstimate[] | null> {
  if (!verifySheetOwnership(sheetId, userId)) return null;
  const out: AutorunRowsEstimate[] = [];
  for (const e of sheetEntries(sheetId, userId)) {
    // An auto-run paused by the person still counts: resumed, it runs these rows too.
    if (!e.enabled) continue;
    let config: unknown = null;
    try { config = JSON.parse(newestRunOf(sheetId, userId, e.status_column)?.config ?? 'null'); } catch { /* skip */ }
    if (!config) continue;
    const used = usageToday(e.id);
    const base = {
      column: e.status_column,
      pausedBy: e.paused_reason === null ? null : e.paused_reason === 'user' ? 'user' as const : 'system' as const,
      dailyCapUsd: e.daily_cap_micro === null ? null : e.daily_cap_micro / 1e6, dailyRowCap: e.daily_row_cap,
    };
    if (!isEnrichmentConfig(config)) {
      const left = Math.max(0, (e.daily_row_cap ?? AUTORUN_HTTP_DEFAULT_DAILY_ROWS) - used.rows);
      out.push({ ...base, kind: 'http', rows: Math.min(rows, left), lowUsd: null, highUsd: null });
      continue;
    }
    const c = recallChoices(config, e.status_column);
    const est = await estimateEnrichment(userId, {
      toolId: c.toolId, rows, preset: c.preset, given: Object.keys(c.inputs).sort(), skip: c.skipProviders,
      order: c.providerOrder, stopAtFirst: c.stopAtFirst, maxCostPerRowUsd: c.maxCostPerRowUsd, limit: null,
      list: estimateListOf(c),
    });
    const range = 'ok' in est && est.ok.priceKnown ? est.ok.estimate : null;
    out.push({ ...base, kind: 'enrichment', rows, lowUsd: range?.lowUsd ?? null, highUsd: range?.highUsd ?? null });
  }
  return out;
}
