// What a duplicate check or removal is asked to do, checked against the
// sheet's columns: the app, /api/v1 and MCP all come through here.
// columns: a list of column names, or { column, match, phone_country }.
import { isPhoneCountry } from '../lib/clean/phone';
import {
  DEDUPE_KEEPS, DEDUPE_MATCHES, isDedupeKeep, isDedupeMatch, type DedupeKey, type DedupeKeep,
} from '../lib/dedupe/key';
import type { RunFail } from './run-shared';

export interface DedupeRequest { keys: DedupeKey[]; keep: DedupeKeep }
export interface DedupeArgs { columns?: unknown; keep?: unknown }

// The words of the 409 a removal gets while a run holds the sheet (services/autorun-block.ts).
export const DEDUPE_RUN_ACTIVE =
  'Cannot remove duplicates while a run is active on this sheet. Stop or finish the run first.';

const KEY_FIELDS = ['column', 'match', 'phone_country'];
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const quoted = (s: string) => `"${s.slice(0, 200)}"`;

// One key column: a name, or { column, match, phone_country } (auto-dedupe takes the same).
export function parseDedupeKey(item: unknown, columns: string[]): DedupeKey | RunFail {
  const o = (typeof item === 'string' ? { column: item } : item) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return bad('Each entry of columns is a column name, or { column, match }.');
  }
  const stray = Object.keys(o).find(f => !KEY_FIELDS.includes(f));
  if (stray) return bad(`Unknown field ${quoted(stray)} in columns: use column, match and phone_country.`);
  if (typeof o.column !== 'string' || !o.column) return bad('Each entry of columns needs a column name.');
  if (!columns.includes(o.column)) return bad(`There's no column named ${quoted(o.column)}.`);
  const match = o.match ?? 'text';
  if (!isDedupeMatch(match)) return bad(`match must be one of: ${DEDUPE_MATCHES.join(', ')}.`);
  const key: DedupeKey = { column: o.column, match };
  if (o.phone_country !== undefined && o.phone_country !== null) {
    if (match !== 'phone') return bad('phone_country goes with match "phone" only.');
    const c = typeof o.phone_country === 'string' ? o.phone_country.trim().toUpperCase() : '';
    if (!isPhoneCountry(c)) return bad('phone_country must be a two-letter country code, such as US, CA or GB.');
    key.country = c;
  }
  return key;
}

export function parseDedupeRequest(columns: string[], raw: DedupeArgs): { ok: DedupeRequest } | RunFail {
  const list = raw.columns;
  if (!Array.isArray(list) || list.length === 0) {
    return bad('Name the columns to match on: columns is a list of one or more column names.');
  }
  const keys: DedupeKey[] = [];
  for (const item of list) {
    const key = parseDedupeKey(item, columns);
    if ('fail' in key) return key;
    if (keys.some(k => k.column === key.column)) return bad(`${quoted(key.column)} is listed twice.`);
    keys.push(key);
  }
  const keep = raw.keep ?? 'first';
  if (!isDedupeKeep(keep)) return bad(`keep must be one of: ${DEDUPE_KEEPS.join(', ')}.`);
  return { ok: { keys, keep } };
}
