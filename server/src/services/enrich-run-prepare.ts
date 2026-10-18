// The checks and the config of an enrichment run start, before anything is
// written (services/enrich-run-start.ts writes them in one transaction): the
// names, the column a run adds to, the rows in scope, the config built against
// treg's catalog and a list job's destination. A pure read (catalog reads are
// cached), so the agents' estimate_only checks exactly what a start would.
import { db } from '../lib/db';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { findColumnNameCollision, columnCollisionMessage } from '../lib/column-names';
import { validateHttpRunColumns } from '../lib/http-run-validate';
import { isEnrichmentConfig, type EnrichRunConfig } from '../lib/enrich-run-config';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import { sheetRowSpan } from './run-seed';
import { buildEnrichmentConfig } from './enrich-run-build';
import { countFor, enrichRowCounts } from './enrich-row-count';
import type { RunFail } from './run-shared';
import { autorunFillingColumn } from './autorun-block';
import { listRowsBeingAdded, planListStart } from './enrich-list-start';
import { manualListLoop } from './autorun-list';
import type { DestPlan } from './enrich-list-dest';
import { checkRunRule } from './run-rule';
import type { CheckedRule, RuleNode } from '../lib/run-condition';
import type { SeedPlan } from '../lib/enrich-seed';

export interface PreparedStart {
  statusColumn: string;
  outputNames: string[];
  config: EnrichRunConfig;
  listPlan: DestPlan | null;
  columns: string[];
  span: { count: number; lastRow: number };
  // The most rows the run can take (the test rows, else the rows in scope).
  upperBound: number;
  // The "Only run if" rule, checked against the sheet (null: none).
  rule: CheckedRule | null;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// Which rows the run takes (seeding's check, lib/enrich-seed.ts), as the start
// seeds them and the estimates count them.
export function seedPlanFor(input: EnrichRunInput, p: PreparedStart): SeedPlan {
  return {
    statusColumn: input.continueColumn ? p.statusColumn : null, status: input.rows.status,
    where: input.conditions, rule: p.rule?.tree ?? null, config: p.config, columns: p.columns,
  };
}

// The enrichment that owns `name` as its status column, if any.
function enrichmentColumnOwner(sheetId: string, userId: string, name: string): boolean {
  const runs = db.prepare(`SELECT config FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).all(sheetId, userId, name) as Array<{ config: string | null }>;
  return runs.some(r => { try { return isEnrichmentConfig(JSON.parse(r.config ?? 'null')); } catch { return false; } });
}

export function activeRunOn(sheetId: string, userId: string, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL) LIMIT 1`).get(sheetId, userId, name);
}

const ownOutputs = (sheetId: string, userId: string, statusColumn: string): Set<string> => new Set(db.prepare(
  `SELECT extracted_column_name FROM http_column_associations
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?`,
).pluck().all(sheetId, userId, statusColumn) as string[]);

// Adding to a column a run already made: it must be an enrichment column with
// no run active on it, and new output names may only clash with its own.
function continueProblem(
  sheetId: string, userId: string, statusColumn: string, outputNames: string[], columns: string[],
): RunFail | null {
  if (!enrichmentColumnOwner(sheetId, userId, statusColumn)) {
    return bad(`"${statusColumn}" isn't an enrichment column.`);
  }
  if (activeRunOn(sheetId, userId, statusColumn)) {
    return {
      fail: 'conflict', message: autorunFillingColumn(sheetId, userId, statusColumn)
        ?? 'A run on this column is still active. Wait for it to finish, or stop it first.',
    };
  }
  const adding = listRowsBeingAdded(sheetId, userId, statusColumn);
  if (adding) return { fail: 'conflict', message: adding };
  const own = ownOutputs(sheetId, userId, statusColumn);
  const others = columns.filter(c => c !== statusColumn && !own.has(c));
  for (const name of outputNames) {
    const clash = findColumnNameCollision(name, others);
    if (clash) return bad(columnCollisionMessage(name, clash));
  }
  return null;
}

const NOTHING_TO_RUN: Record<string, string> = {
  not_enriched: 'Every row here is enriched already. Pick other rows to run.',
  no_result: 'Every row here has a result already.',
  failed: 'No rows here failed.',
};

// How many rows the run can take at most (it sizes the default run limit):
// the rows in scope passing its "Only run if" conditions, counted by status on
// a column a run already made. Rows
// missing an input still count; seeding skips them.
async function rowsInScope(
  sheetId: string, userId: string, input: EnrichRunInput, statusColumn: string, all: number, rule: RuleNode | null,
): Promise<number> {
  const { mode, status, rowIndexes } = input.rows;
  const byStatus = input.continueColumn && status !== 'any';
  const where = input.conditions;
  if (!byStatus && mode !== 'filter' && where.length === 0 && !rule) {
    return mode === 'selected' ? rowIndexes?.length ?? 0 : all;
  }
  const scope = { mode, rowIndexes, where, rule };
  const counts = await enrichRowCounts(sheetId, userId, byStatus ? statusColumn : null, scope);
  return byStatus ? countFor(counts, status) : counts.total;
}

export async function prepareEnrichmentStart(
  userId: string, sheetId: string, input: EnrichRunInput,
): Promise<{ ok: PreparedStart } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const columns = getSheetColumns(sheetId, userId, false);
  const span = sheetRowSpan(sheetId, userId);
  if (span.count === 0) return bad('There are no rows to run on.');

