// Column details of HTTP API and enrichment columns, each from its newest run
// (one query per status column; a sheet holds at most a few hundred columns).
// The status column carries the request or the enrichment tool, auto-run and
// the rule; the value columns name it and say where in the answer they read.
// A request URL is shown with any credential typed into it masked, and header
// names only, never their values: any token that can read sees this.
import { db } from '../lib/db';
import { maskUrlSecrets, type ColumnDetail } from '../lib/column-details';
import { isEnrichmentConfig, type EnrichRunConfig } from '../lib/enrich-run-config';
import { requestColumns } from '../lib/autorun-rules';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import { autoRunPart, nextRunRule, parseJson, type DetailContext } from './column-details-context';

interface RunRow { id: string; status: string; config: string | null; dest_sheet_id: string | null }

const isHttpConfig = (c: unknown): c is HTTPAPIConfig =>
  !!(c as HTTPAPIConfig | null)?.requestConfig && Array.isArray((c as HTTPAPIConfig).responseMapping);

function enrichmentFill(ctx: DetailContext, run: RunRow, config: EnrichRunConfig): Record<string, unknown> {
  const e = config.enrichment;
  const dest = run.dest_sheet_id
    ? db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck().get(run.dest_sheet_id, ctx.userId)
    : undefined;
  return {
    run_id: run.id, run_status: run.status, tool_id: e.toolId, tool_name: e.toolName,
    max_cost_per_row_usd: e.maxCostPerRowUsd, spend_limit_usd: e.spendLimitUsd,
    ...(e.list ? { adds_rows_to: dest ?? null } : {}),
  };
}

function httpFill(ctx: DetailContext, column: string, run: RunRow, config: HTTPAPIConfig): Record<string, unknown> {
  const rc = config.requestConfig;
  return {
    run_id: run.id, run_status: run.status, method: rc.method,
    url: ctx.cut(column, maskUrlSecrets(String(rc.url ?? ''))),
    header_names: Object.keys(rc.headers ?? {}),
    output_columns: config.responseMapping.map(m => m.columnName),
  };
}

export function describeHttpColumns(ctx: DetailContext): Map<string, ColumnDetail> {
  const out = new Map<string, ColumnDetail>();
  const newest = db.prepare(`SELECT id, status, config, dest_sheet_id FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const configs = new Map<string, HTTPAPIConfig | null>();
  for (const column of ctx.columns) {
    const type = ctx.types[column];
    if (type !== 'http-master' && type !== 'enrich-status') continue;
    const run = newest.get(ctx.sheetId, ctx.userId, column) as RunRow | undefined;
    const parsed = parseJson(run?.config);
    const config = isHttpConfig(parsed) ? parsed : null;
    configs.set(column, config);
    const enrichment = type === 'enrich-status' && isEnrichmentConfig(config);
    const fill = !run || !config ? undefined
      : enrichment ? enrichmentFill(ctx, run, config as EnrichRunConfig) : httpFill(ctx, column, run, config);
    out.set(column, {
      name: column, kind: enrichment ? 'enrichment' : 'http', role: enrichment ? 'status' : 'response',
      ...(fill ? { fill } : {}), reads: config ? requestColumns(config, [...ctx.columns]) : [],
      ...autoRunPart(ctx, column), run_if: nextRunRule(ctx, column, config),
    });
  }
  // Value columns: the status column they hang off says which kind they are.
  for (const column of ctx.columns) {
    if (ctx.types[column] !== 'http-extracted') continue;
    const main = ctx.runState.get(column) ?? column;
    const mainDetail = out.get(main);
    if (main !== column && !mainDetail) continue;  // another kind's run fills it (its describer claims it)
    const path = configs.get(main)?.responseMapping.find(m => m.columnName === column)?.jsonPath;
    out.set(column, {
      name: column, kind: mainDetail?.kind === 'enrichment' ? 'enrichment' : 'http',
      role: mainDetail?.kind === 'enrichment' ? 'output' : 'field',
      ...(main !== column ? { filled_by: main } : {}), ...(path ? { fill: { json_path: path } } : {}),
    });
  }
  return out;
}
