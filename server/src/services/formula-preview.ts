// A formula column's preview (a pure read: nothing is created or written): the
// first rows where an input holds a value, with what the formula gives for
// each, for the app's Formula dialog and an agent's formula_column preview. It
// runs the formula in the sandbox exactly as the fill would.
import { db } from '../lib/db';
import {
  DERIVED_SLICE_MS, FORMULA_PREVIEW_CELL_CHARS, FORMULA_PREVIEW_ROWS, FORMULA_PREVIEW_SCAN_ROWS,
} from '../lib/constants';
import { jsonPath } from '../lib/sql-rows';
import { checkFormulaInput, type FormulaColumnInput } from './formula-column';
import { openFormulaPass } from './formula-kind';
import { inputText } from './derived-write';
import type { RunFail } from './run-shared';

export interface FormulaPreviewSample {
  row: number;                       // row_index
  inputs: Record<string, string>;    // each cut to FORMULA_PREVIEW_CELL_CHARS
  result: string;                    // the cell the fill would write ('' = empty)
  error: string | null;              // the formula's error on this row
}

export interface FormulaPreview {
  column: string | null;   // the formula column's name, when given
  existing: boolean;       // it is a formula column already: saving works every row out again
  formula: string;         // as it will be saved: every {{reference}} naming its column exactly
  reads: string[];
  samples: FormulaPreviewSample[];
  stopped: string | null;  // the formula ran out of time or memory on the sample rows
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function previewFormulaColumn(
  userId: string, sheetId: string, input: FormulaColumnInput,
): Promise<{ ok: FormulaPreview } | RunFail> {
  const s = checkFormulaInput(userId, sheetId, input, { needColumn: false });
  if ('fail' in s) return s;
  const pass = await openFormulaPass(s.compiled.formula, s.compiled.inputs);
  if ('error' in pass) return { fail: 'bad_request', message: pass.error };
  try {
    const inputs = s.compiled.inputs;
    const cells = inputs.map((_, k) => `, json_extract(data, ?) AS in${k}`).join('');
    const scan = db.prepare(`SELECT row_index AS i${cells} FROM rows WHERE sheet_id = ? AND user_id = ?
      ORDER BY row_index LIMIT ?`)
      .iterate(...inputs.map(jsonPath), sheetId, userId, FORMULA_PREVIEW_SCAN_ROWS) as IterableIterator<
        Record<string, unknown>>;
    // The first rows where an input holds a value (a run's own words read as
    // empty, as the fill reads them); the scan stops once it has them.
    const picked: Array<{ row: number; values: unknown[] }> = [];
    for (const r of scan) {
      const values = inputs.map((_, k) => r[`in${k}`]);
      if (inputs.length > 0 && values.every(v => inputText(v) === '')) continue;
      picked.push({ row: r.i as number, values });
      if (picked.length >= FORMULA_PREVIEW_ROWS) break;
    }
    const samples: FormulaPreviewSample[] = [];
    for (let tries = 0; samples.length < picked.length && !pass.failure() && tries < picked.length + 2; tries++) {
      await pass.prepare();
      const rest = picked.slice(samples.length);
      const shown = (values: unknown[]) => Object.fromEntries(
        inputs.map((c, n) => [c, cut(inputText(values[n]), FORMULA_PREVIEW_CELL_CHARS)]));
      pass.compute(rest.map(p => p.values), DERIVED_SLICE_MS).forEach((out, k) => samples.push({
        row: rest[k].row, inputs: shown(rest[k].values),
        result: cut(out.value, FORMULA_PREVIEW_CELL_CHARS), error: out.flag ?? null,
      }));
    }
    return {
      ok: {
        column: s.column, existing: !!s.existing && !s.isNew, formula: s.compiled.formula, reads: inputs,
        samples, stopped: pass.failure(),
      },
    };
  } finally {
    pass.dispose();
  }
}
