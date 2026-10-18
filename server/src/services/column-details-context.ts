// What every column describer (services/column-details-*.ts) is given about
// the sheet, read once per get_sheet, and the parts they share: auto-run as
// it is on a column, and the "Only run if" rule its next run uses.
import { ruleFromConditions } from '../lib/run-condition';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import type { ColumnType } from '../lib/column-types';
import type { ColumnDetail } from '../lib/column-details';
import { whereOf, type AutorunEntry } from './autorun-entry';

export interface DetailContext {
  sheetId: string;
  userId: string;
  columns: readonly string[];               // the sheet's columns, in order
  listed: ReadonlySet<string>;
  types: Readonly<Record<string, ColumnType>>;  // lib/column-types.ts: absent = plain
  runState: ReadonlyMap<string, string>;   // a run's column → the column holding its per-row state
  autorun: ReadonlyMap<string, AutorunEntry>;  // by the column it fills
  cut(column: string, text: string): string;  // a prompt, formula or URL as shown (column-details.ts)
}

// A describer claims the columns whose ColumnType it knows and says what fills
// them. Columns no describer claims are plain.
export type ColumnDescriber = (ctx: DetailContext) => Map<string, ColumnDetail>;

// Auto-run as it is on the column: on or off, why it is paused, and its daily
// caps (an enrichment's dollars, an HTTP API column's rows).
export function autoRunPart(
  ctx: DetailContext, column: string,
): Pick<ColumnDetail, 'auto_run' | 'auto_run_paused' | 'auto_run_caps'> {
  const e = ctx.autorun.get(column);
  if (e?.enabled !== 1) return { auto_run: false };
  const caps = {
    ...(e.daily_cap_micro !== null ? { usd_per_day: e.daily_cap_micro / 1e6 } : {}),
    ...(e.daily_row_cap !== null ? { rows_per_day: e.daily_row_cap } : {}),
  };
  return {
    auto_run: true, ...(e.paused_reason ? { auto_run_paused: e.paused_message ?? e.paused_reason } : {}),
    ...(Object.keys(caps).length ? { auto_run_caps: caps } : {}),
  };
}

// The rule the column's next run checks: auto-run's own while it is on, else
// the newest run's (an enrichment's older condition list reads as one rule).
export function nextRunRule(ctx: DetailContext, column: string, config: unknown): string | null {
  const e = ctx.autorun.get(column);
  if (e?.enabled === 1) return e.run_if ?? ruleFromConditions(whereOf(e));
  const rule = (config as { runIf?: unknown } | null)?.runIf;
  if (typeof rule === 'string') return rule;
  return isEnrichmentConfig(config) ? ruleFromConditions(config.enrichment.rows.where) : null;
}

export const parseJson = (raw: string | null | undefined): unknown => {
  try { return JSON.parse(raw ?? 'null'); } catch { return null; }
};
