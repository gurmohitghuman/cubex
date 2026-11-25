// save_only over REST and MCP (services/column-setup-save.ts): the run tools' choice to store a column's new
// setup and run nothing. Read after a start's preamble; what only a run takes is refused with it, so a call that
// meant to run (or to price one) never quietly saves instead.
import { parseBooleanOption } from '../lib/web-search-options';
import { webSearchSummary } from '../lib/web-search-plan';
import type { HTTPAPIConfig } from '../lib/http-request';
import { changedOf, type Changed } from '../mcp/changed';
import type { ServiceAnswer } from '../mcp/tool-outputs';
import type { RunParams } from '../routes/ai-run-parse';
import { startAiRun } from './ai-run-start';
import { startHttpRun } from './http-run-start';
import { startEnrichmentRun } from './enrich-run-start';
import { startWaterfallRun } from './waterfall-run-start';
import { dailyLimitOf } from './enrich-agent-shared';
import { snakeProviderField } from '../lib/enrich-provider-names';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import { db } from '../lib/db';
import { runIfReply } from './run-rule';
import type { TokenCaller, TokenRunResult } from './run-start-token';

// Arguments that only a run takes, as each tool spells them.
const RUN_ONLY = ['target_row_ids', 'preview_rows', 'webhook_id', 'max_cost_usd', 'allow_unpriced',
  'spend_limit_usd', 'idempotency_key', 'auto_run', 'test', 'rows', 'where', 'use_sheet_filter', 'dry_run'];

export const SAVED_NOTE = 'Saved as the column\'s setup. Nothing ran and nothing was billed: run_id is the setup\'s '
  + 'record (get_run_status shows 0 rows). control_run rerun with it runs the column this way; so do auto-run and the '
  + 'column\'s next run. Cells, and which rows read out of date, stay as they are.';

// true: save; false: a run (or an estimate) as before; or why the arguments can't go together.
export function saveOnlyOf(a: Record<string, unknown>): boolean | { error: string } {
  if (a.save_only === undefined) return false;
  const v = parseBooleanOption(a.save_only);
  if (a.save_only === null || v === 'invalid') return { error: 'save_only must be true or false' };
  if (!v) return false;
  if (parseBooleanOption(a.estimate_only) === true) {
    return { error: 'save_only and estimate_only can\'t go together: one stores the setup, the other prices a run.' };
  }
  const extra = RUN_ONLY.find(k => a[k] !== undefined);
  return extra ? { error: `${extra} is for a run; save_only runs nothing.` } : true;
}

// What a save changed: the columns it set up, no rows.
export const savedChanged = (userId: string, sheetId: string, columns: ReadonlyArray<string | null | undefined>):
  Changed[] => changedOf(userId, [{ sheetId, columns: columns.filter((c): c is string => !!c) }]);

// run_ai_column with save_only: the setup the start would store, as the column's.
export async function saveAiSetupOverToken(
  c: TokenCaller, sheetId: string, parsed: Extract<RunParams, { ok: true }>,
): Promise<TokenRunResult<ServiceAnswer<'run_ai_column'>>> {
  const result = await startAiRun(c.userId, {
    sheetId, cleanColumnName: parsed.cleanColumnName, prompt: parsed.prompt, systemPrompt: parsed.systemPrompt,
    model: parsed.model, useOpenRouterWebSearch: parsed.useOpenRouterWebSearch, useWebFetch: parsed.useWebFetch,
    safeTemperature: parsed.safeTemperature, safeConcurrency: parsed.safeConcurrency,
    safeMaxChars: parsed.safeMaxChars, outputColumns: parsed.outputColumns, search: parsed.search,
    runIf: parsed.runIf, fetchLimits: parsed.fetchLimits, saveOnly: true,
  });
  if ('fail' in result) return result;
  return {
    ok: {
      saved: true, run_id: result.ok.runId, output_column: result.ok.outputColumn,
      data_column: result.ok.dataColumn ?? null,
      ...(result.ok.webSearch ? { web_search: webSearchSummary(result.ok.webSearch) } : {}),
      ...(result.ok.runIf ? runIfReply(result.ok.runIf) : {}), note: SAVED_NOTE,
    },
    started: false,
    changed: savedChanged(c.userId, sheetId, [result.ok.outputColumn, result.ok.dataColumn]),
  };
}

