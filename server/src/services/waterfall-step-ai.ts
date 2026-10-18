// An AI step of a waterfall row: one OpenRouter call (services/ai-model-call.ts,
// the AI columns' own), the prompt's /input words filled from the row's inputs,
// asked for one value as JSON ({"value": ... or null}), read as the result
// type reads it. A paid call is never repeated: only what was never sent or
// billed is retried (services/openrouter-retry.ts). An account problem (a key
// OpenRouter refuses, no credits, the model gone) stops the whole run with
// its message instead of failing every row; anything else is the step's error.
import type OpenAI from 'openai';
import { processPromptTemplate } from '../lib/prompt';
import { extractCompletionText } from '../lib/completion-text';
import { buildMultiOutputInstruction, parseMultiOutput } from '../lib/ai-multi-output';
import { buildWebTools, searchReplayFor, toolCallBudget } from '../lib/ai-web-tools';
import { classifyAiError } from '../lib/ai-error-classify';
import { redactSecrets } from '../lib/redact';
import { WATERFALL_AI_MAX_TOKENS, WATERFALL_AI_TEMPERATURE } from '../lib/constants';
import { normalizeResult, RESULT_INFO } from '../lib/waterfall/result-type';
import { traceDetail, traceValue } from '../lib/waterfall/trace';
import type { AiChoices, BuiltAi, WaterfallBlock } from '../lib/waterfall/config';
import { sendModelCall, FailedCallError, type ModelCall } from './ai-model-call';
import { withConnectRetry, errorCauseCode } from './openrouter-retry';
import { STOP, type StepResult, type StepRun } from './waterfall-step-types';

export interface AiStepArgs {
  w: WaterfallBlock;
  choices: AiChoices;
  built: BuiltAi;
  inputs: Record<string, string>;
  client: OpenAI;
  signal: AbortSignal;                 // ends waits only, never a call that went out
  stopped: () => boolean;
  halt: (message: string) => void;     // an account problem: the run stops with this message
}

const SYSTEM = 'You look up one fact for one row of a spreadsheet. Use the details given and, when you can '
  + 'search the web, what you find there. Never guess or make a value up: when you can\'t find it, answer null. '
  + 'Plain text values only, no markdown.';

const SPEC = (w: WaterfallBlock) => [{
  columnName: 'value', type: 'string' as const,
  description: `${RESULT_INFO[w.resultType].ask}, or null if you can't find it`,
}];

// The messages of one row's call (also what a preview shows).
export function aiMessages(w: WaterfallBlock, prompt: string, inputs: Record<string, string>) {
  const user = `${processPromptTemplate(prompt, inputs)}\n\n${buildMultiOutputInstruction(SPEC(w))}`;
  return [{ role: 'system' as const, content: SYSTEM }, { role: 'user' as const, content: user }];
}

function billed(call: ModelCall | null): Pick<StepRun, 'costUsd' | 'aiProviderUsd'> {
  return { costUsd: call?.usage.costUsd ?? 0, aiProviderUsd: call?.usage.providerCostUsd ?? 0 };
}

// A 429, like OpenRouter's 402 for too many calls in flight, is refused before
// anything is generated or billed: asked again after a wait, at most
// AI_429_RETRIES times. Anything else that failed may have been billed and is
// never sent again (services/openrouter-retry.ts says why).
const AI_429_RETRIES = 2;
const AI_429_WAIT_MS = [2_000, 6_000];
const status = (e: unknown): unknown => (e as { status?: unknown })?.status;
const waitable = (e: unknown): boolean => status(e) === 429
  || (status(e) === 402 && classifyAiError(e instanceof Error ? e.message : String(e)) === 'concurrency');

async function sendOnce(a: AiStepArgs, messages: ReturnType<typeof aiMessages>): Promise<ModelCall> {
  const search = a.built.search;
  const tools = buildWebTools(a.choices.prompt, a.inputs, { search, fetch: false });
  for (let tries = 0; ; tries++) {
    try {
      // No abort signal: a call that went out finishes, so what it cost is
      // counted (a stopped run drops the row's write; the journal keeps the answer).
      return await withConnectRetry(() => sendModelCall(a.client, {
        model: a.built.model, messages, temperature: WATERFALL_AI_TEMPERATURE, maxTokens: WATERFALL_AI_MAX_TOKENS,
        tools, searchReplay: search ? searchReplayFor(search) : null, maxToolCalls: toolCallBudget(search, false),
      }), a.signal, a.stopped);
    } catch (error) {
      if (!waitable(error) || tries >= AI_429_RETRIES || a.stopped()) throw error;
      await new Promise(resolve => setTimeout(resolve, AI_429_WAIT_MS[tries]));
      if (a.stopped()) throw error;
    }
  }
}

export async function aiStep(a: AiStepArgs): Promise<StepResult> {
  if (a.stopped()) return STOP;
  const messages = aiMessages(a.w, a.choices.prompt, a.inputs);
  let call: ModelCall;
  try {
    call = await sendOnce(a, messages);
  } catch (error) {
    // A failed response may have run (and billed) searches: its cost counts.
    const paid = billed(error instanceof FailedCallError ? error.call : null);
    const cost = paid.costUsd > 0 || (paid.aiProviderUsd ?? 0) > 0;
    if (a.stopped() && !cost) return STOP;
    const cause = errorCauseCode(error);
    const text = (error instanceof Error ? error.message : 'Unknown error') + (cause ? ` (${cause})` : '');
    const message = redactSecrets(text);
    if (classifyAiError(message) === 'configuration') {
      a.halt(`OpenRouter refused the AI step: ${message}`);
      // A refusal that still billed comes back as an error, so its cost reaches the run
      // (the halt keeps the row ⏳ for the resume all the same).
      if (!cost) return STOP;
    }
    return { outcome: 'error', value: '', detail: traceDetail(message), ...paid };
  }
  const paid = billed(call);
  let text: string;
  try {
    text = extractCompletionText(call.completion, { cleanMarkdown: false });
  } catch (error) {
    const why = error instanceof Error ? error.message : 'No answer.';
    return { outcome: 'error', value: '', detail: traceDetail(why), ...paid };
  }
  const parsed = parseMultiOutput(text, SPEC(a.w));
  if ('error' in parsed) return { outcome: 'error', value: '', detail: traceDetail(parsed.error), ...paid };
  const raw = parsed.ok.value ?? '';
  const value = normalizeResult(a.w.resultType, raw, a.w.phone);
  if (value) return { outcome: 'answered', value, ...paid };
  return { outcome: 'not_found', value: '', ...(raw ? { got: traceValue(raw) } : {}), ...paid };
}
