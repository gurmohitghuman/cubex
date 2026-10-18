// Usage history: for each column (deleted ones too), each day or each run, the
// runs, the cells they ran, what they cost (OpenRouter's charge, the user's
// own provider key, treg's charges) and the cost per cell. One surface for the
// app's Usage view, GET /api/v1/usage and MCP get_usage. It sums run_usage
// (migration 033: one small record per run, kept by triggers), never rows,
// results or run configs, so a million-row sheet costs no more than its runs.
// Each run counts on the day it started (UTC).
import { db } from '../lib/db';
import { nowDate } from '../lib/clock';
import { parseUsageQuery, rangeBounds, type UsageGroupBy, type UsageQuery, type UsageRange } from '../lib/usage-query';

export interface UsageFigures {
  runs: number; cells: number; reused_cells: number;
  ai_cost_usd: number; provider_cost_usd: number; enrichment_cost_usd: number; total_cost_usd: number;
  cost_per_cell_usd: number | null;
}
type Kind = 'ai' | 'enrichment' | 'http' | 'mixed';
// sheet_deleted: the sheet is gone (what its runs spent stays in the history).
export interface UsageColumnRow extends UsageFigures {
  sheet_id: string; sheet_name: string | null; sheet_deleted: boolean; column: string | null; column_deleted: boolean;
  kind: Kind; last_run_at: string;
}
export interface UsageDayRow extends UsageFigures { day: string }
export interface UsageRunRow extends UsageFigures {
  run_id: string; sheet_id: string; sheet_name: string | null; sheet_deleted: boolean; column: string | null;
  column_deleted: boolean; kind: Kind; what: string | null; status: string; started_at: string;
}
export type UsageRow = UsageColumnRow | UsageDayRow | UsageRunRow;

export interface UsageReport {
  sheet_id: string | null; group_by: UsageGroupBy; range: UsageRange;
  totals: UsageFigures; rows: UsageRow[]; rows_total: number; truncated: boolean;
}

export interface UsageScope { userId: string; sheetId: string | null; range: UsageRange }

type Sums = { runs: number; cells: number; reused: number; ai: number; provider: number; enrich: number };
const round = (v: number, places = 6) => Math.round(v * 10 ** places) / 10 ** places;

export function figures(s: Sums): UsageFigures {
  const enrichment = s.enrich / 1e6;
  const total = s.ai + s.provider + enrichment;
  return {
    runs: s.runs, cells: s.cells, reused_cells: s.reused,
    ai_cost_usd: round(s.ai), provider_cost_usd: round(s.provider), enrichment_cost_usd: round(enrichment),
    total_cost_usd: round(total), cost_per_cell_usd: s.cells > 0 ? round(total / s.cells, 8) : null,
  };
}

// The range on one sheet (its index; +user_id keeps the planner on it) or the
// account. Each statement below spells its columns out, so tests/unit/sql-schema
// checks them; only this WHERE goes in.
function scopeWhere(s: UsageScope): { sql: string; params: unknown[] } {
  const { start, end } = rangeBounds(s.range);
  return s.sheetId
    ? { sql: 'u.sheet_id = ? AND +u.user_id = ? AND u.started_at >= ? AND u.started_at < ?',
      params: [s.sheetId, s.userId, start, end] }
    : { sql: 'u.user_id = ? AND u.started_at >= ? AND u.started_at < ?', params: [s.userId, start, end] };
}

const kindOf = (kinds: string): Kind => (kinds.includes(',') ? 'mixed' : kinds as Kind);

function sheetNames(userId: string): Map<string, string> {
  const rows = db.prepare('SELECT id, name FROM sheets WHERE user_id = ?').all(userId) as
    Array<{ id: string; name: string }>;
  return new Map(rows.map(r => [r.id, r.name]));
}

// The model of an AI run, the tool of an enrichment (a page of runs, by id).
function whatRan(runId: string, kind: string): string | null {
  let v: unknown = null;
  if (kind === 'ai') v = db.prepare('SELECT model FROM ai_runs WHERE id = ?').pluck().get(runId);
  else if (kind === 'enrichment') {
    v = db.prepare(`SELECT json_extract(config, '$.enrichment.toolName') FROM http_runs WHERE id = ?`)
      .pluck().get(runId);
  }
  return typeof v === 'string' ? v : null;
}

type ColumnSql = Sums & { sheet_id: string; col: string | null; deleted: number; kinds: string; last_at: string };
type RunSql = Sums & {
  run_id: string; sheet_id: string; col: string | null; deleted: number; kind: string; status: string;
  started_at: string;
};

function totalsOf(s: UsageScope): UsageFigures {
  const w = scopeWhere(s);
  return figures(db.prepare(`SELECT COUNT(*) AS runs, IFNULL(SUM(u.cells), 0) AS cells,
      IFNULL(SUM(u.reused_cells), 0) AS reused, IFNULL(SUM(u.ai_cost_usd), 0) AS ai,
      IFNULL(SUM(u.provider_cost_usd), 0) AS provider, IFNULL(SUM(u.enrich_micro), 0) AS enrich
    FROM run_usage u WHERE ${w.sql}`).get(...w.params) as Sums);
}

