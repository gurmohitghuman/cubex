// When lookups must not match against a sheet (API thread: the busy map lives
// here). A derived column filling, or stored answers filling the column added
// from them, only writes cells: the sheet doesn't block lookups (a fill that
// reads a column being filled waits for that column alone:
// lookup-fill-wait.ts). Anything else holding the sheet (a sort, an import, a
// column rename or delete, a run writing its placeholders, removing
// duplicates) moves rows or keys: they wait.
import { sheetBusyWith } from '../lib/sheet-busy';
import { FIELD_FILLING } from '../lib/field-fill-columns';
import { CLEANING } from './clean-kind';
import { FORMULA_FILLING } from './formula-kind';

export const LOOKUP_FILLING = 'filling a lookup column';

const WRITES_CELLS = new Set([CLEANING, FORMULA_FILLING, LOOKUP_FILLING, FIELD_FILLING]);

export function lookupSheetBlocked(sheetId: string): string | null {
  const what = sheetBusyWith(sheetId);
  return what && !WRITES_CELLS.has(what) ? what : null;
}
