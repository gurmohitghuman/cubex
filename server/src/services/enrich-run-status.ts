// What the drawer (and later MCP) reads while an enrichment runs: a lean
// status from the run row, the ledger and the results' covering index (run_id,
// status, cost_usd), plus the newest few rows' cells. Never every result; a run
// can have a million. And Resume with a new run limit, for a run its limit paused.
import { db } from '../lib/db';
import { ENRICH_DAILY_LIMIT_MAX_USD, ENRICH_STATUS_LATEST } from '../lib/constants';
import { inputTemplates, isEnrichmentConfig, type EnrichRunConfig } from '../lib/enrich-run-config';
import { jsonPath } from '../lib/sql-rows';
import { getSheetColumns } from '../lib/sql-helpers';
import { runSpentMicro } from './enrich-ledger';
import { dailyLimitView, type DailyLimitView } from './treg-key';
import { resumeRun, type ControlOutcome } from './run-lifecycle';

// One row's result as the grid shows it: its cells (status and outputs), what
// it cost, and the row's first input value, so the drawer can say which row.
export interface EnrichRowResult {
  rowIndex: number; status: string; cells: Record<string, string>;
  costUsd: number | null; reason: string | null; label: string | null;
}

export interface EnrichRunStatus {
  id: string; status: string; pauseReason: string | null; message: string | null;
  statusColumn: string | null; outputColumns: string[]; toolName: string; preset: string | null;
  test: number | null;
  totalRows: number; processedRows: number; skippedRows: number;
  rows: { completed: number; failed: number };
  spentUsd: number; spendLimitUsd: number | null; maxCostPerRowUsd: number | null;
  dailyLimit: DailyLimitView;
  latest: EnrichRowResult[];
}

type RunRow = {
  id: string; sheet_id: string; status: string; pause_reason: string | null; error_message: string | null;
  master_column_name: string | null; config: string | null; total_rows: number | null;
  processed_rows: number | null; skipped_rows: number | null;
};

function loadRun(runId: string, userId: string): { row: RunRow; config: EnrichRunConfig } | null {
  const row = db.prepare(`SELECT id, sheet_id, status, pause_reason, error_message, master_column_name, config,
      total_rows, processed_rows, skipped_rows
    FROM http_runs WHERE id = ? AND user_id = ?`).get(runId, userId) as RunRow | undefined;
  if (!row) return null;
  let config: unknown = null;
  try { config = JSON.parse(String(row.config ?? 'null')); } catch { /* not an enrichment */ }
  return isEnrichmentConfig(config) ? { row, config } : null;
}

// The input column furthest left in the sheet (usually the name or the
// company), whose value says which row a result is for.
function labelColumn(config: EnrichRunConfig, sheetId: string, userId: string): string | null {
  const refs = Object.values(inputTemplates(config))
    .map(t => /^\{\{(.+)\}\}$/.exec(t)?.[1]).filter((c): c is string => !!c);
  if (refs.length <= 1) return refs[0] ?? null;
  const order = getSheetColumns(sheetId, userId, false);
  const at = (c: string) => { const i = order.indexOf(c); return i < 0 ? Infinity : i; };
  return [...refs].sort((x, y) => at(x) - at(y))[0];
}

