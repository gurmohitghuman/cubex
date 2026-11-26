// Settings' spend card: what enrichments cost over the last days, in total and
// per enrichment column, from Cubex's own ledger (every treg call and what treg
// charged for it, services/enrich-ledger.ts). treg's dashboard has the bill;
// this is the part that ran from this Cubex. Calls keep their sheet id and
// column name as they were, so spend on a deleted sheet still adds up (and a
// renamed column shows under its old name too). Spend of calls without a sheet
// (setup and enrichment calls, on hidden working tables: call_sheets, migration
// 075) adds up in one line of its own, while the table is kept and after, listed
// even when the top columns spent more. Calls on a sheet's test copy count under
// the sheet (migration 076), apart from its own column.
import { db } from '../lib/db';
import { ENRICH_SPEND_TOP_COLUMNS, ENRICH_SPEND_WINDOWS } from '../lib/constants';
import { yieldToRequests } from '../lib/slices';

export interface SpendColumn {
  sheetId: string | null; tableName: string | null; sheetName: string | null; column: string | null;
  onTestCopy: boolean; spentUsd: number; calls: number;
  // Every call without a sheet, added up (sheet and column are then null).
  call?: true;
}

export interface EnrichSpend {
  days: number; totalUsd: number; calls: number;
  columns: SpendColumn[];
  // Columns past the list's end, added up.
  otherUsd: number; otherColumns: number;
}

export const spendWindow = (raw: unknown): number => {
  const n = Number(raw);
  return (ENRICH_SPEND_WINDOWS as readonly number[]).includes(n) ? n : 30;
};

type Group = { sheet_id: string | null; status_column: string | null; micro: number; calls: number; call?: true };

// A test copy's groups moved under the sheet it tested (a column's tests together, apart from its own); the calls'
// line stays as it is.
function underTestedSheets(userId: string, groups: Iterable<Group>): Map<string, Group & { on_copy: boolean }> {
  const all = [...groups];
  const ids = [...new Set(all.map(g => g.sheet_id).filter((id): id is string => !!id))];
  const tested = new Map((db.prepare(`SELECT copy_id, sheet_id FROM test_copies
    WHERE user_id = ? AND copy_id IN (SELECT value FROM json_each(?))`).all(userId, JSON.stringify(ids)) as
    Array<{ copy_id: string; sheet_id: string }>).map(r => [r.copy_id, r.sheet_id]));
  const out = new Map<string, Group & { on_copy: boolean }>();
  for (const g of all) {
    const sheet = (g.sheet_id && tested.get(g.sheet_id)) || g.sheet_id;
    const onCopy = sheet !== g.sheet_id;
    const key = g.call ? 'call' : JSON.stringify([sheet, g.status_column, onCopy]);
    const cur = out.get(key) ?? { ...g, sheet_id: sheet, micro: 0, calls: 0, on_copy: onCopy };
    cur.micro += g.micro; cur.calls += g.calls;
    out.set(key, cur);
  }
  return out;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// One day of the ledger at a time (its (user_id, created_at) index), letting
// other requests in between: 90 days can hold millions of calls.
export async function enrichSpend(userId: string, days: number): Promise<EnrichSpend> {
  const day = db.prepare(`
    SELECT sheet_id, status_column, COALESCE(SUM(cost_micro), 0) AS micro, COUNT(*) AS calls
    FROM enrichment_calls WHERE user_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY sheet_id, status_column
  `);
  const sums = new Map<string, Group>();
  const callSheet = db.prepare('SELECT 1 FROM call_sheets WHERE sheet_id = ? AND user_id = ?').pluck();
  const calls = new Map<string, boolean>();
  const isCall = (id: string | null): boolean => {
    if (!id) return false;
    if (!calls.has(id)) calls.set(id, !!callSheet.get(id, userId));
    return calls.get(id)!;
  };
  const end = Date.now() + 1000;
  for (let from = end - days * 86_400_000; from < end; from += 86_400_000) {
    const rows = day.all(userId, stamp(from), stamp(Math.min(from + 86_400_000, end))) as Group[];
    for (const r of rows) {
      const call = isCall(r.sheet_id);
      const key = call ? 'call' : JSON.stringify([r.sheet_id, r.status_column]);
      const cur = sums.get(key) ?? (call ? { sheet_id: null, status_column: null, micro: 0, calls: 0, call }
        : { sheet_id: r.sheet_id, status_column: r.status_column, micro: 0, calls: 0 });
      cur.micro += r.micro; cur.calls += r.calls;
      sums.set(key, cur);
    }
    await yieldToRequests();
  }
  const groups = [...underTestedSheets(userId, sums.values()).values()]
    .sort((x, y) => y.micro - x.micro || y.calls - x.calls);
  const top = groups.slice(0, ENRICH_SPEND_TOP_COLUMNS);
  const rest = groups.slice(ENRICH_SPEND_TOP_COLUMNS);
  // The calls' line is listed even past the top columns: it is no column, so "N more columns" never takes it in.
  const late = rest.findIndex(g => g.call);
  if (late >= 0) top.push(...rest.splice(late, 1));
  const ids = [...new Set(top.map(g => g.sheet_id).filter((id): id is string => !!id))];
  const names = new Map<string, { sheet: string; table: string }>();
  if (ids.length) {
    const rows = db.prepare(`SELECT s.id, s.name AS sheet, t.name AS tbl
      FROM sheets s JOIN tables t ON t.id = s.table_id
      WHERE s.user_id = ? AND s.id IN (SELECT value FROM json_each(?))`).all(userId, JSON.stringify(ids)) as
      Array<{ id: string; sheet: string; tbl: string }>;
    for (const r of rows) names.set(r.id, { sheet: r.sheet, table: r.tbl });
  }
  return {
    days,
    totalUsd: groups.reduce((s, g) => s + g.micro, 0) / 1e6,
    calls: groups.reduce((s, g) => s + g.calls, 0),
    columns: top.map(g => {
      const n = g.sheet_id ? names.get(g.sheet_id) : undefined;
      return {
        sheetId: n ? g.sheet_id : null, tableName: n?.table ?? null, sheetName: n?.sheet ?? null,
        column: g.status_column, onTestCopy: g.on_copy, spentUsd: g.micro / 1e6, calls: g.calls,
        ...(g.call ? { call: g.call } : {}),
      };
    }),
    otherUsd: rest.reduce((s, g) => s + g.micro, 0) / 1e6,
    otherColumns: rest.length,
  };
}
