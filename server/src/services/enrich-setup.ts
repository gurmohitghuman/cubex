// What the enrichment drawer's Set up step reads: the sheet's row counts, room
// for new columns, the cost estimate for the chosen tool and settings, and the
// treg balance. Pure reads: nothing here creates a column or a run, or makes a
// call that costs money. M2's run start and MCP's estimate_only reuse the
// estimate, so the drawer, the run and agents agree.
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET, ENRICH_VERIFY_TOOL_ID } from '../lib/constants';
import { getSheetColumns } from '../lib/sql-helpers';
import { parseEmptyFilter, buildEmptyFilterSql } from '../lib/empty-filter';
import { parseColumnFilters, buildColumnFiltersSql } from '../lib/column-filters';
import {
  defaultEmailLoopCap, defaultMaxCostPerRow, enabledProviders, estimateRun, noProviderCanRun,
  type Estimate, type ProviderPick,
} from '../lib/enrich-estimate';
import { readTregBalance } from '../lib/treg';
import type { EstimateInput } from '../lib/enrich-estimate-input';
import { getTool, type CatalogFailure } from './enrich-catalog';
import { dailyLimitView, getTregToken, type DailyLimitView } from './treg-key';

// hasWebhook: rows can arrive from outside, so Set up's auto-run choice warns.
export interface SheetSetupInfo {
  rows: { all: number; filter: number | null }; columns: { count: number; max: number }; hasWebhook: boolean;
}

// All rows (index count), the rows the sheet's saved filters show (the same
// clause the grid's read counts with, so the numbers match), and room for columns.
export function sheetSetupInfo(userId: string, sheetId: string): SheetSetupInfo | null {
  const sheet = db.prepare('SELECT empty_filter, column_filters FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { empty_filter: string | null; column_filters: string | null } | undefined;
  if (!sheet) return null;
  const empty = buildEmptyFilterSql(parseEmptyFilter(sheet.empty_filter));
  const contains = buildColumnFiltersSql(parseColumnFilters(sheet.column_filters));
  const count = (clause: string, params: unknown[]) => (db.prepare(
    `SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?${clause}`,
  ).get(sheetId, userId, ...params) as { c: number }).c;
  const clause = empty.clause + contains.clause;
  return {
    rows: { all: count('', []), filter: clause ? count(clause, [...empty.params, ...contains.params]) : null },
    columns: { count: getSheetColumns(sheetId, userId).length, max: MAX_COLUMNS_PER_SHEET },
    hasWebhook: !!db.prepare('SELECT 1 FROM webhook_sources WHERE sheet_id = ? AND user_id = ? LIMIT 1')
      .get(sheetId, userId),
  };
}

export interface EnrichEstimateView {
  estimate: Estimate;
  defaultMaxCostPerRowUsd: number;
  // Waterfalls: the providers a row can reach with these inputs and switches.
  providersOn: string[] | null;
  // A waterfall that would call no provider (the figures are then 0).
  noProvider: boolean;
  // false: a tool with no listed price (it runs on the team's own provider
  // key), so the figures say nothing about what the provider bills.
  priceKnown: boolean;
  dailyLimit: DailyLimitView;
}

// The estimate box. The default per-row cap lets every provider picked
// answer; the verified email preset also budgets for its checks and re-finds.
export async function estimateEnrichment(
  userId: string, input: EstimateInput,
): Promise<{ ok: EnrichEstimateView } | CatalogFailure> {
  const found = await getTool(input.toolId);
  if (!('ok' in found)) return found;
  const tool = found.ok;
  const pick: ProviderPick = input;
  let cap = defaultMaxCostPerRow(tool, pick);
  if (input.preset === 'verified_email') {
    const verify = await getTool(ENRICH_VERIFY_TOOL_ID);
    if ('ok' in verify) cap = defaultEmailLoopCap(cap, defaultMaxCostPerRow(verify.ok, { given: ['email'] }));
  }
  const providersOn = tool.kind === 'waterfall' ? enabledProviders(tool, pick).map(p => p.provider) : null;
  return {
    ok: {
      estimate: estimateRun(tool, input.rows, input.maxCostPerRowUsd ?? cap, pick),
      defaultMaxCostPerRowUsd: cap,
      providersOn: providersOn ? [...new Set(providersOn)] : null,
      noProvider: noProviderCanRun(tool, pick),
      priceKnown: tool.kind === 'waterfall' || tool.price.usd !== null ||
        tool.price.type === 'free' || tool.price.overflowUsd !== null,
      dailyLimit: dailyLimitView(userId),
    },
  };
}

export type BalanceRead =
  | { ok: { balanceUsd: number; onHoldUsd: number } }
  | { fail: 'no_key' | 'unavailable'; message: string };

// Best effort: the estimate box simply leaves the balance out when treg
// can't say.
export async function readEnrichBalance(userId: string): Promise<BalanceRead> {
  const token = getTregToken(userId);
  if (!token) return { fail: 'no_key', message: 'Add your treg key in Settings first.' };
  const balance = await readTregBalance(token);
  if (!balance) return { fail: 'unavailable', message: "Couldn't read your treg balance." };
  return { ok: { balanceUsd: balance.balanceMicro / 1e6, onHoldUsd: balance.onHoldMicro / 1e6 } };
}
