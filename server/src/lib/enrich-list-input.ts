// The list part of a run-start request ("Add results as rows"), and the
// fields picked after a test run, parsed strictly (pure). Names are checked
// against the sheets at start (services/enrich-list-build.ts).
import {
  UUID_PATTERN, ENRICH_LIST_DEFAULT_ITEMS, ENRICH_LIST_MAX_COPY, ENRICH_LIST_MAX_COPY_VALUE, ENRICH_LIST_MAX_FIELDS,
  ENRICH_LIST_MAX_ITEMS, ENRICH_LIST_MAX_DEDUPE_ALSO,
} from './constants';
import { validateMappingPath } from './jsonpath-extract';
import { stripControlChars } from './csv-safety';
import { holdsRunMarker } from './enrich-seed';
import type { ListField } from './enrich-list';
import { timeZoneOf } from './ai-visibility/check';

export interface ListInput {
  // An existing sheet of the table, or a new one made by the start.
  dest: { sheetId: string } | { newSheetName: string };
  provider: string | null;
  maxItems: number;
  fields: ListField[] | null;     // null: picked after the test run
  // A column of the asking row ({from, to}), or the same text in every added row ({from: '', to, value}).
  copy: ListCopyInput[];
  dedupePath: string | null;
  // Paths read in turn when a result has no value at dedupePath (set by a
  // template or an agent, kept on Edit).
  dedupeAlso?: string[];
  // Keep the rows added before: a rerun adds only results the sheet never saw (lib/enrich-list.ts).
  keep?: boolean;
  // Where a single tool's results are, when its example shows that list empty
  // (null: where the catalog says).
  itemsPath?: string | null;
}
// clean and day: Cubex's own copies (lib/enrich-list.ts ListCopy), taken back as they were when the app sends a
// column's setup again (an edit in the drawer keeps them).
export interface ListCopyInput { from: string; to: string; value?: string; clean?: 'domain'; day?: string | null }

const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_NAME = 200;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const name = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim() && v.length <= MAX_NAME ? v.trim() : null);

export function parseListFields(v: unknown): ListField[] | null | string {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.length === 0 || v.length > ENRICH_LIST_MAX_FIELDS) {
    return `Keep 1 to ${ENRICH_LIST_MAX_FIELDS} fields.`;
  }
  const out: ListField[] = [];
  const paths = new Set<string>();
  for (const f of v) {
    const path = isObj(f) && typeof f.path === 'string' ? f.path : '';
    const columnName = isObj(f) ? name(f.columnName) : null;
    if (!columnName || !validateMappingPath(path).ok || path.length > 500) {
      return 'Each field needs a path and a column name.';
    }
    if (paths.has(path)) return 'A field is listed twice.';
    paths.add(path);
    out.push({ path, columnName });
  }
  return out;
}

// A fixed value: plain text (control and direction characters out), never a
// run's own words (⏳, ❌…), which later readers would take for a marker.
function fixedValue(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > ENRICH_LIST_MAX_COPY_VALUE) return null;
  const text = stripControlChars(v);
  return holdsRunMarker(text) ? null : text;
}

function parseCopy(v: unknown): ListInput['copy'] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > ENRICH_LIST_MAX_COPY) return `Copy at most ${ENRICH_LIST_MAX_COPY} columns.`;
  const out: ListInput['copy'] = [];
  for (const c of v) {
    // The day a row is added, in a time zone (null: UTC).
    if (isObj(c) && c.day !== undefined && (c.from === undefined || c.from === '')) {
      const to = name(c.to);
      const day = c.day === null ? null : timeZoneOf(c.day);
      if (!to || (c.day !== null && !day)) return 'A copied day needs a column name (to) and an IANA time zone.';
      out.push({ from: '', to, day });
      continue;
    }
    if (isObj(c) && c.value !== undefined && c.value !== null) {
      const to = name(c.to);
      const value = fixedValue(c.value);
      if (!to || value === null || (c.from !== undefined && c.from !== '')) {
        return `A fixed value needs a column name (to) and plain text of at most ${ENRICH_LIST_MAX_COPY_VALUE} `
          + 'characters (not starting with ⏳, ❌, ⏭️ or ➕).';
      }
      out.push({ from: '', to, value });
      continue;
    }
    const from = isObj(c) ? name(c.from) : null;
    const to = isObj(c) ? name(c.to ?? c.from) : null;
    if (!from || !to) return 'Each copied column needs a name.';
    if (out.some(x => x.from === from)) return `"${from}" is copied twice.`;
    if (isObj(c) && c.clean !== undefined && c.clean !== 'domain') {
      return 'A copied column can only be cleaned to its domain.';
    }
    out.push({ from, to, ...(isObj(c) && c.clean === 'domain' ? { clean: 'domain' as const } : {}) });
  }
  return out;
}

