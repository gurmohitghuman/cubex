import OpenAI from 'openai';
import { processPromptTemplate } from '../lib/prompt';
import { extractCompletionText } from '../lib/completion-text';
import { redactSecrets } from '../lib/http-request';
import { aiMaxTokens, CELL_MAX_ENRICHMENT } from '../lib/constants';
import { stripControlChars, clampCellChars } from '../lib/csv-safety';
import {
  buildMultiOutputInstruction, parseMultiOutput, type OutputColumnSpec,
} from '../lib/ai-multi-output';
import { shouldStop, type AIRunRow, type SheetRow } from './ai-runner-status';
import { STOP_SENTINEL } from './ai-row-writers';
import { writeMultiSuccess, writeMultiFailure, type MultiWriteCtx } from './ai-row-writers-multi';
import { createCompletionWithConnectRetry, connectionCauseCode } from './openrouter-retry';

// Process one row of a STRUCTURED (multi-column) run: build the prompt + JSON
// instruction, call OpenRouter once, parse the JSON object into N typed columns,
// and hand success/failure to the multi writers. No web tools (parse rejects the
// combo). Mirrors ai-row.ts's error handling (abort/stop are benign drops).
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

  try {
    const processedPrompt = processPromptTemplate(run.prompt, row.data);
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (run.system_prompt) messages.push({ role: 'system', content: run.system_prompt });
    messages.push({ role: 'user', content: `${processedPrompt}\n\n${buildMultiOutputInstruction(specs)}` });

    if (!run.model) throw new Error('No AI model selected for this run. Start a new run from the AI column dialog.');
    const completion = await createCompletionWithConnectRetry(
      openai,
      { model: run.model, messages, temperature: run.temperature ?? 0.7, max_tokens: aiMaxTokens(run.max_chars), stream: false },
      signal, () => shouldStop(runId, myGeneration),
    );

    // cleanMarkdown:false — this text is JSON, not prose. Cleaning it breaks a
    // ```json fence into an unmatchable `json…` residue (every fenced row would
    // fail) and strips * / # / backticks out of JSON string VALUES (silent data
    // corruption on rows that do parse). Error detection above still applies.
    const rawText = extractCompletionText(completion, { cleanMarkdown: false });
    const rawUsage = (completion as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
    const toTokenCount = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
    const usage = {
      promptTokens: toTokenCount(rawUsage?.prompt_tokens),
      completionTokens: toTokenCount(rawUsage?.completion_tokens),
    };

    if (shouldStop(runId, myGeneration)) return;

    const parsed = parseMultiOutput(rawText, specs);
    if ('error' in parsed) {
      writeMultiFailure(ctx, outputNames, parsed.error);
      return;
    }
    // Apply the same per-cell input policy as the single-column path: strip
    // control chars + clamp to the enrichment cell cap.
    const values: Record<string, string> = {};
    for (const col of outputNames) {
      values[col] = clampCellChars(stripControlChars(parsed.ok[col] ?? ''), CELL_MAX_ENRICHMENT);
    }
    writeMultiSuccess(ctx, values, clampCellChars(rawText, CELL_MAX_ENRICHMENT), usage);
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
    writeMultiFailure(ctx, outputNames, errorMessage);
  }
}
