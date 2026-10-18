import { lookupApiKey } from './http-api-key-lookup';
import { goneColumnFor, goneColumnMessage, templateTokenIs } from './template-token-match';

export interface HTTPRequestConfig {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  // Deleted columns this request read: never filled with a saved key (lib/template-token-match.ts).
  goneColumns?: string[];
  // A query parameter or body field whose {{column}} comes out empty is left
  // out instead of sent as "" (lib/http-request-build.ts). Off when absent.
  skipEmpty?: boolean;
}

export interface ResponseMapping {
  jsonPath: string;
  columnName: string;
}

export interface HTTPAPIConfig {
  requestConfig: HTTPRequestConfig;
  responseMapping: ResponseMapping[];
  previewSize: number;
  batchSize?: number;
  // "Only run if" rule (lib/run-condition.ts) as stored; absent = every row.
  runIf?: string;
  // Automatic retries of a failed request (lib/http-retry.ts): 0-5 more tries,
  // HTTP_RETRY_DEFAULT when absent. retryPost also retries a POST on a 5xx or a
  // network error (429 and 503 retry every method: the request wasn't processed).
  retries?: number;
  retryPost?: boolean;
}

// The two accepted template token forms:
//   /column_name    — AI column / API-key convention. Allows word chars AND
//                     hyphens, because both API_KEY_NAME_PATTERN and
//                     COLUMN_NAME_PATTERN permit hyphens — a key like
//                     `apollo-key` is suggested as `/apollo-key`. The lookbehind
//                     excludes "://" and trailing-word chars so URLs like
//                     https://x.com/foo-bar aren't mistaken for refs. Matches the
//                     hyphen-inclusive class already used by extractColumnReferences.
//   {{column_name}} — explicit double-brace. Same name resolution.
// We deliberately do NOT support single-brace {column}. ONE regex governs both
// live substitution below and the PAT 'secrets'-scope scan (http-secrets-scan.ts)
// — two copies would drift and open a scan bypass. matchAll clones the regex, so
// the shared /g instance is safe. The name excludes { as well as }: with [^}]
// a long run of "{" made every match attempt scan to the end of the text, so a
// big body took seconds to minutes (quadratic). A name with a { can't be a {{ref}}.
export const TEMPLATE_TOKEN_RE = /\{\{([^{}]+)\}\}|(?<![/:\w])\/([a-zA-Z0-9_-]+)/g;

// Every token NAME a template references ({{name}} → trimmed inner, /name →
// bare name). Used by the run-start secrets scan.
export function extractTemplateTokenNames(template: string): string[] {
  if (typeof template !== 'string') return [];
  const names: string[] = [];
  for (const m of template.matchAll(TEMPLATE_TOKEN_RE)) {
    const name = m[1] !== undefined ? m[1].trim() : m[2];
    if (name) names.push(name);
  }
  return names;
}

// Replace {{column}} (row data) and /column or {api_key_name} in a template string.
// Missing references become "[MISSING: <ref>]" so they're visible in logs/UI rather than
// silently dropped.
//
// `mode: 'redact-secrets'` swaps the API key value for "[REDACTED:<keyName>]" — used
// when the substituted string will be persisted to the DB or sent to the client (e.g.,
// http_results.request_config). Column values are NOT redacted (they're the user's own
// data, not credentials).
//
// `allowSavedKeys: false` disables the saved-api_keys fallback entirely — the
// run-level secret policy (http_runs.allow_secrets, migration 034). A run
// authored by a PAT without the 'secrets' scope must NEVER resolve a saved key,
// even one created AFTER the start-time scan passed. Column substitution is
// unaffected.
//
// `runId`: when set, EVERY key lookup is additionally gated on that run's
// allow_secrets IN THE SAME atomic SQL statement (lookupApiKey). This closes
// the resume-freeze TOCTOU: the worker thread and the API thread (which commits
// the freeze) don't share an event loop, so a boolean captured before the
// lookup can go stale between the two SELECTs; folding the policy into the key
// query makes "is it allowed" and "give me the key" one indivisible read.
export function replaceTemplateVariables(
  template: string,
  rowData: Record<string, string>,
  userId: string,
  mode: 'live' | 'redact-secrets' = 'live',
  allowSavedKeys = true,
  runId?: string,
  gone: readonly string[] = [],
): string {
  // Defensive: AI Generate / AI Troubleshoot / saved templates / direct API
  // callers can hand us undefined or a non-string here. Coerce to '' so the
  // matchAll call below never crashes the worker. Returning '' is safe — the
  // caller (header value, body, etc.) just becomes empty.
  if (typeof template !== 'string') return '';
  const ctx: TokenContext = { rowData, userId, mode, allowSavedKeys, runId, gone };

  // SINGLE-PASS callback replacement, matching processPromptTemplate in
  // lib/prompt.ts. Each token is resolved AT ITS OWN POSITION, so:
  //   - a token never rewrites a longer token that contains it as a prefix
  //     (/key must not touch /key2), and
  //   - a token's literal text inside an unrelated URL path segment
  //     (/domain inside /domain-search) is not rewritten — the tokenizer's
  //     lookbehind already excluded it from matching, and single-pass honors
  //     that boundary at substitution time too.
  // The old per-token `result.replace(/escapedRef/g, …)` re-scanned the whole
  // (already-substituted) string once per token and ignored those boundaries,
  // corrupting URLs and swapping the wrong value on prefix collisions.
  //
  // The callback return value is taken LITERALLY (String.replace never treats a
  // function's result as a replacement pattern), so $&/$'/$$/$` in a cell value
  // or API key can't be re-expanded — the reason the previous code already used
  // the callback form.
  return template.replace(TEMPLATE_TOKEN_RE, (full, braceInner, slashName) =>
    resolveTemplateToken(full, braceInner, slashName, ctx).text);
}

