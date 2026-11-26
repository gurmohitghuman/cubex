// One enrichment tool called on 1-ENRICH_CALL_MAX_ITEMS items without a sheet (MCP call_enrichment, REST POST
// /api/v1/enrichments/:toolId/calls). The items become the rows of a hidden working table (setup-call.ts), one
// column per tool input, and the tool runs there through run_enrichment's own start (enrich-token-run.ts): every
// input mapped to its column, every output field (or those asked for) to a column of its name. Priced first, on
// the items in memory (enrich-call-estimate.ts: an estimate writes nothing); refused before anything is made when
// the estimate's high end is over max_cost_usd, today's daily limit left, the treg balance or the token's cap, or
// the tool has no known price (unless allow_unpriced). A start gets a spend limit of that high end, so it never
// pauses halfway on a limit. The call is the run: get_run_status and get_run_results (an item's number is its
// row_index) answer for it, control_run stops it, and its run webhook is an enrichment run's. Its working table
// goes as a setup call's does (sweepSetupCalls).
import { db } from '../lib/db';
import { ENRICH_CALL_MAX_ITEMS } from '../lib/constants-setups';
import { MAX_ROWS_PER_SHEET, TREG_TOOL_ID_PATTERN } from '../lib/constants';
import { withoutChangeLog } from '../lib/change-log';
import { getTool } from './enrich-catalog';
import { createTable } from './table-crud';
import { addSheetColumn } from './column-add';
import { appendRows } from './rows-write';
import { txnFailMessage } from './data-plane-shared';
import { itemsOf, removeWorkingTable } from './setup-call';
import { tokenStartEnrichmentRun, type TokenEnrichArgs } from './enrich-token-run';
import { estimateEnrichCall } from './enrich-call-estimate';
import { readTokenSpend } from './token-spend';
import type { RunFail } from './run-shared';
import type { TokenCaller } from './run-start-token';
import type { CallFail } from './setup-call';
import { findColumnNameCollision } from '../lib/column-names';
import { v4 as uuidv4 } from 'uuid';

export interface EnrichCallInput {
  toolId: string; items: unknown; fields?: string[]; estimateOnly: boolean; maxCostUsd?: number | null;
  allowUnpriced?: boolean; webhookId?: string | null; maxCostPerRowUsd?: number | null;
}
export type EnrichCallOutcome =
  | { ok: { estimate_only: true; estimate: Record<string, unknown> } }
  | { ok: { run_id: string; run_type: 'enrichment'; items: number; status_column: string; output_columns: string[] } }
  | CallFail;

const STATUS = 'Status';
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// What a refusal reads of the estimate (enrich-call-estimate.ts).
type Estimate = {
  price_known: boolean; estimated_cost_usd: { low: number; high: number } | null; may_pass_daily_limit: boolean;
  may_pass_balance?: boolean; daily_limit: { remaining_usd: number | null };
};

// The working table's column names. Each output field keeps its own (get_run_results reads it by that name); an
// input named like one, in any case, gets " (input)", and the status column is "Status" unless a field or input
// takes it (an email check's tool answers a "status" field), then "Status 2" and on.
export function callColumns(used: string[], fields: string[]): { input: Map<string, string>; status: string } {
  const input = new Map(used.map(n => [n, findColumnNameCollision(n, fields) ? `${n} (input)` : n]));
  const names = [...fields, ...input.values()];
  let status = STATUS;
  for (let i = 2; findColumnNameCollision(status, names); i++) status = `${STATUS} ${i}`;
  return { input, status };
}

// Why a priced call can't start without running halfway, or null.
export function callRefusal(est: Estimate, input: EnrichCallInput, c: TokenCaller): string | null {
  if (!est.price_known) {
    return input.allowUnpriced ? null : 'This tool has no known price (it runs on your own provider key), so it '
      + 'can\'t be held to a ceiling. Pass allow_unpriced: true to run it anyway.';
  }
  const high = est.estimated_cost_usd!.high;
  if (input.maxCostUsd != null && high > input.maxCostUsd) {
    return `It could cost up to $${high.toFixed(2)}, more than max_cost_usd ($${input.maxCostUsd}).`;
  }
  if (est.may_pass_daily_limit) {
    return `It could cost up to $${high.toFixed(2)}, more than today's enrichment limit has left `
      + `($${est.daily_limit.remaining_usd?.toFixed(2)}).`;
  }
  if (est.may_pass_balance) return `It could cost up to $${high.toFixed(2)}, more than your treg balance.`;
  const token = readTokenSpend(c.userId, c.tokenId);
  if (token && token.capUsd !== null && token.capUsd - token.spentUsd < high) {
    return `It could cost up to $${high.toFixed(2)}, more than this access token's spend cap has left.`;
  }
  return null;
}

