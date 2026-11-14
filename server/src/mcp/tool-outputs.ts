// Every MCP tool's outputSchema, by name, in one table as its title and hints are (tool-annotations.ts).
// registerTool (tool-helpers.ts) refuses a tool missing from it, and its handler's answers must have the type
// ToolAnswer gives, so an answer that doesn't fit fails the typecheck. output-schema.ts says how one is written.
import type { z } from 'zod';
import type { Fits } from './output-schema';
import * as read from './outputs/read';
import * as rows from './outputs/rows';
import * as columns from './outputs/columns';
import * as runs from './outputs/runs';
import * as fill from './outputs/fill';
import * as enrich from './outputs/enrich';
import * as setups from './outputs/setups';
import * as account from './outputs/account';

export const TOOL_OUTPUTS = {
  get_workspace: read.getWorkspace, list_tables: read.listTables, get_sheet: read.getSheet, read_rows: read.readRows,
  export_csv: read.exportCsv, list_runs: read.listRuns, import_csv: read.importCsv,
  create_upload_link: read.createUploadLink, create_download_link: read.createDownloadLink,
  append_rows: rows.appendRows, update_cells: rows.updateCells, delete_rows: rows.deleteRows,
  transfer_rows: rows.transferRows, transform_column: rows.transformColumn,
  remove_duplicates: rows.removeDuplicates, set_auto_dedupe: rows.setAutoDedupe,
  add_column: columns.addColumn, set_description: columns.setDescription, rename_column: columns.renameColumn,
  delete_column: columns.deleteColumn, sort_sheet: columns.sortSheet, set_column_order: columns.setColumnOrder,
  manage_table: columns.manageTable, manage_sheet: columns.manageSheet, manage_view: columns.manageView,
  run_ai_column: runs.runAiColumn, run_http_enrichment: runs.runHttpEnrichment,
  check_run_condition: runs.checkRunCondition, write_run_condition: runs.writeRunCondition,
  get_run_status: runs.getRunStatus, control_run: runs.controlRun, undo_run: runs.undoRun,
  get_run_results: runs.getRunResults, list_run_webhooks: runs.listRunWebhooks,
  manage_run_webhook: runs.manageRunWebhook,
  clean_column: fill.cleanColumn, formula_column: fill.formulaColumn, write_formula: fill.writeFormula,
  lookup_column: fill.lookupColumn, add_enrichment_field: fill.addEnrichmentField,
  get_list_fields: fill.getListFields, add_list_rows: fill.addListRows, set_auto_run: fill.setAutoRun,
  search_enrichments: enrich.searchEnrichments, get_enrichment: enrich.getEnrichment,
  run_enrichment: enrich.runEnrichment, waterfall_column: enrich.waterfallColumn,
  ai_visibility: enrich.aiVisibility, get_balances: enrich.getBalances, get_usage: enrich.getUsage,
  list_setups: setups.listSetups, save_setup: setups.saveSetup, delete_setup: setups.deleteSetup,
  apply_setup: setups.applySetup, get_setup_run: setups.getSetupRun, control_setup_run: setups.controlSetupRun,
  list_setup_versions: setups.listSetupVersions, manage_setup_version: setups.manageSetupVersion,
  restore_setup_version: setups.restoreSetupVersion,
  list_models: account.listModels, set_default_model: account.setDefaultModel, get_version: account.getVersion,
  list_trash: account.listTrash, restore_from_trash: account.restoreFromTrash,
  get_sheet_history: account.getSheetHistory, list_saved_keys: account.listSavedKeys,
} satisfies Record<string, z.ZodObject<any, any>>;

export type ToolName = keyof typeof TOOL_OUTPUTS;
// The type a tool's answer (its structuredContent) must have.
export type ToolAnswer<N extends ToolName> = Fits<z.input<(typeof TOOL_OUTPUTS)[N]>>;
