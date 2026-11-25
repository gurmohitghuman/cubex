// The free count in a hiring table's estimate (services/job-count.ts), from
// its first searches. A routed search is counted by its terms (title, country,
// how recent). A table with More filters is counted with each search's own
// request, built as its run builds it, so the count takes the same filters.
import { db } from '../lib/db';
import { getSheetColumns, parseRowData } from '../lib/sql-helpers';
import { HIRING_COUNT_MAX_SEARCHES } from '../lib/constants';
import { buildRequest } from '../lib/enrich-request';
import { inputTemplates, type EnrichRunConfig } from '../lib/enrich-run-config';
import { HIRING_DIRECT_TOOL_ID, SEARCH_COLUMNS } from '../lib/hiring/names';
import { searchesATitle } from '../lib/hiring/title-words';
import { countDirectJobs, countJobs, type JobCount, type SearchTerms } from './job-count';

// The first searches with a role title to search for (of the first HIRING_COUNT_MAX_SEARCHES rows): one of
// only punctuation isn't searched, so it isn't counted (lib/hiring/title-words.ts).
function firstSearches(userId: string, sheetId: string): Array<Record<string, string>> {
  const rows = db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?')
    .all(sheetId, userId, HIRING_COUNT_MAX_SEARCHES) as Array<{ data: string }>;
  return rows.map(r => parseRowData(r.data)).filter(d => searchesATitle(String(d[SEARCH_COLUMNS.role] ?? ''), false));
}

function searchTerms(rows: Array<Record<string, string>>): SearchTerms[] {
  return rows.map(r => {
    const days = Number(r[SEARCH_COLUMNS.days]);
    return { title: String(r[SEARCH_COLUMNS.role]).trim(), country: String(r[SEARCH_COLUMNS.country] ?? '').trim(),
      days: Number.isSafeInteger(days) && days > 0 ? days : null };
  });
}

// Each search's request body, as its run sends it (a search whose request can't be built isn't counted).
function directBodies(userId: string, sheetId: string, config: EnrichRunConfig,
  rows: Array<Record<string, string>>): Array<Record<string, unknown>> {
  const columns = getSheetColumns(sheetId, userId);
  const templates = inputTemplates(config);
  return rows.flatMap(row => {
    const built = buildRequest(config.enrichment.toolSnapshot, templates, row,
      { cleanDomains: config.enrichment.cleanDomains, columns });
    if (!built.ok || !built.body) return [];
    const body: unknown = JSON.parse(built.body);
    return body && typeof body === 'object' && !Array.isArray(body) ? [body as Record<string, unknown>] : [];
  });
}

export async function countHiringMatches(userId: string, sheetId: string, config: EnrichRunConfig,
  provider: string | null): Promise<JobCount | null> {
  const rows = firstSearches(userId, sheetId);
  if (config.enrichment.toolId === HIRING_DIRECT_TOOL_ID) {
    return countDirectJobs(userId, directBodies(userId, sheetId, config, rows));
  }
  return countJobs(userId, provider, searchTerms(rows));
}
