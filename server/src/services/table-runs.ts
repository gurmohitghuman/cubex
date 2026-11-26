// The home's Runs column: each table's AI and HTTP runs going now (pending or running) and paused, and the first
// sheet (by position) that has one, for the link. Read from the run tables' partial status indexes (migrations 014
// and 059), never from rows or cells; `+user_id` keeps the planner off the user_id index, which on one account holds
// every run there ever was (as services/workspace-overview.ts does). Runs on a sheet the home doesn't list (a hidden
// working table's, a test copy's) are left out. The wait (GET /api/tables/runs) answers once that changes.
import { db } from '../lib/db';
import { ACTIVE_STATUS_SQL } from './run-list';
import type { LiveSheet } from './table-row-counts';

export interface TableRuns { id: string; running: number; paused: number; sheet_id: string }

// One row per run going now or paused: its sheet and status. For tests/unit/table-runs.test.ts to check the plan.
export const HOME_RUNS_SQL = `
  SELECT sheet_id, status FROM ai_runs WHERE +user_id = ? AND setup_only = 0 AND ${ACTIVE_STATUS_SQL}
  UNION ALL
  SELECT sheet_id, status FROM http_runs WHERE +user_id = ? AND setup_only = 0 AND ${ACTIVE_STATUS_SQL}`;

type RunRow = { sheet_id: string; status: string };
const runsNow = (userId: string): RunRow[] => db.prepare(HOME_RUNS_SQL).all(userId, userId) as RunRow[];

// What the runs are, as one string: it changes when a run starts, ends, pauses or resumes.
function keyOf(rows: RunRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.sheet_id}:${r.status === 'paused' ? 'p' : 'r'}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k}:${n}`).sort().join(',');
}

function byTable(rows: RunRow[], sheets: Pick<LiveSheet, 'id' | 'table_id'>[]): TableRuns[] {
  const bySheet = new Map<string, { running: number; paused: number }>();
  for (const r of rows) {
    const s = bySheet.get(r.sheet_id) ?? { running: 0, paused: 0 };
    if (r.status === 'paused') s.paused++; else s.running++;
    bySheet.set(r.sheet_id, s);
  }
  const out = new Map<string, TableRuns>();
  // sheets come by table and position, so a table's link is its first sheet with a run.
  for (const sheet of sheets) {
    const s = bySheet.get(sheet.id);
    if (!s) continue;
    const t = out.get(sheet.table_id);
    if (t) { t.running += s.running; t.paused += s.paused; }
    else out.set(sheet.table_id, { id: sheet.table_id, running: s.running, paused: s.paused, sheet_id: sheet.id });
  }
  return [...out.values()];
}

// For GET /api/tables, which has read the sheets already.
export function homeRuns(userId: string, sheets: Pick<LiveSheet, 'id' | 'table_id'>[]): Map<string, TableRuns> {
  return new Map(byTable(runsNow(userId), sheets).map(t => [t.id, t]));
}

// The sheets of the tables the home lists, by table and position: only those whose runs are read.
const listedSheets = (userId: string, ids: string[]) => ids.length === 0 ? [] : db.prepare(`
  SELECT s.id, s.table_id FROM sheets s JOIN tables t ON t.id = s.table_id
  WHERE s.id IN (SELECT value FROM json_each(?)) AND s.user_id = ? AND s.trash_id IS NULL AND s.test_of IS NULL
    AND t.hidden = 0 AND t.trash_id IS NULL
  ORDER BY s.table_id, s.position`).all(JSON.stringify(ids), userId) as Array<{ id: string; table_id: string }>;

export interface HomeRuns { key: string; tables: TableRuns[] }

// The runs as they are now, and their key.
export function homeRunsNow(userId: string): HomeRuns {
  const rows = runsNow(userId);
  return { key: keyOf(rows), tables: byTable(rows, listedSheets(userId, [...new Set(rows.map(r => r.sheet_id))])) };
}

// The home's wait: the runs once their key is no longer `since`, checked every `everyMs`, or as they are at
// `until`. `stopped` ends it early (the page left); it then answers nothing anyone reads.
export async function homeRunsWhenChanged(userId: string, since: string | null, until: number, everyMs: number,
  stopped: () => boolean): Promise<HomeRuns> {
  for (;;) {
    const rows = runsNow(userId);
    const key = keyOf(rows);
    if (key !== since || Date.now() >= until || stopped()) {
      return { key, tables: byTable(rows, listedSheets(userId, [...new Set(rows.map(r => r.sheet_id))])) };
    }
    await new Promise(r => setTimeout(r, everyMs));
  }
}
