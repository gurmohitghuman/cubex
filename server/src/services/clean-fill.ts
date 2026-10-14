// Filling a clean data column (clean_columns, migration 024): each row's
// source value, cleaned (lib/clean/), with no request and no cost. The fill
// itself is the derived columns' (derived-fill.ts): sliced, with the sheet
// busy, resumed at boot from its cursor.
import type { CleanColumnRow } from '../lib/clean-columns';
import { cleanKind } from './clean-kind';
import { resumeDerivedFills, runDerivedFill, waitForDerivedFill } from './derived-fill';

export { CLEANING } from './clean-kind';

// Runs (or resumes) the fill as the sheet's heavy operation; call inside it.
export const runCleanFill = (id: string): Promise<void> => runDerivedFill(cleanKind, id);

// At boot, before serving: every unfinished fill marks its sheet busy at once.
export const resumeCleanFills = (): void => resumeDerivedFills(cleanKind);

// An agent's answer waits for the fill, up to `ms`.
export const waitForCleanFill = (id: string, ms: number): Promise<CleanColumnRow | undefined> =>
  waitForDerivedFill(cleanKind, id, ms);
