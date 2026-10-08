// What the grid shows about auto-run and spend (a pure read, small: one entry
// per column at most). It rides the sheet payload (routes/sheets-read.ts), so
// every reload refreshes the column headers' ⚡ and tooltips and the header
// chip, and GET /api/autorun/sheets/:id serves the dialog.
import { db } from '../lib/db';
import { isEnrichmentConfig, type EnrichCondition } from '../lib/enrich-run-config';
import { columnOutputs, newestRunOf, sheetEntries, usageToday, whereOf } from './autorun-entry';

export interface AutorunColumnView {
  column: string;
  kind: 'enrichment' | 'http';
  enabled: boolean;
  pausedReason: string | null;
  pausedMessage: string | null;
  where: EnrichCondition[];
  dailyCapUsd: number | null;     // enrichment columns
  dailyRowCap: number | null;     // HTTP API columns
  usedTodayUsd: number;
  rowsToday: number;
}

export interface SheetAutorunView {
  columns: Record<string, AutorunColumnView>;
  // A webhook adds rows from outside: with auto-run on, each one can cost money.
  hasWebhook: boolean;
}

export function sheetAutorunView(sheetId: string, userId: string): SheetAutorunView {
  const columns: Record<string, AutorunColumnView> = {};
  for (const e of sheetEntries(sheetId, userId)) {
    const used = usageToday(e.id);
    columns[e.status_column] = {
      column: e.status_column, kind: e.kind, enabled: e.enabled === 1,
      pausedReason: e.paused_reason, pausedMessage: e.paused_message, where: whereOf(e),
      dailyCapUsd: e.daily_cap_micro === null ? null : e.daily_cap_micro / 1e6, dailyRowCap: e.daily_row_cap,
      usedTodayUsd: used.spentMicro / 1e6, rowsToday: used.rows,
    };
  }
  const hasWebhook = !!db.prepare('SELECT 1 FROM webhook_sources WHERE sheet_id = ? AND user_id = ? LIMIT 1')
    .get(sheetId, userId);
  return { columns, hasWebhook };
}

// What the column dialog needs about its column: the columns its runs fill
// ("Only run if" can't read them), and whether the team's own provider key
// bills its tool (from the newest run, as auto-run repeats it: no dollar cap).
export function autorunTargetView(
  sheetId: string, userId: string, column: string,
): { outputs: string[]; ownKey: boolean } {
  let config: unknown = null;
  try { config = JSON.parse(newestRunOf(sheetId, userId, column)?.config ?? 'null'); } catch { /* none */ }
  const ownKey = isEnrichmentConfig(config) && config.enrichment.maxCostPerRowUsd === null;
  return { outputs: columnOutputs(sheetId, userId, column), ownKey };
}

// What each enrichment column has spent over all its runs, and on how many
// rows, from the runs' own totals (kept in step with the ledger).
export function enrichColumnSpend(
  sheetId: string, userId: string, statusColumns: string[],
): Record<string, { spentUsd: number; rows: number }> {
  if (statusColumns.length === 0) return {};
  const rows = db.prepare(`SELECT master_column_name AS c, SUM(spent_micro) AS s, SUM(processed_rows) AS n
    FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name IN (SELECT value FROM json_each(?))
    GROUP BY master_column_name`).all(sheetId, userId, JSON.stringify(statusColumns)) as
    Array<{ c: string; s: number | null; n: number | null }>;
  return Object.fromEntries(rows.map(r => [r.c, { spentUsd: (r.s ?? 0) / 1e6, rows: r.n ?? 0 }]));
}
