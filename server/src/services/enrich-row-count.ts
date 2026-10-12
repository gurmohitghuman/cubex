// How many rows an enrichment run would take, by the status of its column:
// all of them, not enriched yet (empty, or "⏭️ Condition not met"), without a
// result (empty, ⏭️ or ❌) and failed (❌), for a scope (every row, the saved filter's rows, or the
// selected rows), and only rows passing the run's "Only run if" conditions.
// The same rules as lib/enrich-seed.ts statusMatches (and its blank
// characters). Rows missing an input are counted too: a run skips them
// at no cost. A count reads JSON from every row, about a second at a million
// rows, so it goes a range of row numbers at a time and lets other requests in
// between (lib/slices.ts), like the sliced jobs.
import { db } from '../lib/db';
import { HEAVY_SLICE_ROWS } from '../lib/constants';
import { jsonPath } from '../lib/sql-rows';
import { yieldToRequests } from '../lib/slices';
import { parseRowData } from '../lib/sql-helpers';
import { BLANK_CHARS, FAILED_MARK, SKIPPED_MARK, passesRunConditions, statusMatches } from '../lib/enrich-seed';
import { CONDITION_NOT_MET } from '../lib/run-markers';
import type { RuleNode } from '../lib/run-condition';
import type { EnrichCondition, EnrichRowsMode, EnrichRowsStatus } from '../lib/enrich-run-config';
import { rowFilterSql } from './enrich-rows-filter';

export interface EnrichRowCounts { total: number; notEnriched: number; noResult: number; failed: number }

// where / rule: the run's "Only run if" (the older condition list, the rule);
// rows failing them are left out (counted with the check seeding uses, so a
// row's JSON is read in each slice).
export interface CountScope {
  mode: EnrichRowsMode; rowIndexes: number[] | null; where?: EnrichCondition[]; rule?: RuleNode | null;
}

// Rows per counting slice: one scan of a million rows took about a second, so a
// slice holds the server for about 20 ms.
const COUNT_SLICE_ROWS = HEAVY_SLICE_ROWS * 4;

const generation = (sheetId: string, userId: string) => db.prepare(
  'SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?',
).pluck().get(sheetId, userId) as number | undefined;

// A sort moving rows mid-count (rows parked high) could count some twice; a
// count whose sheet's row_generation moved meanwhile is read again, once.
export async function enrichRowCounts(
  sheetId: string, userId: string, column: string | null, scope: CountScope,
): Promise<EnrichRowCounts> {
  const before = generation(sheetId, userId);
  const counts = await countOnce(sheetId, userId, column, scope);
  return generation(sheetId, userId) === before ? counts : countOnce(sheetId, userId, column, scope);
}

async function countOnce(
  sheetId: string, userId: string, column: string | null, scope: CountScope,
): Promise<EnrichRowCounts> {
  const filter = rowFilterSql(sheetId, userId, scope.mode);
  const selected = scope.mode === 'selected' ? ' AND row_index IN (SELECT value FROM json_each(?))' : '';
  const first = db.prepare('SELECT MIN(row_index) FROM rows WHERE sheet_id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as number | null;
  const out: EnrichRowCounts = { total: 0, notEnriched: 0, noResult: 0, failed: 0 };
  if (first === null) return out;
  // Slice edges come from the (sheet_id, user_id, row_index) index, so sparse
  // row numbers (rows parked high during a sort) still make even slices.
  const edge = db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index >= ?
    ORDER BY row_index LIMIT 1 OFFSET ?`).pluck();
  // The marks and blank set bind first (the SELECT list), then the
  // column path (the subquery's SELECT), then its WHERE.
  const rule = scope.rule ?? null;
  const where = scope.where?.length || rule ? scope.where ?? [] : null;
  const cell = column === null ? `''` : 'TRIM(COALESCE(json_extract(data, ?), \'\'), ?)';
  const read = db.prepare(`SELECT data FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index >= ? AND row_index < ?${filter.clause}${selected}`).pluck();
  const count = db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(s = '' OR s = ?), 0) AS not_enriched,
      COALESCE(SUM(s = '' OR instr(s, ?) = 1 OR instr(s, ?) = 1), 0) AS no_result,
      COALESCE(SUM(instr(s, ?) = 1), 0) AS failed
    FROM (SELECT ${cell} AS s FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index >= ? AND row_index < ?${filter.clause}${selected})
  `);
  const marks = [CONDITION_NOT_MET, FAILED_MARK, SKIPPED_MARK, FAILED_MARK];
  const head = [...marks, ...(column === null ? [] : [jsonPath(column), BLANK_CHARS])];
  const tail = [...filter.params, ...(selected ? [JSON.stringify(scope.rowIndexes ?? [])] : [])];
  for (let lo = first; ;) {
    const next = edge.get(sheetId, userId, lo, where ? HEAVY_SLICE_ROWS : COUNT_SLICE_ROWS) as number | undefined;
    const hi = next ?? Number.MAX_SAFE_INTEGER;
    if (where) {
      for (const raw of read.iterate(sheetId, userId, lo, hi, ...tail) as Iterable<string>) {
        const data = parseRowData(raw);
        if (!passesRunConditions(data, where, rule)) continue;
        const cellValue = column === null ? '' : data[column];
        out.total++;
        if (statusMatches(cellValue, 'not_enriched')) out.notEnriched++;
        if (statusMatches(cellValue, 'no_result')) out.noResult++;
        if (statusMatches(cellValue, 'failed')) out.failed++;
      }
    } else {
      const r = count.get(...head, sheetId, userId, lo, hi, ...tail) as {
        total: number; not_enriched: number; no_result: number; failed: number;
      };
      out.total += r.total; out.notEnriched += r.not_enriched; out.noResult += r.no_result; out.failed += r.failed;
    }
    if (next === undefined) return out;
    lo = next;
    await yieldToRequests();
  }
}

export function countFor(counts: EnrichRowCounts, status: EnrichRowsStatus): number {
  if (status === 'not_enriched') return counts.notEnriched;
  if (status === 'no_result') return counts.noResult;
  if (status === 'failed') return counts.failed;
  return counts.total;
}
