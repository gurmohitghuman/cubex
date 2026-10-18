// The checks and the config of a waterfall run start, before anything is
// written (services/waterfall-run-start.ts writes them in one transaction):
// the column names (the result column, "answered by", one per step), the
// column a run adds to, the rows in scope, the "Only run if" rule and the
// config built against the catalog and the AI defaults. A pure read, so an
// estimate checks exactly what a start would.
import { db } from '../lib/db';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { findColumnNameCollision, columnCollisionMessage } from '../lib/column-names';
import { validateHttpRunColumns } from '../lib/http-run-validate';
import { parseRowData } from '../lib/sql-rows';
import type { CheckedRule } from '../lib/run-condition';
import type { HTTPRequestConfig, ResponseMapping } from '../lib/http-request-template';
import type { SeedPlan } from '../lib/enrich-seed';
import { ANSWERED_BY_PATH, stepPath, waterfallColumns, type WaterfallRunConfig } from '../lib/waterfall/config';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import { sheetRowSpan } from './run-seed';
import { countFor, enrichRowCounts } from './enrich-row-count';
import { checkRunRule } from './run-rule';
import { autorunFillingColumn } from './autorun-block';
import { buildWaterfall, type BuiltWaterfall } from './waterfall-build';
import { newestWaterfallRun } from './waterfall-column';
import type { RunFail } from './run-shared';

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const SAMPLE_ROWS = 20;

export interface PreparedWaterfall {
  resultColumn: string;
  outputs: ResponseMapping[];          // answered-by and step columns
  newColumns: string[];                // what the start adds to the sheet (result first)
  hideColumns: string[];               // new step columns hidden in every view
  config: WaterfallRunConfig;
  built: BuiltWaterfall;
  columns: string[];
  span: { count: number; lastRow: number };
  upperBound: number;                  // the most rows the run can take
  rule: CheckedRule | null;
}

export const answeredByName = (result: string): string => `${result} (Answered by)`;
export const stepColumnName = (result: string, label: string): string => `${result} (${label})`;

