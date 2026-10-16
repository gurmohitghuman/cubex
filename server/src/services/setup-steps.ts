// A sheet's filled columns as setup steps (setup-save.ts): each AI, HTTP API
// and enrichment column from its newest run, each clean and formula column
// from its record, with auto-run as it is on the column. Reads only what the
// sheet lists (column_order), and one newest run per column, never every run.
// A column that can't go in a setup says why (problem). An AI column renamed
// since its run gets back the name its run makes ("Score (Output)"): renames
// says which, so the steps reading it are written against that name.
import { db } from '../lib/db';
import { getColumnTypes } from '../lib/column-types';
import { getSheetColumns } from '../lib/sql-helpers';
import { aiRunDataColumn } from '../lib/ai-data-column';
import { isEnrichmentConfig, listOf } from '../lib/enrich-run-config';
import { recallChoices } from '../lib/enrich-run-recall';
import { ruleFromConditions } from '../lib/run-condition';
import { goneColumnsOf } from '../lib/template-token-match';
import { sheetCleanColumns } from '../lib/clean-columns';
import { sheetFormulaColumns } from '../lib/formula-columns';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import type { OutputColumnSpec } from '../lib/ai-multi-output';
import { stepColumns, type AiStep, type AutoRunSpec, type SetupStep, type StepKind } from '../lib/setups/spec';
import { entryFor, newestRunOf, whereOf } from './autorun-entry';

export interface Candidate {
  kind: StepKind;
  columns: string[];                  // the columns it made, as the sheet names them now (main first)
  step: SetupStep | null;             // null when it can't go in a setup
  problem: string | null;
  renames: Array<[string, string]>;   // sheet name → the name the step makes
}

interface AiRunRow {
  column_name: string; prompt: string; system_prompt: string | null; model: string | null; temperature: number | null;
  max_chars: number | null; concurrency: number | null; use_openrouter_web_search: number; use_web_fetch: number;
  output_columns: string | null; data_column: string | null; web_search_engine: string | null;
  web_search_mode: string | null; web_search_max_per_row: number | null; run_if: string | null;
}

function autoRunOf(sheetId: string, userId: string, column: string): AutoRunSpec | null {
  const e = entryFor(sheetId, userId, column);
  if (!e?.enabled) return null;
  return {
    runIf: e.run_if ?? ruleFromConditions(whereOf(e)),
    dailyCapUsd: e.daily_cap_micro === null ? null : e.daily_cap_micro / 1e6,
    dailyRowCap: e.daily_row_cap,
  };
}

const followOn = (sheetId: string, userId: string, column: string) => !!entryFor(sheetId, userId, column)?.enabled;

function aiCandidate(run: AiRunRow, listed: Set<string>): Candidate {
  let outputs: OutputColumnSpec[] | null = null;
  try { outputs = run.output_columns ? JSON.parse(run.output_columns) : null; } catch { /* below */ }
  if (run.output_columns && !Array.isArray(outputs)) {
    return { kind: 'ai', columns: [run.column_name], step: null, problem: 'Its setup is damaged.', renames: [] };
  }
  const suffix = outputs?.length ? ' (Status)' : ' (Output)';
  const name = run.column_name.endsWith(suffix) ? run.column_name.slice(0, -suffix.length) : run.column_name;
  const webSearch = !!run.use_openrouter_web_search;
  const step: AiStep = {
    kind: 'ai', name, prompt: run.prompt, systemPrompt: run.system_prompt, model: run.model,
    temperature: run.temperature ?? 0.7, maxChars: run.max_chars, concurrency: run.concurrency,
    webSearch, webFetch: !!run.use_web_fetch,
    search: webSearch
      ? { engine: run.web_search_engine ?? 'auto', mode: run.web_search_mode, maxPerRow: run.web_search_max_per_row }
      : null,
    outputColumns: outputs?.length ? outputs.map(o => ({ ...o })) : null, runIf: run.run_if,
  };
  const data = aiRunDataColumn(run);
  const actual = [run.column_name, ...(outputs ?? []).map(o => o.columnName), ...(data ? [data] : [])];
  const made = stepColumns(step);
  // Made in the step's order: main, outputs, data (the actual list's order too).
  const renames = actual.map((c, i) => [c, made[i]] as [string, string]).filter(([a, b]) => b && a !== b);
  return { kind: 'ai', columns: actual.filter(c => listed.has(c)), step, problem: null, renames };
}

