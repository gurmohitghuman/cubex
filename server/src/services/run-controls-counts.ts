// The column menu's numbers ("Run N empty or out-of-date rows", "Force run
// all N rows", "Retry N failed rows") and the header's "N failed, retry", read
// from the run's main cells (services/run-controls-column.ts). One column's
// counts take one walk over the sheet a slice at a time (lib/sheet-slices.ts),
// each slice one SELECT of sums: empty (blank or "⏭️ Condition not met", the
// rows a rerun's 'empty' takes), failed (❌), out of date (a result whose
// inputs changed since, lib/run-inputs). Like other counts they answer busy
// while a heavy operation moves the sheet's rows.
import { db } from '../lib/db';
import { jsonPath } from '../lib/json-path';
import { BLANK_CHARS, CONDITION_NOT_MET, FAILED_MARK, LIST_MARK, RUNNING_MARK } from '../lib/run-markers';
import { sliceSql, slicedUnlessBusy, walkSlices } from '../lib/sheet-slices';
import { columnCounts } from './column-counts';
import { columnStaleCheck } from './run-inputs';
import { sheetRunMains } from './run-controls-column';
import { sheetRunColumns } from './row-filter';
import { getSheetColumns } from '../lib/sql-helpers';

export interface RunColumnCounts { total: number; empty: number; outOfDate: number; failed: number }
export type CountsAnswer<T> = { ok: T } | { busy: string } | { stopped: true };

const BLANK_SQL = `char(${[...BLANK_CHARS].map(c => c.codePointAt(0)).join(', ')})`;

export async function runColumnCounts(
  sheetId: string, userId: string, main: string, stop?: () => boolean,
): Promise<CountsAnswer<RunColumnCounts>> {
  const stale = columnStaleCheck(sheetId, userId, main);
  const stmt = db.prepare(`SELECT COUNT(*),
      COALESCE(SUM(s = '' OR s = ?), 0),
      COALESCE(SUM(instr(s, ?) = 1), 0),
      COALESCE(SUM(st AND s <> '' AND s <> ? AND instr(s, ?) <> 1 AND instr(s, ?) <> 1 AND instr(s, ?) <> 1), 0)
    FROM (SELECT TRIM(COALESCE(json_extract(data, ?), ''), ${BLANK_SQL}) AS s,
        ${stale ? `${stale.sql} IS 1` : '0'} AS st
      FROM rows WHERE sheet_id = ? AND user_id = ? AND ${sliceSql()})`).raw();
  const head = [CONDITION_NOT_MET, FAILED_MARK, CONDITION_NOT_MET, RUNNING_MARK, LIST_MARK, FAILED_MARK,
    jsonPath(main), ...(stale?.params ?? [])];
  return slicedUnlessBusy(sheetId, async (): Promise<CountsAnswer<RunColumnCounts>> => {
    const out: RunColumnCounts = { total: 0, empty: 0, outOfDate: 0, failed: 0 };
    const finished = await walkSlices(sheetId, userId, { sliced: true, stop }, (a, b) => {
      const [total, empty, failed, outOfDate] = stmt.get(...head, sheetId, userId, a, b) as number[];
      out.total += total; out.empty += empty; out.failed += failed; out.outOfDate += outOfDate;
      return false;
    });
    return finished ? { ok: out } : { stopped: true };
  });
}

// The header's "N failed, retry": failed rows of every run column's main
// column, in one walk (services/column-counts.ts). Columns with none are left out.
export async function sheetFailedCounts(
  sheetId: string, userId: string, stop?: () => boolean,
): Promise<CountsAnswer<Record<string, number>>> {
  const mains = [...sheetRunMains(sheetId, userId).keys()];
  if (mains.length === 0) return { ok: {} };
  const runColumns = sheetRunColumns(sheetId, userId, getSheetColumns(sheetId, userId, false));
  const counted = await columnCounts(sheetId, userId, mains, runColumns, stop);
  if (!('ok' in counted)) return counted;
  const out: Record<string, number> = {};
  for (const [column, c] of counted.ok) if (c.errors > 0) out[column] = c.errors;
  return { ok: out };
}
