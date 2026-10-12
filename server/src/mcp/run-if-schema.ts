// The run_if argument every run-start tool (and set_auto_run) takes, described
// once so the tools teach the same rule language (lib/run-condition-parse.ts).
import { z } from 'zod';
import { MAX_RULE_CHARS } from '../lib/run-condition';

export const RULE_LANGUAGE = 'Rule language: {{Column}} is "x" | is not "x" | contains "x" | does not contain "x" '
  + '| is empty | is not empty | > 50 | < 50 | >= 50 | <= 50, joined with AND, OR, NOT and brackets (AND binds '
  + 'tighter than OR). Columns are named exactly, inside {{ }}. Text checks ignore case; >, < need a plain number in '
  + 'the cell; cells holding ⏳ ❌ ⏭️ ➕ (Cubex\'s own words) count as empty.';

export const runIfSchema = z.string().max(MAX_RULE_CHARS).optional().describe(
  '"Only run if": rows that fail this rule are not run, cost nothing, and show "⏭️ Condition not met" '
  + '(a real value an earlier run wrote is kept). ' + RULE_LANGUAGE
  + ' Example: ({{Industry}} is "SaaS" OR {{Industry}} is "Fintech") AND {{Employees}} > 50. '
  + 'CHAINS: give each next column a rule on the previous one\'s result, e.g. {{Fit (Output)}} is "yes", once '
  + 'that run has finished; rows the previous rule kept out count as empty, so they stay out too. Check a rule '
  + 'with check_run_condition (free), or have write_run_condition write one from plain words. Reruns of the '
  + 'column repeat its rule; estimate_only counts only the rows that pass.',
);
