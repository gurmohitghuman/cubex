// Which rows an enrichment run takes (pure), decided while its ⏳ placeholders
// are seeded: rows "not enriched yet" (an empty status cell) when it adds to an
// existing column, rows passing every "Only run if" condition, and rows that
// have the inputs. A row without its inputs gets no ⏳ and no status, so it
// reads as not run yet and a later run (or auto-run) picks it up once filled.
import { passesCondition, type TextConditionOp } from './row-conditions';
import { buildRequest } from './enrich-request';
import { inputTemplates, type EnrichCondition, type EnrichRunConfig } from './enrich-run-config';

export type SeedVerdict = 'run' | 'skip' | 'missing';

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

export interface SeedPlan {
  statusColumn: string | null;     // set: only rows whose status cell is empty
  where: EnrichCondition[];
  config: EnrichRunConfig;
  columns: string[];               // the sheet's column registry
}

export function seedVerdict(data: Record<string, string>, p: SeedPlan): SeedVerdict {
  if (p.statusColumn !== null && (data[p.statusColumn] ?? '').trim() !== '') return 'skip';
  if (!p.where.every(c => conditionPasses(data, c))) return 'skip';
  const e = p.config.enrichment;
  const built = buildRequest(e.toolSnapshot, inputTemplates(p.config), data, { cleanDomains: e.cleanDomains, columns: p.columns });
  // A value the tool can't take still runs: its row shows why (❌).
  return !built.ok && 'missing' in built ? 'missing' : 'run';
}
