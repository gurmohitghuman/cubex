// The words a run writes into a cell instead of data (pure): still filling
// (⏳), failed (❌), found nothing or skipped (⏭️), adding rows elsewhere (➕).
// They're Cubex's words, not values: as an input (auto-run), in an "Only run
// if" rule or as a copied value, a cell holding one reads as empty.
export const FAILED_MARK = '❌';
export const SKIPPED_MARK = '⏭️';
// A list job's row whose results are on their way to another sheet (never ⏳).
export const LIST_MARK = '➕';
// A run's placeholder ('⏳ Processing...', lib/placeholder-cells.ts) starts with it.
export const RUNNING_MARK = '⏳';
// A row an "Only run if" rule kept out of a run (lib/run-condition.ts). It
// counts as not run yet: a later run or auto-run takes the row once it passes.
export const CONDITION_NOT_MET = '⏭️ Condition not met';

// What counts as blank around a status cell: the same set in the seeding check
// and in the SQL count (TRIM(cell, BLANK_CHARS)), so the two never disagree.
export const BLANK_CHARS = ' \t\n\r\u00a0';
const BLANK_EDGES = /^[ \t\n\r\u00a0]+|[ \t\n\r\u00a0]+$/g;
export const trimBlank = (s: string): string => s.replace(BLANK_EDGES, '');

export function holdsRunMarker(value: string): boolean {
  const t = trimBlank(value);
  return [RUNNING_MARK, FAILED_MARK, SKIPPED_MARK, LIST_MARK].some(m => t.startsWith(m));
}

// A cell an "Only run if" rule left: the row hasn't been run.
export const isConditionNotMet = (value: string | undefined): boolean => trimBlank(value ?? '') === CONDITION_NOT_MET;

// A cell "⏭️ Condition not met" may replace: empty, still filling (⏳), failed
// (❌) or already kept out. Any other result stays, "⏭️ Not found" included:
// some providers bill a miss, and a row marked as not run would be paid again.
export function takesConditionMark(value: string | undefined): boolean {
  const t = trimBlank(value ?? '');
  return t === '' || t.startsWith(RUNNING_MARK) || t.startsWith(FAILED_MARK) || t === CONDITION_NOT_MET;
}
