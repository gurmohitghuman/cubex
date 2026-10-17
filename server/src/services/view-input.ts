// Checking what a view is given (services/views.ts): its name, description,
// filters (a `where`, split into the parts the grid shows) and hidden columns.
import { containsInvisibleNameChar, normalizeNameSpacing } from '../lib/name-safety';
import { MAX_VIEW_DESCRIPTION_CHARS, MAX_VIEW_NAME_CHARS } from '../lib/constants-filters';
import { checkWhere, parseWhere } from '../lib/row-filter/where';
import { readsRunState, splitWhere, type ViewFilters } from '../lib/views/filters';
import { sheetRunColumns } from './row-filter';
import type { ViewFail } from './view-store';

export const bad = (message: string): ViewFail => ({ fail: 'bad_request', message });
export const notFound = (what = 'View'): ViewFail => ({ fail: 'not_found', message: `${what} not found` });
export const taken = (name: string): ViewFail =>
  ({ fail: 'conflict', message: `A view named "${name}" already exists.` });
export const isFail = (v: unknown): v is ViewFail => !!v && typeof v === 'object' && 'fail' in v;

export function viewName(raw: unknown): string | ViewFail {
  if (typeof raw !== 'string' || !raw.trim()) return bad('Give the view a name.');
  const name = normalizeNameSpacing(raw);
  if (name.length > MAX_VIEW_NAME_CHARS) return bad(`A view's name can be at most ${MAX_VIEW_NAME_CHARS} characters.`);
  if (containsInvisibleNameChar(name)) {
    return bad('The name has invisible characters in it. Remove them and try again.');
  }
  return name;
}

function viewDescription(raw: unknown): string | null | ViewFail {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return bad('The description must be text.');
  const text = raw.trim();
  if (text.length > MAX_VIEW_DESCRIPTION_CHARS) {
    return bad(`The description can be at most ${MAX_VIEW_DESCRIPTION_CHARS} characters.`);
  }
  return text || null;
}

// A view's filters from a `where` (null or [] = none), checked against the sheet.
export function checkViewWhere(
  sheetId: string, userId: string, raw: unknown, columns: readonly string[],
): ViewFilters | ViewFail {
  if (raw === null || (Array.isArray(raw) && raw.length === 0)) return splitWhere([]);
  const parsed = parseWhere(raw);
  if ('error' in parsed) return bad(parsed.error);
  const runColumns = readsRunState(parsed.where) ? sheetRunColumns(sheetId, userId, columns) : new Map();
  const invalid = checkWhere(parsed.where, { columns, runColumns });
  return invalid ? bad(invalid) : splitWhere(parsed.where);
}

function checkHidden(raw: unknown, columns: readonly string[]): string | null | ViewFail {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.some(c => typeof c !== 'string')) {
    return bad('hidden_columns is a list of column names.');
  }
  const hidden = [...new Set(raw as string[])];
  const unknown = hidden.filter(c => !columns.includes(c));
  if (unknown.length) return bad(`Unknown column(s): ${unknown.join(', ')}`);
  if (columns.length > 0 && hidden.length >= columns.length) return bad('Keep at least one column showing.');
  return hidden.length ? JSON.stringify(hidden) : null;
}

export interface ViewInput {
  name?: unknown; description?: unknown; where?: unknown; hidden_columns?: unknown;
}

export interface Checked { name?: string; description?: string | null; filters?: ViewFilters; hidden?: string | null }

export function checkInput(
  sheetId: string, userId: string, input: ViewInput, columns: readonly string[],
): Checked | ViewFail {
  const out: Checked = {};
  if (input.name !== undefined) {
    const name = viewName(input.name);
    if (isFail(name)) return name;
    out.name = name;
  }
  if (input.description !== undefined) {
    const description = viewDescription(input.description);
    if (isFail(description)) return description;
    out.description = description;
  }
  if (input.where !== undefined) {
    const filters = checkViewWhere(sheetId, userId, input.where, columns);
    if (isFail(filters)) return filters;
    out.filters = filters;
  }
  if (input.hidden_columns !== undefined) {
    const hidden = checkHidden(input.hidden_columns, columns);
    if (isFail(hidden)) return hidden;
    out.hidden = hidden;
  }
  return out;
}

