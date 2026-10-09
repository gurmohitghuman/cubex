// What the programmatic run reads (MCP get_run_status, list_runs and
// get_run_results; GET /api/v1/http-runs/:id, /runs and /results) add for an
// enrichment run: the tool, what it cost (the run's ledger total), its limits
// and why it paused, and for a list job where its rows go. Per row: what the
// row cost, who found it, and on request the stored answer whose paths
// add_enrichment_field takes.
import { db } from '../lib/db';
import { isEnrichmentConfig, type EnrichRunConfig } from '../lib/enrich-run-config';
import { parseStored, readStored } from '../lib/answer-store';
import { budgetAnswer } from '../lib/answer-budget';
import { AGENT_ANSWER_MAX_CHARS } from '../lib/constants';
import { httpRunSecretRefsRequiringScope } from '../lib/http-secrets-scan';
import { listProgress } from './enrich-run-status';
import { dailyLimitOf } from './enrich-agent-shared';

export interface EnrichRunRow {
  id: string; config: string | null; spent_micro: number | null; pause_reason: string | null;
  skipped_rows: number | null; dest_sheet_id: string | null; list_rows_added: number | null;
}

export function enrichConfigOf(raw: string | null): EnrichRunConfig | null {
  try { const c = JSON.parse(raw ?? 'null'); return isEnrichmentConfig(c) ? c : null; } catch { return null; }
}

// The enrichment block of a run summary (null: a plain HTTP run). full: the
// list progress and the daily limit too (one run's status, not a list of runs).
export function enrichSummaryPart(r: EnrichRunRow, userId: string, full: boolean): Record<string, unknown> {
  const config = enrichConfigOf(r.config);
  if (!config) return {};
  const e = config.enrichment;
  const progress = full ? listProgress({ ...r, list_rows_added: r.list_rows_added ?? 0 }, config, userId) : null;
  return {
    cost_usd: (r.spent_micro ?? 0) / 1e6,
    enrichment: {
      tool_id: e.toolId, tool_name: e.toolName, kind: e.kind, preset: e.preset,
      provider_order: e.route.prefer.map(p => e.providerNames[p] ?? p),
      max_cost_per_row_usd: e.maxCostPerRowUsd, spend_limit_usd: e.spendLimitUsd,
      pause_reason: r.pause_reason, skipped_rows_missing_inputs: r.skipped_rows ?? 0, test_rows: e.rows.test,
      ...(e.list ? {
        list: {
          destination_sheet_id: r.dest_sheet_id, results_per_row: e.list.maxItems,
          provider: e.list.provider ? e.providerNames[e.list.provider.toLowerCase()] ?? e.list.provider : null,
          fields: e.list.fields?.map(f => ({ path: f.path, column_name: f.columnName })) ?? null,
          ...(progress ? {
            destination_name: progress.destName, rows_added: progress.added, adding: progress.adding,
            waiting_for_fields: progress.waitingFields, waiting_for_room: progress.waitingRoom,
          } : {}),
        },
      } : {}),
    },
    ...(full ? { daily_limit: dailyLimitOf(userId) } : {}),
  };
}

// answer_cut: parts of the answer left out (largest first) to keep it under AGENT_ANSWER_MAX_CHARS.
export interface EnrichResultExtra {
  cost_usd: number | null; found_by: string | null; answer?: unknown; answer_cut?: string[];
}

function boundedAnswer(raw: string | null): { answer: unknown; answer_cut?: string[] } {
  const body = readStored(parseStored(raw)).body ?? null;
  const fitted = budgetAnswer(body, AGENT_ANSWER_MAX_CHARS);
  return fitted.cut.length ? { answer: fitted.value, answer_cut: fitted.cut } : { answer: body };
}

// A run whose requests used saved API keys answered with what those keys can
// see: its stored answers need the 'secrets' scope, as running it does.
export function answersNeedSecrets(runId: string, userId: string, hasSecretsScope: boolean): string | null {
  const run = db.prepare('SELECT config, allow_secrets FROM http_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { config: string | null; allow_secrets: number | null } | undefined;
  if (!run) return null;
  const refs = httpRunSecretRefsRequiringScope(userId, run, hasSecretsScope);
  return refs.length ? `This run's requests used saved API key(s) (${refs.join(', ')}): reading its stored `
    + "answers needs the 'secrets' scope." : null;
}

// Per-row extras for a page of an enrichment run's results, by row index.
export function enrichResultExtras(
  runId: string, userId: string, rowIndexes: number[], answers: boolean,
): Map<number, EnrichResultExtra> {
  const out = new Map<number, EnrichResultExtra>();
  if (rowIndexes.length === 0) return out;
  const rows = db.prepare(`SELECT row_index, cost_usd, json_extract(response_data, '$._cubex.found_by') AS found_by
      ${answers ? ', response_data' : ''}
    FROM http_results WHERE run_id = ? AND user_id = ? AND row_index IN (SELECT value FROM json_each(?))`)
    .all(runId, userId, JSON.stringify(rowIndexes)) as Array<{
    row_index: number; cost_usd: number | null; found_by: unknown; response_data?: string | null;
  }>;
  for (const r of rows) {
    out.set(r.row_index, {
      cost_usd: r.cost_usd, found_by: typeof r.found_by === 'string' ? r.found_by : null,
      ...(answers ? boundedAnswer(r.response_data ?? null) : {}),
    });
  }
  return out;
}
