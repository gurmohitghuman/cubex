// The rows a rerun of an AI or HTTP API column takes: the ones named, else
// those whose cell in its column passes the rerun's mode, among the sheet's
// first rows ("Run first rows") or a set of rows (a setup's test rows) when
// asked, else over the whole sheet a page at a time. keptOut: the column's
// "Only run if" rule, for a setup carrying the column on: a row the rule kept
// out ("⏭️ Condition not met") is taken only if the rule passes on it now, so
// a sheet whose rule keeps most rows out isn't asked about all of them again
// each time. Called inside the start's busy window, so no sort moves the rows
// between choosing them and seeding them.
import { db } from '../lib/db';
import { jsonPath } from '../lib/sql-rows';
import { yieldToRequests } from '../lib/slices';
import { existingRowIndexes } from '../lib/run-rows';
import { rulePasses, type CheckedRule } from '../lib/run-condition';
import { FAILED_MARK, RUNNING_MARK, isConditionNotMet } from '../lib/run-markers';
import type { RunFail } from './run-shared';

export interface RerunScope {
  rowIndices?: number[]; // exactly these rows (the ones that exist); wins over the rest
  firstRows?: number;    // only among the sheet's first rows, in row order
  withinRows?: number[]; // only among these rows
}

const PAGE_ROWS = 20_000;

// Calls `take` with each row the rerun takes, in row order.
async function eachTarget(
  sheetId: string, userId: string, column: string, keep: (value: unknown) => boolean, scope: RerunScope,
  keptOut: CheckedRule | null, take: (rowIndex: number) => void,
): Promise<void> {
  const ruleCols = keptOut?.columns ?? [];
  const paths = [column, ...ruleCols].map(jsonPath);
  const sel = paths.map(() => ', json_extract(data, ?)').join('');
  const passes = (r: unknown[]): boolean => {
    if (!keep(r[1])) return false;
    if (!keptOut || !isConditionNotMet(r[1] == null ? '' : String(r[1]))) return true;
    const values: Record<string, string> = {};
    ruleCols.forEach((c, i) => { values[c] = r[i + 2] == null ? '' : String(r[i + 2]); });
    return rulePasses(keptOut.tree, values);
  };
  const each = (rows: unknown[][]) => { for (const r of rows) if (passes(r)) take(r[0] as number); };
  if (scope.firstRows !== undefined) {
    return each(db.prepare(`SELECT row_index${sel} FROM rows WHERE sheet_id = ? AND user_id = ?
      ORDER BY row_index LIMIT ?`).raw().all(...paths, sheetId, userId, scope.firstRows) as unknown[][]);
  }
  if (scope.withinRows) {
    return each(db.prepare(`SELECT row_index${sel} FROM rows WHERE sheet_id = ? AND user_id = ?
      AND row_index IN (SELECT value FROM json_each(?)) ORDER BY row_index`).raw()
      .all(...paths, sheetId, userId, JSON.stringify(scope.withinRows)) as unknown[][]);
  }
  const page = db.prepare(`SELECT row_index${sel} FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    ORDER BY row_index LIMIT ?`).raw();
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const rows = page.all(...paths, sheetId, userId, after, PAGE_ROWS) as unknown[][];
    each(rows);
    if (rows.length < PAGE_ROWS) return;
    after = rows[rows.length - 1][0] as number;
    await yieldToRequests();
  }
}

export async function chooseRerunTargets(
  sheetId: string, userId: string, column: string, keep: (value: unknown) => boolean, scope: RerunScope,
  keptOut: CheckedRule | null = null,
): Promise<number[]> {
  if (scope.rowIndices?.length) return existingRowIndexes(sheetId, userId, scope.rowIndices);
  const out: number[] = [];
  await eachTarget(sheetId, userId, column, keep, scope, keptOut, i => { out.push(i); });
  return out;
}

// How many rows chooseRerunTargets would take, without holding them (an estimate).
export async function countRerunTargets(
  sheetId: string, userId: string, column: string, keep: (value: unknown) => boolean, scope: RerunScope,
  keptOut: CheckedRule | null = null,
): Promise<number> {
  let n = 0;
  await eachTarget(sheetId, userId, column, keep, scope, keptOut, () => { n++; });
  return n;
}

// An HTTP API column's 'missing' rows: its status cell empty, still ⏳, failed
// (❌) or left by its "Only run if" rule.
export function httpCellMissing(value: unknown): boolean {
  const v = ((value as string | null) || '').toString();
  return v.trim() === '' || v.includes(RUNNING_MARK) || v.startsWith(FAILED_MARK) || isConditionNotMet(v);
}

// No row is left for the rerun: a setup carrying a column on counts that as done.
export const NO_TARGET_ROWS: RunFail = {
  fail: 'bad_request', message: 'No target rows found to re-run', nothingToRun: true,
};
