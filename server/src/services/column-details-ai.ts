// Column details of AI columns. The run's main column carries its newest run's
// model, prompt and rule (one newest run per column, never every run); its
// output and "(Data)" columns name it. AI columns have no auto-run.
import { db } from '../lib/db';
import { runStatus } from '../lib/column-details';
import { aiRunDataColumn } from '../lib/ai-data-column';
import type { ColumnDetail } from '../lib/column-details';
import { promptReads } from '../lib/prompt';
import type { OutputColumnSpec } from '../lib/ai-multi-output';
import { parseJson, type DetailContext } from './column-details-context';

interface AiRunRow {
  id: string; column_name: string; prompt: string; model: string | null; status: string; setup_only: number;
  output_columns: string | null; data_column: string | null; use_openrouter_web_search: number;
  use_web_fetch: number; run_if: string | null;
}

function outputsOf(run: Pick<AiRunRow, 'output_columns'>): OutputColumnSpec[] {
  const list = parseJson(run.output_columns);
  return Array.isArray(list) ? list.filter((s): s is OutputColumnSpec => typeof s?.columnName === 'string') : [];
}

// A run's outputs and its "(Data)" column. Every shape a column's runs had,
// newest last: a rerun that changes the outputs leaves the older output columns
// in the sheet, still typed as AI (lib/column-types.ts), so they say which run made them.
interface ShapeRow {
  column_name: string; output_columns: string | null; data_column: string | null; use_openrouter_web_search: number;
}

export function describeAiColumns(ctx: DetailContext): Map<string, ColumnDetail> {
  const out = new Map<string, ColumnDetail>();
  const claims = (col: string, type: 'ai-output' | 'ai-data') => ctx.listed.has(col) && ctx.types[col] === type;
  const shapes = db.prepare(`SELECT column_name, output_columns, data_column, use_openrouter_web_search
    FROM ai_runs WHERE sheet_id = ? AND user_id = ?
    GROUP BY column_name, output_columns, data_column, use_openrouter_web_search ORDER BY MAX(rowid)`)
    .all(ctx.sheetId, ctx.userId) as ShapeRow[];
  for (const shape of shapes) {
    const main = shape.column_name;
    for (const o of outputsOf(shape)) {
      if (!claims(o.columnName, 'ai-output') || o.columnName === main) continue;
      const asks = o.description ? { asks_for: ctx.cut(o.columnName, o.description) } : {};
      out.set(o.columnName, {
        name: o.columnName, kind: 'ai', role: 'output', filled_by: main, fill: { type: o.type, ...asks },
      });
    }
    const data = aiRunDataColumn(shape);
    if (data && claims(data, 'ai-data')) out.set(data, { name: data, kind: 'ai', role: 'sources', filled_by: main });
  }
  // Each main column from its newest run (MAX(rowid) is the newest insert).
  const runs = db.prepare(`SELECT id, column_name, prompt, model, status, setup_only, output_columns, data_column,
      use_openrouter_web_search, use_web_fetch, run_if
    FROM ai_runs WHERE rowid IN (
      SELECT MAX(rowid) FROM ai_runs WHERE sheet_id = ? AND user_id = ? GROUP BY column_name)`)
    .all(ctx.sheetId, ctx.userId) as AiRunRow[];
  for (const run of runs) {
    const main = run.column_name;
    if (!claims(main, 'ai-output')) continue;
    const outputs = outputsOf(run);
    out.set(main, {
      name: main, kind: 'ai', role: outputs.length ? 'status' : 'answer',
      fill: {
        run_id: run.id, run_status: runStatus(run), model: run.model,
        prompt: ctx.cut(main, run.prompt ?? ''),
        ...(outputs.length ? { output_columns: outputs.map(o => o.columnName) } : {}),
        web_search: !!run.use_openrouter_web_search, web_fetch: !!run.use_web_fetch,
      },
      reads: promptReads(run.prompt ?? '', ctx.columns), auto_run: false, run_if: run.run_if,
    });
  }
  return out;
}
