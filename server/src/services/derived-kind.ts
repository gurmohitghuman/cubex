// Derived columns: a column filled for free from other columns of its own row,
// then kept current by auto-run, which follows the inputs. Clean data columns
// (clean-kind.ts: one source, a cleaner), formula columns (formula-kind.ts:
// the columns a formula reads, the sandbox) and lookup columns (lookup-kind.ts:
// one source, matched against another sheet) are the kinds. The fill
// (derived-fill.ts), the cell writer (derived-write.ts) and auto-run's follow
// (derived-follow.ts) are one implementation for both, given a kind.
import type { DerivedCounts } from './derived-write';

export type DerivedKindId = 'clean' | 'formula' | 'lookup';

export interface DerivedRecord {
  id: string; user_id: string; sheet_id: string; column_name: string;
  fill_status: 'filling' | 'done' | 'failed'; fill_cursor: number;
}

// One row's cell ('' empties it). filled: it holds a result. flag: the row had
// something the kind couldn't use (a value the cleaner couldn't read, the
// formula's error), counted and, the first time, kept with the row number.
export interface DerivedCell { value: string; filled: boolean; flag?: string }

// One pass over one setup: a fill, a follow tick, a preview.
export interface DerivedPass {
  // The cells of the first rows, from each row's input cells (as stored, in
  // the kind's inputs order): as many as fit budgetMs (at least one), or none
  // when the pass can't go on until prepare() (the slice ends there).
  compute(rows: unknown[][], budgetMs: number): DerivedCell[];
  // Before each slice, outside its transaction (a formula's sandbox reopens).
  prepare(): Promise<void>;
  // Why the pass must stop for good (a formula too slow), else null.
  failure(): string | null;
  // How auto-run pauses when failure() says so (default 'too_slow'): 'setup'
  // when the column's own setup can't work any more (a lookup's sheet deleted).
  failureReason?: 'too_slow' | 'setup';
  // The pass can't go on now but will by itself later (a lookup: the other
  // sheet is sorting, or a run is filling a column it reads): what it waits
  // for, and a check that turns true once it can go on. A fill frees its sheet
  // meanwhile (derived-fill.ts); auto-run comes back later.
  waiting?(): DerivedWait | null;
  dispose(): void;
}

export interface DerivedWait { note: string; ready: () => boolean }

// What a pass is for: a fill goes until done; auto-run's tick and a preview are short.
export type DerivedUse = 'fill' | 'follow' | 'preview';

export interface DerivedKind<R extends DerivedRecord = DerivedRecord> {
  id: DerivedKindId;              // also its auto-run entries' kind
  table: 'clean_columns' | 'formula_columns' | 'lookup_columns';
  busy: string;                   // what the busy sheet is doing, for busyMessage
  noun: string;                   // in logs
  load(id: string): R | undefined;
  forColumn(sheetId: string, userId: string, column: string): R | undefined;
  inputs(rec: R): string[];
  // Still the same setup (a fill or follow started on `a` stops when it changed).
  sameSetup(a: R, b: R): boolean;
  // A pass for this setup, or why there can't be one (the fill ends failed).
  open(rec: R, use: DerivedUse): Promise<DerivedPass | { error: string }>;
  // Inside a fill slice's transaction: the cursor (a rowid) and the slice's counts.
  advance(rec: R, cursor: number, counts: DerivedCounts): void;
}
