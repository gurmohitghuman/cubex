// What a run control would cost, before it runs (a pure read): the column
// menu's "Run N empty or out-of-date rows" and "Force run all N rows" confirm,
// and a cell's play button. Each kind prices the rows its own rerun would
// take, with the column's own settings: an AI column renders its prompt over
// them (services/run-estimate.ts), an HTTP API column has no price (only its
// rows), an enrichment and a waterfall quote their own estimate and run limit.
import { db } from '../lib/db';
import { existingRowIndexes } from '../lib/run-rows';
import type { OutputColumnSpec } from '../lib/ai-multi-output';
import type { SearchOptions, SearchEngine } from '../lib/web-search-options';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import { estimateAiRun } from './run-estimate';
import { estimateHttpRun } from './run-estimate-http';
import { resolveRerunTargets } from './ai-rerun-modes';
import { rerunEnrichmentColumn } from './enrich-rerun';
import { rerunWaterfallColumn } from './waterfall-rerun';
import type { RunFail } from './run-shared';
import type { RunColumn, RunKind } from './run-controls-column';
import { enrichRowsOf, modeOf, NOTHING, type RunTarget } from './run-controls-target';

export interface RunControlEstimate {
  kind: RunKind; column: string; rows: number;
  // null: no price is known (an HTTP API, a provider billing your own key, a model without a price).
  lowUsd: number | null; highUsd: number | null;
  // 'range': lowUsd to highUsd; 'average_max': about lowUsd a row on average, at most highUsd (a waterfall).
  basis: 'range' | 'average_max';
  // An enrichment's or a waterfall's run limit at these figures (the start keeps it).
  spendLimitUsd: number | null;
  reusedRows: number;        // an enrichment's rows reusing a found answer at $0
  note: string | null;
}
type Outcome = { ok: RunControlEstimate } | RunFail;

interface AiSettings {
  prompt: string; system_prompt: string | null; model: string | null; use_openrouter_web_search: number;
  use_web_fetch: number; max_chars: number | null; output_columns: string | null; run_if: string | null;
  concurrency: number; web_search_engine: string | null; web_search_mode: string | null;
  web_search_max_per_row: number | null;
}

// The column's newest run's settings (never target_rows: a rerun's can list a million rows).
const latestAi = (sheetId: string, userId: string, main: string) => db.prepare(`SELECT prompt, system_prompt, model,
    use_openrouter_web_search, use_web_fetch, max_chars, output_columns, run_if, concurrency, web_search_engine,
    web_search_mode, web_search_max_per_row
  FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
  .get(sheetId, userId, main) as AiSettings | undefined;

// The rows an AI or HTTP rerun takes; null: every row (the estimate counts the sheet).
async function rerunRows(sheetId: string, userId: string, main: string, t: RunTarget): Promise<number[] | null> {
  if ('row' in t) return existingRowIndexes(sheetId, userId, [t.row]);
  return t.rows === 'all' ? null : resolveRerunTargets(sheetId, userId, main, modeOf(t));
}

async function estimateAi(userId: string, sheetId: string, main: string, t: RunTarget): Promise<Outcome> {
  const run = latestAi(sheetId, userId, main);
  if (!run) return { fail: 'not_found', message: 'No AI run found for this column' };
  const targets = await rerunRows(sheetId, userId, main, t);
  if (targets?.length === 0) return NOTHING;
  const est = await estimateAiRun(userId, {
    sheetId, prompt: run.prompt, systemPrompt: run.system_prompt ?? undefined, model: run.model ?? undefined,
    useOpenRouterWebSearch: !!run.use_openrouter_web_search, useWebFetch: !!run.use_web_fetch,
    outputColumns: run.output_columns ? JSON.parse(run.output_columns) as OutputColumnSpec[] : undefined,
    maxChars: run.max_chars, targetRowIndexes: targets ?? undefined, runIf: run.run_if, concurrency: run.concurrency,
    search: run.use_openrouter_web_search ? {
      engine: (run.web_search_engine ?? 'auto') as SearchEngine, mode: run.web_search_mode,
      maxPerRow: run.web_search_max_per_row,
    } satisfies SearchOptions : null,
  });
  if ('fail' in est) return est.fail === 'no_rows' ? NOTHING : { fail: est.fail, message: est.message };
  const cost = est.ok.estimated_cost_usd;
  return {
    ok: {
      kind: 'ai', column: main, rows: est.ok.rows_to_process, lowUsd: cost?.low ?? null, highUsd: cost?.high ?? null,
      basis: 'range', spendLimitUsd: null, reusedRows: 0,
      note: cost ? null : est.ok.model ? `No price is known for ${est.ok.model}.` : 'No AI model is set for it.',
    },
  };
}

async function estimateHttp(userId: string, sheetId: string, main: string, t: RunTarget): Promise<Outcome> {
  const config = db.prepare(`SELECT config FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck().get(sheetId, userId, main) as string | undefined;
  if (!config) return { fail: 'not_found', message: 'No HTTP run found for this column' };
  const targets = await rerunRows(sheetId, userId, main, t);
  if (targets?.length === 0) return NOTHING;
  const est = await estimateHttpRun(userId, sheetId, targets ?? undefined, (JSON.parse(config) as HTTPAPIConfig).runIf);
  if ('fail' in est) return est.fail === 'no_rows' ? NOTHING : { fail: est.fail, message: est.message };
  return {
    ok: {
      kind: 'http', column: main, rows: est.ok.rows_to_process, lowUsd: null, highUsd: null, basis: 'range',
      spendLimitUsd: null, reusedRows: 0, note: 'Sends one request a row to your API: Cubex has no price for it.',
    },
  };
}

export async function estimateRunControl(
  userId: string, sheetId: string, col: RunColumn, t: RunTarget, rowGeneration: number | null,
): Promise<Outcome> {
  if (col.kind === 'ai') return estimateAi(userId, sheetId, col.main, t);
  if (col.kind === 'http') return estimateHttp(userId, sheetId, col.main, t);
  const rows = enrichRowsOf(t);
  if (col.kind === 'enrichment') {
    const out = await rerunEnrichmentColumn(userId, sheetId, {
      column: col.main, rows, estimateOnly: true, spendLimitUsd: null, rowGeneration,
    });
    if ('fail' in out) return out;
    if (!('estimate' in out.ok)) return { fail: 'bad_request', message: 'It couldn\'t be priced.' };
    const e = out.ok.estimate;
    return {
      ok: {
        kind: 'enrichment', column: col.main, rows: e.rows, lowUsd: e.priceKnown ? e.lowUsd : null,
        highUsd: e.priceKnown ? e.highUsd : null, basis: 'range', spendLimitUsd: e.spendLimitUsd,
        reusedRows: e.reusedRows, note: e.priceKnown ? null : 'Billed by the provider on your own key.',
      },
    };
  }
  const out = await rerunWaterfallColumn(userId, sheetId, {
    column: col.main, status: rows.status, rowIndexes: rows.rowIndexes, test: null, rowGeneration, fresh: false,
    noReuse: false, spendLimitUsd: null,
  }, { estimateOnly: true, hasSecretsScope: true });
  if ('fail' in out) return out;
  if (!('estimate' in out.ok)) return { fail: 'bad_request', message: 'It couldn\'t be priced.' };
  const e = out.ok.estimate;
  return {
    ok: {
      kind: 'waterfall', column: col.main, rows: e.rows, lowUsd: e.total.average_usd, highUsd: e.total.max_usd,
      basis: 'average_max', spendLimitUsd: e.run_limit_usd, reusedRows: 0, note: e.notes[0] ?? null,
    },
  };
}