function parseItemsPath(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' && v.length <= 500 && validateMappingPath(v).ok ? v : undefined;
}

// The dedupe path must be one of the fields kept.
export function parseDedupe(v: unknown, fields: ListField[] | null): string | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !fields?.some(f => f.path === v)) return undefined;
  return v;
}

// More paths for the duplicate check: only beside its own path.
function parseDedupeAlso(v: unknown, dedupePath: string | null): string[] | null | undefined {
  if (v === undefined || v === null) return null;
  if (!dedupePath || !Array.isArray(v) || v.length > ENRICH_LIST_MAX_DEDUPE_ALSO) return undefined;
  const ok = v.every(p => typeof p === 'string' && p.length <= 500 && validateMappingPath(p).ok);
  return ok && v.length > 0 ? [...new Set(v as string[])] : ok ? null : undefined;
}

function parseDest(v: unknown): ListInput['dest'] | null {
  if (!isObj(v)) return null;
  if (typeof v.sheetId === 'string' && UUID_PATTERN.test(v.sheetId)) return { sheetId: v.sheetId };
  const newName = name(v.newSheetName);
  return newName ? { newSheetName: newName } : null;
}

export function parseListInput(v: unknown): ListInput | null | string {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return 'list must describe where the results go.';
  const dest = parseDest(v.dest);
  if (!dest) return 'Pick the sheet the results go to.';
  const provider = v.provider === undefined || v.provider === null ? null
    : typeof v.provider === 'string' && PROVIDER_RE.test(v.provider) ? v.provider : undefined;
  if (provider === undefined) return 'provider must be a provider name.';
  const maxItems = v.maxItems ?? ENRICH_LIST_DEFAULT_ITEMS;
  if (typeof maxItems !== 'number' || !Number.isSafeInteger(maxItems) || maxItems < 1
    || maxItems > ENRICH_LIST_MAX_ITEMS) {
    return `Results per row must be 1 to ${ENRICH_LIST_MAX_ITEMS}.`;
  }
  const fields = parseListFields(v.fields);
  if (typeof fields === 'string') return fields;
  const copy = parseCopy(v.copy);
  if (typeof copy === 'string') return copy;
  const dedupePath = parseDedupe(v.dedupePath, fields);
  if (dedupePath === undefined) return 'Skip duplicates by one of the fields you keep.';
  const also = parseDedupeAlso(v.dedupeAlso, dedupePath);
  if (also === undefined) {
    return `dedupeAlso takes up to ${ENRICH_LIST_MAX_DEDUPE_ALSO} JSON paths, beside a dedupePath.`;
  }
  if (v.keep !== undefined && v.keep !== null && typeof v.keep !== 'boolean') return 'keep must be true or false.';
  // Keep mode knows a result by its key: with none, every rerun would add every result again.
  if (v.keep === true && !dedupePath) return 'keep needs dedupePath: the field that tells results apart.';
  const itemsPath = parseItemsPath(v.itemsPath);
  if (itemsPath === undefined) return 'itemsPath must be a JSON path to the results.';
  return {
    dest, provider, maxItems, fields, copy, dedupePath, ...(also ? { dedupeAlso: also } : {}),
    ...(v.keep === true ? { keep: true } : {}), ...(itemsPath ? { itemsPath } : {}),
  };
}
