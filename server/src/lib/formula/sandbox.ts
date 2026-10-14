// A formula as the API thread runs it: the one way a formula runs, in the
// formula worker's QuickJS (worker.ts, qjs.ts), never the server's own eval,
// Function or vm, and never in the browser. open() compiles it there (async:
// the worker may need starting); runRows() works out rows synchronously, as
// many as fit a time budget, with a wall-clock cap (host.ts). One sandbox
// serves one formula for one pass (a fill, an auto-run tick, a preview).
//
// When the worker is stopped (a row ran past the cap) or stops (its WASM
// instance broke), runRows answers `closed` until ensure() opens the formula
// again. The row it hung on is remembered and answered "took too long" next
// time without running it, so a pass always moves on, and that row counts as
// a runaway (the caller stops after a few: FORMULA_MAX_RUNAWAYS).
import { createHash } from 'crypto';
import { FORMULA_OPEN_CAP_MS, FORMULA_ROW_MS, FORMULA_WAIT_SLACK_MS } from '../constants-formula';
import type { FormulaOutcome, FormulaRow } from './cells';
import { formulaHost } from './host';
import { FormulaError, type CompiledFormula } from './refs';

const TOO_LONG: FormulaOutcome = { ok: false, error: 'The formula took too long', runaway: true };
const digest = (row: FormulaRow): string => createHash('sha1').update(JSON.stringify(row)).digest('base64');

let nextSid = 1;

export class FormulaSandbox {
  private readonly sid = nextSid++;
  private gen = -1;
  private readonly hung = new Set<string>();

  private constructor(private readonly compiled: CompiledFormula) {}

  // Throws FormulaError when the formula doesn't compile (QuickJS's message).
  static async open(compiled: CompiledFormula): Promise<FormulaSandbox> {
    const sandbox = new FormulaSandbox(compiled);
    await sandbox.ensure();
    return sandbox;
  }

  // Opens the formula in the worker unless it's open in the running one.
  async ensure(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = await formulaHost.ready();
      if (this.gen === gen) return;
      const r = formulaHost.request({
        op: 'open', sid: this.sid, source: this.compiled.source, usesLodash: this.compiled.usesLodash,
      }, FORMULA_OPEN_CAP_MS);
      if ('ok' in r) { this.gen = gen; return; }
      if ('error' in r) throw new FormulaError(r.error);
      if ('timedOut' in r) throw new FormulaError('The formula took too long to start.');
      // gone: the worker stopped meanwhile; start it again.
    }
    throw new Error('The formula engine could not start.');
  }

  // The outcomes of the first rows, in order: as many as fit budgetMs (at
  // least one), none when closed.
  runRows(rows: FormulaRow[], budgetMs: number): { outcomes: FormulaOutcome[]; closed: boolean } {
    if (rows.length === 0) return { outcomes: [], closed: false };
    if (this.gen !== formulaHost.gen) return { outcomes: [], closed: true };
    let send = rows;
    if (this.hung.size > 0) {
      const at = rows.findIndex(r => this.hung.has(digest(r)));
      if (at === 0) return { outcomes: [TOO_LONG], closed: false };
      if (at > 0) send = rows.slice(0, at);
    }
    const r = formulaHost.request(
      { op: 'run', sid: this.sid, rows: send, budgetMs }, budgetMs + FORMULA_ROW_MS + FORMULA_WAIT_SLACK_MS);
    if ('timedOut' in r) {
      this.hung.add(digest(send[r.timedOut >= 0 && r.timedOut < send.length ? r.timedOut : 0]));
      return { outcomes: [], closed: true };
    }
    if ('outcomes' in r) return { outcomes: r.outcomes, closed: false };
    return { outcomes: [], closed: true };
  }

  dispose(): void {
    if (this.gen === formulaHost.gen) formulaHost.post({ op: 'dispose', sid: this.sid });
    this.gen = -1;
  }
}