  // Names: a new status column, or an existing enrichment column to add to.
  const mapping = input.outputs.map(o => ({ columnName: o.columnName, jsonPath: '$.x' }));
  const v = validateHttpRunColumns(sheetId, userId, mapping, input.columnName, !input.continueColumn);
  if (!v.ok) return bad(v.error!);
  const statusColumn = v.sanitizedMaster!;
  const outputNames = v.sanitizedMappingColumns!;
  if (input.continueColumn) {
    const problem = continueProblem(sheetId, userId, statusColumn, outputNames, columns);
    if (problem) return problem;
  }
  if (input.rows.mode === 'selected' && !input.rows.rowIndexes?.length) return bad('Select some rows first.');
  const rule = checkRunRule(sheetId, userId, input.runIf);
  if ('error' in rule) return bad(rule.error);
  const inScope = await rowsInScope(sheetId, userId, input, statusColumn, span.count, rule.ok?.tree ?? null);
  // Nothing left to run here (a setup carrying the column on counts it as done).
  if (inScope === 0 && (input.conditions.length || rule.ok)) {
    return { ...bad('No rows here pass "Only run if". Pick other rows to run.'), nothingToRun: true };
  }
  if (inScope === 0) {
    return { ...bad(NOTHING_TO_RUN[input.rows.status] ?? 'There are no rows to run on.'), nothingToRun: true };
  }
  const upperBound = Math.min(input.rows.test ?? inScope, inScope);

  const named = { ...input, outputs: input.outputs.map((o, i) => ({ ...o, columnName: outputNames[i] })) };
  const built = await buildEnrichmentConfig(named, columns, upperBound);
  if ('fail' in built) return built;
  const listPlan = planListStart(userId, sheetId, input, built.ok, columns);
  if ('fail' in listPlan) return listPlan;
  // The column's auto-run repeats its newest run: rows it adds must not come back here.
  const destSheetId = listPlan.ok?.sheetId;
  const loop = destSheetId ? manualListLoop(sheetId, userId, statusColumn, destSheetId) : null;
  if (loop) return loop;
  // Kept in the config in Cubex's spelling, so reruns and auto-run repeat it.
  if (rule.ok) built.ok.runIf = rule.ok.rule;
  return {
    ok: {
      statusColumn, outputNames, config: built.ok, listPlan: listPlan.ok, columns, span, upperBound, rule: rule.ok,
    },
  };
}
