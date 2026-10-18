// Which rows an enrichment run takes (pure), decided while its ⏳ placeholders
// are seeded: on a column a run already made, the rows whose status cell fits
// (not enriched yet, without a result, failed, or any), rows passing every
// "Only run if" condition, and rows that have the inputs. A row without its
// inputs gets no ⏳ and no status, so it reads as not run yet and a later run
// (or auto-run) picks it up once filled. services/enrich-row-count.ts counts
// the same statuses in SQL.
import { asNumber, foldText, numberPasses, textPasses } from './row-filter/ops';
import { buildRequest } from './enrich-request';
import { CONDITION_NOT_MET, FAILED_MARK, SKIPPED_MARK, trimBlank } from './run-markers';
import { rulePasses, type RuleNode } from './run-condition';
import { cellStatus } from './row-filter/cell-status';
import {
  inputTemplates, type EnrichCondition, type EnrichRowsStatus, type EnrichRunConfig,
} from './enrich-run-config';
import { isWaterfallConfig, type WaterfallRunConfig } from './waterfall/config';
import { waterfallRowCanRun } from './waterfall/rows';
import type { CompiledFilter } from './row-filter/sql';

// skip: not one of the rows asked for (another status). condition: asked
// for, but "Only run if" keeps it out (a full run marks it ⏭️ Condition not met).
export type SeedVerdict = 'run' | 'skip' | 'condition' | 'missing';

// The operators the drawer offers, read as every row condition reads them
// (lib/row-filter/ops.ts: text compares trim and ignore case; gt/lt need a
// number on both sides).
export function conditionPasses(data: Record<string, string>, c: EnrichCondition): boolean {
  const cell = data[c.column];
  if (c.op === 'gt' || c.op === 'lt') return numberPasses(c.op, asNumber(cell), asNumber(c.value));
  return textPasses(c.op, foldText(cell), foldText(c.value));
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
// stale: the row's result in the column is made from inputs that changed since
// (read in SQL by the caller, lib/run-inputs); it counts only on a result.
export function statusMatches(cell: string | undefined, status: EnrichRowsStatus, stale = false): boolean {
  const s = trimBlank(cell ?? '');
  const notEnriched = s === '' || s === CONDITION_NOT_MET;
  const outOfDate = stale && cellStatus(s, '', true) === 'out_of_date';
  if (status === 'not_enriched') return notEnriched;
  if (status === 'failed') return s.startsWith(FAILED_MARK);
  if (status === 'no_result') return s === '' || s.startsWith(FAILED_MARK) || s.startsWith(SKIPPED_MARK);
  if (status === 'out_of_date') return outOfDate;
  if (status === 'empty_or_out_of_date') return notEnriched || outOfDate;
  return true;
}

export interface SeedPlan<C extends EnrichRunConfig | WaterfallRunConfig = EnrichRunConfig> {
  statusColumn: string | null;     // the column a run already made (null: a new one)
  status: EnrichRowsStatus;        // which of its rows, by their status cell
  where: EnrichCondition[];
  rule: RuleNode | null;           // the run's "Only run if" rule
  config: C;                       // a waterfall takes a row when some step can run
  columns: string[];               // the sheet's column registry
  // The out-of-date check of statusColumn, read once before the run starts (the
  // setup its count and estimate were made with), for an out_of_date status.
  stale?: CompiledFilter | null;
}

// stale: the row's result in the status column is out of date (statusMatches).
export function seedVerdict(
  data: Record<string, string>, p: SeedPlan<EnrichRunConfig | WaterfallRunConfig>, stale = false,
): SeedVerdict {
  if (p.statusColumn !== null && !statusMatches(data[p.statusColumn], p.status, stale)) return 'skip';
  if (!passesRunConditions(data, p.where, p.rule)) return 'condition';
  if (isWaterfallConfig(p.config)) return waterfallRowCanRun(p.config, data, p.columns) ? 'run' : 'missing';
  const e = p.config.enrichment;
  const built = buildRequest(e.toolSnapshot, inputTemplates(p.config), data, {
    cleanDomains: e.cleanDomains, columns: p.columns,
  });
  // A value the tool can't take still runs: its row shows why (❌).
  return !built.ok && 'missing' in built ? 'missing' : 'run';
}
