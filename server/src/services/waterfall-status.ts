// A waterfall run's status (the app's run view, GET /api/waterfall/runs/:id,
// and the `waterfall` part of get_run_status): how far it is, what it spent
// (treg and AI, against its limit), and per step how many rows reached it,
// how many it answered, failed or skipped for missing inputs, and what it cost
// (waterfall_step_tally). A pure read of the run and its few tally rows.
import { db } from '../lib/db';
import { waterfallConfigOf, waterfallColumns } from '../lib/waterfall/config';
import { RESULT_INFO } from '../lib/waterfall/result-type';

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface WaterfallStepStatus {
  id: string; label: string; kind: string; on: boolean;
  reached: number; answered: number; rejected: number; failed: number; skipped: number; cost_usd: number;
}

export interface WaterfallRunStatus {
  id: string; sheet_id: string; status: string; message: string | null; pause_reason: string | null;
  starting: boolean; processed_rows: number; total_rows: number; skipped_rows: number;
  condition_skipped_rows: number; result_column: string | null; answered_by_column: string | null;
  result_type: string; dry: boolean; auto_run: boolean;
  spent: { treg_usd: number; ai_usd: number; total_usd: number }; run_limit_usd: number | null;
  max_per_row_usd: number;             // every on step's cap: the most one row can cost
  steps: WaterfallStepStatus[];
  created_at: string; updated_at: string;
}

interface RunRow {
  id: string; sheet_id: string; status: string; error_message: string | null; pause_reason: string | null;
  placeholder_work: string | null; processed_rows: number; total_rows: number; skipped_rows: number | null;
  condition_skipped_rows: number | null; master_column_name: string | null; config: string | null;
  spent_micro: number; ai_cost_usd: number; autorun_id: string | null; created_at: string; updated_at: string;
}

// The waterfall part of a run summary from an http_runs row (null: not a waterfall).
export function waterfallStatusOf(r: RunRow, userId: string): WaterfallRunStatus | null {
  const config = waterfallConfigOf(r.config);
  if (!config) return null;
  const w = config.waterfall;
  const tallies = new Map((db.prepare(`SELECT step_id, reached, answered, rejected, failed, skipped, cost_usd
    FROM waterfall_step_tally WHERE run_id = ? AND user_id = ?`).all(r.id, userId) as Array<{
    step_id: string; reached: number; answered: number; rejected: number; failed: number; skipped: number;
    cost_usd: number;
  }>).map(t => [t.step_id, t]));
  const treg = r.spent_micro / 1e6;
  return {
    id: r.id, sheet_id: r.sheet_id, status: r.status, message: r.error_message, pause_reason: r.pause_reason,
    starting: r.placeholder_work === 'seeding', processed_rows: r.processed_rows, total_rows: r.total_rows,
    skipped_rows: r.skipped_rows ?? 0, condition_skipped_rows: r.condition_skipped_rows ?? 0,
    result_column: r.master_column_name, answered_by_column: waterfallColumns(config).answeredBy,
    result_type: RESULT_INFO[w.resultType].label, dry: !!w.dry, auto_run: r.autorun_id !== null,
    spent: { treg_usd: round6(treg), ai_usd: round6(r.ai_cost_usd), total_usd: round6(treg + r.ai_cost_usd) },
    run_limit_usd: w.spendLimitUsd, max_per_row_usd: w.maxCostPerRowUsd,
    steps: w.steps.map(s => {
      const t = tallies.get(s.id);
      return {
        id: s.id, label: s.label, kind: s.choices.kind, on: s.on, reached: t?.reached ?? 0,
        answered: t?.answered ?? 0, rejected: t?.rejected ?? 0, failed: t?.failed ?? 0, skipped: t?.skipped ?? 0,
        cost_usd: round6(t?.cost_usd ?? 0),
      };
    }),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function waterfallRunStatus(userId: string, runId: string): WaterfallRunStatus | null {
  const r = db.prepare(`SELECT id, sheet_id, status, error_message, pause_reason, placeholder_work, processed_rows,
      total_rows, skipped_rows, condition_skipped_rows, master_column_name, config, spent_micro, ai_cost_usd,
      autorun_id, created_at, updated_at
    FROM http_runs WHERE id = ? AND user_id = ?`).get(runId, userId) as RunRow | undefined;
  return r ? waterfallStatusOf(r, userId) : null;
}

// What each waterfall column spent, every run of it (treg and AI), and the
// rows it ran: the header's ⚡ and tooltip. Read from usage history (one small
// record per run, migration 033), never from the runs' configs.
export function waterfallColumnSpend(
  sheetId: string, userId: string, columns: string[],
): Record<string, { spentUsd: number; rows: number }> {
  if (columns.length === 0) return {};
  const rows = db.prepare(`SELECT u.column_name AS c, SUM(u.enrich_micro) / 1e6 + SUM(u.ai_cost_usd) AS s,
      SUM(u.cells) AS n
    FROM run_usage u WHERE u.sheet_id = ? AND +u.user_id = ? AND u.mode = 'waterfall' AND u.column_deleted = 0
      AND u.column_name IN (SELECT value FROM json_each(?))
    GROUP BY u.column_name`).all(sheetId, userId, JSON.stringify(columns)) as
    Array<{ c: string; s: number | null; n: number | null }>;
  return Object.fromEntries(rows.map(r => [r.c, { spentUsd: round6(r.s ?? 0), rows: r.n ?? 0 }]));
}
