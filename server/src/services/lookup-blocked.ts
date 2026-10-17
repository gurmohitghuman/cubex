// When lookups must not match against a sheet (API thread: the busy map lives
// here). A derived column filling only writes cells: lookups go on (two sheets
// looking each other up never wait on each other's fills). Anything else
// holding the sheet (a sort, an import, a column rename or delete, a run
// writing its placeholders, removing duplicates) moves rows or keys: they wait.
import { sheetBusyWith } from '../lib/sheet-busy';
import { CLEANING } from './clean-kind';
import { FORMULA_FILLING } from './formula-kind';

export const LOOKUP_FILLING = 'filling a lookup column';

export function lookupSheetBlocked(sheetId: string): string | null {
  const what = sheetBusyWith(sheetId);
  return what && what !== CLEANING && what !== FORMULA_FILLING && what !== LOOKUP_FILLING ? what : null;
}
