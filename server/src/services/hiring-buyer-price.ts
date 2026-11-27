// Which companies "Find buyers" takes, and what the first find costs before its columns exist
// (services/hiring-buyer.ts). Both are pure reads: an estimate never saves a column or a setup.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { MAX_COLUMN_RUN_ROW_IDS } from '../lib/constants-setups';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import type { WhereItem } from '../lib/row-filter/where';
import { fixedInputs } from '../lib/enrich-estimate-input';
import { estimateEnrichment } from './enrich-setup';
import { wherePlaces } from './column-run-rows';
import type { ColumnEstimate, ColumnRunEstimate } from './column-run-estimate';
import type { ColumnRunMode } from './column-run-input';
import type { RunFail } from './run-shared';

// The companies a find takes: those whose Buyer cell is empty (never searched, no one found with the titles then, or
// failed), picked once by row id as the run starts (a where on Buyer would move as the run fills it); every row
// before Buyer is on Companies. A column run takes at most MAX_COLUMN_RUN_ROW_IDS chosen rows, so past that it takes
// the companies never searched.
export interface BuyerPick { mode: ColumnRunMode; rowIds: string[] | null; rows: number }

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

export async function buyerPick(userId: string, sheetId: string, buyer: string): Promise<{ ok: BuyerPick } | RunFail> {
  const total = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
    .get(sheetId, userId) as number;
  if (total === 0) return bad('Companies has no rows yet: check the table first, then find buyers.');
  if (!getSheetColumns(sheetId, userId, false).includes(buyer)) {
    return { ok: { mode: 'all', rowIds: null, rows: total } };
  }
  const where: WhereItem[] = [{ column: buyer, operator: 'empty' }];
  // The scan is sliced; a sort between it and the ids moves the places, so that reads it again.
  for (let tries = 0; ; tries++) {
    const before = generation(sheetId, userId);
    const places = await wherePlaces(sheetId, userId, where);
    if ('problem' in places) return bad(places.problem);
    if (places.length === 0) return bad(`Every company on Companies has a ${buyer} already.`);
    if (places.length > MAX_COLUMN_RUN_ROW_IDS) return { ok: { mode: 'empty', rowIds: null, rows: places.length } };
    const rowIds = db.prepare(`SELECT id FROM rows WHERE sheet_id = ? AND user_id = ?
      AND row_index IN (SELECT value FROM json_each(?)) ORDER BY row_index`).pluck()
      .all(sheetId, userId, JSON.stringify(places)) as string[];
    if (generation(sheetId, userId) !== before && tries === 0) continue;
    return { ok: { mode: 'all', rowIds, rows: rowIds.length } };
  }
}

const generation = (sheetId: string, userId: string) => db.prepare(
  'SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?').pluck().get(sheetId, userId) as number | undefined;

const round = (n: number) => Math.round(n * 1e4) / 1e4;

// One column priced as a column run prices it once saved (column-run-estimate.ts): the tool's price on every row, at
// the setup's most a row.
async function priceColumn(userId: string, input: EnrichRunInput, rows: number, layer: number)
  : Promise<{ ok: ColumnEstimate } | RunFail> {
  const out = await estimateEnrichment(userId, {
    toolId: input.toolId, rows, preset: input.preset, given: Object.keys(input.inputs).sort(),
    skip: input.skipProviders, order: input.providerOrder, stopAtFirst: input.stopAtFirst,
    maxCostPerRowUsd: input.maxCostPerRowUsd, limit: null, list: null, fixed: fixedInputs(input.inputs),
  });
  if (!('ok' in out)) {
    return { fail: out.fail === 'unreachable' || out.fail === 'upstream' ? 'upstream' : 'bad_request',
      message: out.message };
  }
  const { estimate: e, priceKnown } = out.ok;
  return {
    ok: {
      column: input.columnName, kind: 'enrichment', layer, rows: e.rows,
      low_usd: priceKnown ? round(e.lowUsd) : null, high_usd: priceKnown ? round(e.highUsd) : null,
      row_most_usd: null, sends_requests: false, at_most: false,
      note: priceKnown ? null : 'Billed by the provider on your own key.',
    },
  };
}

// The first find, its columns not saved yet: each column over every company it takes (the email at most one a
// company: only those the search finds someone at are searched), as the run will price them once they're saved.
export async function priceUnsaved(userId: string, inputs: EnrichRunInput[], rows: number)
  : Promise<{ ok: ColumnRunEstimate } | RunFail> {
  const columns: ColumnEstimate[] = [];
  for (const [i, input] of inputs.entries()) {
    const out = await priceColumn(userId, input, rows, i + 1);
    if ('fail' in out) return out;
    columns.push(out.ok);
  }
  const priced = columns.filter(c => c.high_usd !== null);
  return {
    ok: {
      rows_in_scope: rows,
      low_usd: round(priced.reduce((s, c) => s + (c.low_usd ?? 0), 0)),
      high_usd: round(priced.reduce((s, c) => s + (c.high_usd ?? 0), 0)),
      row_most_usd: 0,
      unpriced: columns.filter(c => c.rows > 0 && c.high_usd === null).map(c => c.column),
      columns,
    },
  };
}
