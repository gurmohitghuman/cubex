// A waterfall run's formulas (formula steps and formula checks): each opened
// once in this thread's formula worker (lib/formula/sandbox.ts: QuickJS, never
// the server's own eval) and worked out one row at a time with the formula
// column's per-row time cap. After FORMULA_MAX_RUNAWAYS rows ran out of time
// or memory the run is told (it pauses), as a formula column's fill stops.
import { FORMULA_MAX_RUNAWAYS, FORMULA_ROW_MS, WATERFALL_FORMULA_ROW_TRIES } from '../lib/constants';
import { FormulaSandbox } from '../lib/formula/sandbox';
import { formulaRow, type FormulaOutcome } from '../lib/formula/cells';
import type { CompiledFormula } from '../lib/formula/refs';

export class RunFormulas {
  private readonly open = new Map<string, Promise<FormulaSandbox>>();
  private runaways = 0;

  constructor(private readonly onTooSlow: (message: string) => void) {}

  // The formula's outcome on one row; values in compiled.inputs' order.
  async run(key: string, compiled: CompiledFormula, values: unknown[]): Promise<FormulaOutcome> {
    let opening = this.open.get(key);
    if (!opening) {
      opening = FormulaSandbox.open(compiled);
      this.open.set(key, opening);
      opening.catch(() => this.open.delete(key));
    }
    let sandbox: FormulaSandbox;
    try {
      sandbox = await opening;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), runaway: false };
    }
    const row = formulaRow(values);
    // The worker restarted (this row, or another row at once, ran past its cap): open the formula
    // again and ask again. A row that hung is answered "took too long" then (the sandbox remembers
    // it); one still not answered after a few tries counts as running away too.
    let outcome: FormulaOutcome | undefined;
    for (let tries = 0; tries < WATERFALL_FORMULA_ROW_TRIES && !outcome; tries++) {
      if (tries > 0) {
        try {
          await sandbox.ensure();
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error), runaway: false };
        }
      }
      const r = sandbox.runRows([row], FORMULA_ROW_MS);
      if (!r.closed) outcome = r.outcomes[0];
    }
    outcome ??= { ok: false, error: 'The formula took too long', runaway: true };
    if (!outcome.ok && outcome.runaway && ++this.runaways === FORMULA_MAX_RUNAWAYS) {
      this.onTooSlow(`A formula ran out of time or memory on ${FORMULA_MAX_RUNAWAYS} rows. Fix it, then resume.`);
    }
    return outcome;
  }

  dispose(): void {
    for (const opening of this.open.values()) opening.then(s => s.dispose(), () => {});
    this.open.clear();
  }
}

// A formula's text result as a yes or no: empty, "false", "0", "null" and "undefined" are no.
export const formulaPasses = (value: string): boolean =>
  !['', 'false', '0', 'null', 'undefined', 'nan'].includes(value.trim().toLowerCase());
