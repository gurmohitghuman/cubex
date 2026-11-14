// What the read, export, link and import tools answer (tools-read.ts, tools-workspace.ts, tools-links.ts,
// tools-import.ts).
import { z } from 'zod';
import { keyed, obj, open } from '../output-schema';
import {
  autoDedupe, autoRunNotice, bool, cells, changed, info, nul, num, opt, str, strs, trash, versions,
} from './shared';

const sheetEntry = obj({ id: str, name: str, position: num, row_count: num });
export const listTables = obj({
  tables: z.array(obj({ id: str, name: str, created_at: str, updated_at: str, sheets: z.array(sheetEntry) })),
});

// get_workspace (services/workspace-overview.ts): each part bounded, the counts say what was left out.
const runStatus = z.enum(['pending', 'running', 'paused']);
export const getWorkspace = obj({
  cubex_version: str,
  access_token: obj({ name: str, scopes: strs, spend_cap_usd: nul(num), spent_usd: num, left_usd: nul(num) }),
  enrichment_daily_limit: obj({ limit_usd: nul(num), used_today_usd: num, remaining_usd: nul(num) }),
  default_ai_model: nul(str), table_count: num, sheet_count: num,
  tables: z.array(obj({
    id: str, name: str, sheet_count: num,
    sheets: z.array(obj({
      id: str, name: str, columns: nul(num).describe('null: not listed yet (get_sheet lists them)'),
      row_count: num, row_count_at_least: opt(z.literal(true)).describe('true: more rows than row_count'),
      data_version: num, updated_at: str,
    })),
  })),
  active_run_count: num,
  active_runs: z.array(obj({
    run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall']), run_id: str, sheet_id: str, column: str,
    status: runStatus, processed_rows: num, total_rows: num, auto_run: bool,
  })),
  active_setup_run_count: num,
  active_setup_runs: z.array(obj({
    setup_run_id: str, setup: str, sheet_id: str, status: z.enum(['running', 'paused']),
  })),
  note: str,
});

const activeRun = obj({
  run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall']), run_id: str,
  status: z.enum(['pending', 'running', 'paused']), column: str, auto_run: bool,
});
const columnDetail = obj({
  name: str, kind: str, role: opt(str), filled_by: opt(str),
  fill: opt(info('What fills it: its newest run (run_id, run_status, ...) or its setup; fields by kind')),
  reads: opt(strs), auto_run: opt(bool), auto_run_paused: opt(str),
  auto_run_caps: opt(obj({ usd_per_day: opt(num), rows_per_day: opt(num) })),
  run_if: opt(nul(str)), description: opt(str),
  counts: opt(nul(obj({ filled: num, empty: num, errors: num }))),
});
const view = obj({
  id: str, name: str, description: nul(str), is_default: bool, active: bool, hidden_columns: strs,
  where: z.array(info('A where item')),
});
export const getSheet = obj({
  id: str, table_id: str, name: str, description: nul(str), columns: strs, row_count: num, ...versions,
  default_ai_model: nul(str), filling_columns: strs, active_runs: z.array(activeRun),
  active_setup_runs: z.array(obj({ setup_run_id: str, setup: str, status: z.enum(['running', 'paused']) })),
  clean_columns: z.array(info('A clean column\'s setup')),
  formula_columns: z.array(info('A formula column\'s setup')),
  lookup_columns: z.array(info('A lookup column\'s setup')),
  views: z.array(view), column_details: z.array(columnDetail),
  auto_dedupe: nul(info('The set_auto_dedupe setting')),
  limits: obj({ max_rows: num, rows_remaining: num, max_columns: num, columns_remaining: num }),
});

const row = obj({ id: str, index: num, data: opt(cells), updated_at: opt(str).describe('row_ids and updated_since') });
export const readRows = obj({
  rows: opt(z.array(row)).describe('Not with return_mode count or group_by'),
  next_cursor: opt(z.union([num, str, z.null()])).describe('Pass as cursor for the next page; null at the end'),
  ...versions,
  count: opt(num).describe('return_mode count'),
  view_version: opt(str),
  cut_cells: opt(keyed(keyed(num))).describe('max_chars_per_cell: row id -> column -> full length'),
  missing: opt(strs).describe('row_ids: ids that are no row of the sheet'),
  unread_ids: opt(strs).describe('row_ids: rows past the size budget; read them again'),
  as_of: opt(str).describe('updated_since: the next updated_since'),
  filling: opt(strs).describe('updated_since: columns still filling'),
  rows_matched: opt(num), group_count: opt(num), truncated: opt(bool),
  groups: opt(z.array(obj({ group: keyed(str), count: num, values: opt(keyed(nul(num))) }))),
});

export const exportCsv = obj({
  sheet_id: str, sheet_name: nul(str), csv: str, row_count: num, columns: opt(strs),
  matching_rows: opt(nul(num)), truncated: opt(bool), rest: opt(str).describe('How to read the rows cut off'),
});

// A run as list_runs and get_run_status show it (services/run-status.ts RunSummary): other fields by run type.
export const runSummary = open({
  id: str, sheet_id: str, type: z.enum(['ai', 'http']), column_name: nul(str), status: str,
  processed_rows: num, total_rows: num, target_row_count: nul(num), error_message: nul(str),
  failed_rows: num, succeeded_rows: num, cost_usd: opt(nul(num)), created_at: str, updated_at: str,
});
export const listRuns = obj({ runs: z.array(runSummary), count: num });

export const createUploadLink = obj({
  upload_url: str, curl: str, mode: z.enum(['append', 'replace']), expires_at: str, max_mb: num, note: str,
});
export const createDownloadLink = obj({ download_url: str, curl: str, columns: strs, expires_at: str, note: str });

export const importCsv = obj({
  rows_imported: num, starting_row: num, new_columns: strs, replaced: bool, trash: opt(trash),
  dropped_blank_starter_rows: opt(bool), auto_dedupe: opt(autoDedupe), truncated_cells: opt(num),
  garbled_cells: opt(num), garbled_samples: opt(info('Garbled text found, by column')), note: opt(str),
  auto_run: opt(autoRunNotice), changed,
});
