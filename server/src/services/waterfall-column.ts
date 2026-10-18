// A waterfall column's newest run: what "Edit waterfall" opens with (every
// choice, recalled from its stored config), what the column menu's reruns and
// auto-run start from, and whether a run is active on it. A pure read.
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { waterfallColumns, waterfallConfigOf, type WaterfallRunConfig } from '../lib/waterfall/config';
import { inputSourcesOf } from '../lib/waterfall/inputs';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import type { StepInput } from '../lib/waterfall/input-steps';
import { entryFor } from './autorun-entry';
import { lookedInSheet } from './waterfall-build-lookup';
import type { RunFail } from './run-shared';

export interface ColumnRun {
  id: string; status: string; active: boolean; config: WaterfallRunConfig; allowSecrets: number;
}

// The column's newest run, when it is a waterfall (null: no run, or another kind).
export function newestWaterfallRun(sheetId: string, userId: string, column: string): ColumnRun | null {
  const row = db.prepare(`SELECT id, status, placeholder_work, config, allow_secrets FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(sheetId, userId, column) as
    { id: string; status: string; placeholder_work: string | null; config: string | null; allow_secrets: number } |
    undefined;
  const config = waterfallConfigOf(row?.config);
  if (!row || !config || config.waterfall.dry) return null;
  const active = ['pending', 'running', 'paused'].includes(row.status) || row.placeholder_work !== null;
  return { id: row.id, status: row.status, active, config, allowSecrets: row.allow_secrets };
}

// The choices a stored run was started with, as a start request (Edit
// waterfall, reruns, auto-run). Rows default to the ones not run yet.
export function recallInput(config: WaterfallRunConfig, column: string): WaterfallRunInput {
  const w = config.waterfall;
  const sources = inputSourcesOf(config);
  const cols = waterfallColumns(config);
  const steps: StepInput[] = w.steps.map(s => ({
    id: s.id, label: s.label, on: s.on, requires: s.requires, choices: s.choices, check: s.check?.choices ?? null,
  }));
  return {
    columnName: column, continueColumn: true, resultType: w.resultType, phone: w.phone ?? null,
    inputs: w.inputs.map(i => ({ key: i.key, label: i.label, source: sources[i.key] ?? null })),
    steps, answeredBy: cols.answeredBy !== null, hideStepColumns: w.hideStepColumns,
    rows: { mode: 'all', status: 'not_enriched', test: null, rowIndexes: null },
    runIf: config.runIf ?? null, spendLimitUsd: null, concurrency: config.batchSize ?? null, fresh: w.fresh,
    noReuse: false, rowGeneration: null, dry: null,
  };
}

export interface WaterfallSetup {
  input: WaterfallRunInput;
  columns: { answeredBy: string | null; steps: Record<string, string> };
  activeRunId: string | null;
  autoRun: boolean;
  toolNames: Record<string, string>;   // an enrichment step's tool, by step id, as the run froze it
  sheetNames: Record<string, string | null>;   // a lookup step's sheet, by step id, as it's named now (null: gone)
}

export function waterfallSetup(sheetId: string, userId: string, column: string): { ok: WaterfallSetup } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const run = newestWaterfallRun(sheetId, userId, column);
  if (!run) return { fail: 'not_found', message: `"${column}" isn't a waterfall column.` };
  const entry = entryFor(sheetId, userId, column);
  return {
    ok: {
      input: recallInput(run.config, column), columns: waterfallColumns(run.config),
      activeRunId: run.active ? run.id : null, autoRun: !!entry?.enabled,
      toolNames: Object.fromEntries(run.config.waterfall.steps
        .flatMap(s => (s.built.kind === 'enrichment' ? [[s.id, s.built.toolName]] : []))),
      sheetNames: Object.fromEntries(run.config.waterfall.steps.flatMap(s => {
        if (s.choices.kind !== 'lookup') return [];
        const sheet = lookedInSheet(s.choices.sheetId, userId);
        return [[s.id, 'name' in sheet ? sheet.name : null]];
      })),
    },
  };
}
