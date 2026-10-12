// The "Only run if" rule a run start was given (lib/run-condition.ts), checked
// against the sheet's columns: null when there is none, else the rule in
// Cubex's own spelling plus what seeding needs. One check for every run kind
// and surface (drawer, /api/v1, MCP), so they refuse the same rules alike.
import { getSheetColumns } from '../lib/sql-helpers';
import { checkRule, RuleError, type CheckedRule } from '../lib/run-condition';
import type { RuleSeed } from '../lib/placeholder-rule-seed';

export type RuleCheck = { ok: CheckedRule | null } | { error: string };

export function checkRunRule(sheetId: string, userId: string, text: string | null | undefined): RuleCheck {
  if (text === null || text === undefined || text.trim() === '') return { ok: null };
  try {
    return { ok: checkRule(text, getSheetColumns(sheetId, userId, false)) };
  } catch (e) {
    if (e instanceof RuleError) return { error: `"Only run if": ${e.message}` };
    throw e;
  }
}

// What seeding needs: rows that fail get "⏭️ Condition not met" in `markColumn`.
export const ruleSeed = (rule: CheckedRule | null, markColumn: string): RuleSeed | null =>
  rule ? { tree: rule.tree, columns: rule.columns, markColumn } : null;

// A stored rule (a rerun's), checked again: a column it reads may be gone.
export function storedRule(sheetId: string, userId: string, text: string | null | undefined): RuleCheck {
  const checked = checkRunRule(sheetId, userId, text);
  return 'error' in checked
    ? { error: `${checked.error} Edit the rule, or run without it.` }
    : checked;
}

// What a /api/v1 or MCP start says about its rule.
export const runIfReply = (rule: string) => ({
  run_if: rule,
  run_if_note: 'target_rows counts the rows before the rule. Rows that fail it get "⏭️ Condition not met" and '
    + 'cost nothing; get_run_status counts them (condition_skipped_rows) and leaves them out of total_rows once '
    + 'the run has started.',
});
