// One short call to the person's model for something Cubex writes once from
// plain words (an "Only run if" rule, a formula): temperature 0 where the
// model takes one (a 400 naming it sends the call again without it, as a
// run's rows do). Returns the reply's text and what the call cost.
import { getOpenRouterClient } from './openrouter';
import { refusesTemperature } from './ai-model-call';
import { modelTakesTemperature } from '../lib/openrouter';
import { usageOf } from '../lib/responses-adapter';

export type WriterClient = Awaited<ReturnType<typeof getOpenRouterClient>>;

export async function askWriterModel(
  openai: WriterClient, model: string, system: string, user: string, maxTokens: number,
): Promise<{ text: string; cost: number | null }> {
  const body: Record<string, unknown> = {
    model, max_tokens: maxTokens, usage: { include: true },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (modelTakesTemperature(model) !== false) body.temperature = 0;
  let completion: any;
  try {
    completion = await openai.chat.completions.create(body as never);
  } catch (error) {
    if (!('temperature' in body) || !refusesTemperature(error)) throw error;
    delete body.temperature;
    completion = await openai.chat.completions.create(body as never);
  }
  return { text: completion?.choices?.[0]?.message?.content ?? '', cost: usageOf(completion).costUsd };
}
