// Builds the request a column stores from a parsed cURL command, once every key
// key-detect.ts found has a choice: saved as a saved key, swapped for one already
// saved, or left out. A key with no choice stops the build, and the result is
// scanned again, so a pasted key can't reach a column's setup through any surface.
import { CURL_KEY_NAME_MAX } from '../constants-curl';
import { CurlError } from './shared';
import { findKeys, type Draft, type KeyField, type KeyFinding } from './key-detect';
import type { CurlMethod } from './request';

export type KeyChoice = { save: string; value?: string } | { use: string } | { drop: true };

export interface BuiltRequest {
  method: CurlMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const KEY_NAME_RE = /^[a-zA-Z0-9_-]+$/; // API_KEY_NAME_PATTERN
const REF_RE = /\{\{([^{}]+)\}\}/g;

export function choiceName(c: KeyChoice): string | null {
  return 'save' in c ? c.save : 'use' in c ? c.use : null;
}

// canonicalName: a {{name}} that differs from a saved key's name only in case
// is rewritten to the key's exact name (the key lookup is exact); null keeps it.
export function applyKeyChoices(
  d: Draft, findings: KeyFinding[], choices: Record<string, KeyChoice>,
  canonicalName: (name: string) => string | null = () => null,
): BuiltRequest {
  const edits = new Map<string, Array<{ start: number; end: number; text: string }>>();
  const dropHeaders = new Set<number>();
  const dropQuery = new Set<number>();
  let auth: { insert: string; name: string } | 'drop' | undefined;
  for (const f of findings) {
    const c = choices[f.id];
    if (!c) throw new CurlError(`Choose what to do with the key in the ${f.where}.`);
    if ('drop' in c) {
      if (!f.canDrop) throw new CurlError(`The key in ${f.where} can't be left out. Save it or use a saved key.`);
      if (f.field.at === 'header') dropHeaders.add(f.field.index);
      else if (f.field.at === 'query') dropQuery.add(f.field.index);
      else auth = 'drop';
      continue;
    }
    const name = choiceName(c)!;
    if (!KEY_NAME_RE.test(name) || name.length > CURL_KEY_NAME_MAX) {
      throw new CurlError(`"${name.slice(0, 40)}" can't be a key name: use letters, numbers, _ and -.`);
    }
    if (f.field.at === 'auth') { auth = { insert: f.insert ?? '', name }; continue; }
    const at = fieldKey(f.field, f.inKey);
    edits.set(at, [...(edits.get(at) ?? []), { start: f.start, end: f.end, text: `${f.insert ?? ''}{{${name}}}` }]);
  }
  const edit = (field: KeyField, text: string, inKey = false) => {
    let out = text;
    for (const e of (edits.get(fieldKey(field, inKey)) ?? []).sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
  };
  const next: Draft = {
    method: d.method,
    base: edit({ at: 'url' }, d.base),
    query: d.query.map((p, index) => ({
      ...p, key: edit({ at: 'query', index }, p.key, true), value: edit({ at: 'query', index }, p.value),
    }))
      .filter((_p, index) => !dropQuery.has(index)),
    headers: d.headers.map((h, index) => ({ ...h, value: edit({ at: 'header', index }, h.value) }))
      .filter((_h, index) => !dropHeaders.has(index)),
    ...(d.body !== undefined ? { body: edit({ at: 'body' }, d.body) } : {}),
  };
  // With no finding, auth is a bearer {{reference}} that resolves, or an empty -u (sent as nothing).
  if (auth && auth !== 'drop') {
    next.headers.push({ name: 'Authorization', value: `${auth.insert}{{${auth.name}}}` });
  } else if (!auth && d.auth?.kind === 'bearer') {
    next.headers.push({ name: 'Authorization', value: `Bearer ${d.auth.token}` });
  }
  // Belt and braces: whatever key-detect calls a literal key must be gone now.
  const left = findKeys(next, { resolves: () => true, variables: [] }).filter(f => f.kind === 'value');
  if (left.length > 0) throw new CurlError(`Choose what to do with the key in the ${left[0].where}.`);

  const canon = (s: string) => s.replace(REF_RE, (whole, inner: string) => {
    const exact = canonicalName(inner.trim());
    return exact ? `{{${exact}}}` : whole;
  });
  const query = next.query.map(p => (p.bare ? p.key : `${p.key}=${p.value}`)).join('&');
  return {
    method: next.method,
    url: canon(query ? `${next.base}?${query}` : next.base),
    headers: Object.fromEntries(next.headers.map(h => [h.name, canon(h.value)])),
    ...(next.body !== undefined && next.body !== '' ? { body: canon(next.body) } : {}),
  };
}

const fieldKey = (f: KeyField, inKey = false) => ('index' in f ? `${f.at}:${f.index}` : f.at) + (inKey ? '#name' : '');

// Names offered for new saved keys: the API's name from its host (api.openai.com
// gives "openai"), plus what the key is when a command has several (a cookie is
// always "_cookie": it's left out by default, so the API's key keeps the plain
// name); a missing $NAME keeps its own name. Never a name taken by a saved key
// or a sheet column.
export function suggestKeyNames(base: string, findings: KeyFinding[], taken: (name: string) => boolean): string[] {
  const api = hostSlug(base);
  const several = findings.filter(f => !f.cookie).length > 1;
  const used = new Set<string>();
  return findings.map(f => {
    const wanted = f.refName && KEY_NAME_RE.test(f.refName) ? f.refName
      : f.cookie ? `${api}_cookie` : several ? `${api}_${f.role}` : api;
    const stem = wanted.slice(0, CURL_KEY_NAME_MAX - 3);
    let name = stem;
    for (let n = 2; taken(name) || used.has(name.toLowerCase()); n++) name = `${stem}_${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function hostSlug(base: string): string {
  let host = '';
  try { host = new URL(base.replace(REF_RE, 'x')).hostname; } catch { return 'api'; }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return 'api';
  let labels = host.split('.').filter(Boolean);
  const n = labels.length;
  if (n >= 3 && labels[n - 1].length === 2 && /^(co|com|org|net|gov|ac|edu)$/.test(labels[n - 2])) {
    labels = labels.slice(0, -2);
  } else if (n >= 2) {
    labels = labels.slice(0, -1);
  }
  const slug = (labels[labels.length - 1] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : 'api';
}
