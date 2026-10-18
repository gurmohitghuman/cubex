// The trash's query and body checks, shared by /api/trash, /api/v1/trash and MCP.
import { TRASH_IDS_MAX, TRASH_LIST_PAGE, TRASH_ROWS_PAGE_MAX } from '../lib/constants';
import { TRASH_HOWS, type TrashHow, type TrashKind } from '../lib/trash/store';

const KINDS: TrashKind[] = ['rows', 'sheet', 'table'];

// A whole number >= 1 (undefined when absent, null when not one).
function posInt(v: unknown): number | undefined | null {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function parseTrashIds(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > TRASH_IDS_MAX) return null;
  const ids = v.map(posInt);
  return ids.every((n): n is number => typeof n === 'number') ? [...new Set(ids)] : null;
}

export function trashListAsk(q: Record<string, unknown>):
  { q?: string; kind?: TrashKind; how?: TrashHow; sheetId?: string; before?: number; limit?: number }
  | { error: string } {
  const before = posInt(q.before);
  const limit = posInt(q.limit);
  if (before === null) return { error: 'before must be a trash id.' };
  if (limit === null) return { error: `limit must be a whole number from 1 to ${TRASH_LIST_PAGE}.` };
  const kind = q.kind === undefined || q.kind === '' ? undefined : q.kind;
  if (kind !== undefined && !KINDS.includes(kind as TrashKind)) return { error: 'kind must be rows, sheet or table.' };
  const how = q.how === undefined || q.how === '' ? undefined : q.how;
  if (how !== undefined && !TRASH_HOWS.includes(how as TrashHow)) {
    return { error: `how must be one of: ${TRASH_HOWS.join(', ')}.` };
  }
  const sheetId = typeof q.sheet_id === 'string' && q.sheet_id ? q.sheet_id : undefined;
  return { q: typeof q.q === 'string' ? q.q.slice(0, 200) : undefined, kind: kind as TrashKind | undefined,
    how: how as TrashHow | undefined, sheetId, before, limit };
}

export function trashRowsAsk(q: Record<string, unknown>):
  { after?: number; limit?: number; column?: string; contains?: string } | { error: string } {
  const after = q.after === undefined || q.after === '' ? undefined : Number(q.after);
  if (after !== undefined && (!Number.isInteger(after) || after < 0)) return { error: 'after must be a seq.' };
  const limit = posInt(q.limit);
  if (limit === null) return { error: `limit must be a whole number from 1 to ${TRASH_ROWS_PAGE_MAX}.` };
  const column = typeof q.column === 'string' && q.column ? q.column : undefined;
  const contains = typeof q.contains === 'string' && q.contains.trim() ? q.contains.slice(0, 500) : undefined;
  return { after, limit, column, contains };
}
