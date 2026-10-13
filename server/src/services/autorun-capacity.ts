// How many rows an auto-run may take now, or why it can't take one: an
// enrichment within its column's daily cap and the daily limit for all
// enrichments (each row can cost up to its per-row cap), an HTTP API column
// within its rows a day. Today is the UTC day (lib/clock.ts). The messages
// leave out when it goes on: the grid says so in the reader's own time.
import { AUTORUN_HTTP_DEFAULT_DAILY_ROWS, AUTORUN_MAX_ROWS } from '../lib/constants';
import { limitReached, rowsThatFit, UNCAPPED_BILLED_NOTE } from '../lib/enrich-estimate';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import { getDailyLimitMicro, spentTodayMicro } from './treg-key';
import { heldMicro } from './enrich-holds';
import { usageToday, type AutorunEntry } from './autorun-entry';

export type Capacity =
  | { rows: number; runLimitUsd: number | null }   // runLimitUsd: what is left of the column's cap today
  | { reason: string; message: string };

const money = (usd: number) => `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function autorunCapacity(e: AutorunEntry, config: HTTPAPIConfig): Capacity {
  const used = usageToday(e.id);
  if (!isEnrichmentConfig(config)) {
    const cap = e.daily_row_cap ?? AUTORUN_HTTP_DEFAULT_DAILY_ROWS;
    const left = cap - used.rows;
    if (left < 1) {
      const most = cap.toLocaleString('en-US');
      return { reason: 'row_cap', message: `It ran ${most} rows today, its most a day.` };
    }
    return { rows: Math.min(left, AUTORUN_MAX_ROWS), runLimitUsd: null };
  }
  // null: the team's own provider key should bill these calls, so a row can't
  // be priced; what treg really charged still counts against both limits.
  const perRow = config.enrichment.maxCostPerRowUsd;
  const billed = perRow === null ? ` ${UNCAPPED_BILLED_NOTE}` : '';
  const limit = getDailyLimitMicro(e.user_id);
  const spentToday = limit === null ? 0 : spentTodayMicro(e.user_id) / 1e6;
  if (limit !== null && limitReached(limit / 1e6, spentToday, perRow)) {
    return { reason: 'daily_limit', message: `Today's ${money(limit / 1e6)} enrichment limit is reached.${billed}` };
  }
  const capUsd = e.daily_cap_micro === null ? null : e.daily_cap_micro / 1e6;
  const spentUsd = used.spentMicro / 1e6;
  if (limitReached(capUsd, spentUsd, perRow)) {
    return { reason: 'column_cap', message: `It reached today's ${money(capUsd ?? 0)} cap for this column.${billed}` };
  }
  if (perRow === null) return { rows: AUTORUN_MAX_ROWS, runLimitUsd: null };
  // What running batches hold for their calls still out shrinks the run, but
  // pauses nothing: it comes back as they settle, and the run waits for it.
  const byDay = limit === null ? Infinity
    : Math.max(1, rowsThatFit(limit / 1e6, spentToday + heldMicro(e.user_id) / 1e6, perRow));
  const byCap = rowsThatFit(capUsd, spentUsd, perRow);
  return {
    rows: Math.min(byCap, byDay, AUTORUN_MAX_ROWS),
    runLimitUsd: capUsd === null ? null : round6(Math.max(0, capUsd - spentUsd)),
  };
}
