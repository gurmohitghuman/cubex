// The AI engines an AI visibility table asks (pure): the treg tool each one
// runs on, the inputs a question and its country go to, where the answer and
// its cited sources are, and the fields of a source each keeps. The cloro tools
// answer as each engine's own app does (Gemini's and AI Mode's catalog
// examples show their sources empty, so their runs name that list). Perplexity
// runs on treg's job pinned to its model-API provider: cloro's Perplexity
// answers too rarely to rely on, and a job that adds rows asks one provider.
export type EngineId = 'chatgpt' | 'gemini' | 'ai_mode' | 'perplexity' | 'copilot';

export interface EngineSpec {
  id: EngineId;
  name: string;                  // its status column, and the Engine of the sites it cites
  toolId: string;
  questionInput: string;
  countryInput: string;
  answerPath: string;            // the answer text
  sourcesPath: string;           // the cited sources, added as rows
  namesSources: boolean;         // the run names sourcesPath (the catalog lists no results for the tool)
  provider: string | null;       // a waterfall's one provider
  fields: { url: string; title: string; position: string | null };
  defaultOn: boolean;
}

const CLORO_FIELDS = { url: '$.url', title: '$.label', position: '$.position' };
const cloro = (id: EngineId, name: string, toolId: string, extra: Partial<EngineSpec> = {}): EngineSpec => ({
  id, name, toolId, questionInput: 'prompt', countryInput: 'country', answerPath: '$.result.text',
  sourcesPath: '$.result.sources', namesSources: false, provider: null, fields: CLORO_FIELDS, defaultOn: true,
  ...extra,
});

export const ENGINES: readonly EngineSpec[] = [
  cloro('chatgpt', 'ChatGPT', 'cloro.ai-search.chatgpt.scrape'),
  cloro('gemini', 'Gemini', 'cloro.ai-search.gemini.scrape', { namesSources: true }),
  cloro('ai_mode', 'AI Mode', 'cloro.google.serp.ai_mode', { countryInput: 'gl', namesSources: true }),
  {
    id: 'perplexity', name: 'Perplexity', toolId: 'treg.ai-search.perplexity.answer', questionInput: 'prompt',
    countryInput: 'country', answerPath: '$.output.answer', sourcesPath: '$.output.sources', namesSources: false,
    provider: 'dataforseo', fields: { url: '$.url', title: '$.title', position: null }, defaultOn: true,
  },
  cloro('copilot', 'Copilot', 'cloro.ai-search.copilot.scrape', { defaultOn: false }),
];

export const engineById = (id: string): EngineSpec | undefined => ENGINES.find(e => e.id === id);

// The columns an engine fills on the questions sheet.
export const engineColumns = (e: EngineSpec) => ({
  status: e.name, answer: `${e.name} answer`, you: `You in ${e.name}`,
});

export const QUESTION_COLUMN = 'Question';
export const NAMED_BY_COLUMN = 'Named by';
export const NAMED_FIRST_COLUMN = 'Named first';
export const SITE_COLUMNS = {
  question: 'Question', engine: 'Engine', position: 'Position', title: 'Title', url: 'URL', domain: 'Domain',
  yours: 'Your site',
} as const;
