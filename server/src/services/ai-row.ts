import OpenAI from 'openai';
import { processPromptTemplate } from '../lib/prompt';
import { extractCompletionText } from '../lib/completion-text';
import { redactSecrets } from '../lib/http-request';
import { aiMaxTokens, CELL_MAX_ENRICHMENT } from '../lib/constants';
import { stripControlChars, clampCellChars } from '../lib/csv-safety';
import { aiDataCellSummary } from '../lib/ai-data-cell';
import { buildWebTools, runSearchConfig, searchReplayFor, toolCallBudget } from '../lib/ai-web-tools';
import { citationsFromCompletion } from '../lib/ai-citations';
import { aiRunDataColumn } from '../lib/ai-data-column';
import { shouldStop, type AIRunRow, type SheetRow } from './ai-runner-status';
import { STOP_SENTINEL, writeSuccess, writeFailure } from './ai-row-writers';
import { withConnectRetry, connectionCauseCode } from './openrouter-retry';
import { sendModelCall, rowUsage, billedUsage, type ModelCall } from './ai-model-call';

// Process a single sheet row: build messages, call OpenRouter, then hand the
// result (or error) to the transactional writers in ai-row-writers.ts.
export async function processRow(
  runId: string,
  row: SheetRow,
  run: AIRunRow,
  openai: OpenAI,
  signal: AbortSignal | undefined,
  myGeneration: number,
): Promise<void> {
  // Structured (multi-column) runs take a separate processor: one call → a JSON
  // object → N typed columns + status. Delegated whole so this stays the
  // single-column path.
  if (run.output_columns) {
    const { processMultiRow } = await import('./ai-row-multi');
    return processMultiRow(runId, row, run, openai, signal, myGeneration);
  }
  // (Data) column only exists for runs with web SEARCH on (lib/ai-data-column.ts).
  // Web fetch returns no caller-visible breadcrumb on chat-completions, and a
  // free-text answer has no room for a sources list (structured runs ask for one).
  const needsDataColumn = aiRunDataColumn(run) !== null;
  const ctx = {
    runId, userId: run.user_id, sheetId: run.sheet_id, rowIndex: row.rowIndex,
    columnName: run.column_name, inputValues: JSON.stringify(row.data),
    needsDataColumn, myGeneration,
  };

  // Set once the call comes back, so a failure after it (an unusable answer)
  // still records what that billed call cost and searched (as does a failed
  // response: billedUsage).
  let call: ModelCall | null = null;
  try {
    const processedPrompt = processPromptTemplate(run.prompt, row.data);
    const search = runSearchConfig(run);
    const usingTools = !!search || !!run.use_web_fetch;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (run.system_prompt && !usingTools) {
      messages.push({ role: 'system', content: run.system_prompt });
    }
    if (usingTools) {
      messages.push({
        role: 'system',
        content: 'You are a helpful AI assistant. You can reference and analyze information from web search results and fetched pages when provided. Use that context to provide accurate, up-to-date information. Provide clean, plain text output without markdown formatting like **bold** or *italic*. When you cite sources, prefer plain URLs over markdown links.',
      });
    }
    messages.push({ role: 'user', content: processedPrompt });

    // Web search (+ datetime) and per-row domain-limited web fetch: lib/ai-web-tools.ts.
    const tools = buildWebTools(run.prompt, row.data, { search, fetch: !!run.use_web_fetch });

    // Every start/rerun path resolves and stores a user-chosen model, so a NULL
    // here means a legacy pre-default-era run resurrected by the queue. Fail the
    // row loudly (→ "❌ Error" cell + failed row record) rather than silently
    // billing the user on a model they never picked.
    const model = run.model;
    if (!model) throw new Error('No AI model selected for this run. Start a new run from the AI column dialog.');

    // One retry for the stale-keep-alive-socket ECONNRESET only (nothing was
    // generated/billed); every other failure keeps maxRetries:0 semantics.
    // Floored max_tokens so reasoning models can think AND answer (the old 1000
    // cap made them return null content → silent blank cells); max_chars raises it.
    call = await withConnectRetry(() => sendModelCall(openai, {
      model, messages, temperature: run.temperature ?? 0.7, maxTokens: aiMaxTokens(run.max_chars),
      tools, searchReplay: search ? searchReplayFor(search) : null, maxToolCalls: toolCallBudget(search, !!run.use_web_fetch),
    }, signal), signal, () => shouldStop(runId, myGeneration));

    // Throws (→ caught below, recorded as a `failed` row + "❌ Error" cell) when
    // the model returned no usable content — a reasoning model exhausting the
    // token budget, a refusal, a content filter — instead of writing a blank cell.
    let result = extractCompletionText(call.completion);
    if (run.max_chars && result.length > run.max_chars) result = result.substring(0, run.max_chars);
    // Strip control chars (same input policy as every other write path — P2-9)
    // and clamp to the enrichment cell cap (P2-8). Applied to the single `result`
    // BEFORE writeSuccess so ai_results.output_value == the cell == the SSE
    // replay all stay identical. max_chars (user's explicit choice) still applies
    // above; this is the hard storage ceiling on top.
    result = clampCellChars(stripControlChars(result), CELL_MAX_ENRICHMENT);

    const citedUrls = citationsFromCompletion(call.completion);
    const scrapedDataJson = citedUrls.length > 0 ? JSON.stringify(citedUrls) : null;
    // Built from the same stored fields the SSE stream (ai-stream.ts) reads, so
    // the live (Data) cell == the persisted one: sources, searches and cost.
    const scrapedSummary = aiDataCellSummary(citedUrls, 'Searched', {
      queries: call.search?.queries ?? null, costUsd: call.usage.costUsd,
    });

    // If the run was cancelled OR a resume bumped past us while this row's API
    // call was in flight, drop the result. Cheap early-out before opening a txn.
    if (shouldStop(runId, myGeneration)) return;

    // Tokens and cost for cost reporting + history-based estimates, best-effort
    // (null when the provider omits them), plus the row's searches.
    writeSuccess(ctx, result, scrapedDataJson, scrapedSummary, rowUsage(call));
  } catch (error) {
    // Our own in-txn stop sentinel: the run was cancelled/superseded, the write
    // rolled back. Benign — drop without recording a failure.
    if (error === STOP_SENTINEL) return;
    // If the row failed because we aborted it (or the run was cancelled mid-flight),
    // don't record it as a failure — the user explicitly stopped this run.
    const aborted =
      (error as { name?: string })?.name === 'AbortError' ||
      (error as { name?: string })?.name === 'APIUserAbortError' ||
      signal?.aborted === true;
    if (aborted || shouldStop(runId, myGeneration)) return;

    // Append the transport cause code ("Connection error. (ECONNRESET)") so a
    // user-reported cell tells us WHICH transport failure it was — the SDK's
    // bare message hides whether the stale-socket retry missed or the retry
    // itself failed again.
    const causeCode = connectionCauseCode(error);
    const rawErrorMessage = (error instanceof Error ? error.message : 'Unknown error')
      + (causeCode ? ` (${causeCode})` : '');
    // Redact API-key-shaped tokens before logging or persisting. OpenRouter 401
    // responses sometimes echo the offending key prefix; without this those keys
    // would land in server logs AND in ai_results.error_message.
    const errorMessage = redactSecrets(rawErrorMessage);
    console.error(`Row ${row.rowIndex} processing error:`, errorMessage);
    writeFailure(ctx, errorMessage, billedUsage(call, error));
  }
}
