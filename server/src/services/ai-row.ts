import OpenAI from 'openai';
import { processPromptTemplate, extractAllowedDomainsFromRow } from '../lib/prompt';
import { extractCompletionText } from '../lib/completion-text';
import { redactSecrets } from '../lib/http-request';
import { aiMaxTokens, CELL_MAX_ENRICHMENT } from '../lib/constants';
import { WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_MAX_TOTAL_RESULTS } from '../lib/constants-ai';
import { stripControlChars, clampCellChars } from '../lib/csv-safety';
import { aiDataCellSummary } from '../lib/ai-data-cell';
import { shouldStop, type AIRunRow, type SheetRow } from './ai-runner-status';
import { STOP_SENTINEL, writeSuccess, writeFailure } from './ai-row-writers';
import { createCompletionWithConnectRetry, connectionCauseCode } from './openrouter-retry';

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
  // (Data) column only exists for runs with web SEARCH on. Web fetch returns no
  // caller-visible breadcrumb on chat-completions, so a Data column for
  // fetch-only runs would always be empty — see ai-run-start.ts.
  const needsDataColumn = !!run.use_openrouter_web_search;
  const ctx = {
    runId, userId: run.user_id, sheetId: run.sheet_id, rowIndex: row.rowIndex,
    columnName: run.column_name, inputValues: JSON.stringify(row.data),
    needsDataColumn, myGeneration,
  };

  try {
    const processedPrompt = processPromptTemplate(run.prompt, row.data);
    const usingTools = !!run.use_openrouter_web_search || !!run.use_web_fetch;

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

    const tools: any[] = [];
    if (run.use_openrouter_web_search) {
      // max_total_results caps the CUMULATIVE results across every search the
      // model chooses to run for one row — without it, result count is
      // unbounded and model-controlled (observed 2-4 searches/row, 10-20
      // results, 2-4x the advertised estimate).
      // This limits result/context exposure; pricing is engine-
      // dependent (native provider search even ignores max_results), so it is
      // NOT an absolute dollar ceiling — see constants-ai.ts.
      tools.push({
        type: 'openrouter:web_search',
        parameters: {
          max_results: WEB_SEARCH_MAX_RESULTS,
          max_total_results: WEB_SEARCH_MAX_TOTAL_RESULTS,
        },
      });
      // Search needs a "now" anchor for queries like "latest …"; datetime is free,
      // so always pair it with search rather than hand-injecting.
      tools.push({ type: 'openrouter:datetime' });
    }
    if (run.use_web_fetch) {
      // Per-row allowed_domains: only let the model fetch URLs whose host appears
      // in this row's URL-valued cells of /columns referenced in the prompt.
      // ALWAYS send parameters.allowed_domains, even when empty — omitting the
      // key entirely leaves the behavior up to OpenRouter's defaults, which are
      // not contractually documented and have historically meant "allow any
      // public URL." Sending an explicit empty list means "block everything,"
      // which is the safe-by-default behavior for a row whose URL columns are
      // unpopulated.
      const allowed = extractAllowedDomainsFromRow(run.prompt, row.data);
      tools.push({
        type: 'openrouter:web_fetch',
        parameters: { allowed_domains: allowed },
      });
    }

    // Every start/rerun path resolves and stores a user-chosen model, so a NULL
    // here means a legacy pre-default-era run resurrected by the queue. Fail the
    // row loudly (→ "❌ Error" cell + failed row record) rather than silently
    // billing the user on a model they never picked.
    if (!run.model) throw new Error('No AI model selected for this run. Start a new run from the AI column dialog.');
    const completionArgs: any = {
      model: run.model,
      messages,
      temperature: run.temperature ?? 0.7,
      // Floored so reasoning models can think AND answer (the old 1000 cap made
      // them return null content → silent blank cells); max_chars raises it.
      max_tokens: aiMaxTokens(run.max_chars),
      stream: false,
    };
    if (tools.length > 0) completionArgs.tools = tools;

    // One retry for the stale-keep-alive-socket ECONNRESET only (nothing was
    // generated/billed); every other failure keeps maxRetries:0 semantics.
    const completion = await createCompletionWithConnectRetry(
      openai, completionArgs, signal, () => shouldStop(runId, myGeneration),
    );

    // Throws (→ caught below, recorded as a `failed` row + "❌ Error" cell) when
    // the model returned no usable content — a reasoning model exhausting the
    // token budget, a refusal, a content filter — instead of writing a blank cell.
    let result = extractCompletionText(completion);
    if (run.max_chars && result.length > run.max_chars) result = result.substring(0, run.max_chars);
    // Strip control chars (same input policy as every other write path — P2-9)
    // and clamp to the enrichment cell cap (P2-8). Applied to the single `result`
    // BEFORE writeSuccess so ai_results.output_value == the cell == the SSE
    // replay all stay identical. max_chars (user's explicit choice) still applies
    // above; this is the hard storage ceiling on top.
    result = clampCellChars(stripControlChars(result), CELL_MAX_ENRICHMENT);

    const annotations = (completion.choices[0]?.message as any)?.annotations as
      | Array<{ type?: string; url_citation?: { url: string; title?: string; content?: string } }>
      | undefined;
    const citedUrls = (annotations || [])
      .filter(a => a?.type === 'url_citation' && a.url_citation?.url)
      .map(a => ({
        title: a.url_citation!.title || a.url_citation!.url,
        url: a.url_citation!.url,
        content: a.url_citation!.content || '',
        snippet: (a.url_citation!.content || '').slice(0, 200),
      }));

    const scrapedDataJson = citedUrls.length > 0 ? JSON.stringify(citedUrls) : null;
    // Shared with the SSE stream (ai-stream.ts) so the live (Data) cell == the
    // persisted one.
    const scrapedSummary = aiDataCellSummary(citedUrls);

    // Capture per-row token usage for cost reporting + history-based estimates.
    // Best-effort: some providers omit `usage`, and coerce anything non-numeric
    // (never let a malformed usage block fail the row) to null.
    const rawUsage = (completion as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
    const toTokenCount = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
    const usage = {
      promptTokens: toTokenCount(rawUsage?.prompt_tokens),
      completionTokens: toTokenCount(rawUsage?.completion_tokens),
    };

    // If the run was cancelled OR a resume bumped past us while this row's API
    // call was in flight, drop the result. Cheap early-out before opening a txn.
    if (shouldStop(runId, myGeneration)) return;

    writeSuccess(ctx, result, scrapedDataJson, scrapedSummary, usage);
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
    writeFailure(ctx, errorMessage);
  }
}
