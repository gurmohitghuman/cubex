// What the drawer (and later MCP) reads while an enrichment runs: a lean
// status from the run row, the ledger and the results' covering index (run_id,
// status, cost_usd). Never the results themselves; a run can have a million.
// And Resume with a new run limit, for a run its limit paused.
import { db } from '../lib/db';
import { ENRICH_DAILY_LIMIT_MAX_USD } from '../lib/constants';
import { isEnrichmentConfig, type EnrichRunConfig } from '../lib/enrich-run-config';
import { runSpentMicro } from './enrich-ledger';
import { dailyLimitView, type DailyLimitView } from './treg-key';
import { resumeRun, type ControlOutcome } from './run-lifecycle';

export interface EnrichRunStatus {
  id: string; status: string; pauseReason: string | null; message: string | null;
  statusColumn: string | null; toolName: string; preset: string | null;
  totalRows: number; processedRows: number; skippedRows: number;
  rows: { completed: number; failed: number };
  spentUsd: number; spendLimitUsd: number | null; maxCostPerRowUsd: number | null;
  dailyLimit: DailyLimitView;
}

function loadRun(runId: string, userId: string): { row: Record<string, unknown>; config: EnrichRunConfig } | null {
  const row = db.prepare(`SELECT id, status, pause_reason, error_message, master_column_name, config, total_rows, processed_rows, skipped_rows
    FROM http_runs WHERE id = ? AND user_id = ?`).get(runId, userId) as Record<string, unknown> | undefined;
  if (!row) return null;
  let config: unknown = null;
  try { config = JSON.parse(String(row.config ?? 'null')); } catch { /* not an enrichment */ }
  return isEnrichmentConfig(config) ? { row, config } : null;
}

export function enrichRunStatus(runId: string, userId: string): EnrichRunStatus | null {
  const run = loadRun(runId, userId);
  if (!run) return null;
  const { row, config } = run;
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM http_results WHERE run_id = ? GROUP BY status').all(runId) as Array<{ status: string; n: number }>;
  const n = (s: string) => counts.find(c => c.status === s)?.n ?? 0;
  const e = config.enrichment;
  return {
    id: String(row.id), status: String(row.status), pauseReason: (row.pause_reason as string | null) ?? null,
    message: (row.error_message as string | null) ?? null, statusColumn: (row.master_column_name as string | null) ?? null,
    toolName: e.toolName, preset: e.preset,
    totalRows: Number(row.total_rows ?? 0), processedRows: Number(row.processed_rows ?? 0), skippedRows: Number(row.skipped_rows ?? 0),
    rows: { completed: n('completed'), failed: n('failed') },
    spentUsd: runSpentMicro(runId, userId) / 1e6, spendLimitUsd: e.spendLimitUsd, maxCostPerRowUsd: e.maxCostPerRowUsd,
    dailyLimit: dailyLimitView(userId),
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
    if (typeof spendLimitUsd !== 'number' || !Number.isFinite(spendLimitUsd) || spendLimitUsd <= 0 || spendLimitUsd > ENRICH_DAILY_LIMIT_MAX_USD) {
      return { fail: 'bad_request', message: `The run limit must be more than $0 and at most $${ENRICH_DAILY_LIMIT_MAX_USD.toLocaleString('en-US')}.` };
    }
    if (run.config.enrichment.maxCostPerRowUsd === null) return { fail: 'bad_request', message: 'This run has no run limit (the provider bills it).' };
    const r = db.prepare(`UPDATE http_runs SET config = json_set(config, '$.enrichment.spendLimitUsd', ?)
      WHERE id = ? AND user_id = ? AND status = 'paused'`).run(spendLimitUsd, runId, userId);
    if (r.changes === 0) return { fail: 'not_paused', message: 'Run is not paused' };
  }
  // Enrichments never read saved API keys (allow_secrets 0), so no scope gate applies.
  return resumeRun('http', runId, userId, true);
}
