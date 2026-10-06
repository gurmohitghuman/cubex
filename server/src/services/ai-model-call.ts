// One model call for one AI row, shared by the run rows (ai-row.ts,
// ai-row-multi.ts) and previews (routes/ai-preview-runner.ts). A row with web
// search goes through the Responses API, the only OpenRouter API that reports
// the searches the model ran (lib/responses-adapter.ts); every other row stays
// on Chat Completions. Either way the caller gets a chat-completion-shaped
// answer, the row's tokens and cost, and, with search, its search log.
import type OpenAI from 'openai';
import { modelTakesTemperature } from '../lib/openrouter';
import {
  completionFromResponse, responseError, searchLogFromResponse, usageOf,
  type ChatLikeCompletion, type SearchLog, type SearchReplay,
} from '../lib/responses-adapter';
import type { RowTokenUsage } from './ai-row-writers';

export interface ModelCallInput {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  maxTokens: number;
  tools: object[];
  // Set when the row searches: how to tell which search calls ran.
  searchReplay: SearchReplay | null;
  // The request's tool-call budget (ai-web-tools.ts toolCallBudget); null: OpenRouter's default.
  maxToolCalls?: number | null;
}

export interface ModelCall {
  completion: ChatLikeCompletion;
  usage: { promptTokens: number | null; completionTokens: number | null; costUsd: number | null };
  search: SearchLog | null;
}

// A response that came back failed. It may already have run (and billed)
// searches, so it carries what the call cost for the failed row's record.
export class FailedCallError extends Error {
  constructor(message: string, readonly call: ModelCall) { super(message); }
}

// A 400 whose message or provider detail names temperature: the model takes
// none. OpenRouter usually wraps a provider's refusal as "Provider returned
// error", with the provider's own text in error.metadata.raw.
export function refusesTemperature(error: unknown): boolean {
  const e = error as { status?: unknown; message?: unknown; error?: { message?: unknown; metadata?: { raw?: unknown } } };
  if (e?.status !== 400) return false;
  const text = [e.message, e.error?.message, e.error?.metadata?.raw]
    .map(v => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))).join(' ');
  return /temperature/i.test(text);
}

async function sendResponses(openai: OpenAI, input: ModelCallInput, replay: SearchReplay, signal?: AbortSignal): Promise<ModelCall> {
  const body: Record<string, unknown> = {
    model: input.model,
    input: input.messages,
    max_output_tokens: input.maxTokens,
    tools: input.tools,
    ...(input.maxToolCalls ? { max_tool_calls: input.maxToolCalls } : {}),
  };
  // OpenAI's reasoning models (gpt-6-luna among them) take no temperature.
  // Chat Completions drops it quietly. Here it's left out up front when
  // OpenRouter's model list says so; otherwise a 400 naming it sends the row
  // again without it (a 400 comes before anything is generated or billed).
  if (modelTakesTemperature(input.model) !== false) body.temperature = input.temperature;
  // The SDK's generic post, not responses.create: that one's output_text
  // helper throws on a failed response that has no output.
  let response: unknown;
  try {
    response = await openai.post('/responses', { body, signal });
  } catch (error) {
    if (!('temperature' in body) || !refusesTemperature(error)) throw error;
    delete body.temperature;
    response = await openai.post('/responses', { body, signal });
  }
  const completion = completionFromResponse(response);
  const call = { completion, usage: usageOf(completion), search: searchLogFromResponse(response, replay) };
  const failed = responseError(response);
  if (failed) throw new FailedCallError(failed, call);
  return call;
}

export async function sendModelCall(openai: OpenAI, input: ModelCallInput, signal?: AbortSignal): Promise<ModelCall> {
  if (input.searchReplay) return sendResponses(openai, input, input.searchReplay, signal);
  const completion = await openai.chat.completions.create({
    model: input.model,
    messages: input.messages,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    stream: false,
    // usage.cost is the row's real price, web fetch fees included.
    usage: { include: true },
    ...(input.tools.length > 0 ? { tools: input.tools } : {}),
    ...(input.maxToolCalls ? { max_tool_calls: input.maxToolCalls } : {}),
  } as never, { signal }) as unknown as ChatLikeCompletion;
  return { completion, usage: usageOf(completion), search: null };
}

// The ai_results spend fields of a call that came back (success or not).
export function rowUsage(call: ModelCall): RowTokenUsage {
  return {
    ...call.usage,
    webSearches: call.search ? call.search.searches : null,
    searchQueries: call.search ? JSON.stringify(call.search.queries) : null,
  };
}

// What a failed row's record keeps: the call that came back, or the one a
// failed response carried; nothing when no call came back.
export function billedUsage(call: ModelCall | null, error: unknown): RowTokenUsage | undefined {
  const billed = call ?? (error instanceof FailedCallError ? error.call : null);
  return billed ? rowUsage(billed) : undefined;
}
