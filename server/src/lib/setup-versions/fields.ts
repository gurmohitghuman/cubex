// The settings of a column's setup in words, field by field (pure), for a
// version's diff against the sheet: what differs between two fills of the
// same kind, and auto-run. An HTTP API, enrichment or waterfall column's rows
// and what stays hidden from a read token: fields-http.ts. Long text is cut,
// much later for the app (`reveal`), whose dialogs show it whole anyway.
import { SETUP_VERSION_DIFF_CHARS, SETUP_VERSION_DIFF_CHARS_APP } from '../constants-setups';
import { conditionWords, httpRows, settingsOf, type Row } from './fields-http';
import type { AiFill, AutoRunSnap, CleanFill, Fill, FormulaFill, LookupFill } from './spec';

export interface FieldChange { field: string; version: string | null; now: string | null }
export interface FieldContext { reveal: boolean; sheetName: (id: string) => string | null }

// Fields whose change doesn't change what a column's cells would hold: no
// need to run it again for them.
export const NO_RERUN_FIELDS = new Set(['Description', 'Auto-run', 'Reads columns that were deleted', 'Filled by',
  'Concurrency', 'Batch size', 'Retries', 'Retry POST', 'Timeout', 'Max cost per row', 'Uses saved API keys',
  'Other settings']);

const onOff = (b: boolean) => (b ? 'on' : 'off');
const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

function aiRows(f: AiFill): Row[] {
  return [
    ['Prompt', f.prompt], ['System prompt', f.systemPrompt], ['Model', f.model],
    ['Temperature', text(f.temperature)], ['Max characters', text(f.maxChars)], ['Concurrency', text(f.concurrency)],
    ['Web search', onOff(f.webSearch)], ['Search engine', f.webSearch ? f.searchEngine : null],
    ['Search mode', f.webSearch ? f.searchMode : null],
    ['Searches per row', f.webSearch ? text(f.maxSearchesPerRow) : null],
    ['Web fetch', onOff(f.webFetch)],
    ['Output columns', f.outputColumns?.length
      ? f.outputColumns.map(o => `${o.columnName} (${o.type})`).join(', ') : null],
    ['Only run if', f.runIf],
  ];
}

const cleanRows = (f: CleanFill): Row[] =>
  [['Reads', f.source], ['Cleaner', f.cleaner],
    ['Options', Object.keys(f.options).length ? canonical(f.options) : null]];
const formulaRows = (f: FormulaFill): Row[] => [['Formula', f.formula], ['Described as', f.description]];
const lookupRows = (f: LookupFill, ctx: FieldContext): Row[] => [
  ['Reads', f.source], ['Looks in', ctx.sheetName(f.otherSheetId) ?? 'a sheet deleted since'],
  ['Matches', f.matchColumn], ['Match', f.match], ['Returns', f.returns],
  ['Return columns', f.returnColumns?.join(', ') ?? null], ['Limit', text(f.limit)],
];

function rowsOf(f: Fill, ctx: FieldContext): Row[] {
  switch (f.kind) {
    case 'ai': return aiRows(f);
    case 'http': return httpRows(f, ctx);
    case 'clean': return cleanRows(f);
    case 'formula': return formulaRows(f);
    case 'lookup': return lookupRows(f, ctx);
  }
}

// JSON with object keys sorted: two configs saved by different paths compare equal.
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
}

// What makes two fills the same setup. An HTTP column's linked columns aren't
// part of it (they only ever grow), nor what belongs to one run (fields-http.ts settingsOf).
// An AI run's resolved search engine is its run's too.
export const fillKey = (f: Fill): string => canonical(f.kind === 'http'
  ? { ...f, extracted: null, config: settingsOf(f.config) } : f.kind === 'ai' ? { ...f, searchEngineUsed: null } : f);

// Fields that differ between two fills of the same kind (and mode). A value
// compared but not shown that differs while the shown words read the same
// says so.
export function fillChanges(version: Fill, now: Fill, ctx: FieldContext): FieldChange[] {
  const max = ctx.reveal ? SETUP_VERSION_DIFF_CHARS_APP : SETUP_VERSION_DIFF_CHARS;
  const cut = (s: string | null) => (s === null || s.length <= max ? s : `${s.slice(0, max - 1)}…`);
  const a = new Map(rowsOf(version, ctx).map(r => [r[0], r])), b = new Map(rowsOf(now, ctx).map(r => [r[0], r]));
  const out: FieldChange[] = [];
  for (const field of new Set([...a.keys(), ...b.keys()])) {
    const [, vShown = null, vKey] = a.get(field) ?? [];
    const [, nShown = null, nKey] = b.get(field) ?? [];
    const differ = (vKey === undefined ? vShown : vKey) !== (nKey === undefined ? nShown : nKey);
    if (!differ) continue;
    const same = vShown === nShown && nShown !== null;
    out.push({ field, version: cut(vShown), now: same ? `${cut(nShown)} (changed)` : cut(nShown) });
  }
  // A difference the rows don't name (a setting a later build added): still a difference.
  if (!out.length && fillKey(version) !== fillKey(now)) {
    out.push({ field: 'Other settings', version: null, now: 'changed' });
  }
  return out;
}

export function autoRunWords(a: AutoRunSnap | null): string {
  if (!a) return 'off';
  const where = conditionWords(a.where);
  const parts = [a.runIf ? `only if ${a.runIf}` : '', where ? `only if ${where}` : '',
    a.dailyCapUsd !== null ? `up to $${a.dailyCapUsd} a day` : '',
    a.dailyRowCap !== null ? `up to ${a.dailyRowCap.toLocaleString('en-US')} rows a day` : ''].filter(Boolean);
  return parts.length ? `on, ${parts.join(', ')}` : 'on';
}
