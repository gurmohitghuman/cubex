import OpenAI from 'openai';
import { processPromptTemplate, extractAllowedDomainsFromRow } from '../lib/prompt';
import { extractCompletionText } from '../lib/completion-text';
import { redactSecrets } from '../lib/http-request';
import { aiMaxTokens, CELL_MAX_ENRICHMENT } from '../lib/constants';
import { stripControlChars, clampCellChars } from '../lib/csv-safety';
import {
  buildMultiOutputInstruction, parseMultiOutput, sourcesFromOutput, type OutputColumnSpec,
} from '../lib/ai-multi-output';
import { buildWebTools, runSearchConfig, searchReplayFor, toolCallBudget } from '../lib/ai-web-tools';
import { citationsFromCompletion, withSourceUrls } from '../lib/ai-citations';
import { aiDataCellSummary } from '../lib/ai-data-cell';
import { shouldStop, type AIRunRow, type SheetRow } from './ai-runner-status';
import { STOP_SENTINEL } from './ai-row-writers';
import { writeMultiSuccess, writeMultiFailure, type MultiWriteCtx } from './ai-row-writers-multi';
import { withConnectRetry, connectionCauseCode } from './openrouter-retry';
import { sendModelCall, rowUsage, billedUsage, type ModelCall } from './ai-model-call';

// Process one row of a STRUCTURED (multi-column) run: build the prompt + JSON
// instruction, call OpenRouter once, parse the JSON object into N typed columns,
// and hand success/failure to the multi writers. With web search or web fetch
// on, the model gets those tools and also lists the URLs it used; those plus the
// search citations fill the run's "(Data)" column. Mirrors ai-row.ts's error
// handling (abort/stop are benign drops).
export async function processMultiRow(
  runId: string,
  row: SheetRow,
  run: AIRunRow,
  openai: OpenAI,
  signal: AbortSignal | undefined,
  myGeneration: number,
): Promise<void> {
  const specs = JSON.parse(run.output_columns as string) as OutputColumnSpec[];
  const statusColumn = run.status_column || run.column_name;
  const ctx: MultiWriteCtx = {
    runId, userId: run.user_id, sheetId: run.sheet_id, rowIndex: row.rowIndex,
    inputValues: JSON.stringify(row.data), statusColumn, myGeneration,
  };
  const outputNames = specs.map(s => s.columnName);
  const search = runSearchConfig(run);
  const web = { search: !!search, fetch: !!run.use_web_fetch };
  const dataColumn = run.data_column || null;
  // Cleared with the outputs on failure, so no cell is stranded on the placeholder.
  const blankOnFailure = dataColumn ? [...outputNames, dataColumn] : outputNames;
  // Set once the call comes back: a failure after it still records its cost.
  let call: ModelCall | null = null;

  try {
    const processedPrompt = processPromptTemplate(run.prompt, row.data);
    const withSources = web.search || web.fetch;
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (run.system_prompt) messages.push({ role: 'system', content: run.system_prompt });
    messages.push({ role: 'user', content: `${processedPrompt}\n\n${buildMultiOutputInstruction(specs, { withSources })}` });

    const model = run.model;
    if (!model) throw new Error('No AI model selected for this run. Start a new run from the AI column dialog.');
    const tools = buildWebTools(run.prompt, row.data, { search, fetch: web.fetch });
    call = await withConnectRetry(() => sendModelCall(openai, {
      model, messages, temperature: run.temperature ?? 0.7, maxTokens: aiMaxTokens(run.max_chars),
      tools, searchReplay: search ? searchReplayFor(search) : null, maxToolCalls: toolCallBudget(search, web.fetch),
    }, signal), signal, () => shouldStop(runId, myGeneration));
    const usage = rowUsage(call);

    // cleanMarkdown:false — this text is JSON, not prose. Cleaning it breaks a
    // ```json fence into an unmatchable `json…` residue (every fenced row would
    // fail) and strips * / # / backticks out of JSON string VALUES (silent data
    // corruption on rows that do parse). Error detection above still applies.
    const rawText = extractCompletionText(call.completion, { cleanMarkdown: false });

    if (shouldStop(runId, myGeneration)) return;

    const parsed = parseMultiOutput(rawText, specs);
    if ('error' in parsed) {
      writeMultiFailure(ctx, blankOnFailure, parsed.error, usage);
      return;
    }
    // Apply the same per-cell input policy as the single-column path: strip
    // control chars + clamp to the enrichment cell cap.
    const values: Record<string, string> = {};
    for (const col of outputNames) {
      values[col] = clampCellChars(stripControlChars(parsed.ok[col] ?? ''), CELL_MAX_ENRICHMENT);
    }
    let sources;
    if (dataColumn) {
      // Listed pages count only on hosts this row could reach (ai-citations.ts).
      const fetchHosts = web.fetch ? extractAllowedDomainsFromRow(run.prompt, row.data) : [];
      const cited = withSourceUrls(citationsFromCompletion(call.completion), sourcesFromOutput(rawText), fetchHosts);
      const summary = aiDataCellSummary(cited, web.search ? 'Searched' : 'Read', {
        queries: call.search?.queries ?? null, costUsd: call.usage.costUsd,
      });
      sources = {
        column: dataColumn,
        summary: clampCellChars(stripControlChars(summary), CELL_MAX_ENRICHMENT),
        json: cited.length > 0 ? JSON.stringify(cited) : null,
      };
    }
    writeMultiSuccess(ctx, values, clampCellChars(rawText, CELL_MAX_ENRICHMENT), usage, sources);
  } catch (error) {
    if (error === STOP_SENTINEL) return;
    const aborted =
      (error as { name?: string })?.name === 'AbortError' ||
      (error as { name?: string })?.name === 'APIUserAbortError' ||
      signal?.aborted === true;
    if (aborted || shouldStop(runId, myGeneration)) return;
    const causeCode = connectionCauseCode(error);
    const rawMsg = (error instanceof Error ? error.message : 'Unknown error') + (causeCode ? ` (${causeCode})` : '');
    const errorMessage = redactSecrets(rawMsg);
    console.error(`Multi-row ${row.rowIndex} processing error:`, errorMessage);
    writeMultiFailure(ctx, blankOnFailure, errorMessage, billedUsage(call, error));
  }
}
