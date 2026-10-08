import { db } from '../lib/db';
import { jsonPath } from '../lib/sql-helpers';
import { getRunStatusAndGen } from './http-runner-status';

// Writers shared by HTTP and enrichment rows (split out of http-row.ts).

// True if the worker no longer owns the run: paused, cancelled, gone, or a
// resume bumped the generation (see ai-runner for the race this closes).
export const shouldStopHttpRun = (runId: string, capturedGeneration: number): boolean => {
  const cur = getRunStatusAndGen(runId);
  if (cur === null) return true;
  if (cur.status === 'paused' || cur.status === 'cancelled') return true;
  return cur.generation !== capturedGeneration;
};

// Apply a {columnName: value} map to one row by building a single json_set call.
// Paths are precomputed via jsonPath() so dotted/bracketed column names work.
export const writeRowColumns = (
  sheetId: string, userId: string, rowIndex: number,
  values: Array<[string, string]>,
) => {
  if (values.length === 0) return;
  const setExprParts = values.map(() => `?, ?`).join(', ');
  const args: any[] = [];
  for (const [col, val] of values) args.push(jsonPath(col), val);
  args.push(sheetId, userId, rowIndex);
  db.prepare(`
    UPDATE rows SET data = json_set(data, ${setExprParts}),
                    updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND row_index = ?
  `).run(...args);
};
