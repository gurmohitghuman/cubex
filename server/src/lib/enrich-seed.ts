// Which rows an enrichment run takes (pure), decided while its ⏳ placeholders
// are seeded: on a column a run already made, the rows whose status cell fits
// (not enriched yet, without a result, failed, or any), rows passing every
// "Only run if" condition, and rows that have the inputs. A row without its
// inputs gets no ⏳ and no status, so it reads as not run yet and a later run
// (or auto-run) picks it up once filled. services/enrich-row-count.ts counts
// the same statuses in SQL.
import { passesCondition, type TextConditionOp } from './row-conditions';
import { buildRequest } from './enrich-request';
import {
  inputTemplates, type EnrichCondition, type EnrichRowsStatus, type EnrichRunConfig,
} from './enrich-run-config';

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

// The status cell markers a run writes (lib/enrich-cells.ts): failed rows
// start with ❌, rows without an answer (not found, over budget) with ⏭️.
export const FAILED_MARK = '❌';
export const SKIPPED_MARK = '⏭️';
// A list job's row whose results are on their way to another sheet (never ⏳).
export const LIST_MARK = '➕';
// A run's placeholder ('⏳ Processing...', lib/placeholder-cells.ts) starts with it.
const RUNNING_MARK = '⏳';

// What counts as blank around a status cell: the same set in the seeding check
// here and in the SQL count (TRIM(cell, BLANK_CHARS)), so the two never disagree.
export const BLANK_CHARS = ' \t\n\r\u00a0';
const BLANK_EDGES = /^[ \t\n\r\u00a0]+|[ \t\n\r\u00a0]+$/g;
export const trimBlank = (s: string): string => s.replace(BLANK_EDGES, '');

// A cell holding a run's own word: still filling (⏳), found nothing (⏭️),
// failed (❌), or adding rows elsewhere (➕). Cubex's words, not data: as an
// input (auto-run) or a copied value it reads as empty.
export function holdsRunMarker(value: string): boolean {
  const t = trimBlank(value);
  return [RUNNING_MARK, FAILED_MARK, SKIPPED_MARK, LIST_MARK].some(m => t.startsWith(m));
}

export function statusMatches(cell: string | undefined, status: EnrichRowsStatus): boolean {
  const s = trimBlank(cell ?? '');
  if (status === 'not_enriched') return s === '';
  if (status === 'failed') return s.startsWith(FAILED_MARK);
  if (status === 'no_result') return s === '' || s.startsWith(FAILED_MARK) || s.startsWith(SKIPPED_MARK);
  return true;
}

export interface SeedPlan {
  statusColumn: string | null;     // the column a run already made (null: a new one)
  status: EnrichRowsStatus;        // which of its rows, by their status cell
  where: EnrichCondition[];
  config: EnrichRunConfig;
  columns: string[];               // the sheet's column registry
}

export function seedVerdict(data: Record<string, string>, p: SeedPlan): SeedVerdict {
  if (p.statusColumn !== null && !statusMatches(data[p.statusColumn], p.status)) return 'skip';
  if (!p.where.every(c => conditionPasses(data, c))) return 'skip';
  const e = p.config.enrichment;
  const built = buildRequest(e.toolSnapshot, inputTemplates(p.config), data, {
    cleanDomains: e.cleanDomains, columns: p.columns,
  });
  // A value the tool can't take still runs: its row shows why (❌).
  return !built.ok && 'missing' in built ? 'missing' : 'run';
}
