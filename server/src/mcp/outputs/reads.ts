// What the merged reads answer (fewer MCP tools, PR A: tools-get-run.ts, tools-account.ts, find_enrichments,
// get_workspace's all_tables and get_sheet's history). Each action or mode answers what its own tool answered
// before, so an old caller reads the same fields: the schema is all of them, each field optional.
import { eitherAnswer, obj, open } from '../output-schema';
import { getRunResults, getRunStatus } from './runs';
import { getSheet as sheetDetails, getWorkspace as overview, listRuns, listTables } from './read';
import { getSetupRun } from './setups';
import { getBalances, getEnrichment, getUsage, searchEnrichments } from './enrich';
import { getSheetHistory, getVersion, listSavedKeys } from './account';

// status: the run (open: its type adds fields); results: a page of rows; list: runs; setup: setup runs or one.
export const getRun = open(eitherAnswer(getRunStatus.shape, getRunResults.shape, listRuns.shape, getSetupRun.shape));
// balances, usage, saved_keys or version.
export const getAccount = obj(eitherAnswer(getBalances.shape, getUsage.shape, listSavedKeys.shape,
  getVersion.shape));
// search: tools; get: one tool (open: its kind adds fields).
export const findEnrichments = open(eitherAnswer(searchEnrichments.shape, getEnrichment.shape));
// The overview, or with all_tables every table and its sheets.
export const getWorkspace = obj(eitherAnswer(overview.shape, listTables.shape));
// The sheet's details, or with history its change log.
export const getSheet = obj(eitherAnswer(sheetDetails.shape, getSheetHistory.shape));
