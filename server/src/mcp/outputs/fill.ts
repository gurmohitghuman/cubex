// What the free fill tools and the enrichment field tools answer (tools-clean.ts, tools-formula.ts,
// tools-lookup.ts, tools-enrich-manage.ts).
import { z } from 'zod';
import { obj, open } from '../output-schema';
import { autoRunNotice, bool, changed, info, nul, num, opt, str, strs } from './shared';

const preview = {
  preview: opt(bool).describe('true: nothing was written; samples shows what it would write'),
  samples: opt(z.array(info('A row: what it reads and what it would write'))),
  created: opt(bool), note: opt(str),
};
const filling = { auto_run: opt(bool), status: opt(str), filled_rows: opt(num), error_rows: opt(num) };

// The clean column's setup (its cleaner's options too), or a preview.
export const cleanColumn = open({
  column: str, source_column: opt(str), cleaner: opt(str), auto_run: opt(bool), status: opt(str),
  cleaned_rows: opt(num), blank_rows: opt(num), cleans_existing_column: opt(bool), ...preview, changed,
});

export const formulaColumn = obj({
  column: nul(str), formula: str, reads: strs, ...filling, changes_existing_column: opt(bool),
  first_error: opt(str), description: opt(str), auto_run_paused: opt(str).describe('Why auto-run is paused'),
  error: opt(str).describe('Why the fill failed'),
  stopped: opt(str).describe('preview: the formula ran out of time or memory on the sample rows'), ...preview, changed,
});

export const writeFormula = obj({
  model: str, model_source: str, cost_usd: nul(num).describe('null when the provider did not say'), formula: str,
  preview: info('formula_column\'s preview of the formula written'),
});

// The lookup column's setup, or a preview.
export const lookupColumn = open({
  column: nul(str), source_column: opt(str), other_sheet: nul(str).describe('null when that sheet was deleted'),
  other_sheet_id: opt(str), other_table: opt(str),
  match_column: opt(str), match: opt(str), returns: opt(str), return_column: opt(nul(str)),
  return_columns: opt(z.union([strs, z.literal('all')])).describe('"all": every column'),
  limit: opt(num), ...filling, first_error: opt(str), broken: opt(str), changes_existing_column: opt(bool),
  other_rows: opt(num), checked_rows: opt(num), checked_note: opt(str), ...preview, changed,
});

export const addEnrichmentField = obj({ column: str, filling: bool, note: str, changed });

export const getListFields = obj({
  fields: z.array(obj({ path: str, label: str, filled: num, sample: str })), results_read: num,
  waiting_for_fields: nul(obj({ rows: num, results: num })),
  kept: nul(z.array(obj({ path: str, column_name: str }))).describe('The fields kept as columns; null: none yet'),
  dedupe_path: nul(str), destination_sheet_id: nul(str),
});

export const addListRows = obj({ source_rows_released: num, auto_run: opt(autoRunNotice), note: str, changed });

const autoRunColumn = obj({
  column: str, kind: str, enabled: bool, sends_requests: bool, paused_reason: nul(str), paused_message: nul(str),
  where: z.array(info('A where item')), run_if: nul(str), daily_cap_usd: nul(num), daily_row_cap: nul(num),
  used_today_usd: num, rows_today: num,
});
export const setAutoRun = obj({
  auto_run: z.array(autoRunColumn), has_webhook: bool,
  daily_limit: obj({ limit_usd: nul(num), used_today_usd: num, remaining_usd: nul(num) }), changed,
});