// What one token stands for, given the row and the run's key policy (the
// arguments of replaceTemplateVariables). kind: a row's 'column' value (data,
// which the request builder escapes or encodes for where it goes), a saved
// 'key' (sent exactly as saved), 'literal' text left as written (an unknown
// /path, an empty {{ }}), or a 'marker' Cubex wrote in the record of a request
// (a redacted key, a [MISSING] note). Only column values are ever changed.
export interface TokenContext {
  rowData: Record<string, string>; userId: string; mode: 'live' | 'redact-secrets';
  allowSavedKeys: boolean; runId?: string; gone: readonly string[];
}
export interface ResolvedToken { text: string; kind: 'column' | 'key' | 'literal' | 'marker' }

// One token, resolved at its own position (see replaceTemplateVariables). The
// request builder (http-request-build.ts) calls it per token so it can put each
// value where it goes; the rules here are the whole substitution contract.
export function resolveTemplateToken(
  full: string, braceInner: string | undefined, slashName: string | undefined, ctx: TokenContext,
): ResolvedToken {
  const { rowData, userId, mode, allowSavedKeys, runId, gone } = ctx;
  const isBrace = braceInner !== undefined;
  const name = isBrace ? String(braceInner).trim() : slashName;
  // Empty-trimmed name (e.g. "{{  }}"): leave the token untouched, exactly as
  // the old `if (!name) continue` did — do NOT emit a [MISSING] marker.
  if (!name) return { text: full, kind: 'literal' };

  // Match column names using the same normalization the AI prompt path uses
  // (lib/prompt.ts normalizeColumnName). Without this, columns with dots/brackets
  // — common in CSV headers like "company.domain" — would never match
  // /company_domain even though the UI suggests that form.
  const matchingColumn = Object.keys(rowData).find(col => templateTokenIs(name, col));

  if (matchingColumn) {
    return { text: rowData[matchingColumn] || '', kind: 'column' };
  }
  // A deleted column it read: never its saved-key namesake.
  const goneColumn = goneColumnFor(name, gone);
  if (goneColumn !== undefined) {
    if (mode === 'live') throw new Error(goneColumnMessage(goneColumn));
    return { text: `[MISSING: ${full}]`, kind: 'marker' };
  }

  // allowSavedKeys is the fast pre-filter (start-time frozen policy); runId
  // makes the lookup itself re-check allow_secrets atomically for the runtime
  // freeze race. Both must permit for a key to resolve.
  const apiKeyValue = allowSavedKeys ? lookupApiKey(userId, name, runId) : null;
  if (apiKeyValue) {
    // In redact mode, replace with a non-secret marker that records WHICH key
    // was used without revealing its value. Live mode injects the actual secret.
    return mode === 'redact-secrets'
      ? { text: `[REDACTED:${name}]`, kind: 'marker' } : { text: apiKeyValue, kind: 'key' };
  }
  if (isBrace) {
    // An unresolved {{column}} is an explicit ref the user clearly intended.
    // A live request must not go out with it (it was sent as "[MISSING: ...]"
    // and the row marked a success): fail the row instead. The redacted
    // record keeps the marker so it shows what was wrong.
    if (mode === 'live') {
      throw new Error(`${full} doesn't match a column or a saved key, so the request wasn't sent.`);
    }
    return { text: `[MISSING: ${full}]`, kind: 'marker' };
  }
  // An unresolved /name is left UNTOUCHED (Bug 8): a slash token is ambiguous
  // between a column/key ref and a literal URL path segment ("/v1/users") or
  // JSON-body path. Emitting "[MISSING: /v1]" corrupted legitimate requests.
  // If the user genuinely meant a reference, the explicit {{name}} form still
  // flags it.
  return { text: full, kind: 'literal' };
}

// column_order is the column registry and a row holds only the keys it has
// values for, so a listed column the row lacks is an empty cell. Callers fill
// those in before substituting: a missing key used to fall through to a saved
// key of the same name, or to "[MISSING: ...]" in the outgoing request.
export function withSheetColumns(rowData: Record<string, string>, columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) out[c] = '';
  return Object.assign(out, rowData);
}
