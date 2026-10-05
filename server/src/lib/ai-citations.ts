// The sources behind an AI answer, stored in ai_results.scraped_data and
// summarized in the "(Data)" cell (lib/ai-data-cell.ts).

export interface Citation { title: string; url: string; content: string; snippet: string }

type Annotation = { type?: string; url_citation?: { url?: string; title?: string; content?: string } };

// The url_citation annotations OpenRouter returns for web SEARCH results. Web
// fetch adds none (its pages reach only the model), which is why structured
// runs also ask the model to list its sources (withSourceUrls).
export function citationsFromCompletion(completion: unknown): Citation[] {
  const message = (completion as { choices?: Array<{ message?: { annotations?: Annotation[] } }> })
    ?.choices?.[0]?.message;
  return (message?.annotations ?? [])
    .filter(a => a?.type === 'url_citation' && a.url_citation?.url)
    .map(a => {
      const c = a.url_citation!;
      return { title: c.title || c.url!, url: c.url!, content: c.content || '', snippet: (c.content || '').slice(0, 200) };
    });
}

const sameUrl = (u: string) => u.replace(/\/+$/, '').toLowerCase();

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() || null; } catch { return null; }
}

// Add the URLs a structured run's model listed (pages it fetched or read) to
// the search citations, each once. A listed URL counts only on a host the row
// could reach: one fetch was allowed (fetchHosts, from the row's cells), one a
// search result came from, or a subdomain of either. Anything else the model
// can't have read, so it never shows up as a source.
export function withSourceUrls(cited: Citation[], urls: string[], fetchHosts: string[] = []): Citation[] {
  const reachable = [...fetchHosts, ...cited.map(c => hostOf(c.url))].filter((h): h is string => !!h);
  const canReach = (url: string) => {
    const host = hostOf(url);
    return !!host && reachable.some(h => host === h || host.endsWith(`.${h}`));
  };
  const seen = new Set(cited.map(c => sameUrl(c.url)));
  const out = [...cited];
  for (const url of urls) {
    if (seen.has(sameUrl(url)) || !canReach(url)) continue;
    seen.add(sameUrl(url));
    out.push({ title: url, url, content: '', snippet: '' });
  }
  return out;
}
