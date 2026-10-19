// Column details of waterfall columns, from each result column's newest run
// (one query per result column). The result column carries the steps in order
// (an enrichment's tool, an AI step's model and prompt, an HTTP step's request
// with keys masked and header names only, a formula, a lookup step's sheet and
// columns), the run's caps, the input columns,
// auto-run and the rule; "answered by" and each step's column name it.
import { db } from '../lib/db';
import { maskUrlSecrets, runStatus, type ColumnDetail } from '../lib/column-details';
import { waterfallColumns, waterfallConfigOf, type WaterfallStep } from '../lib/waterfall/config';
import { inputSourcesOf } from '../lib/waterfall/inputs';
import { autoRunPart, nextRunRule, type DetailContext } from './column-details-context';
import { lookedInSheet } from './waterfall-build-lookup';

interface RunRow { id: string; status: string; setup_only: number; config: string | null }

function stepFill(ctx: DetailContext, column: string, s: WaterfallStep): Record<string, unknown> {
  const c = s.choices;
  const ch = s.check?.choices;
  const check = !ch ? {} : ch.kind === 'verify' ? { check: { kind: 'verify', accept: ch.accept } }
    : { check: { kind: 'formula', formula: ctx.cut(column, ch.formula) } };
  const base = { id: s.id, label: s.label, kind: c.kind, on: s.on, ...check };
  if (c.kind === 'enrichment') {
    const toolName = s.built.kind === 'enrichment' ? s.built.toolName : undefined;
    return { ...base, tool_id: c.toolId, ...(toolName ? { tool_name: toolName } : {}) };
  }
  if (c.kind === 'ai') {
    const model = s.built.kind === 'ai' ? s.built.model : c.model;
    return { ...base, model, prompt: ctx.cut(column, c.prompt), web_search: c.webSearch };
  }
  if (c.kind === 'http') {
    return {
      ...base, method: c.method, url: ctx.cut(column, maskUrlSecrets(c.url)), header_names: Object.keys(c.headers),
      value_path: c.valuePath,
    };
  }
  if (c.kind === 'formula') return { ...base, formula: ctx.cut(column, c.formula) };
  if (c.kind === 'lookup') {
    // The sheet's name now; null with why when it's deleted or in the trash (the step pauses its run).
    const other = lookedInSheet(c.sheetId, ctx.userId);
    return {
      ...base, other_sheet: 'name' in other ? other.name : null, ...('gone' in other ? { broken: other.gone } : {}),
      other_sheet_id: c.sheetId, match_column: c.matchColumn, match: c.mode, input: c.inputKey,
      return_column: c.returnColumn,
    };
  }
  return base;
}

export function describeWaterfallColumns(ctx: DetailContext): Map<string, ColumnDetail> {
  const out = new Map<string, ColumnDetail>();
  const newest = db.prepare(`SELECT id, status, setup_only, config FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  for (const column of ctx.columns) {
    if (ctx.types[column] !== 'waterfall') continue;
    const run = newest.get(ctx.sheetId, ctx.userId, column) as RunRow | undefined;
    const config = waterfallConfigOf(run?.config);
    if (!run || !config) { out.set(column, { name: column, kind: 'waterfall', role: 'answer' }); continue; }
    const w = config.waterfall;
    const reads = Object.values(inputSourcesOf(config))
      .flatMap(s => (s && 'column' in s && ctx.listed.has(s.column) ? [s.column] : []));
    out.set(column, {
      name: column, kind: 'waterfall', role: 'answer',
      fill: {
        run_id: run.id, run_status: runStatus(run), result_type: w.resultType,
        steps: w.steps.map(s => stepFill(ctx, column, s)),
        max_cost_per_row_usd: w.maxCostPerRowUsd, spend_limit_usd: w.spendLimitUsd,
      },
      reads: [...new Set(reads)], ...autoRunPart(ctx, column), run_if: nextRunRule(ctx, column, config),
    });
    const cols = waterfallColumns(config);
    if (cols.answeredBy && ctx.listed.has(cols.answeredBy)) {
      out.set(cols.answeredBy, { name: cols.answeredBy, kind: 'waterfall', role: 'answered_by', filled_by: column });
    }
    for (const s of w.steps) {
      const name = cols.steps[s.id];
      if (!name || !ctx.listed.has(name)) continue;
      out.set(name, {
        name, kind: 'waterfall', role: 'step', filled_by: column, fill: { step_id: s.id, step_label: s.label },
      });
    }
  }
  return out;
}
