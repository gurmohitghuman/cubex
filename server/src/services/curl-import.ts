// "Paste a cURL command" for an HTTP column, one implementation for every
// surface (the dialog's route, /api/v1 and MCP). Three steps, so a dry run
// writes nothing: plan (parse the command, find its keys), prepare (apply the
// caller's choice for each key: save, use a saved one, leave out) and commit
// (save the new keys). A key never reaches the column's setup: lib/curl/key-apply.ts.
import { CurlError } from '../lib/curl/shared';
import { parseCurl, type ParsedCurl } from '../lib/curl/parse';
import { findKeys, toDraft, type Draft, type KeyFinding } from '../lib/curl/key-detect';
import { applyKeyChoices, suggestKeyNames, type BuiltRequest, type KeyChoice } from '../lib/curl/key-apply';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { templateTokenIs } from '../lib/template-token-match';
import { normalizeColumnName } from '../lib/prompt';
import { saveImportedKeys, savedKeyFinder, savedKeyNames, type ImportedKey, type SavedKeyType } from './saved-keys';
import type { RunFail } from './run-shared';

export interface CurlPlan {
  draft: Draft;
  findings: KeyFinding[];
  suggested: string[]; // a new key's name for each finding
  existing: Array<string | null>; // the saved key already holding each finding's value
  variables: string[];
  notes: string[];
  columns: string[];
  keyNames: string[];
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const REF_RE = /\{\{([^{}]+)\}\}/g;

// matchSaved: look for a saved key already holding each key's value. Only for a
// caller who may use saved keys: anyone else could test guesses of a key's value.
export function planCurl(
  userId: string, sheetId: string, curl: unknown, { matchSaved }: { matchSaved: boolean },
): { ok: CurlPlan } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (typeof curl !== 'string') return bad('curl must be a string (the whole cURL command).');
  let parsed: ParsedCurl;
  try {
    parsed = parseCurl(curl);
  } catch (e) {
    if (e instanceof CurlError) return bad(e.message);
    throw e;
  }
  const columns = getSheetColumns(sheetId, userId, false);
  const keyNames = savedKeyNames(userId);
  // templateTokenIs's rule (any case, or the normalized name), from sets built once.
  const columnLower = new Set(columns.map(c => c.toLowerCase()));
  const columnNorm = new Set(columns.map(normalizeColumnName));
  const keyLower = new Set(keyNames.map(k => k.toLowerCase()));
  const isColumn = (n: string) => columnLower.has(n.toLowerCase()) || columnNorm.has(normalizeColumnName(n));
  const isKey = (n: string) => keyLower.has(n.toLowerCase());
  const draft = toDraft(parsed);
  let findings: KeyFinding[];
  try {
    findings = findKeys(draft, { resolves: n => isColumn(n) || isKey(n), variables: parsed.variables });
  } catch (e) {
    if (e instanceof CurlError) return bad(e.message);
    throw e;
  }
  const holder = matchSaved ? savedKeyFinder(userId, isColumn) : () => null;
  return {
    ok: {
      draft, findings, variables: parsed.variables, notes: parsed.notes, columns, keyNames,
      suggested: suggestKeyNames(draft.base, findings, n => isKey(n) || isColumn(n)),
      existing: findings.map(f => (f.kind === 'value' && f.secret ? holder(f.secret) : null)),
    },
  };
}

export interface PreparedCurl { request: BuiltRequest; keys: ImportedKey[] }

// The request a column would store, and the keys to save for it. Writes nothing.
export function prepareCurl(plan: CurlPlan, choices: Record<string, KeyChoice>): { ok: PreparedCurl } | RunFail {
  const keys: ImportedKey[] = [];
  for (const f of plan.findings) {
    const c = choices[f.id];
    if (!c) continue; // applyKeyChoices names it
    if ('use' in c && !plan.keyNames.includes(c.use)) return bad(`There's no saved key named "${c.use.slice(0, 64)}".`);
    if ('use' in c && plan.columns.some(col => templateTokenIs(c.use, col))) {
      return bad(`"${c.use}" is also a column in this sheet, which would be read instead of the key. `
        + 'Pick another key.');
    }
    if (!('save' in c)) continue;
    let value = f.kind === 'value' ? f.secret ?? '' : typeof c.value === 'string' ? c.value.trim() : '';
    if (!value) return bad(`Paste the key for the ${f.where} first.`);
    // A missing Basic sign-in is typed as user:password; the key holds its base64.
    if (f.basic && f.kind === 'missing') value = Buffer.from(value, 'utf8').toString('base64');
    keys.push({ name: c.save, value, key_type: keyType(plan.draft, f), description: describe(plan.draft, f) });
  }
  try {
    const canonical = (n: string) => {
      if (plan.columns.some(col => templateTokenIs(n, col)) || plan.keyNames.includes(n)) return null;
      return plan.keyNames.find(k => k.toLowerCase() === n.toLowerCase()) ?? null;
    };
    return { ok: { request: applyKeyChoices(plan.draft, plan.findings, choices, canonical), keys } };
  } catch (e) {
    if (e instanceof CurlError) return bad(e.message);
    throw e;
  }
}

// dryRun: every check (name clashes with a column or another key), no write.
export function commitCurlKeys(
  userId: string, plan: CurlPlan, keys: ImportedKey[], dryRun = false,
): { ok: string[] } | RunFail {
  if (keys.length === 0) return { ok: [] };
  const saved = saveImportedKeys(userId, plan.columns, keys, dryRun);
  return 'fail' in saved ? saved : { ok: [...new Set(saved.ok)] };
}

// {{names}} the request still uses that match no column or saved key yet
// (often a $VARIABLE from API docs), for the dialog to point out.
export function unresolvedRefNotes(plan: CurlPlan, request: BuiltRequest, savedNow: string[]): string[] {
  const names = new Set<string>();
  const parts = [request.url, request.body ?? '', ...Object.keys(request.headers), ...Object.values(request.headers)];
  for (const part of parts) for (const m of part.matchAll(REF_RE)) names.add(m[1].trim());
  const known = (n: string) => savedNow.includes(n) || plan.keyNames.includes(n)
    || plan.columns.some(c => templateTokenIs(n, c));
  return [...names].filter(n => !known(n)).map(n => (
    `{{${n}}}${plan.variables.includes(n) ? ` (from $${n})` : ''} doesn't match a column or a saved key yet. `
    + 'Before you run it, type / in its place to pick one.'
  ));
}

function keyType(d: Draft, f: KeyFinding): SavedKeyType {
  if (f.basic || f.cookie) return 'custom';
  const scheme = f.insert ?? (f.field.at === 'header' ? d.headers[f.field.index].value.slice(0, f.start) : '');
  return /^bearer\b/i.test(scheme.trim()) ? 'bearer' : 'api_key';
}

function describe(d: Draft, f: KeyFinding): string {
  let host = 'the API';
  try { host = new URL(d.base.replace(REF_RE, 'x')).host; } catch { /* keep the generic name */ }
  return `Saved from a pasted cURL command: the ${f.where} for ${host}.`.slice(0, 200);
}
