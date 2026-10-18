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
import { CONDITION_NOT_MET, LIST_MARK, RUNNING_MARK } from '../lib/run-markers';
import type { CompiledFilter } from '../lib/row-filter/sql';
import type { RuleNode } from '../lib/run-condition';
import type { EnrichCondition, EnrichRowsMode, EnrichRowsStatus } from '../lib/enrich-run-config';
import { rowFilterSql } from './enrich-rows-filter';

// outOfDate: rows holding a result made from inputs that changed since
// (lib/run-inputs); counted only when the scope gives the check (stale), else 0.
export interface EnrichRowCounts {
  total: number; notEnriched: number; noResult: number; failed: number; outOfDate: number;
}

// where / rule: the run's "Only run if" (the older condition list, the rule);
// rows failing them are left out (counted with the check seeding uses, so a
// row's JSON is read in each slice).
export interface CountScope {
  mode: EnrichRowsMode; rowIndexes: number[] | null; where?: EnrichCondition[]; rule?: RuleNode | null;
  stale?: CompiledFilter | null;     // services/run-inputs.ts statusStaleCheck
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
  const out: EnrichRowCounts = { total: 0, notEnriched: 0, noResult: 0, failed: 0, outOfDate: 0 };
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
  // Out of date: a result (not blank, kept out, running or failed) whose run's fingerprint differs now.
  const stale = column !== null ? scope.stale ?? null : null;
  const flag = stale ? `${stale.sql} IS 1` : '0';
  const read = db.prepare(`SELECT data, ${flag} FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index >= ? AND row_index < ?${filter.clause}${selected}`).raw();
  const count = db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(s = '' OR s = ?), 0) AS not_enriched,
      COALESCE(SUM(s = '' OR instr(s, ?) = 1 OR instr(s, ?) = 1), 0) AS no_result,
      COALESCE(SUM(instr(s, ?) = 1), 0) AS failed,
      COALESCE(SUM(st AND s <> '' AND s <> ? AND instr(s, ?) <> 1 AND instr(s, ?) <> 1 AND instr(s, ?) <> 1), 0)
        AS out_of_date
    FROM (SELECT ${cell} AS s, ${flag} AS st FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index >= ? AND row_index < ?${filter.clause}${selected})
  `);
  const marks = [CONDITION_NOT_MET, FAILED_MARK, SKIPPED_MARK, FAILED_MARK,
    CONDITION_NOT_MET, RUNNING_MARK, LIST_MARK, FAILED_MARK];
  const head = [...marks, ...(column === null ? [] : [jsonPath(column), BLANK_CHARS]), ...(stale?.params ?? [])];
  const tail = [...filter.params, ...(selected ? [JSON.stringify(scope.rowIndexes ?? [])] : [])];
  for (let lo = first; ;) {
    // Out of date hashes each row's inputs: half the rows a slice, so it holds the server as long as before.
    const size = where ? HEAVY_SLICE_ROWS : stale ? COUNT_SLICE_ROWS / 2 : COUNT_SLICE_ROWS;
    const next = edge.get(sheetId, userId, lo, size) as number | undefined;
    const hi = next ?? Number.MAX_SAFE_INTEGER;
    if (where) {
      const readArgs = [...(stale?.params ?? []), sheetId, userId, lo, hi, ...tail];
      for (const [raw, st] of read.iterate(...readArgs) as Iterable<[string, number]>) {
        const data = parseRowData(raw);
        if (!passesRunConditions(data, where, rule)) continue;
        const cellValue = column === null ? '' : data[column];
        out.total++;
        if (statusMatches(cellValue, 'not_enriched')) out.notEnriched++;
        if (statusMatches(cellValue, 'no_result')) out.noResult++;
        if (statusMatches(cellValue, 'failed')) out.failed++;
        if (statusMatches(cellValue, 'out_of_date', st === 1)) out.outOfDate++;
      }
    } else {
      const r = count.get(...head, sheetId, userId, lo, hi, ...tail) as {
        total: number; not_enriched: number; no_result: number; failed: number; out_of_date: number;
      };
      out.total += r.total; out.notEnriched += r.not_enriched; out.noResult += r.no_result; out.failed += r.failed;
      out.outOfDate += r.out_of_date;
    }
    if (next === undefined) return out;
    lo = next;
    await yieldToRequests();
  }
}

// A scope counting out_of_date or empty_or_out_of_date must ask for stale.
export function countFor(counts: EnrichRowCounts, status: EnrichRowsStatus): number {
  if (status === 'not_enriched') return counts.notEnriched;
  if (status === 'no_result') return counts.noResult;
  if (status === 'failed') return counts.failed;
  if (status === 'out_of_date') return counts.outOfDate;
  if (status === 'empty_or_out_of_date') return counts.notEnriched + counts.outOfDate;
  return counts.total;
}
