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
import * as reads from './outputs/reads';
import * as merged from './outputs/merged';

export const TOOL_OUTPUTS = {
  get_workspace: reads.getWorkspace, get_sheet: reads.getSheet, read_rows: read.readRows,
  export_csv: read.exportCsv, import_csv: read.importCsv,
  file_link: merged.fileLink,
  append_rows: rows.appendRows, update_cells: rows.updateCells, delete_rows: rows.deleteRows,
  transfer_rows: rows.transferRows, transform_column: rows.transformColumn,
  remove_duplicates: merged.removeDuplicates,
  add_column: columns.addColumn, set_description: columns.setDescription, rename_column: columns.renameColumn,
  delete_column: columns.deleteColumn, sort_sheet: columns.sortSheet, set_column_order: columns.setColumnOrder,
  manage_table: columns.manageTable, manage_sheet: columns.manageSheet, manage_view: columns.manageView,
  manage_sheet_webhook: columns.manageSheetWebhook,
  run_ai_column: runs.runAiColumn, run_http_enrichment: runs.runHttpEnrichment,
  check_run_condition: runs.checkRunCondition, write_run_condition: runs.writeRunCondition,
  get_run: reads.getRun, control_run: merged.controlRun,
  list_run_webhooks: runs.listRunWebhooks,
  manage_run_webhook: runs.manageRunWebhook,
  clean_column: fill.cleanColumn, formula_column: merged.formulaColumn,
  lookup_column: fill.lookupColumn, stored_answers: merged.storedAnswers,
  get_list_fields: fill.getListFields, set_auto_run: fill.setAutoRun,
  list_prompt_starters: fill.listPromptStarters,
  find_enrichments: reads.findEnrichments,
  run_enrichment: enrich.runEnrichment, waterfall_column: enrich.waterfallColumn,
  ai_visibility: enrich.aiVisibility, hiring_signals: enrich.hiringSignals,
  social_research: enrich.socialResearch,
  get_account: reads.getAccount,
  list_setups: setups.listSetups, manage_setup: merged.manageSetup,
  manage_run_schedule: setups.manageRunSchedule,
  apply_setup: setups.applySetup,
  run_columns: setups.runColumns,
  list_setup_versions: setups.listSetupVersions, manage_setup_version: merged.manageSetupVersion,
  list_models: account.listModels, set_default_model: account.setDefaultModel,
  get_tool_guide: account.getToolGuide,
  list_trash: account.listTrash, restore_from_trash: account.restoreFromTrash,
} satisfies Record<string, z.ZodObject<any, any>>;

export type ToolName = keyof typeof TOOL_OUTPUTS;
// The type a tool's answer (its structuredContent) must have.
export type ToolAnswer<N extends ToolName> = Fits<z.input<(typeof TOOL_OUTPUTS)[N]>>;
// A tool's answer as a service shared with REST builds it: the MCP handler adds changed (mcp/changed.ts).
// (Without, not Omit: an open answer's index signature would take its named fields with it.)
type Without<T, K extends string> = { [P in keyof T as P extends K ? never : P]: T[P] };
export type ServiceAnswer<N extends ToolName> = Fits<Without<z.input<(typeof TOOL_OUTPUTS)[N]>, 'changed'>>;
