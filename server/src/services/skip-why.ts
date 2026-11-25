// Why a "⏭️ Condition not met" cell didn't run ("Why didn't this row run?"): the column's "Only run if" rules (its
// newest run's, and its auto-run's own when it has one) checked against the row as it is now, each part that fails
// named in plain words (lib/run-condition-explain.ts). Free: no AI, a rule check on one row. A row that passes now
// (its cells changed since) says so: running it again would fill it.
import { db } from '../lib/db';
import { checkRule, ruleFromConditions, type RuleNode } from '../lib/run-condition';
import { ruleMisses } from '../lib/run-condition-explain';
import { getSheetColumns } from '../lib/sql-helpers';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import { entryFor, whereOf } from './autorun-entry';

// tree: the rule as checked; problem: why it can't be checked now (a column it reads is gone), as a run says it.
export type SkipRule = { rule: string; by: 'run' | 'auto_run' } & ({ tree: RuleNode } | { problem: string });
export interface SkipWhy {
  // Each rule the row fails now, with why; empty when it passes every rule now.
  rules: Array<{ rule: string; by: 'run' | 'auto_run'; why: string[] }>;
  passes_now: boolean;
}

// The rule text a run column's newest run keeps (an AI run's run_if; an HTTP API, enrichment or waterfall run's
// config.runIf, or an enrichment's older "conditions"); null when it has none.
function runRule(sheetId: string, userId: string, column: string): string | null {
  const ai = db.prepare(`SELECT run_if FROM ai_runs WHERE sheet_id = ? AND user_id = ?
    AND (column_name = ? OR status_column = ?) ORDER BY rowid DESC LIMIT 1`).get(sheetId, userId, column, column) as
    { run_if: string | null } | undefined;
  if (ai) return ai.run_if;
  const config = db.prepare(`SELECT config FROM http_runs WHERE rowid = (SELECT MAX(rowid) FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?)`).pluck().get(sheetId, userId, column) as
    string | null | undefined;
  let parsed: unknown = null;
  try { parsed = JSON.parse(config ?? 'null'); } catch { parsed = null; }
  const rule = (parsed as { runIf?: unknown } | null)?.runIf;
  if (typeof rule === 'string') return rule;
  return isEnrichmentConfig(parsed) ? ruleFromConditions(parsed.enrichment.rows.where) : null;
}

// The rules a column's rows are kept out by, parsed against the sheet's columns now. A rule that can't be checked
// (it names a column gone since) is kept with the reason its next run would refuse to start with.
export function columnSkipRules(sheetId: string, userId: string, column: string): SkipRule[] {
  const columns = getSheetColumns(sheetId, userId, false);
  const entry = entryFor(sheetId, userId, column);
  const texts: Array<{ text: string | null; by: SkipRule['by'] }> = [
    { text: runRule(sheetId, userId, column), by: 'run' },
    { text: entry ? entry.run_if ?? ruleFromConditions(whereOf(entry)) : null, by: 'auto_run' },
  ];
  const out: SkipRule[] = [];
  for (const t of texts) {
    if (!t.text || out.some(r => r.rule === t.text)) continue;
    try {
      const checked = checkRule(t.text, columns);
      out.push({ rule: checked.rule, by: t.by, tree: checked.tree });
    } catch (e) {
      const why = e instanceof Error ? e.message : 'It no longer reads.';
      out.push({ rule: t.text, by: t.by,
        problem: `This rule can't be checked: ${why} Edit the rule, or run without it.` });
    }
  }
  return out;
}

export function skipWhy(rules: readonly SkipRule[], data: Record<string, string>): SkipWhy {
  const failing = rules.map(r => ({ rule: r.rule, by: r.by,
    why: 'tree' in r ? ruleMisses(r.tree, data) : [r.problem] }))
    .filter(r => r.why.length > 0);
  return { rules: failing, passes_now: failing.length === 0 };
}

// For a read of many rows (read_rows include_status): each column's rules read once, the reasons of one cell.
export function skipExplainer(sheetId: string, userId: string) {
  const byColumn = new Map<string, SkipRule[]>();
  return (column: string, data: Record<string, string>): string[] => {
    let rules = byColumn.get(column);
    if (!rules) { rules = columnSkipRules(sheetId, userId, column); byColumn.set(column, rules); }
    const w = skipWhy(rules, data);
    return w.passes_now ? ['It passes "Only run if" now: run it again to fill it.'] : w.rules.flatMap(r => r.why);
  };
}
