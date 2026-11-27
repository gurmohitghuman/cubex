import { db } from '../lib/db';
import { AI_ESTIMATE_SAMPLE_ROWS } from '../lib/constants-ai';
import { rulePasses, type CheckedRule } from '../lib/run-condition';
import { findUnknownColumnReferences, unknownRefsMessage } from '../lib/prompt';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { rowsByIndex, scanRule } from './run-condition-rows';
import { checkRuleOn, checkRunRule } from './run-rule';

// A setup call's items, priced without a sheet (setup-call-estimate.ts): its columns and its rows in the order sent,
// each as a sheet row holds it (a missing key is an empty cell).
export interface EstimateItems { columns: string[]; rows: Array<Record<string, string>> }
// Where an estimate's rows come from: a sheet, or a call's items (sheetId null).
export type EstimateRowsFrom = { sheetId: string; items?: undefined } | { sheetId: null; items: EstimateItems };

// The rows an AI estimate prices (run-estimate.ts), checked first as a run's start checks them: the prompt's column
// references, then its "Only run if" rule. count: the rows it would take; sample: a few of them for input tokens;
// skipped: the rows the rule keeps out.
export type EstimateRows = {
  columns: string[]; rule: CheckedRule | null; count: number; skipped: number; sample: Record<string, string>[];
};
type RowsFail = { fail: 'not_found' | 'bad_request'; message: string };
type RowsInput = EstimateRowsFrom & { prompt: string; runIf?: string | null; targetRowIndexes?: number[] };

export async function estimateRows(userId: string, input: RowsInput): Promise<EstimateRows | RowsFail> {
  if (input.sheetId === null) return itemRows(input.items, input.prompt, input.runIf);
  const { sheetId } = input;
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  // The same up-front refusal a real run makes: never price a prompt that
  // would substitute "[MISSING]" on every row (A9).
  const refsError = unknownPromptRefsError(sheetId, userId, input.prompt);
  if (refsError) return { fail: 'bad_request', message: refsError };
  const rule = checkRunRule(sheetId, userId, input.runIf);
  if ('error' in rule) return { fail: 'bad_request', message: rule.error };
  const rows = rule.ok
    ? await ruleRowsAndSample(sheetId, userId, rule.ok, input.targetRowIndexes)
    : { ...targetRowsAndSample(sheetId, userId, input.targetRowIndexes), skipped: 0 };
  return { columns: getSheetColumns(sheetId, userId, false), rule: rule.ok, ...rows };
}

// The same checks on a call's items, in memory: every item, or those its rule lets through.
function itemRows(items: EstimateItems, prompt: string, runIf: string | null | undefined): EstimateRows | RowsFail {
  const unknown = findUnknownColumnReferences(prompt, items.columns);
  if (unknown.length > 0) return { fail: 'bad_request', message: unknownRefsMessage(unknown) };
  const rule = checkRuleOn(() => items.columns, runIf);
  if ('error' in rule) return { fail: 'bad_request', message: rule.error };
  const tree = rule.ok?.tree;
  const passing = tree ? items.rows.filter(r => rulePasses(tree, r)) : items.rows;
  return {
    columns: items.columns, rule: rule.ok, count: passing.length, skipped: items.rows.length - passing.length,
    sample: passing.slice(0, AI_ESTIMATE_SAMPLE_ROWS),
  };
}

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
