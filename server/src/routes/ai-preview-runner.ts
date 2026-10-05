import type OpenAI from 'openai';
import { processPromptTemplate } from '../lib/prompt';
import { extractCompletionText } from '../lib/completion-text';
import { aiMaxTokens } from '../lib/constants';
import { buildWebTools } from '../lib/ai-web-tools';
import { citationsFromCompletion, type Citation } from '../lib/ai-citations';

interface PreviewArgs {
  prompt: string
  systemPrompt?: string
  model: string
  safeTemperature: number
  maxChars?: number
  useOpenRouterWebSearch: boolean
  useWebFetch: boolean
  // Structured (multi-column) preview: the model returns JSON, so the text must
  // NOT be markdown-cleaned — cleaning breaks ```json fences and strips * / # /
  // backticks out of JSON string values. Defaults to prose behavior.
  rawText?: boolean
  // Appended after the row's /references are filled in, exactly as the
  // structured runner appends its JSON instruction (ai-row-multi.ts).
  promptSuffix?: string
}

export interface PreviewRowResult {
  rowIndex: number
  value: string
  error?: string
  // Actual token usage OpenRouter reported for this row (non-streaming response
  // carries it). Surfaced so /preview can extrapolate an estimated token/cost for
  // the full run. Absent when the row errored before a completion came back.
  promptTokens?: number
  completionTokens?: number
  // Web search citations (url_citation annotations); [] without search.
  citations?: Citation[]
  // What OpenRouter charged for this row, web fees included, when the response
  // reports it (usage.cost). Absent otherwise; callers fall back to tokens.
  costUsd?: number
}

// Run a single row through OpenRouter for preview. Returns a result row including any
// per-row error so /preview can show partial success. `externalSignal` (the route's
// client-disconnect signal) aborts the OpenRouter call AND the 429 retry sleep early
// so a closed browser tab stops burning OpenRouter cost.
export const processOneRow = async (
  row: { rowIndex: number; data: Record<string, string> },
  openai: OpenAI,
  args: PreviewArgs,
  externalSignal?: AbortSignal,
): Promise<PreviewRowResult> => {
  try {
    const filled = processPromptTemplate(args.prompt, row.data);
    const processedPrompt = args.promptSuffix ? `${filled}\n\n${args.promptSuffix}` : filled;
    // A prose answer with web tools gets the runner's tools system message in
    // place of the user's (ai-row.ts); a structured (JSON) one keeps the user's
    // system prompt, as ai-row-multi.ts does.
    const proseWithTools = (args.useOpenRouterWebSearch || args.useWebFetch) && !args.rawText;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (args.systemPrompt && !proseWithTools) {
      messages.push({ role: 'system', content: args.systemPrompt });
    }
    if (proseWithTools) {
      messages.push({
        role: 'system',
        content: 'You are a helpful AI assistant. You can reference and analyze information from web search results and fetched pages when provided. Use that context to provide accurate, up-to-date information. Provide clean, plain text output without markdown formatting like **bold** or *italic*. When you cite sources, prefer plain URLs over markdown links.',
      });
    }
    messages.push({ role: 'user', content: processedPrompt });

    const baseArgs: any = {
      model: args.model,
      messages,
      temperature: args.safeTemperature,
      // Floored so reasoning models have room to think AND answer (the old 1000
      // cap made them return null content); maxChars raises it up to a ceiling.
      max_tokens: aiMaxTokens(args.maxChars),
      stream: false,
      // OpenRouter usage accounting: usage.cost is the row's real price, web
      // search and fetch fees included (tokens alone miss them).
      usage: { include: true },
    };
    // The production runners' exact tools (lib/ai-web-tools.ts): a preview must
    // cost and behave like the run it previews.
    const tools = buildWebTools(args.prompt, row.data, {
      search: args.useOpenRouterWebSearch, fetch: args.useWebFetch,
    });
    if (tools.length > 0) baseArgs.tools = tools;

    // 60s timeout per preview row. The OpenAI SDK's default would let a stuck request
    // hang for ~10min, which means an unreachable OpenRouter freezes the entire preview
    // UI. AbortError is then surfaced as a row-level error rather than killing the
    // whole preview. The controller also aborts when the route's client-disconnect
    // signal fires, so a closed tab cancels in-flight calls (manual wiring rather than
    // AbortSignal.any for portability across Node versions).
    const previewController = new AbortController();
    const previewTimeout = setTimeout(() => previewController.abort(), 60_000);
    const onExternalAbort = () => previewController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) previewController.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let completion;
    try {
      completion = await openai.chat.completions.create(baseArgs, { signal: previewController.signal });
    } catch (e: any) {
      if (e?.status === 401) throw new Error('Invalid OpenRouter API key. Please check your settings.');
      if (e?.status === 429) {
        // ONE 429 retry (preview only, UX: a transient rate-limit shouldn't fail the
        // sample row). Cost-safe: 429 is rejected BEFORE generation so it's not billed,
        // and the shared client now sets maxRetries:0 — so this is the ONLY retry, not
        // stacked on top of SDK retries (which previously let a sustained 429 hit ~6
        // attempts). Abortable 2s backoff so a disconnect/timeout doesn't sleep-then-
        // retry; the abort listener is removed on BOTH paths so it can't outlive the sleep.
        await new Promise<void>((resolve, reject) => {
          if (previewController.signal.aborted) return reject(new Error('aborted'));
          const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
          const t = setTimeout(() => { previewController.signal.removeEventListener('abort', onAbort); resolve(); }, 2000);
          previewController.signal.addEventListener('abort', onAbort, { once: true });
        });
        completion = await openai.chat.completions.create(baseArgs, { signal: previewController.signal });
      } else if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') {
        throw new Error('Preview timed out (60s). The model may be overloaded — try again.');
      } else throw e;
    } finally {
      clearTimeout(previewTimeout);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }

    // Throws (→ caught below as a per-row error) if the model returned no usable
    // content — a reasoning model hitting the token limit, a refusal, etc. — so
    // the row shows an "Error" badge instead of a silent blank.
    let result = extractCompletionText(completion, { cleanMarkdown: !args.rawText });
    // A structured reply is JSON: cutting it would break it, and the real run
    // never does (ai-row-multi.ts clamps each cell instead).
    if (!args.rawText && args.maxChars && result.length > args.maxChars) result = result.substring(0, args.maxChars);
    const usage = (completion as { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: unknown } }).usage;
    const cost = usage?.cost;
    return {
      rowIndex: row.rowIndex,
      value: result,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      citations: citationsFromCompletion(completion),
      ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return { rowIndex: row.rowIndex, value: '', error: `Failed to generate preview: ${msg}` };
  }
};
