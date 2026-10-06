// Single source of truth for the AI "(Data)" column cell string. Both the
// workers (ai-row.ts, ai-row-multi.ts, which persist it) and the SSE stream
// (ai-stream.ts, which paints it live) build it from the SAME stored fields, so
// the live cell matches the saved state. Before this, the SSE always sent '' on
// success, blanking a populated "(Data)" cell until a reload re-fetched the
// persisted value (L9).
//
// Every form starts with 📊: the grid makes exactly those "(Data)" cells
// clickable (the sources popup), old cells included.

export interface CitedUrl { title?: string; url?: string }

// What a row searched and cost. queries null: the row didn't search (or ran
// before searches were logged); costUsd null: OpenRouter didn't report it.
export interface RowSearchSummary {
  queries: Array<{ query: string; ran: boolean }> | null;
  costUsd: number | null;
}

const QUERIES_SHOWN = 3;
const QUERY_CHARS_SHOWN = 60;

// "$0.0018": a row's cost, readable at a glance.
export function formatRowCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function sourcesPart(citedUrls: CitedUrl[], verb: string | null): string {
  const head = citedUrls.slice(0, 2).map(w => w.title || w.url || '').join(', ');
  const more = citedUrls.length > 2 ? ` +${citedUrls.length - 2} more` : '';
  const n = `${citedUrls.length} source${citedUrls.length > 1 ? 's' : ''}`;
  return `${verb ? `${verb} ` : ''}${n}: ${head}${more}`;
}

// '2 searches: "a", "b"'. A search whose words weren't reported (a model's own
// search, counted from usage) adds to the count but has nothing to quote.
function searchesPart(queries: Array<{ query: string; ran: boolean }>): string {
  const ran = queries.filter(q => q.ran);
  // Not "didn't search": a model's own search may run without reporting it.
  if (ran.length === 0) return 'No searches reported';
  const withWords = ran.filter(q => q.query);
  const shown = withWords.slice(0, QUERIES_SHOWN).map(q =>
    `"${q.query.length > QUERY_CHARS_SHOWN ? `${q.query.slice(0, QUERY_CHARS_SHOWN)}…` : q.query}"`);
  const more = withWords.length > shown.length ? ` +${withWords.length - shown.length} more` : '';
  return `${ran.length} search${ran.length === 1 ? '' : 'es'}${shown.length ? `: ${shown.join(', ')}` : ''}${more}`;
}

// The "(Data)" cell: the row's cost first (a narrow column still shows it),
// then what it searched for, then its sources: '📊 $0.0025 · 1 search:
// "stripe ceo" · 5 sources: …'. Without a search log or a cost (rows from
// before they were recorded), the original breadcrumb: '📊 Searched N sources:
// …', or '' with no sources. 'Read' is for a structured run that only fetched pages.
export function aiDataCellSummary(
  citedUrls: CitedUrl[], verb: 'Searched' | 'Read' = 'Searched', row?: RowSearchSummary,
): string {
  if (!row || (row.queries === null && row.costUsd === null)) {
    return citedUrls.length === 0 ? '' : `📊 ${sourcesPart(citedUrls, verb)}`;
  }
  const parts: string[] = row.costUsd !== null ? [formatRowCost(row.costUsd)] : [];
  if (row.queries !== null) {
    parts.push(searchesPart(row.queries));
    if (citedUrls.length > 0) parts.push(sourcesPart(citedUrls, null));
  } else {
    parts.push(citedUrls.length > 0 ? sourcesPart(citedUrls, verb) : 'No sources');
  }
  return `📊 ${parts.join(' · ')}`;
}

// Parse ai_results.scraped_data JSON to a CitedUrl[] (defensive — null/malformed
// → []). Used by the SSE stream to reconstruct the summary the worker persisted.
export function parseScrapedData(raw: string | null | undefined): CitedUrl[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Parse ai_results.web_search_queries ([{query, ran}]); null when absent or malformed.
export function parseSearchQueries(raw: string | null | undefined): Array<{ query: string; ran: boolean }> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(q => q && typeof q.query === 'string').map(q => ({ query: q.query, ran: q.ran !== false }));
  } catch {
    return null;
  }
}