// The newest rows: rows run in row order, so the highest row numbers are the
// latest (the unique (run_id, row_index) index reads them backwards).
function latestRows(run: RunRow, userId: string, config: EnrichRunConfig): EnrichRowResult[] {
  const rows = db.prepare(`SELECT row_index, status, extracted_fields, cost_usd, error_message FROM http_results
    WHERE run_id = ? AND user_id = ? ORDER BY row_index DESC LIMIT ?`)
    .all(run.id, userId, ENRICH_STATUS_LATEST) as Array<{
    row_index: number; status: string; extracted_fields: string | null;
    cost_usd: number | null; error_message: string | null;
  }>;
  const column = rows.length ? labelColumn(config, run.sheet_id, userId) : null;
  const labels = new Map<number, string>();
  if (column && rows.length) {
    const read = db.prepare(`SELECT row_index, json_extract(data, ?) AS v FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index IN (SELECT value FROM json_each(?))`);
    const found = read.all(jsonPath(column), run.sheet_id, userId, JSON.stringify(rows.map(r => r.row_index))) as
      Array<{ row_index: number; v: unknown }>;
    for (const r of found) {
      if (r.v !== null && r.v !== undefined && String(r.v).trim()) labels.set(r.row_index, String(r.v).slice(0, 80));
    }
  }
  return rows.map(r => {
    let cells: Record<string, string> = {};
    try { cells = JSON.parse(r.extracted_fields ?? '{}') as Record<string, string>; } catch { /* no cells */ }
    return {
      rowIndex: r.row_index, status: r.status, cells, costUsd: r.cost_usd, reason: r.error_message,
      label: labels.get(r.row_index) ?? null,
    };
  });
}

export function enrichRunStatus(runId: string, userId: string): EnrichRunStatus | null {
  const run = loadRun(runId, userId);
  if (!run) return null;
  const { row, config } = run;
  // By run only (loadRun checked it is the user's): the covering index
  // (run_id, status, cost_usd) answers it without reading a million rows.
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM http_results WHERE run_id = ? GROUP BY status')
    .all(runId) as Array<{ status: string; n: number }>;
  const n = (s: string) => counts.find(c => c.status === s)?.n ?? 0;
  const e = config.enrichment;
  return {
    id: row.id, status: row.status, pauseReason: row.pause_reason, message: row.error_message,
    statusColumn: row.master_column_name, outputColumns: config.responseMapping.map(m => m.columnName),
    toolName: e.toolName, preset: e.preset, test: e.rows.test,
    totalRows: Number(row.total_rows ?? 0), processedRows: Number(row.processed_rows ?? 0),
    skippedRows: Number(row.skipped_rows ?? 0),
    rows: { completed: n('completed'), failed: n('failed') },
    spentUsd: runSpentMicro(runId, userId) / 1e6, spendLimitUsd: e.spendLimitUsd, maxCostPerRowUsd: e.maxCostPerRowUsd,
    dailyLimit: dailyLimitView(userId),
    latest: latestRows(row, userId, config),
  };
}

// Resume, optionally with a higher run limit (the "Raise to $40 and resume"
// fix for a run its limit paused). The limit is written before the resume's
// own compare-and-set, only while the run is still paused.
export async function resumeEnrichmentRun(
  runId: string, userId: string, spendLimitUsd: unknown,
): Promise<ControlOutcome | { fail: 'bad_request'; message: string }> {
  const run = loadRun(runId, userId);
  if (!run) return { fail: 'not_found', message: 'Enrichment run not found' };
  if (spendLimitUsd !== undefined && spendLimitUsd !== null) {
    if (typeof spendLimitUsd !== 'number' || !Number.isFinite(spendLimitUsd) || spendLimitUsd <= 0
      || spendLimitUsd > ENRICH_DAILY_LIMIT_MAX_USD) {
      const max = ENRICH_DAILY_LIMIT_MAX_USD.toLocaleString('en-US');
      return { fail: 'bad_request', message: `The run limit must be more than $0 and at most $${max}.` };
    }
    if (run.config.enrichment.maxCostPerRowUsd === null) {
      return { fail: 'bad_request', message: 'This run has no run limit (the provider bills it).' };
    }
    const r = db.prepare(`UPDATE http_runs SET config = json_set(config, '$.enrichment.spendLimitUsd', ?)
      WHERE id = ? AND user_id = ? AND status = 'paused'`).run(spendLimitUsd, runId, userId);
    if (r.changes === 0) return { fail: 'not_paused', message: 'Run is not paused' };
  }
  // Enrichments never read saved API keys (allow_secrets 0), so no scope gate applies.
  return resumeRun('http', runId, userId, true);
}
