// A formula's row in and its cell out (pure). In: each input cell's text, with
// a run's own words (⏳ ❌ ⏭️ ➕) read as empty, and the cells holding JSON (text
// starting with { or [, nested at most FORMULA_JSON_MAX_DEPTH deep) marked to
// be parsed inside the sandbox, so `{{Response}}.emails` is a list there. Out:
// the value, cleaned of control and bidi characters and cut to the cell cap.
// A row the formula couldn't work out reads "❌ <the error>", which anything
// reading the column (a formula, a rule, auto-run) sees as empty, like any
// run's ❌.
import { CELL_MAX_ENRICHMENT } from '../constants';
import { FORMULA_ERROR_CHARS, FORMULA_JSON_MAX_DEPTH } from '../constants-formula';
import { clampCellChars, stripControlChars } from '../csv-safety';
import { FAILED_MARK, holdsRunMarker } from '../run-markers';

// v: the input values in the formula's order; j: which of them to JSON.parse.
export interface FormulaRow { v: string[]; j: number[] }

// runaway: the row ran out of time or memory (the caller stops after a few).
export type FormulaOutcome =
  | { ok: true; value: string }
  | { ok: false; error: string; runaway: boolean };

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v));
const JSON_START = /^[ \t\n\r]*[[{]/;

// True when JSON-looking text nests at most `max` deep (strings skipped). It
// stops reading once past max.
export function jsonDepthWithin(s: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (inString) {
      if (c === 92) k++;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 123 || c === 91) { if (++depth > max) return false; }
    else if (c === 125 || c === 93) depth--;
  }
  return true;
}

export function formulaRow(cells: unknown[]): FormulaRow {
  const v: string[] = [];
  const j: number[] = [];
  cells.forEach((cell, i) => {
    const t = text(cell);
    const value = holdsRunMarker(t) ? '' : t;
    v.push(value);
    if (JSON_START.test(value) && jsonDepthWithin(value, FORMULA_JSON_MAX_DEPTH)) j.push(i);
  });
  return { v, j };
}

// The cell a row's outcome writes ('' = empty: the key is removed).
export function formulaCell(outcome: FormulaOutcome): string {
  if (outcome.ok) return clampCellChars(stripControlChars(outcome.value), CELL_MAX_ENRICHMENT);
  return clampCellChars(`${FAILED_MARK} ${stripControlChars(outcome.error)}`, FORMULA_ERROR_CHARS);
}
