// A column something reads that a run holds (lib/run-locked-columns.ts, with clearing: a run still going on
// it, or a stopped or failed one putting back what its ⏳ cells held): which one, and how. A start refused
// for it carries it (services/run-shared.ts RunFail.held), so a setup's step waits for that column instead
// of failing (services/setup-runner.ts).
import { runHeldColumns, type RunHold } from './run-locked-columns';
import { heldReadWords } from './run-held-words';
import { ruleColumns } from './run-condition';

export interface HeldRead { column: string; hold: RunHold }
export type HeldRefusal = HeldRead & { message: string };

// The first of `reads` (null: a column that's gone) a run holds now, leaving out `own` (what the reader
// writes itself: its own run never holds it up).
// reads: called only when some column is held.
export function firstHeldRead(
  sheetId: string, userId: string, reads: () => Iterable<string | null>, own: readonly string[] = [],
): HeldRead | null {
  const held = runHeldColumns(sheetId, userId, { clearing: true });
  if (held.size === 0) return null;
  for (const column of reads()) {
    const hold = column === null || own.includes(column) ? undefined : held.get(column);
    if (column !== null && hold) return { column, hold };
  }
  return null;
}

// The refusal with the shared words (lib/run-held-words.ts). reader: what reads it, such as `The request`.
export const heldRefusal = (reader: string, read: HeldRead | null): HeldRefusal | null =>
  (read ? { ...read, message: heldReadWords(reader, read.column, read.hold) } : null);

// An "Only run if" rule (and an enrichment's older list of conditions) is judged on each row as its start
// seeds it: a held column's ⏳ would read as empty. rule: as checked (columns named exactly).
export function heldRuleRefusal(
  sheetId: string, userId: string, rule: string | null | undefined, conditionColumns: readonly string[] = [],
  own: readonly string[] = [],
): HeldRefusal | null {
  const reads = [...(rule ? ruleColumns(rule) : []), ...conditionColumns];
  if (reads.length === 0) return null;
  return heldRefusal('"Only run if"', firstHeldRead(sheetId, userId, () => reads, own));
}
