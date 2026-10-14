// formula_column for agents: MCP and POST /api/v1/sheets/:id/formula-columns
// call this one function. preview reads only. Otherwise the column is created
// (or, naming a formula column already there, changed) and the answer waits
// for the fill up to FORMULA_WAIT_MS, so most sheets answer with their
// counts; a bigger one answers "filling" (get_sheet lists it in
// filling_columns until done).
import { FORMULA_WAIT_MS } from '../lib/constants';
import { strayKey } from '../lib/enrich-agent-args';
import { flagOf } from '../lib/enrich-agent-input';
import { waitForDerivedFill } from './derived-fill';
import { startFormulaColumn, type FormulaColumnInput } from './formula-column';
import { formulaKind } from './formula-kind';
import { previewFormulaColumn } from './formula-preview';
import { formulaColumnJson, formulaColumnView } from './formula-view';
import type { RunFail } from './run-shared';

export interface AgentFormulaArgs {
  column?: unknown; formula?: unknown; description?: unknown; auto_run?: unknown; preview?: unknown;
}
const KNOWN = ['column', 'formula', 'description', 'auto_run', 'preview'];

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const FILLING_NOTE = 'Still filling: its cells read "⏳ Processing..." until done. '
  + 'get_sheet lists it in filling_columns.';

export type AgentFormulaOutcome = { ok: Record<string, unknown>; created: boolean } | RunFail;

export async function agentFormulaColumn(
  userId: string, sheetId: string, a: AgentFormulaArgs,
): Promise<AgentFormulaOutcome> {
  const stray = strayKey(a as Record<string, unknown>, KNOWN, '');
  if (stray) return bad(`${stray} Nothing was changed.`);
  const preview = flagOf(a.preview), autoRun = flagOf(a.auto_run);
  if (preview === 'invalid' || autoRun === 'invalid') return bad('preview and auto_run must be true or false.');
  const input: FormulaColumnInput = { formula: a.formula, column: a.column, description: a.description, autoRun };
  if (preview) {
    const p = await previewFormulaColumn(userId, sheetId, input);
    if ('fail' in p) return p;
    return {
      created: false,
      ok: {
        preview: true, column: p.ok.column, formula: p.ok.formula, reads: p.ok.reads,
        changes_existing_column: p.ok.existing,
        samples: p.ok.samples.map(s => ({
          row_index: s.row, inputs: s.inputs, result: s.result, ...(s.error ? { error: s.error } : {}),
        })),
        ...(p.ok.stopped ? { stopped: p.ok.stopped } : {}),
        note: 'Nothing was written. Call again without preview to create the column.',
      },
    };
  }
  const started = await startFormulaColumn(userId, sheetId, input);
  if ('fail' in started) return started;
  const rec = await waitForDerivedFill(formulaKind, started.ok.id, FORMULA_WAIT_MS);
  if (!rec) return { fail: 'conflict', message: 'The formula column was removed while it filled.' };
  return {
    created: started.ok.created,
    ok: {
      ...formulaColumnJson(formulaColumnView(rec)), created: started.ok.created,
      ...(rec.fill_status === 'filling' ? { note: FILLING_NOTE } : {}),
    },
  };
}
