// Which rows an enrichment run takes (pure), decided while its ⏳ placeholders
// are seeded: on a column a run already made, the rows whose status cell fits
// (not enriched yet, without a result, failed, or any), rows passing every
// "Only run if" condition, and rows that have the inputs. A row without its
// inputs gets no ⏳ and no status, so it reads as not run yet and a later run
// (or auto-run) picks it up once filled. services/enrich-row-count.ts counts
// the same statuses in SQL.
import { passesCondition, type TextConditionOp } from './row-conditions';
import { buildRequest } from './enrich-request';
import { CONDITION_NOT_MET, FAILED_MARK, SKIPPED_MARK, trimBlank } from './run-markers';
import { rulePasses, type RuleNode } from './run-condition';
import {
  inputTemplates, type EnrichCondition, type EnrichRowsStatus, type EnrichRunConfig,
} from './enrich-run-config';

// skip: not one of the rows asked for (another status). condition: asked
// for, but "Only run if" keeps it out (a full run marks it ⏭️ Condition not met).
export type SeedVerdict = 'run' | 'skip' | 'condition' | 'missing';

const asNumber = (raw: string | undefined): number | null => {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// The operators the drawer offers (row-selection.ts semantics: text compares
// trim and ignore case; gt/lt need a number on both sides).
export function conditionPasses(data: Record<string, string>, c: EnrichCondition): boolean {
  const cell = data[c.column];
  if (c.op === 'gt' || c.op === 'lt') {
    const a = asNumber(cell), b = asNumber(c.value);
    if (a === null || b === null) return false;
    return c.op === 'gt' ? a > b : a < b;
  }
  return passesCondition(cell, c.op as TextConditionOp, c.value);
}

// The status cell markers and blank rules live in lib/run-markers.ts (shared
// with "Only run if" rules); re-exported for the enrichment code that reads them.
export { FAILED_MARK, SKIPPED_MARK, LIST_MARK, BLANK_CHARS, trimBlank, holdsRunMarker } from './run-markers';

// Both "Only run if" forms: the older condition list (all must pass) and a rule.
export function passesRunConditions(
  data: Record<string, string>, where: EnrichCondition[], rule: RuleNode | null,
): boolean {
  return where.every(c => conditionPasses(data, c)) && (!rule || rulePasses(rule, data));
}

// A row "Only run if" kept out ("⏭️ Condition not met") was never enriched.
export function statusMatches(cell: string | undefined, status: EnrichRowsStatus): boolean {
  const s = trimBlank(cell ?? '');
  if (status === 'not_enriched') return s === '' || s === CONDITION_NOT_MET;
  if (status === 'failed') return s.startsWith(FAILED_MARK);
  if (status === 'no_result') return s === '' || s.startsWith(FAILED_MARK) || s.startsWith(SKIPPED_MARK);
  return true;
}

export interface SeedPlan {
  statusColumn: string | null;     // the column a run already made (null: a new one)
  status: EnrichRowsStatus;        // which of its rows, by their status cell
  where: EnrichCondition[];
  rule: RuleNode | null;           // the run's "Only run if" rule
  config: EnrichRunConfig;
  columns: string[];               // the sheet's column registry
}

export function seedVerdict(data: Record<string, string>, p: SeedPlan): SeedVerdict {
  if (p.statusColumn !== null && !statusMatches(data[p.statusColumn], p.status)) return 'skip';
  if (!passesRunConditions(data, p.where, p.rule)) return 'condition';
  const e = p.config.enrichment;
  const built = buildRequest(e.toolSnapshot, inputTemplates(p.config), data, {
    cleanDomains: e.cleanDomains, columns: p.columns,
  });
  // A value the tool can't take still runs: its row shows why (❌).
  return !built.ok && 'missing' in built ? 'missing' : 'run';
}
