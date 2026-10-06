// Web search cost controls: which engine OpenRouter's openrouter:web_search
// tool runs on, that engine's mode, and a cap on searches per row. Validation
// and labels only; what each engine costs is in web-search-pricing.ts, and the
// engine a run really gets (auto, native fallback, caps) in web-search-plan.ts.
// Engines and modes as OpenRouter documents them (docs, server tools > web
// search, 2026-10); firecrawl is left out because it needs the caller's own key.
import { MAX_SEARCHES_PER_ROW } from './constants-ai';

export const SEARCH_ENGINES = ['auto', 'native', 'exa', 'parallel', 'perplexity'] as const;
export type SearchEngine = typeof SEARCH_ENGINES[number];
// The engine that actually runs the searches ('auto' always becomes one of these).
export type SearchEngineUsed = Exclude<SearchEngine, 'auto'>;

export const SEARCH_MODES = {
  exa: ['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning'],
  parallel: ['turbo', 'fast', 'basic', 'advanced'],
} as const;
export type ModalEngine = keyof typeof SEARCH_MODES;
// What a request without a mode runs and bills as (the catalog's default_mode).
export const DEFAULT_SEARCH_MODE: Record<ModalEngine, string> = { exa: 'auto', parallel: 'basic' };

export const hasModes = (e: string): e is ModalEngine => e === 'exa' || e === 'parallel';

export interface SearchOptions {
  engine: SearchEngine;
  mode: string | null;          // null: the engine's default
  maxPerRow: number | null;     // null: no cap
}
// Web search with nothing chosen: OpenRouter picks the engine, no cap.
export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { engine: 'auto', mode: null, maxPerRow: null };

const ENGINE_NAMES: Record<Exclude<SearchEngineUsed, 'native'>, string> = {
  exa: 'Exa', parallel: 'Parallel', perplexity: 'Perplexity',
};

// "Parallel (fast mode)", "OpenAI's own search", "Exa (auto mode)", or just
// "Exa" (withMode false: a fallback whose default mode nobody chose).
export function engineLabel(used: SearchEngineUsed, mode: string | null, nativeProvider: string | null, withMode = true): string {
  if (used === 'native') return nativeProvider ? `${nativeProvider}'s own search` : "the model's own search";
  const billedMode = withMode ? mode ?? (hasModes(used) ? DEFAULT_SEARCH_MODE[used] : null) : null;
  return billedMode ? `${ENGINE_NAMES[used]} (${billedMode} mode)` : ENGINE_NAMES[used];
}

// Accepts true/false and the text "true"/"false" (an MCP client whose tool list
// predates an option sends it as text). undefined/null: not given.
export function parseBooleanOption(v: unknown): boolean | undefined | 'invalid' {
  if (v === undefined || v === null) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return 'invalid';
}

function parseCap(v: unknown): number | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SEARCHES_PER_ROW ? n : 'invalid';
}

// The search options of a run request, checked. null when web search is off and
// none were given; an error when one was given without web search, so a capped
// "search" never silently runs as no search at all.
export function parseSearchOptions(
  raw: { engine?: unknown; mode?: unknown; maxPerRow?: unknown },
  webSearch: boolean,
): { ok: SearchOptions | null } | { error: string } {
  const given = [raw.engine, raw.mode, raw.maxPerRow].some(v => v !== undefined && v !== null && v !== '');
  if (!webSearch) {
    return given ? { error: 'search_engine, search_mode and max_searches_per_row need web_search turned on.' } : { ok: null };
  }
  const engineRaw = raw.engine === undefined || raw.engine === null || raw.engine === ''
    ? 'auto' : typeof raw.engine === 'string' ? raw.engine.trim().toLowerCase() : raw.engine;
  if (typeof engineRaw !== 'string' || !(SEARCH_ENGINES as readonly string[]).includes(engineRaw)) {
    return { error: `search_engine must be one of: ${SEARCH_ENGINES.join(', ')}.` };
  }
  const engine = engineRaw as SearchEngine;
  let mode: string | null = null;
  if (raw.mode !== undefined && raw.mode !== null && raw.mode !== '') {
    if (!hasModes(engine)) {
      return { error: 'search_mode applies only to search_engine exa or parallel.' };
    }
    const m = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : '';
    const valid: readonly string[] = SEARCH_MODES[engine];
    if (!valid.includes(m)) return { error: `search_mode for ${engine} must be one of: ${valid.join(', ')}.` };
    mode = m;
  }
  const maxPerRow = parseCap(raw.maxPerRow);
  if (maxPerRow === 'invalid') {
    return { error: `max_searches_per_row must be a whole number from 1 to ${MAX_SEARCHES_PER_ROW}.` };
  }
  return { ok: { engine, mode, maxPerRow } };
}
