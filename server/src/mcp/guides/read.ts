// The guides of the reading tools (guide.ts says what a guide holds).
import { FILE_LINK_TTL_MINUTES, ROWS_BY_ID_MAX } from '../../lib/api-v1-constants';
import { CHANGE_LOG_DAYS, MAX_CSV_UPLOAD_BYTES } from '../../lib/constants';
import { COLUMN_COUNTS_MAX_COLUMNS } from '../../lib/constants-columns';
import { IMPORT_GARBLED_SAMPLES } from '../../lib/constants-clean';
import { INCLUDE_STATUS_HELP, VIEW_HELP, WHERE_LANGUAGE } from '../where-schema';
import { AGGREGATES_HELP, COLUMNS_HELP, GROUP_BY_HELP, MAX_CHARS_PER_CELL_HELP } from '../query-schema';
import type { ToolGuide } from './guide';

const MAX_MB = Math.round(MAX_CSV_UPLOAD_BYTES / (1024 * 1024));

// What import_csv and an upload link answer about cells that look garbled.
const GARBLED_HELP = 'When cells look like text read with the wrong character set (they hold U+0080-U+009F, a '
  + 'sequence that lost one of those bytes, as "FraudFighterâ¢", or fix_encoding would change them, as with '
  + '"CafÃ©"), the answer adds garbled_cells (how many) and '
  + `garbled_samples (where the first ${IMPORT_GARBLED_SAMPLES} are, as {"<row id>": ["<column>", ...]}, without `
  + 'their values: read_rows with those row_ids shows them), and its note says clean_column with cleaner '
  + 'fix_encoding repairs them; their U+0080-U+009F characters are kept either way.';

export const READ_GUIDES: Record<string, ToolGuide> = {
  read_rows: {
    text: [
      'Paging a filtered read (where) echoes expected_data_version and expected_row_generation from the page '
        + 'before; a sheet that changed answers "restart paging". include_status reads run cells as {status, '
        + 'value, error}.',
      `row_ids (1 to ${ROWS_BY_ID_MAX}) returns those rows in that order with updated_at, and missing (list_trash `
        + 'has deleted ones); past about 40,000 characters read unread_ids next. Prefer it to re-read rows a run '
        + 'just touched. It takes only columns, include_status and max_chars_per_cell.',
      'updated_since returns rows changed at or after that UTC second, oldest first; page with cursor = '
        + 'next_cursor (text). To keep a copy up to date: when next_cursor is null, pass as_of as the next '
        + 'updated_since and dedupe by id; deleted rows don\'t show. It takes only columns, include_status, limit '
        + 'and cursor.',
      'max_chars_per_cell cuts long cells and lists them in cut_cells; read those whole with row_ids.',
    ],
    fields: {
      columns: COLUMNS_HELP, where: WHERE_LANGUAGE, include_status: INCLUDE_STATUS_HELP, group_by: GROUP_BY_HELP,
      aggregates: AGGREGATES_HELP, view: VIEW_HELP, max_chars_per_cell: MAX_CHARS_PER_CELL_HELP,
    },
  },
  get_sheet: {
    text: [
      'column_details says for each column its kind (plain, ai, http, enrichment, waterfall, webhook, clean, '
        + 'formula, lookup), what fills it (fill: its newest run or its setup; filled_by names the column whose run '
        + 'fills it), the columns it reads, auto_run, run_if (the "Only run if" rule) and description. Prompts, '
        + 'formulas and URLs are cut short unless the column is named in columns; credentials in a URL read "…".',
      'include_counts adds filled, errors (a failed run or ❌) and empty (the rest: not run, skipped, running) per '
        + `column, reading every row (up to ${COLUMN_COUNTS_MAX_COLUMNS} columns: those in columns, else the first).`,
      'Also: filling_columns (their cells read "⏳ Processing..." until done), the setups of clean, formula and '
        + 'lookup columns (a lookup\'s broken says why it stopped, and kept_changing why rows it looked up may hold '
        + 'older values), active_runs and active_setup_runs (control_run cancel_all stops them all), views (pass '
        + 'view to read_rows or export_csv) and auto_dedupe (remove_duplicates\' keep_doing setting, or null).',
      `history: A sheet's change log, newest first, kept ${CHANGE_LOG_DAYS} days: columns added, renamed and `
        + 'deleted, runs started and stopped, auto-run and "Only run if" changes, default model, clean, formula and '
        + 'lookup columns, views, its webhook, and rows deleted, restored, imported, sorted, moved and deduplicated. '
        + 'Each line has when (at, UTC), by (the app, an access token by name over the API or MCP, or Cubex itself), '
        + 'action, column, summary and detail; a line about rows or a column deleted to the trash has its trash_id '
        + 'and in_trash: true while that item is in the trash (also while a big column\'s cells are still moving in), '
        + 'false once it is restored or permanently deleted (still true after a restore that left cells behind in '
        + 'it). For what was deleted, list_trash.',
    ],
  },
  import_csv: { text: ['Fails on columns an active run owns.', GARBLED_HELP] },
  export_csv: { text: [], fields: { view: VIEW_HELP } },
  file_link: {
    text: [
      `upload: Import a CSV file of any size (up to ${MAX_MB} MB) into a sheet without its contents passing through `
        + 'your context. Returns a one-time link; upload the file to it with the curl command in the result, from any '
        + 'machine that can reach Cubex. curl prints the import result (rows imported, new columns).',
      GARBLED_HELP,
      'Same header rules as import_csv; mode "replace" deletes all existing rows when the file arrives (to the '
        + 'trash, restorable). Needs the write scope.',
      'With setup_id: the file\'s header names the setup\'s inputs (a column the setup doesn\'t read is ignored, '
        + 'an input the file lacks reads as empty), and the call starts once the file is in: curl prints the '
        + 'import\'s summary with the setup_call (get_run (action setup) follows it). Nobody sees an estimate first, '
        + 'so max_cost_usd is required: a file whose estimate could pass it starts nothing (curl prints the estimate), '
        + 'and so does a file with no rows. Price it first with apply_setup on a few items. mode stays append, and '
        + 'making the link counts as a run start.',
      'download: Save a sheet, or the columns and rows you pick (as in read_rows), as a CSV file of any size without '
        + 'its contents passing through your context. format jsonl saves JSON lines instead: one {"id", "data"} '
        + 'object a row, as read_rows answers it, with its values\' types and no formula quote. Returns a one-time '
        + 'link; download it with the curl command in the result to save it anywhere on your machine, or give the '
        + 'link to the user to open in a browser.',
      `The link works once and expires in ${FILE_LINK_TTL_MINUTES} minutes. Until then anyone who has it can `
        + 'download the data, so give it only to the user. The file holds the rows up to the last one the sheet had '
        + 'when the download begins. CSV values are escaped against spreadsheet formula injection.',
      'With setup_run_id instead of sheet_id, it saves a setup call\'s items (apply_setup with items): each item\'s '
        + 'inputs and outputs, while its results are kept.',
    ],
    fields: { view: VIEW_HELP },
  },
};
