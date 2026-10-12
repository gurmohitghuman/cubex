// Reading a sheet through an "Only run if" rule (lib/run-condition.ts): how
// many rows pass, the first ones that do (an estimate's or a preview's
// sample), and the first rows with their verdict (the rule box's check). Only
// the rule's own columns are read, a page at a time between requests, so a
// million-row sheet neither freezes the server nor sits in memory.
import { db } from '../lib/db';
import { jsonPath, parseRowData } from '../lib/sql-rows';
import { yieldToRequests } from '../lib/slices';
import { rulePasses, type RuleNode } from '../lib/run-condition';

const PAGE_ROWS = 10_000;

export interface RuleScan {
  considered: number;                 // rows looked at (the targets, or every row)
  passing: number;
  passingRows: number[];              // the first `keepPassing` passing row indexes
  firstRows: Array<{ rowIndex: number; values: Record<string, string>; passes: boolean }>;
}

export async function scanRule(args: {
  sheetId: string; userId: string; tree: RuleNode; columns: string[];
  targets?: number[] | null; keepPassing?: number; keepFirst?: number;
}): Promise<RuleScan> {
  const { sheetId, userId, tree, columns } = args;
  const keepPassing = args.keepPassing ?? 0, keepFirst = args.keepFirst ?? 0;
  const inTargets = args.targets ? new Set(args.targets) : null;
  const picks = columns.map(() => ', json_extract(data, ?)').join('');
  const page = db.prepare(`SELECT row_index${picks} FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ${PAGE_ROWS}`).raw();
  const paths = columns.map(jsonPath);
  const out: RuleScan = { considered: 0, passing: 0, passingRows: [], firstRows: [] };
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const rows = page.all(...paths, sheetId, userId, after) as unknown[][];
    for (const r of rows) {
      const rowIndex = r[0] as number;
      if (inTargets && !inTargets.has(rowIndex)) continue;
      const values: Record<string, string> = {};
      columns.forEach((c, i) => { values[c] = r[i + 1] == null ? '' : String(r[i + 1]); });
      const passes = rulePasses(tree, values);
      out.considered++;
      if (passes) {
        out.passing++;
        if (out.passingRows.length < keepPassing) out.passingRows.push(rowIndex);
      }
      if (out.firstRows.length < keepFirst) out.firstRows.push({ rowIndex, values, passes });
    }
    if (rows.length < PAGE_ROWS) return out;
    after = rows[rows.length - 1][0] as number;
    await yieldToRequests();
  }
}

// Whole rows, for a sample the scan picked.
export function rowsByIndex(
  sheetId: string, userId: string, indexes: number[],
): Array<{ rowIndex: number; data: Record<string, string> }> {
  if (indexes.length === 0) return [];
  const rows = db.prepare(`SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index IN (SELECT value FROM json_each(?)) ORDER BY row_index`)
    .all(sheetId, userId, JSON.stringify(indexes)) as Array<{ row_index: number; data: string }>;
  return rows.map(r => ({ rowIndex: r.row_index, data: parseRowData(r.data) }));
}
