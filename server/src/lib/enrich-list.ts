// List results into rows (pure): what a list enrichment keeps in its config,
// the status cells its source rows show, the results of one answer, the fields
// those results have, and the duplicate key. A list job's results are the
// provider's own rows (treg doesn't make them alike across providers), so a
// run asks one provider and the fields to keep are picked from real results.
import { createHash } from 'node:crypto';
import { pathSegment } from './enrich-tool-io';
import { cellText } from './enrich-cells';
import { ENRICH_LIST_MAX_FIELDS } from './constants';
import { LIST_MARK, holdsRunMarker } from './enrich-seed';

export { LIST_MARK };

// A result's field (a path inside one result) and the destination column it fills.
export interface ListField { path: string; columnName: string }
// A source column copied into every row a source row adds, or (value set,
// from '') the same text written into each of them.
export interface ListCopy { id: string; from: string; to: string; value?: string }

export interface EnrichListConfig {
  destSheetId: string;
  // Where the results are in treg's answer: a waterfall's list output
  // ($.output.people), or the list in a single tool's example answer.
  itemsPath: string;
  // The run named itemsPath (another list of a single tool's answer than the
  // catalog's): kept on reruns, and refused once the example no longer has it.
  itemsNamed?: boolean;
  provider: string | null;      // a waterfall's one provider (null: a single tool)
  maxItems: number;
  // null: not picked yet (a test run): its results wait in the journal.
  fields: ListField[] | null;
  copy: ListCopy[];
  // Skip a result whose value at this path matches one added before.
  dedupe: { path: string } | null;
}

// A source row's status cell starts with LIST_MARK while its results are on
// their way (never ⏳: rerun rules read any ⏳ as a row still processing).
const count = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
export const listCell = {
  adding: (n: number) => `${LIST_MARK} Adding ${count(n, 'row')}…`,
  // A rerun with no results: the rows the row added before are on their way out.
  replacing: `${LIST_MARK} Removing earlier rows…`,
  waitingFields: (n: number) => `${LIST_MARK} ${count(n, 'result')}, waiting for fields`,
  // n 0: a rerun with no results, whose removal waits behind its row's earlier results.
  waitingRoom: (n: number, dest: string) =>
    `${LIST_MARK} ${n ? `${count(n, 'row')} waiting` : 'Waiting'} for room in ${dest}`,
  // A paused run on the destination may still fill the rows these replace: say what to do.
  waitingPausedRun: (n: number, dest: string, column: string | null) =>
    `${LIST_MARK} ${n ? `${count(n, 'row')} wait` : 'Removing earlier rows waits'}: `
    + `the ${column ? `${column} ` : ''}run in ${dest} is paused. Resume or cancel it`,
  // Nothing new: the useful number first (a grid cell cuts the end off).
  added: (n: number, skipped: number) => (n === 0 && skipped > 0
    ? (skipped === 1 ? '✅ Already there' : `✅ All ${skipped.toLocaleString('en-US')} already there`)
    : `✅ ${count(n, 'row')} added${skipped > 0 ? `, ${skipped.toLocaleString('en-US')} already there` : ''}`),
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// The value at a simple path ($.a.b, $["k"], $[0]): the paths Cubex builds
// (pathSegment), read without a JSONPath engine (a row can hold 100 results).
const SEGMENT = /\.([A-Za-z_$][A-Za-z0-9_$]*)|\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]/y;
export function readPath(value: unknown, path: string): unknown {
  if (!path.startsWith('$')) return undefined;
  let at: unknown = value;
  SEGMENT.lastIndex = 1;
  while (SEGMENT.lastIndex < path.length) {
    const start = SEGMENT.lastIndex;
    const m = SEGMENT.exec(path);
    if (!m || m.index !== start) return undefined;
    const key = m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : undefined);
    if (key !== undefined) at = isObj(at) ? at[key] : undefined;
    else at = Array.isArray(at) ? at[Number(m[3])] : undefined;
    if (at === undefined) return undefined;
  }
  return at;
}

// The results of one answer: the list at itemsPath, first `max` of them.
export function itemsOf(answer: unknown, itemsPath: string, max: number): unknown[] {
  const list = readPath(answer, itemsPath);
  return Array.isArray(list) ? list.filter(v => v !== null && v !== undefined).slice(0, max) : [];
}

export interface ListFieldInfo { path: string; label: string; filled: number; sample: string }

const MAX_DEPTH = 3;
const SAMPLE_CHARS = 60;

// Every field the results have, in the order first seen: object keys walked
// down to plain values (a list inside a result is one field, kept as text),
// with how many results fill it and one value as a sample.
export function discoverFields(items: unknown[]): ListFieldInfo[] {
  const seen = new Map<string, ListFieldInfo>();
  const note = (path: string, label: string, value: unknown) => {
    let f = seen.get(path);
    if (!f) {
      if (seen.size >= ENRICH_LIST_MAX_FIELDS) return;
      f = { path, label, filled: 0, sample: '' };
      seen.set(path, f);
    }
    const text = cellText(value);
    if (text === '') return;
    f.filled++;
    if (!f.sample) f.sample = text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS - 1)}…` : text;
  };
  const walk = (value: unknown, path: string, label: string, depth: number) => {
    if (isObj(value) && depth < MAX_DEPTH && Object.keys(value).length > 0) {
      for (const [k, v] of Object.entries(value)) {
        walk(v, `${path}${pathSegment(k)}`, label ? `${label}.${k}` : k, depth + 1);
      }
      return;
    }
    note(path, label || 'value', value);
  };
  for (const item of items) walk(item, '$', '', 0);
  return [...seen.values()];
}

// The source row's copied cells, by copy id, as the run read them. A run's
// own word in a cell (⏳, ❌, ⏭️, ➕) isn't data and copies as empty.
export function copyValues(list: EnrichListConfig, data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of list.copy) {
    if (c.value !== undefined) { out[c.id] = c.value; continue; }
    const v = data[c.from] ?? '';
    out[c.id] = holdsRunMarker(v) ? '' : v;
  }
  return out;
}

// One result as destination cells.
export function itemCells(item: unknown, fields: ListField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.columnName] = cellText(readPath(item, f.path));
  return out;
}

// What "already added" compares: the field's path and its trimmed value
// (null when the result has no value there, so it never counts as a duplicate).
export function dedupeKey(item: unknown, path: string): string | null {
  const value = cellText(readPath(item, path)).trim();
  if (!value) return null;
  return createHash('sha256').update(`${path}\u0000${value}`).digest('hex').slice(0, 32);
}