export async function callEnrichment(c: TokenCaller, input: EnrichCallInput): Promise<EnrichCallOutcome> {
  if (!TREG_TOOL_ID_PATTERN.test(input.toolId)) return bad('tool_id must be a tool id from search_enrichments.');
  const found = await getTool(input.toolId);
  if (!('ok' in found)) {
    return { fail: found.fail === 'not_found' || found.fail === 'hidden' ? 'not_found' : 'upstream',
      message: found.message };
  }
  const tool = found.ok;
  if (tool.list) {
    return bad('This tool adds rows (a list job), which a call can\'t hold: use run_enrichment on a sheet.');
  }
  const inputNames = tool.inputs.map(i => i.name);
  const items = itemsOf(input.items, inputNames, ENRICH_CALL_MAX_ITEMS, 'tool');
  if (typeof items === 'string') return bad(items);
  const known = tool.outputs.map(o => o.field);
  const fields = input.fields?.length ? input.fields : known;
  const unknown = fields.find(f => !known.includes(f));
  if (unknown !== undefined) return bad(`"${unknown}" isn't an output field of this tool (get_enrichment lists them).`);
  if (fields.length === 0) return bad('This tool lists no output fields to keep.');
  const used = inputNames.filter(n => items.some(it => n in it));
  if (used.length === 0) return bad('No item has any of the tool\'s inputs.');

  const cols = callColumns(used, fields);
  // The working table's columns and rows, as a start makes them: priced in memory first.
  const columns = [...cols.input.values()];
  const rows = items.map(it => Object.fromEntries(Object.entries(it).map(([k, v]) => [cols.input.get(k) ?? k, v])));
  const args = {
    tool_id: input.toolId, column_name: cols.status,
    inputs: Object.fromEntries(used.map(n => [n, cols.input.get(n)!])),
    outputs: fields.map(f => ({ field: f, column_name: f })),
    ...(input.maxCostPerRowUsd != null ? { max_cost_per_row_usd: input.maxCostPerRowUsd } : {}),
    ...(input.webhookId ? { webhook_id: input.webhookId } : {}),
  };
  const priced = await estimateEnrichCall(c, tool, args, { columns, rows });
  if ('fail' in priced) return priced;
  const est = priced.ok;
  const { status_column: _s, ...estimate } = est;
  if (input.estimateOnly) return { ok: { estimate_only: true, estimate } };
  const no = callRefusal(est, input, c);
  if (no) return { fail: 'over_ceiling', message: no, estimate };

  const made = withoutChangeLog(() => createTable(c.userId, `Enrichment call ${uuidv4()}`, { hidden: true }));
  if ('fail' in made) return bad(made.message);
  const { id: tableId, sheetId } = made.ok;
  let started = false;
  try {
    for (const name of columns) {
      const added = withoutChangeLog(() => addSheetColumn(sheetId, c.userId, name, { seedEmptyRow: false }));
      if ('fail' in added) return bad(added.error);
    }
    const appended = withoutChangeLog(() => appendRows(sheetId, c.userId, rows));
    if ('fail' in appended) return bad(txnFailMessage(appended, MAX_ROWS_PER_SHEET));
    const high = est.estimated_cost_usd?.high;
    const out = await tokenStartEnrichmentRun(c, {
      ...args, sheet_id: sheetId, ...(high ? { spend_limit_usd: high } : {}),
    } as TokenEnrichArgs);
    if ('fail' in out) return out;
    const runId = (out.ok as { run_id: string }).run_id;
    db.prepare('INSERT INTO enrichment_item_calls (id, user_id, table_id, sheet_id, items) VALUES (?, ?, ?, ?, ?)')
      .run(runId, c.userId, tableId, sheetId, items.length);
    started = true;
    return { ok: { run_id: runId, run_type: 'enrichment', items: items.length, status_column: cols.status,
      output_columns: fields } };
  } finally {
    if (!started) removeWorkingTable(c.userId, tableId);
  }
}