function httpCandidate(sheetId: string, userId: string, master: string, listed: Set<string>): Candidate | null {
  const run = newestRunOf(sheetId, userId, master);
  let config: HTTPAPIConfig | null = null;
  try { config = JSON.parse(run?.config ?? 'null'); } catch { /* below */ }
  if (!config?.requestConfig || !Array.isArray(config.responseMapping)) return null;
  const columns = [master, ...config.responseMapping.map(m => m.columnName)].filter(c => listed.has(c));
  const fail = (kind: StepKind, problem: string): Candidate => ({ kind, columns, step: null, problem, renames: [] });
  const gone = goneColumnsOf(config.requestConfig);
  const autoRun = autoRunOf(sheetId, userId, master);
  if (isEnrichmentConfig(config)) {
    if (listOf(config)) return fail('enrichment', 'It adds rows to another sheet, which a setup can\'t do yet.');
    const { columnName: _c, list: _l, ...choices } = recallChoices(config, master);
    return { kind: 'enrichment', columns, step: { kind: 'enrichment', name: master, ...choices, autoRun },
      problem: null, renames: [] };
  }
  if (gone.length) return fail('http', `Its request reads ${gone[0]}, which was deleted. Edit the column first.`);
  const rc = config.requestConfig;
  return {
    kind: 'http', columns, problem: null, renames: [],
    step: {
      kind: 'http', name: master,
      request: { method: rc.method, url: rc.url, headers: { ...(rc.headers ?? {}) }, body: rc.body ?? null,
        timeout: rc.timeout ?? null },
      mappings: config.responseMapping.map(m => ({ jsonPath: m.jsonPath, columnName: m.columnName })),
      batchSize: config.batchSize ?? null, runIf: config.runIf ?? null, autoRun,
    },
  };
}

export function sheetCandidates(sheetId: string, userId: string): Candidate[] {
  const listed = new Set(getSheetColumns(sheetId, userId, false));
  const types = getColumnTypes(sheetId, userId);
  const out: Candidate[] = [];
  // One newest run per AI column (MAX(rowid) is the newest insert).
  const aiRuns = db.prepare(`SELECT * FROM ai_runs WHERE rowid IN (
    SELECT MAX(rowid) FROM ai_runs WHERE sheet_id = ? AND user_id = ? GROUP BY column_name)`)
    .all(sheetId, userId) as AiRunRow[];
  for (const run of aiRuns) if (listed.has(run.column_name)) out.push(aiCandidate(run, listed));
  for (const [column, type] of Object.entries(types)) {
    if ((type !== 'http-master' && type !== 'enrich-status') || !listed.has(column)) continue;
    const c = httpCandidate(sheetId, userId, column, listed);
    if (c) out.push(c);
  }
  for (const rec of sheetCleanColumns(sheetId, userId)) {
    if (!listed.has(rec.column_name)) continue;
    let options: Record<string, unknown> = {};
    try { options = JSON.parse(rec.options) ?? {}; } catch { /* the cleaner's defaults */ }
    out.push({ kind: 'clean', columns: [rec.column_name], problem: null, renames: [], step: {
      kind: 'clean', name: rec.column_name, source: rec.source_column, cleaner: rec.cleaner, options,
      autoRun: followOn(sheetId, userId, rec.column_name),
    } });
  }
  for (const rec of sheetFormulaColumns(sheetId, userId)) {
    if (!listed.has(rec.column_name)) continue;
    out.push({ kind: 'formula', columns: [rec.column_name], problem: null, renames: [], step: {
      kind: 'formula', name: rec.column_name, formula: rec.formula, description: rec.description,
      autoRun: followOn(sheetId, userId, rec.column_name),
    } });
  }
  return out;
}
