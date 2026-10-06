// The OpenRouter server tools an AI row gets. One builder for the single-column
// runner (ai-row.ts), the structured runner (ai-row-multi.ts) and preview
// (ai-preview-runner.ts), so a preview costs and behaves like the run it
// previews, and the three can't drift apart.
import { extractAllowedDomainsFromRow } from './prompt';
import {
  WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_MAX_TOTAL_RESULTS, SEARCH_TOOL_CALL_SLACK, FETCH_TOOL_CALLS_PER_ROW,
} from './constants-ai';
import type { SearchEngine, SearchEngineUsed } from './web-search-options';
import type { SearchReplay } from './responses-adapter';

// A run's search settings as stored (ai_runs.web_search_*) or planned
// (web-search-plan.ts). engine null: a run from before engines could be chosen,
// which sends none and gets OpenRouter's default.
export interface SearchToolConfig {
  engine: SearchEngine | null;
  used: SearchEngineUsed | null;
  mode: string | null;
  maxPerRow: number | null;
}

function searchParameters(s: SearchToolConfig): Record<string, unknown> {
  // max_total_results caps the results across every search the model runs for
  // a row; without any limit the count is model-controlled (observed 2-4
  // searches a row). A per-row cap is sent as max_uses, and the result limit
  // rises with it so that the cap, not the results, is what stops the row.
  const params: Record<string, unknown> = {
    max_results: WEB_SEARCH_MAX_RESULTS,
    max_total_results: s.maxPerRow !== null ? s.maxPerRow * WEB_SEARCH_MAX_RESULTS : WEB_SEARCH_MAX_TOTAL_RESULTS,
  };
  if (s.engine) params.engine = s.engine;
  if (s.mode) params.mode = s.mode;
  if (s.maxPerRow !== null) params.max_uses = s.maxPerRow;
  return params;
}

// The limits OpenRouter applies to this row's searches, replayed to tell which
// calls ran (responses-adapter.ts). A model's own search isn't policed by
// OpenRouter; only Anthropic's takes the cap (web-search-plan.ts refuses or
// moves any other capped one). An unknown engine (an older run) counts every
// call as run.
export function searchReplayFor(s: SearchToolConfig): SearchReplay {
  if (s.used === null) return { cap: null, maxTotalResults: null };
  if (s.used === 'native') return { cap: s.maxPerRow, maxTotalResults: null };
  return {
    cap: s.maxPerRow,
    maxTotalResults: s.maxPerRow !== null ? s.maxPerRow * WEB_SEARCH_MAX_RESULTS : WEB_SEARCH_MAX_TOTAL_RESULTS,
  };
}

// The request's max_tool_calls for a capped row (constants-ai.ts says why);
// null without a cap, leaving OpenRouter's default.
export function toolCallBudget(search: SearchToolConfig | null, fetch: boolean): number | null {
  if (search?.maxPerRow == null) return null;
  return search.maxPerRow + SEARCH_TOOL_CALL_SLACK + (fetch ? FETCH_TOOL_CALLS_PER_ROW : 0);
}

export function buildWebTools(
  prompt: string,
  rowData: Record<string, string>,
  opts: { search: SearchToolConfig | null; fetch: boolean },
): object[] {
  const tools: object[] = [];
  if (opts.search) {
    tools.push({ type: 'openrouter:web_search', parameters: searchParameters(opts.search) });
    // Search needs a "now" anchor for queries like "latest …"; datetime is free.
    tools.push({ type: 'openrouter:datetime' });
  }
  if (opts.fetch) {
    // Only hosts that appear in this row's cells of the /columns the prompt
    // references (a URL or a bare domain like stripe.com). ALWAYS sent, even
    // empty: an explicit empty list blocks every fetch, while omitting the key
    // leaves it to OpenRouter's undocumented default, historically "any URL".
    tools.push({
      type: 'openrouter:web_fetch',
      parameters: { allowed_domains: extractAllowedDomainsFromRow(prompt, rowData) },
    });
  }
  return tools;
}

// A stored run's search settings, or null when the run doesn't search.
export function runSearchConfig(run: {
  use_openrouter_web_search: number | boolean | null;
  web_search_engine?: string | null; web_search_engine_used?: string | null;
  web_search_mode?: string | null; web_search_max_per_row?: number | null;
}): SearchToolConfig | null {
  if (!run.use_openrouter_web_search) return null;
  return {
    engine: (run.web_search_engine ?? null) as SearchEngine | null,
    used: (run.web_search_engine_used ?? null) as SearchEngineUsed | null,
    mode: run.web_search_mode ?? null,
    maxPerRow: run.web_search_max_per_row ?? null,
  };
}
