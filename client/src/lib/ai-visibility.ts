// AI visibility tables: the engines a table can ask, as the server names them
// (server/src/lib/ai-visibility/engines.ts), and the create form's limits
// (server/src/lib/constants-ai-visibility.ts).
export const AI_ENGINES = [
  { id: 'chatgpt', name: 'ChatGPT', defaultOn: true },
  { id: 'gemini', name: 'Gemini', defaultOn: true },
  { id: 'ai_mode', name: 'Google AI Mode', defaultOn: true },
  { id: 'perplexity', name: 'Perplexity', defaultOn: true },
  { id: 'copilot', name: 'Copilot', defaultOn: false },
] as const
export type AiEngineId = (typeof AI_ENGINES)[number]['id']

export const AI_VISIBILITY_MAX_QUESTIONS = 100
export const AI_VISIBILITY_MAX_COMPETITORS = 20
// Making a table checks treg's catalog, then fills up to 7 free columns one after another.
export const AI_VISIBILITY_CREATE_TIMEOUT_MS = 180_000

// One entry per line (or comma, for brands), blanks dropped.
export const linesOf = (text: string, commas = false): string[] =>
  text.split(commas ? /[\n,]/ : /\n/).map(s => s.trim()).filter(Boolean)
