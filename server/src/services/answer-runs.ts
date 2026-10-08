// Which runs a clicked cell's answer comes from: its column's status column
// (itself, or the one an output column belongs to through
// http_column_associations), that column's runs newest first, and the newest
// of them with a result at the row, read through the UNIQUE (run_id,
// row_index) index. Enrichment and HTTP API columns alike; pure reads.
import { db } from '../lib/db';
import { isEnrichmentConfig, type EnrichRunConfig } from '../lib/enrich-run-config';
import type { HTTPAPIConfig } from '../lib/http-request-template';

export interface ColumnRunRef {
  id: string; createdAt: string; status: string; placeholderWork: string | null;
  config: HTTPAPIConfig | null; enrichment: EnrichRunConfig | null;
}

export interface ColumnRuns {
  statusColumn: string;
  output: boolean;             // the clicked column is one of its outputs
  runs: ColumnRunRef[];        // newest first
}

export interface RowResult {
  run: ColumnRunRef;
  status: string; response_data: string | null; error_message: string | null; cost_usd: number | null;
}

function parseConfig(raw: string | null): HTTPAPIConfig | null {
  try {
    const c = JSON.parse(raw ?? 'null');
    return c && typeof c === 'object' && Array.isArray(c.responseMapping) ? c as HTTPAPIConfig : null;
  } catch { return null; }
}

export function statusColumnRuns(sheetId: string, userId: string, statusColumn: string): ColumnRunRef[] {
  const rows = db.prepare(`SELECT id, created_at, status, placeholder_work, config FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC`).all(sheetId, userId, statusColumn) as Array<{
      id: string; created_at: string; status: string; placeholder_work: string | null; config: string | null;
    }>;
  return rows.map(r => {
    const config = parseConfig(r.config);
    return {
      id: r.id, createdAt: r.created_at, status: r.status, placeholderWork: r.placeholder_work, config,
      enrichment: isEnrichmentConfig(config) ? config : null,
    };
  });
}

// An output column reads the runs linked to it (a later run that dropped it
// still holds results at the row, but not for this column).
export function columnRuns(sheetId: string, userId: string, column: string): ColumnRuns | null {
  const own = statusColumnRuns(sheetId, userId, column);
  if (own.length > 0) return { statusColumn: column, output: false, runs: own };
  const links = db.prepare(`SELECT master_column_name AS master, run_id AS runId FROM http_column_associations
    WHERE sheet_id = ? AND user_id = ? AND extracted_column_name = ? AND master_column_name IS NOT NULL
    ORDER BY created_at DESC, rowid DESC`).all(sheetId, userId, column) as
    Array<{ master: string; runId: string | null }>;
  if (links.length === 0) return null;
  const statusColumn = links[0].master;
  const linked = new Set(links.filter(l => l.master === statusColumn).map(l => l.runId));
  const runs = statusColumnRuns(sheetId, userId, statusColumn).filter(r => linked.has(r.id));
  return runs.length > 0 ? { statusColumn, output: true, runs } : null;
}

export function isActiveRun(r: ColumnRunRef): boolean {
  return ['pending', 'running', 'paused'].includes(r.status) || r.placeholderWork !== null;
}

// The newest result at the row among `runs` (a rerun of other rows leaves
// this row's answer in the run that made it).
export function resultAtRow(runs: ColumnRunRef[], userId: string, rowIndex: number): RowResult | null {
  const probe = db.prepare(`SELECT status, response_data, error_message, cost_usd FROM http_results
    WHERE run_id = ? AND row_index = ? AND user_id = ?`);
  for (const run of runs) {
    const hit = probe.get(run.id, rowIndex, userId) as Omit<RowResult, 'run'> | undefined;
    if (hit && (hit.status === 'completed' || hit.status === 'failed')) return { run, ...hit };
  }
  return null;
}
