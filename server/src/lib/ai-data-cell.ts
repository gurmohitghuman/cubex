// Single source of truth for the AI "(Data)" column cell string (the web-search
// sources breadcrumb). Both the worker (ai-row.ts, which persists it) and the SSE
// stream (ai-stream.ts, which paints it live) build it from the SAME cited-URLs,
// so the live cell matches the saved state. Before this, the SSE always sent ''
// on success, blanking a populated "(Data)" cell ('📊 Searched N sources: …')
// until a reload re-fetched the persisted value (L9).

export interface CitedUrl { title?: string; url?: string }

// Build the "(Data)" cell breadcrumb from cited URLs. Empty list → '' (matches
// the worker: no sources → blank cell). Mirrors ai-row.ts's scrapedSummary.
// 'Read' is for a structured run that only fetched pages: it searched nothing.
export function aiDataCellSummary(citedUrls: CitedUrl[], verb: 'Searched' | 'Read' = 'Searched'): string {
  if (citedUrls.length === 0) return '';
  const head = citedUrls.slice(0, 2).map(w => w.title || w.url || '').join(', ');
  const more = citedUrls.length > 2 ? ` +${citedUrls.length - 2} more` : '';
  return `📊 ${verb} ${citedUrls.length} source${citedUrls.length > 1 ? 's' : ''}: ${head}${more}`;
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
