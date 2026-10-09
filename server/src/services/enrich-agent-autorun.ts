// Auto-run for the agent surfaces: MCP set_auto_run and PUT /api/v1/sheets/
// :id/enrichment-auto-run turn a column's auto-run on or off and pause it (the
// same services as the column dialog and the header chip), and appends from
// MCP and /api/v1 say which auto-runs the new rows set off (auto_run).
import { parseConditions } from '../lib/enrich-run-input';
import type { EnrichCondition } from '../lib/enrich-run-config';
import { agentConditions, flagOf } from '../lib/enrich-agent-input';
import { strayKey } from '../lib/enrich-agent-args';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { saveAutorunSettings, setSheetAutorunPaused } from './autorun-settings';
import { sheetAutorunView, type AutorunColumnView } from './autorun-view';
import { estimateAutorunRows } from './autorun-estimate';
import { dailyLimitOf } from './enrich-agent-shared';
import type { RunFail } from './run-shared';
import { AUTORUN_NOTICE_PRICE_MS } from '../lib/constants';

export function autorunColumnJson(v: AutorunColumnView) {
  return {
    column: v.column, kind: v.kind, enabled: v.enabled, sends_requests: v.kind === 'http',
    paused_reason: v.pausedReason, paused_message: v.pausedMessage,
    where: v.where.map(c => ({ column: c.column, operator: c.op, value: c.value })),
    daily_cap_usd: v.dailyCapUsd, daily_row_cap: v.dailyRowCap,
    used_today_usd: v.usedTodayUsd, rows_today: v.rowsToday,
  };
}

export function sheetAutorunJson(sheetId: string, userId: string) {
  const view = sheetAutorunView(sheetId, userId);
  return {
    auto_run: Object.values(view.columns).map(autorunColumnJson), has_webhook: view.hasWebhook,
    daily_limit: dailyLimitOf(userId),
  };
}

export interface AgentAutorunArgs {
  column?: unknown; enabled?: unknown; paused?: unknown; where?: unknown;
  daily_cap_usd?: unknown; daily_row_cap?: unknown;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const num = (v: unknown): number | null | undefined => (v === undefined || v === null ? null
  : typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// paused (with or without a column): pause or resume; else enabled turns the
// column's auto-run on (with where and caps) or off.
export async function agentSetAutorun(
  userId: string, sheetId: string, a: AgentAutorunArgs, hasSecretsScope: boolean,
): Promise<{ ok: ReturnType<typeof sheetAutorunJson> } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const stray = strayKey(a as Record<string, unknown>,
    ['column', 'enabled', 'paused', 'where', 'daily_cap_usd', 'daily_row_cap'], '');
  if (stray) return bad(`${stray} Nothing was changed.`);
  const column = a.column === undefined || a.column === null ? null : a.column;
  if (column !== null && (typeof column !== 'string' || !column.trim() || column.length > 200)) {
    return bad('column must be a column name.');
  }
  const paused = flagOf(a.paused), enabled = flagOf(a.enabled);
  if (paused === 'invalid' || enabled === 'invalid') return bad('enabled and paused must be true or false.');
  if ((paused === undefined) === (enabled === undefined)) {
    return bad('Pass enabled (turn a column\'s auto-run on or off) or paused (pause or resume), not both.');
  }
  if (paused !== undefined) {
    if (column !== null && !sheetAutorunView(sheetId, userId).columns[column]?.enabled) {
      return bad(`Auto-run isn't on for "${column}".`);
    }
    setSheetAutorunPaused(userId, sheetId, paused, column ?? undefined);
    return { ok: sheetAutorunJson(sheetId, userId) };
  }
  if (column === null) return bad('Name the column whose auto-run to turn on or off.');
  let where: EnrichCondition[] | null = null;
  if (a.where !== undefined && a.where !== null) {
    const mapped = agentConditions(a.where);
    if (typeof mapped === 'string') return bad(mapped);
    const parsed = parseConditions(mapped);
    if (typeof parsed === 'string') return bad(parsed);
    where = parsed;
  }
  const cap = num(a.daily_cap_usd), rowCap = num(a.daily_row_cap);
  if (cap === undefined || rowCap === undefined) return bad('daily_cap_usd and daily_row_cap must be numbers.');
  const saved = await saveAutorunSettings(userId, sheetId, {
    column, enabled: enabled as boolean, where, dailyCapUsd: cap, dailyRowCap: rowCap,
  }, { hasSecretsScope });
  return 'fail' in saved ? saved : { ok: sheetAutorunJson(sheetId, userId) };
}

// What `rows` new rows in the sheet set off through auto-run, for an append's
// answer (nothing when no auto-run is on there). afterWriting: what a run
// writing these columns on `rows` rows sets off instead (a run start's answer).
export async function appendAutorunNotice(
  userId: string, sheetId: string, rows: number, afterWriting?: string[],
): Promise<{ auto_run?: unknown[] }> {
  if (rows < 1) return {};
  const runs = await estimateAutorunRows(userId, sheetId, rows,
    { priceWithinMs: AUTORUN_NOTICE_PRICE_MS, ...(afterWriting ? { afterWriting } : {}) });
  if (!runs?.length) return {};
  return {
    auto_run: runs.map(r => ({
      column: r.column, kind: r.kind, rows: r.rows, sends_requests: r.kind === 'http',
      estimated_usd: r.lowUsd === null || r.highUsd === null ? null : { low: r.lowUsd, high: r.highUsd },
      daily_cap_usd: r.dailyCapUsd, daily_row_cap: r.dailyRowCap,
      paused: r.pausedBy,
      ...(r.priceTimedOut ? { note: "treg's catalog didn't answer in time, so there's no estimate." } : {}),
    })),
  };
}
