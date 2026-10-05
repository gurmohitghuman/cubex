// The OpenRouter server tools an AI row gets. One builder for the single-column
// runner (ai-row.ts), the structured runner (ai-row-multi.ts) and preview
// (ai-preview-runner.ts), so a preview costs and behaves like the run it
// previews, and the three can't drift apart.
import { extractAllowedDomainsFromRow } from './prompt';
import { WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_MAX_TOTAL_RESULTS } from './constants-ai';

export function buildWebTools(
  prompt: string,
  rowData: Record<string, string>,
  opts: { search: boolean; fetch: boolean },
): object[] {
  const tools: object[] = [];
  if (opts.search) {
    // max_total_results caps the CUMULATIVE results across every search the
    // model chooses to run for one row; without it the count is unbounded and
    // model-controlled (observed 2-4 searches/row). Pricing is engine-dependent,
    // so this limits exposure rather than fixing a price (constants-ai.ts).
    tools.push({
      type: 'openrouter:web_search',
      parameters: { max_results: WEB_SEARCH_MAX_RESULTS, max_total_results: WEB_SEARCH_MAX_TOTAL_RESULTS },
    });
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
