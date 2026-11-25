// Whether a hiring table's search has a role title to search for (pure). A Role title cell of only punctuation
// (",") leaves the search no title, and in the search with More filters a title that is only words to leave out
// ("-intern") leaves none either: either way the job index answers any role. Such a row is skipped as a row with
// no title is (lib/enrich-request.ts: no call, nothing paid, "Missing inputs" on the row), and the free count
// leaves it out (services/hiring-count.ts). Only a hiring table's search is checked (its title input reads the
// Role title column): the same tools used on another sheet keep sending what their cells give.
import { HIRING_DIRECT_TOOL_ID, HIRING_TOOL_ID, SEARCH_COLUMNS } from './names';

const WORD = /[\p{L}\p{N}]/u;
const ROLE_TOKEN = `{{${SEARCH_COLUMNS.role}}}`;

// A title with a letter or digit; with More filters, also not a word to leave out ("-" first).
export const searchesATitle = (title: string, direct: boolean): boolean =>
  WORD.test(title) && !(direct && title.trim().startsWith('-'));

// The input a hiring table's search lacks when its title has no word to search for, or null.
export function hiringTitleMissing(
  toolId: string, inputMap: Record<string, string>, sent: Record<string, unknown>,
): string | null {
  if (toolId === HIRING_TOOL_ID && inputMap.title?.includes(ROLE_TOKEN)) {
    return typeof sent.title === 'string' && searchesATitle(sent.title, false) ? null : 'title';
  }
  if (toolId !== HIRING_DIRECT_TOOL_ID || !inputMap.job_titles?.includes(ROLE_TOKEN)) return null;
  const titles = Array.isArray(sent.job_titles) ? sent.job_titles : [];
  return titles.some(t => typeof t === 'string' && searchesATitle(t, true)) ? null : 'job_titles';
}
