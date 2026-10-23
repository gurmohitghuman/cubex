// Every MCP tool's display title and behaviour hints, in one table so they are
// reviewed together. Clients use the hints to decide what to confirm with the
// user: without them the spec's defaults apply (readOnlyHint false,
// destructiveHint true, openWorldHint true), so a read looked as dangerous as
// a delete (https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
//   readOnlyHint    — changes nothing.
//   destructiveHint — may change or remove what is there (false: only adds).
//   idempotentHint  — repeating the same call has no further effect.
//   openWorldHint   — reaches outside Cubex (OpenRouter, the HTTP APIs a run calls).
// registerTool (tool-helpers.ts) refuses a tool missing from this table.
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

const read = (title: string, openWorldHint = false): ToolAnnotations =>
  ({ title, readOnlyHint: true, idempotentHint: true, openWorldHint });
const write = (
  title: string, destructiveHint: boolean, idempotentHint: boolean, openWorldHint = false,
): ToolAnnotations =>
  ({ title, readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint });

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  list_tables: read('List tables and sheets'),
  get_sheet: read('Get sheet details'),
  read_rows: read('Read rows'),
  export_csv: read('Export rows as CSV'),
  list_runs: read('List runs'),
  get_run_status: read('Get run status'),
  get_run_results: read('Get run results'),
  list_models: read('List AI models', true),
  get_balances: read('Read balances', true),
  get_usage: read('Read usage and costs'),
  list_trash: read('List the trash'),
  get_sheet_history: read("Read a sheet's change log"),
  append_rows: write('Append rows', false, false),
  update_cells: write('Update cells', true, true),
  // Deletes go to the trash (kept the days set in Settings): restore_from_trash brings them back.
  delete_rows: write('Delete rows (to the trash)', true, true),
  add_column: write('Add a column', false, false),
  rename_column: write('Rename a column', true, true),
  set_description: write('Describe a sheet or column', true, true),
  delete_column: write('Delete a column (permanent)', true, true),
  sort_sheet: write('Sort a sheet (permanent reorder)', true, true),
  // A dry run (the default) changes nothing; a removal moves rows to the trash. Repeating it removes nothing more.
  remove_duplicates: write('Remove duplicate rows (to the trash)', true, true),
  // Rows it later removes go to the trash; the same call again changes nothing.
  set_auto_dedupe: write('Keep one row per key as rows arrive', true, true),
  manage_table: write('Create, rename or delete a table (to the trash)', true, false),
  manage_sheet: write('Create, rename, copy, delete or reorder sheets (to the trash)', true, false),
  import_csv: write('Import a CSV', true, false),
  // A one-time link is not read-only (it is a credential for one transfer), so
  // careful clients ask first; open world, since the file moves outside Cubex.
  // An upload link in replace mode moves the rows to the trash when the file arrives.
  create_upload_link: write('Create a one-time CSV upload link', true, false, true),
  create_download_link: write('Create a one-time CSV download link', false, false, true),
  set_default_model: write('Set the default AI model', true, true),
  run_ai_column: write('Run an AI column', true, false, true),
  run_http_enrichment: write('Run an HTTP enrichment', true, false, true),
  check_run_condition: read('Check an "Only run if" rule'),
  // Changes nothing, but spends one small AI call on OpenRouter.
  write_run_condition: write('Write an "Only run if" rule with AI', false, false, true),
  // One run, or with cancel_all every run on a sheet; a rerun spends again (open world).
  control_run: write('Pause, resume, cancel or rerun runs', true, false, true),
  // Writes back the cells a run overwrote (a cell changed since stays); repeating it finds it already undone.
  undo_run: write('Undo a run', true, true),
  transfer_rows: write('Copy or move rows between sheets', true, true),
  transform_column: write('Transform a column', true, false),
  // Adds a column, or cleans its own clean column again from the source (replacing what is in it, hand edits
  // included); no other column is written.
  clean_column: write('Clean a column (free)', true, true),
  // Adds a column, or works its own formula column out again with a new formula (replacing what is in it, hand
  // edits included); no other column is written.
  formula_column: write('Fill a column with a formula (free)', true, true),
  // Adds a column, or looks its own lookup column up again with new settings (replacing what is in it, hand
  // edits included); only reads the other sheet.
  lookup_column: write('Look up values from another sheet (free)', true, true),
  // Changes nothing, but spends one small AI call on OpenRouter.
  write_formula: write('Write a formula with AI', false, false, true),
  search_enrichments: read('Search enrichment tools', true),
  get_enrichment: read('Get an enrichment tool', true),
  get_list_fields: read('Get the fields of list results'),
  // Spends the treg balance and calls providers through treg.
  run_enrichment: write('Run an enrichment (paid)', true, false, true),
  // Adds columns and runs paid steps (treg, AI) and requests to your API; describe and an estimate change nothing.
  waterfall_column: write('Run a waterfall column (paid)', true, false, true),
  // create and set_brands are free; ask (estimate_only false) starts paid treg runs, and asking
  // again or new brands rewrite the answer and formula cells.
  ai_visibility: write('AI visibility table (ask and check_again are paid)', true, false, true),
  add_enrichment_field: write('Add a column from stored answers', false, false),
  add_list_rows: write('Add list results as rows', false, false),
  // Turning it on makes later rows spend (or send requests) on their own.
  set_auto_run: write('Turn auto-run on, off or pause it', true, true, true),
  list_setups: read('List setups'),
  // Adds a setup; the sheet is only read. preview: true saves nothing.
  save_setup: write('Save columns as a setup', false, false),
  delete_setup: write('Delete a setup (permanent)', true, true),
  // Adds columns and starts their runs, which spend (AI, enrichments) or send requests. An estimate changes nothing.
  apply_setup: write('Use a setup on a sheet', true, false, true),
  get_setup_run: read('Get a setup run'),
  control_setup_run: write('Pause, resume or stop a setup run', true, false, true),
  list_setup_versions: read("List or compare a sheet's setup versions"),
  // Saves a version, renames one, or deletes one for good; the sheet itself never changes.
  manage_setup_version: write('Save, rename or delete a setup version', true, false),
  // Puts columns' setups back (and gone columns, empty); nothing runs, but later runs and auto-run use it.
  restore_setup_version: write('Restore a setup version', true, true),
  list_run_webhooks: read('List run webhooks'),
  // Puts rows, sheets and tables back; repeating it finds nothing more to restore.
  restore_from_trash: write('Restore from the trash', false, true),
};