// run_http_enrichment with save_only. curlPart: the keys a cURL command saved, and its notes.
export async function saveHttpSetupOverToken(
  c: TokenCaller, sheetId: string, config: HTTPAPIConfig, master: string | undefined, hasSecretsScope: boolean,
  curlPart: { saved_keys?: string[]; notes?: string[] },
): Promise<TokenRunResult<ServiceAnswer<'run_http_enrichment'>>> {
  const result = await startHttpRun(c.userId, {
    sheetId, config, masterColumnName: master, allowSecrets: hasSecretsScope, saveOnly: true,
  });
  if ('fail' in result) return result;
  return {
    ok: {
      saved: true, run_id: result.ok.runId, master_column: result.ok.masterColumn,
      mapped_columns: result.ok.mappedColumns,
      ...(result.ok.runIf ? runIfReply(result.ok.runIf) : {}), ...curlPart, note: SAVED_NOTE,
    },
    started: false,
    changed: savedChanged(c.userId, sheetId, [result.ok.masterColumn, ...result.ok.mappedColumns]),
  };
}

// run_enrichment with save_only: the setup's limits as stored, so the answer says what its next run sends.
export async function saveEnrichmentOverToken(
  c: TokenCaller, sheetId: string, input: EnrichRunInput,
): Promise<TokenRunResult<ServiceAnswer<'run_enrichment'>>> {
  const out = await startEnrichmentRun(c.userId, sheetId, input);
  if ('fail' in out) return out.fail === 'bad_request' ? { ...out, message: snakeProviderField(out.message) } : out;
  const stored = JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ? AND user_id = ?').pluck()
    .get(out.ok.runId, c.userId) as string) as {
      runIf?: string; enrichment: { maxCostPerRowUsd: number | null; spendLimitUsd: number | null };
    };
  const notes = out.ok.notes?.map(snakeProviderField) ?? [];
  return {
    ok: {
      saved: true, run_id: out.ok.runId, run_type: 'enrichment', status_column: out.ok.statusColumn,
      output_columns: out.ok.outputColumns,
      destination_sheet_id: null, test_rows: null, max_cost_per_row_usd: stored.enrichment.maxCostPerRowUsd,
      spend_limit_usd: stored.enrichment.spendLimitUsd, daily_limit: dailyLimitOf(c.userId),
      ...(stored.runIf ? runIfReply(stored.runIf) : {}), ...(notes.length ? { notes } : {}), note: SAVED_NOTE,
    },
    started: false,
    changed: savedChanged(c.userId, sheetId, [out.ok.statusColumn, ...out.ok.outputColumns]),
  };
}

// waterfall_column with save_only. A step reading a saved key needs the 'secrets' scope, as its run would.
export async function saveWaterfallOverToken(
  c: TokenCaller, sheetId: string, input: WaterfallRunInput,
): Promise<TokenRunResult<ServiceAnswer<'waterfall_column'>>> {
  const out = await startWaterfallRun(c.userId, sheetId, input, { hasSecretsScope: c.scopes.has('secrets') });
  if ('fail' in out) return out.fail === 'bad_request' ? { ...out, message: snakeProviderField(out.message) } : out;
  const notes = out.ok.notes?.map(snakeProviderField) ?? [];
  return {
    ok: {
      saved: true, run_id: out.ok.runId, run_type: 'waterfall', result_column: out.ok.resultColumn,
      output_columns: out.ok.outputColumns,
      ...(notes.length ? { notes } : {}), note: SAVED_NOTE,
    },
    started: false,
    changed: savedChanged(c.userId, sheetId, [out.ok.resultColumn, ...out.ok.outputColumns]),
  };
}
