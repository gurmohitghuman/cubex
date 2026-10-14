// The HTTP column dialog's side of "Paste a cURL command" (POST /api/http/curl).
// First call: the command alone. With keys in it, the reply lists them (a masked
// hint each, never the value) and the dialog asks what to do with each one. The
// second call sends the command again with those choices: keys are saved and the
// reply carries the request to fill the form with.
import { maskKey } from '../lib/curl/key-rules';
import type { BuiltRequest, KeyChoice } from '../lib/curl/key-apply';
import { commitCurlKeys, planCurl, prepareCurl, unresolvedRefNotes, type CurlPlan } from './curl-import';
import type { RunFail } from './run-shared';

export interface PublicKeyFinding {
  id: string;
  where: string;
  kind: 'value' | 'missing';
  hint?: string;
  placeholder?: string;
  suggestedName: string;
  existingKey?: string;
  canDrop: boolean;
  basic: boolean;
  cookie: boolean;
}

export interface ImportedRequest {
  method: BuiltRequest['method'];
  url: string;
  endpoint: string; // the URL without its query string, when query holds it
  query: Array<{ key: string; value: string }> | null; // null: kept in the URL (a ?flag with no =)
  headers: Array<{ key: string; value: string }>;
  body?: string;
}

export type CurlImportReply =
  | { needsKeys: true; keys: PublicKeyFinding[]; notes: string[] }
  | { needsKeys: false; request: ImportedRequest; savedKeys: string[]; notes: string[] };

export function importCurlForApp(
  userId: string, sheetId: string, curl: unknown, rawChoices: unknown,
): { ok: CurlImportReply } | RunFail {
  const choices = parseChoices(rawChoices);
  if ('fail' in choices) return choices;
  const planned = planCurl(userId, sheetId, curl, { matchSaved: true }); // the account owner
  if ('fail' in planned) return planned;
  const plan = planned.ok;
  if (plan.findings.some(f => !choices.ok[f.id])) {
    return { ok: { needsKeys: true, keys: publicKeys(plan), notes: plan.notes } };
  }
  const prepared = prepareCurl(plan, choices.ok);
  if ('fail' in prepared) return prepared;
  const saved = commitCurlKeys(userId, plan, prepared.ok.keys);
  if ('fail' in saved) return saved;
  const request = prepared.ok.request;
  return {
    ok: {
      needsKeys: false, request: toImported(request), savedKeys: saved.ok,
      notes: [...plan.notes, ...unresolvedRefNotes(plan, request, saved.ok)],
    },
  };
}

function publicKeys(plan: CurlPlan): PublicKeyFinding[] {
  return plan.findings.map((f, i) => {
    const auth = plan.draft.auth;
    const hint = f.kind !== 'value' ? undefined
      : f.basic && auth?.kind === 'basic' ? `${maskKey(auth.user)}${auth.password ? ' and a password' : ''}`
        : maskKey(f.secret ?? '');
    return {
      id: f.id, where: f.where, kind: f.kind, suggestedName: plan.suggested[i], canDrop: f.canDrop,
      basic: f.basic, cookie: f.cookie,
      ...(hint ? { hint } : {}),
      // A Basic placeholder may pair a variable with a typed password: never shown.
      ...(f.kind === 'missing' && !f.basic ? { placeholder: f.placeholder } : {}),
      ...(plan.existing[i] ? { existingKey: plan.existing[i]! } : {}),
    };
  });
}

function toImported(r: BuiltRequest): ImportedRequest {
  const headers = Object.entries(r.headers).map(([key, value]) => ({ key, value }));
  const q = r.url.indexOf('?');
  const parts = q < 0 ? [] : r.url.slice(q + 1).split('&').filter(Boolean);
  const query = parts.every(p => p.indexOf('=') > 0)
    ? parts.map(p => ({ key: p.slice(0, p.indexOf('=')), value: p.slice(p.indexOf('=') + 1) })) : null;
  return {
    method: r.method, url: r.url, endpoint: query && q >= 0 ? r.url.slice(0, q) : r.url, query, headers,
    ...(r.body !== undefined ? { body: r.body } : {}),
  };
}

// { [finding id]: { save: name, value? } | { use: name } | { drop: true } }
export function parseChoices(raw: unknown): { ok: Record<string, KeyChoice> } | RunFail {
  if (raw === undefined || raw === null) return { ok: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { fail: 'bad_request', message: 'keys must be an object.' };
  const out: Record<string, KeyChoice> = {};
  for (const [id, c] of Object.entries(raw as Record<string, unknown>)) {
    const v = c as Record<string, unknown> | null;
    if (v && typeof v.save === 'string') {
      out[id] = { save: v.save.trim(), ...(typeof v.value === 'string' ? { value: v.value } : {}) };
    } else if (v && typeof v.use === 'string') {
      out[id] = { use: v.use.trim() };
    } else if (v && v.drop === true) {
      out[id] = { drop: true };
    } else {
      return { fail: 'bad_request', message: 'Each key needs { save: name }, { use: name } or { drop: true }.' };
    }
  }
  return { ok: out };
}
