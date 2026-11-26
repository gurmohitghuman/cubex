// The guides of the tools that write rows and change columns, sheets and their webhook (guide.ts says what a
// guide holds).
import { MAX_VIEWS_PER_SHEET } from '../../lib/constants-filters';
import { MAX_COLUMN_DESCRIPTION_CHARS, MAX_SHEET_DESCRIPTION_CHARS } from '../../lib/constants-columns';
import { SHEET_TEST_MAX_ROWS, SHEET_TEST_ROWS } from '../../lib/constants';
import { AUTO_DELETE_KEEP_DEFAULT } from '../../lib/constants-webhook-auto-delete';
import type { ToolGuide } from './guide';

const RETRY_WORDS = 'idempotency_key makes a retry safe: the same key and arguments within 24 hours answer as the '
  + 'first call did, with replayed: true, and write nothing; the same key with other arguments is refused.';

export const STRUCTURE_GUIDES: Record<string, ToolGuide> = {
  append_rows: {
    text: [
      `${RETRY_WORDS} A replay leaves out auto_run (the first call set the runs off).`,
    ],
  },
  change_rows: {
    text: [
      `update: ${RETRY_WORDS}`,
      'delete: read_rows with where and return_mode ids finds the rows; remove_duplicates removes duplicates. They '
        + 'go to the trash as one batch, kept for the days set in Settings (30 by default; 0 deletes at once): the '
        + 'answer gives its trash_id, and restore_from_trash puts them back. Refused while an AI or HTTP run is '
        + 'working on the sheet.',
    ],
  },
  manage_column: {
    text: [
      'add: Add an empty column at the end, to write into with append_rows or change_rows. formula_column, '
        + 'clean_column, lookup_column (free) or run_ai_column, run_enrichment, waterfall_column (paid) fill a '
        + 'column from each row instead. A name that differs from an existing one only in case or spacing is '
        + 'refused. description describes it at once. Returns the name.',
      'rename: Everything that names it follows: cells, order, filters, views, webhook mappings and the '
        + '/references in saved AI prompts and HTTP requests. Refused while a run writes or reads the column (stop '
        + 'it with control_run first). Returns the new name.',
      'describe: what it holds, where its values come from, how to read it. People see it in the app on the column '
        + 'header and agents in get_sheet (column_details). It is never sent to AI runs. Up to '
        + `${MAX_COLUMN_DESCRIPTION_CHARS.toLocaleString('en-US')} characters. Renaming a column keeps its `
        + 'description; deleting it deletes the description too. The sheet\'s own: manage_sheet describe.',
      'reorder: Only the order the app and reads show changes: no row, cell, run or saved view changes, and a '
        + 'hidden column stays hidden. A column left out, named twice or unknown is refused and nothing changes.',
      'delete: Delete a column: it goes to the trash with its cells, its place, its description and its own setup '
        + '(what makes it an AI, HTTP API, enrichment, waterfall, formula, lookup or clean column), and the '
        + 'answer\'s trash says until when and how to restore it (restore_from_trash). '
        + 'What other columns, views and settings said about it is removed now and does not come back with it: its own '
        + 'auto-run, filters and hidden columns in views, webhook mappings, fields another run writes into it, '
        + 'lookups in other sheets reading it, auto-dedupe on it; the restore answer lists each one so you can set '
        + 'it up again. With Settings keeping deleted things 0 days it is deleted at once (trash_id null).',
      'A big column\'s cells take a while: past a few seconds the answer\'s trash says state "moving" (they go on in '
        + 'the background, and a restore waits until they are all in). Refused for run-owned columns, columns an '
        + 'active run reads, webhook marker columns, and the last remaining column.',
    ],
  },
  manage_sheet: {
    text: [
      'create auto-names the sheet when name is omitted and can insert after a given tab.',
      'copy makes a new sheet right after sheet_id holding its values: the same rows in the same order under the '
        + 'same column names (or only the columns you list), as plain columns that nothing fills (no runs, formulas, '
        + 'lookups, rules or views come along), with a run\'s status words (⏳, ❌, ⏭️, ➕) left empty. Free, no AI; '
        + 'name defaults to "Copy of <sheet>". Use it to keep a sheet as it is now, for example before running its '
        + 'columns again; it answers once every row is in (rows_copied).',
      'test_add_rows adds rows to an open test: the next rows from the top (how top, the default) or at random (how '
        + `random), rows of them (default ${SHEET_TEST_ROWS}), or the row_ids you choose; a test holds at most `
        + `${SHEET_TEST_MAX_ROWS} rows. The copy's clean, formula and lookup columns work the new rows out as they `
        + 'arrive; nothing paid runs.',
      'apply_test: the copy\'s setup becomes the sheet\'s, the sheet\'s old setup is kept as a setup version '
        + '(list_setup_versions), and each sample row\'s newest result made by the column as it is now, from the '
        + 'same inputs, goes back to that row (kept as one finished $0 run, so undo_run can take it back); nothing '
        + 'runs. apply says what it did, or would do on a dry run. Refused while a run is going on the copy; a column '
        + 'whose request reads saved API keys needs the secrets scope.',
      'discard_test deletes the copy with its rows and runs, and the sheet stays as it was. Either way the sheet '
        + 'takes changes again and the webhook deliveries it kept are added in the order they arrived. While a test '
        + 'ends, get_sheet\'s test says state "ending". The copy is never in get_workspace.',
      'sort: Refused while a run works on the sheet. Returns rows_reordered.',
      'describe: what the sheet holds, where its values come from, how to read it. People see it on the sheet\'s '
        + 'tab and agents in get_sheet (description). It is never sent to AI runs. Up to '
        + `${MAX_SHEET_DESCRIPTION_CHARS.toLocaleString('en-US')} characters.`,
    ],
  },
  manage_sheet_webhook: {
    text: [
      'get: its state (webhook null when none): on or off, events_received, last_event_at, last_error and its '
        + 'fields.',
      'turn_off: events get 404 and add nothing until turn_on. add_field: json_path (like $.email or $.plan.name) '
        + 'and column, a new column each event fills, as text (default) or as json. remove_field: field_id; its '
        + 'column and values stay. remove_token: no token needed.',
      `set_auto_delete: what you leave out stays as it was (at first: ${AUTO_DELETE_KEEP_DEFAULT} rows kept, no `
        + 'success column, no copy); null clears success_column or copy_to_sheet_id. The answer\'s auto_delete says '
        + 'paused (why no row leaves until you act) and waiting (a paused auto-run or run the rows wait for). '
        + 'copy_to_sheet_id can\'t be a test copy (manage_sheet test) or a sheet being tested; when a test starts on '
        + 'it later, rows wait until that test ends and waiting says so. auto_delete_off: rows already gone stay gone.',
      'set_auto_delete mode rules: where needs at least one condition turned on; a row with ⏳ or ➕ in a run column '
        + 'still stays. A switch to rules needs success_column: null when one is set (a has_result rule waits for a '
        + 'column there), and a switch back to actions_finish clears the rules. get\'s auto_delete has mode and '
        + 'where.',
      'manage_table or manage_sheet create with webhook true makes a sheet with one.',
    ],
  },
  manage_view: {
    text: [
      'action create makes a copy of the view the app shows (or of from), then sets what you pass: name is required '
        + `and unique in the sheet, ignoring case; a sheet has at most ${MAX_VIEWS_PER_SHEET} views.`,
      'change sets only what you pass on view: where and hidden_columns replace what the view had, null clears them '
        + '(a view with no filters shows every row).',
      'Each change is a line in the sheet\'s History.',
    ],
  },
};
