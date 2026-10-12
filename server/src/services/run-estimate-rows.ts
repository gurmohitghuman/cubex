import { db } from '../lib/db';
import { AI_ESTIMATE_SAMPLE_ROWS } from '../lib/constants-ai';
import type { CheckedRule } from '../lib/run-condition';
import { rowsByIndex, scanRule } from './run-condition-rows';

// Target rows this run would touch: the subset, else all existing rows.
// Returns the count plus a small data sample for input-token averaging.
// targetRowIndexes come from resolveRowIdsToIndexes, so they already exist:
// only the sample is read (a sheet can hold a million rows).
export function targetRowsAndSample(
  sheetId: string, userId: string, targetRowIndexes: number[] | undefined,
): { count: number; sample: Record<string, string>[] } {
  if (targetRowIndexes && targetRowIndexes.length > 0) {
    const targets = [...new Set(targetRowIndexes)];
    const sampleIdx = targets.slice(0, AI_ESTIMATE_SAMPLE_ROWS);
    const sample = sampleIdx.length === 0 ? [] : (db.prepare(
      `SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index IN (${sampleIdx.map(() => '?').join(',')})`,
    ).all(sheetId, userId, ...sampleIdx) as Array<{ data: string }>).map(r => JSON.parse(r.data));
    return { count: targets.length, sample };
  }
  const count = (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?')
    .get(sheetId, userId) as { c: number }).c;
  const sample = (db.prepare(
    'SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index ASC LIMIT ?',
  ).all(sheetId, userId, AI_ESTIMATE_SAMPLE_ROWS) as Array<{ data: string }>).map(r => JSON.parse(r.data));
  return { count, sample };
}

// The same through an "Only run if" rule: only the rows that pass are counted
// and sampled (the rest cost nothing); `skipped` is how many the rule keeps out.
export async function ruleRowsAndSample(
  sheetId: string, userId: string, rule: CheckedRule, targetRowIndexes: number[] | undefined,
): Promise<{ count: number; skipped: number; sample: Record<string, string>[] }> {
  const scan = await scanRule({
    sheetId, userId, tree: rule.tree, columns: rule.columns,
    targets: targetRowIndexes && targetRowIndexes.length > 0 ? targetRowIndexes : null,
    keepPassing: AI_ESTIMATE_SAMPLE_ROWS,
  });
  const sample = rowsByIndex(sheetId, userId, scan.passingRows).map(r => r.data);
  return { count: scan.passing, skipped: scan.considered - scan.passing, sample };
}
