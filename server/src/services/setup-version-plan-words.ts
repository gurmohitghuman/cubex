// A restore plan's checks and words (services/setup-version-plan.ts): why a
// column's setup can't come back on this sheet, the columns a setup reads,
// and each column's note, saying what the restore does to it and how to fill
// it the restored way. Notes name the column menu's own items.
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { cleanerForRecord } from '../lib/clean/cleaners';
import { compileFormula, FormulaError } from '../lib/formula/refs';
import { promptReads } from '../lib/prompt';
import { requestColumns } from '../lib/autorun-rules';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import { KIND_WORDS, type ColumnKind, type Fill } from '../lib/setup-versions/spec';

export const listOf = (names: string[]): string => {
  const q = names.map(n => `"${n}"`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
};

// Why a fill can't be written back on this sheet, or null. columns: the
// sheet's columns once the restore has added its own back.
export function fillProblem(userId: string, sheetId: string, f: Fill, columns: string[]): string | null {
  const has = (c: string) => columns.includes(c);
  switch (f.kind) {
    case 'clean':
      if (!cleanerForRecord(f.cleaner, JSON.stringify(f.options))) {
        return `Its cleaner (${f.cleaner}) isn't one Cubex has.`;
      }
      return has(f.source) ? null : `It cleans "${f.source}", which isn't in the sheet.`;
    case 'formula':
      try { compileFormula(f.formula, columns); return null; } catch (e) {
        if (e instanceof FormulaError) return `Its formula doesn't work here now: ${e.message}`;
        throw e;
      }
    case 'lookup': {
      if (!has(f.source)) return `It reads "${f.source}", which isn't in the sheet.`;
      if (f.otherSheetId === sheetId || !verifySheetOwnership(f.otherSheetId, userId)) {
        return 'The sheet it looks in is gone (deleted or in the trash).';
      }
      const other = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?').pluck()
        .get(f.otherSheetId, userId) as string | null;
      const there = new Set<string>(JSON.parse(other || '[]'));
      const need = [f.matchColumn, ...(f.returnColumns ?? [])].filter(c => !there.has(c));
      return need.length ? `The sheet it looks in has no column "${need[0]}" now.` : null;
    }
    case 'http':
      if (f.destSheetId && !verifySheetOwnership(f.destSheetId, userId)) {
        return 'The sheet it adds rows to is gone (deleted or in the trash).';
      }
      return null;
    default:
      return null;
  }
}

// The sheet columns a setup reads (as its run resolves them).
export function fillReads(f: Fill, columns: string[]): string[] {
  switch (f.kind) {
    case 'ai': return promptReads(f.prompt, columns);
    case 'http': return requestColumns(f.config as HTTPAPIConfig, columns);
    case 'formula': try { return compileFormula(f.formula, columns).inputs; } catch { return []; }
    default: return [f.source];
  }
}

export const isFree = (f: Fill) => f.kind === 'clean' || f.kind === 'formula' || f.kind === 'lookup';
const MENU_ITEM: Record<'clean' | 'formula' | 'lookup', string> = {
  clean: 'Clean all rows again', formula: 'Work out every row again', lookup: 'Look up every row again',
};

// A column set up again whose cells were made the old way.
export function redoNote(f: Fill): string {
  if (f.kind === 'clean' || f.kind === 'formula' || f.kind === 'lookup') {
    return `Its cells still show results from the setup it had before. To redo them, choose ${MENU_ITEM[f.kind]} `
      + 'in its column menu (free).';
  }
  return 'Its cells still hold results from the setup it had before. To redo them with this setup, choose Force '
    + 'run all rows in its column menu (billed).';
}

// A column added back (empty); readers: the columns that read it.
export function addBackNote(f: Fill | null, readers: string[]): string | null {
  const then = readers.length
    ? ` Then run ${listOf(readers)} again: ${readers.length === 1 ? 'it reads' : 'they read'} this column.` : '';
  if (!f) {
    return readers.length ? `${listOf(readers)} ${readers.length === 1 ? 'reads' : 'read'} it: fill it in first, `
      + `then run ${readers.length === 1 ? 'it' : 'them'} again.` : null;
  }
  const fill = f.kind === 'clean' || f.kind === 'formula' || f.kind === 'lookup'
    ? `Fill it with ${MENU_ITEM[f.kind]} in its column menu (free).`
    : 'Fill it with Run empty or out-of-date rows in its column menu (billed).';
  return fill + then;
}

export const kindNote = (was: ColumnKind, now: ColumnKind): string =>
  `In this version it was ${KIND_WORDS[was]}. It's ${KIND_WORDS[now]} now, so restoring leaves it alone. To get `
  + "the version's column back, rename or delete this one, then restore again.";

// Why a column the version had one column fill can't be that column's now
// ("can't be added back", "is filled by "X" now", "is a formula column now").
export function notMineWhy(back: boolean, exists: boolean, nowKind: ColumnKind | undefined,
  nowBy: string | null | undefined): string {
  if (!exists && !back) return "can't be added back";
  if (nowKind === 'made') return `is filled by "${nowBy}" now`;
  return `is ${KIND_WORDS[nowKind ?? 'plain']} now`;
}