export function activeRunOn(sheetId: string, userId: string, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL) LIMIT 1`).get(sheetId, userId, name);
}

// Which rows the run takes (seeding's check), as the start seeds them.
export function seedPlanFor(input: WaterfallRunInput, p: PreparedWaterfall): SeedPlan<WaterfallRunConfig> {
  return {
    statusColumn: input.continueColumn ? p.resultColumn : null, status: input.rows.status, where: [],
    rule: p.rule?.tree ?? null, config: p.config, columns: p.columns,
  };
}

// The first rows' cells (the AI steps' prices read their inputs).
export function sampleRows(sheetId: string, userId: string): Array<Record<string, string>> {
  const rows = db.prepare(`SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?`)
    .all(sheetId, userId, SAMPLE_ROWS) as Array<{ data: string }>;
  return rows.map(r => parseRowData(r.data));
}

// The run's columns: on a continued column its own names stay, a new step gets "<result> (<label>)".
function namesFor(
  input: WaterfallRunInput, built: BuiltWaterfall, prior: WaterfallRunConfig | null,
): { mapping: ResponseMapping[]; stepNames: string[] } {
  const had = prior ? waterfallColumns(prior) : { answeredBy: null, steps: {} as Record<string, string> };
  const mapping: ResponseMapping[] = [];
  if (input.answeredBy) {
    mapping.push({ columnName: had.answeredBy ?? answeredByName(input.columnName), jsonPath: ANSWERED_BY_PATH });
  }
  const stepNames: string[] = [];
  // Every step has a column (one switched off too, so switching it on later
  // fills it); a step whose column was deleted keeps going without one.
  for (const s of built.block.steps) {
    const own = had.steps[s.id];
    if (!own && prior?.waterfall.steps.some(p => p.id === s.id)) continue;
    const col = own ?? stepColumnName(input.columnName, s.label);
    mapping.push({ columnName: col, jsonPath: stepPath(s.id) });
    if (!own) stepNames.push(col);
  }
  return { mapping, stepNames };
}

async function rowsInScope(
  sheetId: string, userId: string, input: WaterfallRunInput, all: number, rule: CheckedRule | null,
): Promise<number> {
  const { mode, status, rowIndexes } = input.rows;
  const byStatus = input.continueColumn && status !== 'any';
  if (!byStatus && mode !== 'filter' && !rule) return mode === 'selected' ? rowIndexes?.length ?? 0 : all;
  const counts = await enrichRowCounts(sheetId, userId, byStatus ? input.columnName : null,
    { mode, rowIndexes, where: [], rule: rule?.tree ?? null });
  return byStatus ? countFor(counts, status) : counts.total;
}

const NOTHING_TO_RUN: Record<string, string> = {
  not_enriched: 'Every row here has been run already. Pick other rows to run.',
  no_result: 'Every row here has a result already.',
  failed: 'No rows here failed.',
};

export async function prepareWaterfallStart(
  userId: string, sheetId: string, input: WaterfallRunInput,
): Promise<{ ok: PreparedWaterfall } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const columns = getSheetColumns(sheetId, userId, false);
  const span = sheetRowSpan(sheetId, userId);
  if (span.count === 0) return bad('There are no rows to run on.');
  let prior: WaterfallRunConfig | null = null;
  if (input.continueColumn) {
    const run = newestWaterfallRun(sheetId, userId, input.columnName);
    if (!run) return bad(`"${input.columnName}" isn't a waterfall column.`);
    if (run.active && !input.dry) {
      return {
        fail: 'conflict', message: autorunFillingColumn(sheetId, userId, input.columnName)
          ?? 'A run on this column is still active. Wait for it to finish, or stop it first.',
      };
    }
    prior = run.config;
  }
  if (input.rows.mode === 'selected' && !input.rows.rowIndexes?.length) return bad('Select some rows first.');
  const rule = checkRunRule(sheetId, userId, input.runIf);
  if ('error' in rule) return bad(rule.error);
  const inScope = await rowsInScope(sheetId, userId, input, span.count, rule.ok);
  if (inScope === 0 && !input.dry) {
    const why = rule.ok ? 'No rows here pass "Only run if". Pick other rows to run.'
      : NOTHING_TO_RUN[input.rows.status] ?? 'There are no rows to run on.';
    return { ...bad(why), nothingToRun: true };
  }
  const upperBound = Math.min(input.rows.test ?? inScope, inScope);
  const built = await buildWaterfall(input, {
    userId, sheetId, columns, sample: sampleRows(sheetId, userId), rowsUpperBound: upperBound,
  });
  if ('fail' in built) return built;
  const { mapping, stepNames } = namesFor(input, built.ok, prior);
  // Names: the result column new (or the one continued), its outputs clear of every other column.
  const v = validateHttpRunColumns(sheetId, userId, mapping, input.columnName, false);
  if (!v.ok) return bad(v.error!);
  const resultColumn = v.sanitizedMaster!;
  const outputs = mapping.map((m, i) => ({ ...m, columnName: v.sanitizedMappingColumns![i] }));
  // A new waterfall's columns are all new; a continued one may reuse its own.
  const own = new Set(prior ? [resultColumn, ...prior.responseMapping.map(m => m.columnName)] : []);
  const others = columns.filter(c => !own.has(c));
  for (const name of [resultColumn, ...outputs.map(o => o.columnName)]) {
    if (own.has(name)) continue;
    const clash = findColumnNameCollision(name, others);
    if (clash) return bad(columnCollisionMessage(name, clash));
  }
  const sanitized = new Map(mapping.map((m, i) => [m.columnName, v.sanitizedMappingColumns![i]]));
  const newColumns = [resultColumn, ...outputs.map(o => o.columnName)].filter(c => !columns.includes(c));
  const body = JSON.stringify(built.ok.inputMap);
  const requestConfig: HTTPRequestConfig = { method: 'POST', url: '', headers: {}, body };
  const config: WaterfallRunConfig = {
    requestConfig, responseMapping: outputs, previewSize: 5,
    ...(input.concurrency !== null ? { batchSize: input.concurrency } : {}),
    ...(rule.ok ? { runIf: rule.ok.rule } : {}),
    waterfall: built.ok.block,
  };
  return {
    ok: {
      resultColumn, outputs, newColumns, config, built: built.ok, columns, span, upperBound, rule: rule.ok,
      hideColumns: input.hideStepColumns ? stepNames.map(n => sanitized.get(n) ?? n) : [],
    },
  };
}
