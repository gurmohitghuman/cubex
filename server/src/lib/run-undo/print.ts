// What a run last wrote into a cell, kept as a number in its undo journal
// (migration 041), and what an undo does with a cell (pure). A cell still
// holding what the run wrote goes back to its old value; one that changed
// since (a person's or an agent's edit, another run) stays as it is.
import { hash53 } from '../run-inputs/fingerprint';
import { CONDITION_NOT_MET, LIST_MARK, PLACEHOLDER, trimBlank } from '../run-markers';

// Small numbers for what runs write most, so a seeded journal stays short.
export const PRINT_EMPTY = 0;
export const PRINT_RUNNING = 1;
export const PRINT_NOT_MET = 2;
const RESERVED = 3;

export const isEmptyCell = (v: unknown): boolean => v === undefined || v === null || v === '';
// Text as SQLite keeps it: a lone surrogate half reads back as U+FFFD, one of them on newer Node and
// three (one per byte Node 22 writes) on Node 22, so any run of U+FFFD counts as one.
const wellFormed = (s: string): string =>
  ((s as string & { toWellFormed?: () => string }).toWellFormed?.() ?? s).replace(/\uFFFD+/g, '\uFFFD');

// A cell's print: its value as a run writes it (text) or as a row holds it.
export function cellPrint(v: unknown): number {
  if (isEmptyCell(v)) return PRINT_EMPTY;
  if (v === PLACEHOLDER) return PRINT_RUNNING;
  if (v === CONDITION_NOT_MET) return PRINT_NOT_MET;
  const h = hash53(typeof v === 'string' ? `s${wellFormed(v)}` : `j${JSON.stringify(v)}`);
  return h < RESERVED ? h + RESERVED : h;
}

// One journaled cell: its slot in the journal's columns, the value before the
// run (JSON; null: empty) and the print of what the run last wrote.
export type JournalCell = [slot: number, old: unknown, print: number];

// A ⏳ is never a value to go back to: a run that met one (a row its seeding
// missed) keeps the cell empty instead.
export const oldValueOf = (cell: JournalCell): unknown => (cell[1] === PLACEHOLDER ? null : cell[1]);

// An older list job's "➕ Adding N rows…": back only while that row's results
// are still on their way (lib/run-undo/restore.ts asks), or nothing would
// ever replace it.
export const isListWords = (v: unknown): boolean => typeof v === 'string' && trimBlank(v).startsWith(LIST_MARK);

const sameValue = (a: unknown, b: unknown): boolean =>
  (isEmptyCell(a) && isEmptyCell(b)) || JSON.stringify(a) === JSON.stringify(b);

// same: the cell already holds its old value (nothing to write); restore: it
// holds what the run wrote, or the empty cell the run's own clear left where
// its ⏳ was; skip: it changed since.
export type CellOutcome = 'same' | 'restore' | 'skip';
export function undoOutcome(current: unknown, cell: JournalCell, old: unknown = oldValueOf(cell)): CellOutcome {
  if (sameValue(current, old)) return 'same';
  const now = cellPrint(current);
  if (now === cell[2]) return 'restore';
  return cell[2] === PRINT_RUNNING && now === PRINT_EMPTY ? 'restore' : 'skip';
}