// Columns (deleted ones too), costliest first.
function columnRows(s: UsageScope, limit: number): UsageColumnRow[] {
  const w = scopeWhere(s);
  const rows = db.prepare(`SELECT u.sheet_id, u.column_name AS col, u.column_deleted AS deleted,
      GROUP_CONCAT(DISTINCT u.kind) AS kinds, MAX(u.started_at) AS last_at, COUNT(*) AS runs,
      IFNULL(SUM(u.cells), 0) AS cells, IFNULL(SUM(u.reused_cells), 0) AS reused, IFNULL(SUM(u.ai_cost_usd), 0) AS ai,
      IFNULL(SUM(u.provider_cost_usd), 0) AS provider, IFNULL(SUM(u.enrich_micro), 0) AS enrich
    FROM run_usage u WHERE ${w.sql}
    GROUP BY u.sheet_id, u.column_name, u.column_deleted
    ORDER BY SUM(u.ai_cost_usd) + SUM(u.provider_cost_usd) + SUM(u.enrich_micro) / 1e6 DESC, SUM(u.cells) DESC,
      u.column_name LIMIT ?`).all(...w.params, limit) as ColumnSql[];
  const names = sheetNames(s.userId);
  return rows.map(r => ({
    sheet_id: r.sheet_id, sheet_name: names.get(r.sheet_id) ?? null, sheet_deleted: !names.has(r.sheet_id),
    column: r.col, column_deleted: r.deleted === 1, kind: kindOf(r.kinds), last_run_at: r.last_at, ...figures(r),
  }));
}

// Days, newest first (a run on the day it started).
function dayRows(s: UsageScope, limit: number): UsageDayRow[] {
  const w = scopeWhere(s);
  const rows = db.prepare(`SELECT substr(u.started_at, 1, 10) AS d, COUNT(*) AS runs, IFNULL(SUM(u.cells), 0) AS cells,
      IFNULL(SUM(u.reused_cells), 0) AS reused, IFNULL(SUM(u.ai_cost_usd), 0) AS ai,
      IFNULL(SUM(u.provider_cost_usd), 0) AS provider, IFNULL(SUM(u.enrich_micro), 0) AS enrich
    FROM run_usage u WHERE ${w.sql}
    GROUP BY substr(u.started_at, 1, 10) ORDER BY d DESC LIMIT ?`).all(...w.params, limit) as
    Array<Sums & { d: string }>;
  return rows.map(r => ({ day: r.d, ...figures(r) }));
}

// The groups of the range, at most `limit` (-1: all of them; columns and days are few).
export function groupRows(s: UsageScope, groupBy: Exclude<UsageGroupBy, 'run'>, limit: number): UsageRow[] {
  return groupBy === 'day' ? dayRows(s, limit) : columnRows(s, limit);
}

function groupCount(s: UsageScope, groupBy: Exclude<UsageGroupBy, 'run'>): number {
  const w = scopeWhere(s);
  const count = groupBy === 'day'
    ? db.prepare(`SELECT COUNT(DISTINCT substr(u.started_at, 1, 10)) FROM run_usage u WHERE ${w.sql}`)
    : db.prepare(`SELECT COUNT(*) FROM (SELECT 1 FROM run_usage u WHERE ${w.sql}
        GROUP BY u.sheet_id, u.column_name, u.column_deleted)`);
  return count.pluck().get(...w.params) as number;
}

// Runs newest first, after (started_at, run_id) `after` (null: from the newest).
export function runPage(s: UsageScope, after: [string, string] | null, limit: number): UsageRunRow[] {
  const w = scopeWhere(s);
  const rows = db.prepare(`SELECT u.run_id, u.sheet_id, u.column_name AS col, u.column_deleted AS deleted, u.kind,
      u.status, u.started_at, 1 AS runs, u.cells, u.reused_cells AS reused, u.ai_cost_usd AS ai,
      u.provider_cost_usd AS provider, u.enrich_micro AS enrich
    FROM run_usage u
    WHERE ${w.sql} AND (u.started_at, u.run_id) < (?, ?) ORDER BY u.started_at DESC, u.run_id DESC LIMIT ?`)
    .all(...w.params, ...(after ?? ['9999', '']), limit) as RunSql[];
  const names = sheetNames(s.userId);
  return rows.map(r => ({
    run_id: r.run_id, sheet_id: r.sheet_id, sheet_name: names.get(r.sheet_id) ?? null,
    sheet_deleted: !names.has(r.sheet_id), column: r.col, column_deleted: r.deleted === 1, kind: kindOf(r.kind), what: whatRan(r.run_id, r.kind), status: r.status,
    started_at: r.started_at, ...figures(r),
  }));
}

export function readUsage(s: UsageScope, q: UsageQuery): UsageReport {
  const totals = totalsOf(s);
  const rows = q.groupBy === 'run' ? runPage(s, null, q.limit) : groupRows(s, q.groupBy, q.limit);
  const rowsTotal = q.groupBy === 'run' ? totals.runs : groupCount(s, q.groupBy);
  return {
    sheet_id: s.sheetId, group_by: q.groupBy, range: q.range, totals, rows, rows_total: rowsTotal,
    truncated: rows.length < rowsTotal,
  };
}

export type UsageAsk = { ok: { scope: UsageScope; query: UsageQuery; name: string } }
  | { fail: 'bad_request' | 'not_found'; message: string };

// Every surface's request: the sheet (null: the whole account) checked, then
// group_by, limit and the range (range, or from and to) parsed.
export function usageAsk(userId: string, sheetId: string | null, input: Record<string, unknown>): UsageAsk {
  let name = 'All sheets';
  if (sheetId !== null) {
    const sheet = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck().get(sheetId, userId);
    if (typeof sheet !== 'string') return { fail: 'not_found', message: 'Sheet not found' };
    name = sheet;
  }
  const q = parseUsageQuery(input, nowDate());
  if ('error' in q) return { fail: 'bad_request', message: q.error };
  return { ok: { scope: { userId, sheetId, range: q.ok.range }, query: q.ok, name } };
}
