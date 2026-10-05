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
const write = (title: string, destructiveHint: boolean, idempotentHint: boolean, openWorldHint = false): ToolAnnotations =>
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
  append_rows: write('Append rows', false, false),
  update_cells: write('Update cells', true, true),
  delete_rows: write('Delete rows (permanent)', true, true),
  add_column: write('Add a column', false, false),
  rename_column: write('Rename a column', true, true),
  delete_column: write('Delete a column (permanent)', true, true),
  sort_sheet: write('Sort a sheet (permanent reorder)', true, true),
  manage_table: write('Create, rename or delete a table', true, false),
  manage_sheet: write('Create, rename, delete or reorder sheets', true, false),
  import_csv: write('Import a CSV', true, false),
  set_default_model: write('Set the default AI model', true, true),
  run_ai_column: write('Run an AI column', true, false, true),
  run_http_enrichment: write('Run an HTTP enrichment', true, false, true),
  control_run: write('Pause, resume, cancel or rerun a run', true, false, true),
  transfer_rows: write('Copy or move rows between sheets', true, true),
  transform_column: write('Transform a column', true, false),
};
