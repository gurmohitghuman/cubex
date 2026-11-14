// What the treg.to, waterfall, AI visibility, balance and usage tools answer (tools-enrich.ts,
// tools-waterfall.ts, tools-ai-visibility.ts, tools-balances.ts, tools-usage.ts).
import { z } from 'zod';
import { obj, open } from '../output-schema';
import { bool, changed, info, nul, num, opt, str, strs } from './shared';

const price = info('What a row costs: the price range in dollars and how it is charged');
const toolEntry = obj({
  tool_id: str, title: str, summary: str, kind: str, provider: nul(str), providers: nul(num), price,
  adds_rows: bool, needs_own_key: bool, preset: opt(str),
});
export const searchEnrichments = obj({ popular: bool, tools: z.array(toolEntry) });

// The tool's inputs, outputs and providers (by kind of tool).
export const getEnrichment = open({
  tool_id: str, name: str, summary: str, kind: str, capability: nul(str), provider: nul(str), price,
  needs_own_key: bool, inputs: z.array(info('An input: its key, label and whether it is required')),
  identity_sets: nul(z.array(strs)), outputs: z.array(info('An output and the column it becomes')),
  output_fields: strs, adds_rows: bool, results_at: opt(str),
  providers: nul(z.array(info('A provider: its name, price and whether it is on')))
    .describe('null: a tool with one provider'),
  has_treg_key: bool,
  presets: opt(z.array(info('A ready-made setting of the tool'))),
});

const range = obj({ low: num, high: num });
// Started: run_id. With estimate_only: the estimate, and nothing started.
export const runEnrichment = open({
  run_id: opt(str), run_type: opt(str), status_column: str, output_columns: strs,
  destination_sheet_id: opt(nul(str)), rows_in_scope: opt(num), rows_to_process: opt(num), test_rows: nul(num),
  max_cost_per_row_usd: nul(num).describe('null: the tool has no listed price, so no cap is sent'),
  spend_limit_usd: nul(num).describe('null: no listed price, so no run limit'),
  daily_limit: info('The account\'s daily enrichment limit'),
  estimate_only: opt(bool), estimated_cost_usd: opt(nul(range)), per_row_usd: opt(nul(range)),
  price_known: opt(bool), reuse: opt(info('Rows answered at $0 from earlier lookups')),
  providers_on: opt(nul(strs).describe('null: a tool with one provider')),
  may_pass_daily_limit: opt(bool), treg_balance_usd: opt(num), treg_on_hold_usd: opt(num),
  may_pass_balance: opt(bool), notes: opt(strs), replayed: opt(bool), run_if: opt(str), run_if_note: opt(str),
  changed,
});

// Started: run_id. With estimate_only (its default here): per_row, total and each step. dry_run: rows, each
// with its trace. describe: the column's setup in the shape the tool takes.
export const waterfallColumn = open({
  run_id: opt(str), run_type: opt(str), result_column: opt(str), output_columns: opt(strs),
  rows_in_scope: opt(num), estimate_only: opt(bool), dry_run: opt(bool), result_type: opt(str),
  steps: opt(z.array(info('A step: its id, label, kind and what it reached or costs'))),
  per_row: opt(info('average_usd and max_usd a row')), total: opt(info('The totals for the rows in scope')),
  rows: opt(z.union([num, z.array(info('A dry-run row: its inputs and every step it reached'))])),
  max_cost_per_row_usd: opt(num), spend_limit_usd: opt(nul(num)), run_limit_usd: opt(nul(num)),
  daily_limit: opt(nul(info('The account\'s daily enrichment limit'))), notes: opt(strs), note: opt(str),
  column_name: opt(str), inputs: opt(info('Input key -> its column or fixed value')), changed,
});

// estimate_only (its default): what it would make and cost. Otherwise the check and its runs.
export const aiVisibility = open({
  estimate_only: opt(bool), problems: strs, id: opt(str), stage: opt(str), table_id: opt(str),
  questions_sheet_id: opt(str), sites_sheet_id: opt(nul(str)), low_usd: opt(num), high_usd: opt(num),
  runs: opt(z.array(info('A run the check started'))), next: opt(str), note: opt(str), changed,
});

export const getBalances = obj({
  treg: info('The treg.to balance in dollars, or why it is unknown'),
  enrichment_daily_limit: info('The daily enrichment limit, used today and left'),
  openrouter: info('The OpenRouter credit left, or why it is unknown'),
  access_token: nul(info('This token\'s spend cap, spent and left; null when it has none')),
});

export const getUsage = obj({
  sheet_id: nul(str), group_by: str, range: info('from and to, UTC'),
  totals: info('Cost in dollars and runs over the range'), rows: z.array(info('A column, day or run and its cost')),
  rows_total: num, truncated: bool,
});
