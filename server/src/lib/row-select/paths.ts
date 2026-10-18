// The columns a row read returns (pure): read_rows' and REST rows/query's
// `columns`, each a column name or {column, path, as} to take one value out of
// a JSON cell, such as an HTTP API answer: path is a list of keys (an object's
// key, or an array's position from 0), at most MAX_PATH_DEPTH deep. Plain keys,
// not JSONPath: nothing in a path is evaluated.
import { MAX_PATH_DEPTH, MAX_PATH_KEY_CHARS } from '../constants-query';

export type PathKey = string | number;
export interface ColumnPick { column: string; path?: PathKey[]; as?: string }

// The name a pick's value goes under: `as`, else "Column.key.0.key".
export const pickName = (p: ColumnPick): string =>
  p.as ?? (p.path ? [p.column, ...p.path.map(String)].join('.') : p.column);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const EXAMPLE = '{"column":"Response","path":["data","emails",0],"as":"Email"}';

function pickShape(raw: unknown): ColumnPick | string {
  if (typeof raw === 'string') return raw ? { column: raw } : 'A column name is non-empty text.';
  if (!isObject(raw)) return `Each column is a name or ${EXAMPLE}.`;
  const extra = Object.keys(raw).find(k => !['column', 'path', 'as'].includes(k));
  if (extra) return `Unknown key "${extra}" in a column. A column has column, path and as.`;
  if (typeof raw.column !== 'string' || !raw.column) return `A column's column is its name, e.g. ${EXAMPLE}.`;
  if (raw.as !== undefined && (typeof raw.as !== 'string' || !raw.as.trim() || raw.as.length > MAX_PATH_KEY_CHARS)) {
    return `as is a name of 1 to ${MAX_PATH_KEY_CHARS} characters.`;
  }
  if (raw.path === undefined) return { column: raw.column, ...(raw.as !== undefined ? { as: raw.as as string } : {}) };
  const path = raw.path;
  if (!Array.isArray(path) || path.length === 0 || path.length > MAX_PATH_DEPTH) {
    return `path is a list of 1 to ${MAX_PATH_DEPTH} keys, e.g. ["data","emails",0].`;
  }
  for (const k of path) {
    const index = typeof k === 'number' && Number.isInteger(k) && k >= 0;
    const key = typeof k === 'string' && k.length > 0 && k.length <= MAX_PATH_KEY_CHARS;
    if (!index && !key) {
      return `A path key is text (an object's key, up to ${MAX_PATH_KEY_CHARS} characters) or a whole number `
        + '(a position in a list, from 0). Paths are plain keys, not JSONPath.';
    }
  }
  return { column: raw.column, path: path as PathKey[], ...(raw.as !== undefined ? { as: raw.as as string } : {}) };
}

// `columns` as picks. picks is null when every entry is a plain name (the
// read then works as it always has); names are the columns read, once each.
export function parseColumns(raw: unknown): { names: string[]; picks: ColumnPick[] | null } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'columns must be a non-empty list.' };
  const picks: ColumnPick[] = [];
  for (const item of raw) {
    const p = pickShape(item);
    if (typeof p === 'string') return { error: p };
    picks.push(p);
  }
  if (picks.every(p => !p.path && p.as === undefined)) return { names: picks.map(p => p.column), picks: null };
  const names = picks.map(pickName);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice !== undefined) return { error: `Two columns would both be named "${twice}": give one an as.` };
  return { names: [...new Set(picks.map(p => p.column))], picks };
}

// The value at `path` inside a cell holding JSON, or null (not JSON, or no
// such key). Objects and lists come back as they are.
export function pickValue(cell: unknown, path: readonly PathKey[]): unknown {
  const text = typeof cell === 'string' ? cell.trim() : '';
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  let at: unknown;
  try { at = JSON.parse(text); } catch { return null; }
  for (const key of path) {
    if (Array.isArray(at)) {
      const i = typeof key === 'number' ? key : /^\d+$/.test(key) ? Number(key) : -1;
      at = i >= 0 && i < at.length ? at[i] : undefined;
    } else if (isObject(at) && Object.prototype.hasOwnProperty.call(at, String(key))) {
      at = at[String(key)];
    } else {
      return null;
    }
    if (at === undefined) return null;
  }
  return at;
}
