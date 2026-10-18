// The request one row sends (URL, headers, body), built from the column's
// templates: live (makeHTTPRequest) or as the redacted record kept in
// http_results (redactedRequestConfig). Both go through here so the record shows
// what was really sent. A row's column values go in the way their place needs;
// saved keys and text left as written (an unknown /path) never change:
//   - URL: in a query value, the characters that would change the query ("&",
//     "#", "+" and a "%" that doesn't start an escape) are encoded, so "AT&T" or
//     "a+b@x.co" arrive as they are; a value already holding %XX escapes keeps
//     them, and the URL parser encodes spaces and other characters as before.
//     The path and parameter names stay as written;
//   - JSON body: escaped inside JSON strings (lib/http-json-template.ts);
//   - form body (Content-Type application/x-www-form-urlencoded): pairs, values
//     encoded as in the query;
//   - headers and any other body: as written.
// skipEmpty (requestConfig.skipEmpty) leaves out a query parameter, form pair or
// JSON field whose {{column}} came out empty, instead of sending "".
import {
  replaceTemplateVariables, resolveTemplateToken,
  type HTTPRequestConfig, type ResolvedToken, type TokenContext,
} from './http-request-template';
import { goneColumnsOf } from './template-token-match';
import { hasToken, renderParts, splitFirst, splitOn, splitTemplate, type TemplatePart } from './http-template-parts';
import { renderJsonTemplate } from './http-json-template';

export interface BuiltRequest { url: string; headers: Record<string, string>; body: string | undefined }

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Every token resolved once, in order (a {{typo}} or a deleted column throws
// here in a live request, as replaceTemplateVariables does).
function resolveAll(parts: TemplatePart[], ctx: TokenContext): ResolvedToken[] {
  const out: ResolvedToken[] = [];
  for (const p of parts) if (p.kind === 'token') out.push(resolveTemplateToken(p.full, p.brace, p.slash, ctx));
  return out;
}

// Only what would change a query or form value's meaning.
const QUERY_SPECIAL = /[&#+]|%(?![0-9A-Fa-f]{2})/g;
export const encodeQueryValue = (s: string): string =>
  s.replace(QUERY_SPECIAL, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function pairsOf(parts: TemplatePart[], v: ResolvedToken[], skip: boolean): { kept: string[]; dropped: number } {
  const raw = (p: { index: number }) => v[p.index].text;
  const encoded = (p: { index: number }) => (v[p.index].kind === 'column'
    ? encodeQueryValue(v[p.index].text) : v[p.index].text);
  const blank = (ps: TemplatePart[]) => hasToken(ps) && renderParts(ps, raw).trim() === '';
  const kept: string[] = [];
  let dropped = 0;
  for (const pair of splitOn(parts, '&')) {
    const eq = splitFirst(pair, '=');
    // A pair with no "=" ("?{{params}}") stays as written: it may hold several.
    const leaveOut = skip && blank(eq ? eq[1] : pair);
    if (leaveOut) { dropped++; continue; }
    kept.push(eq ? `${renderParts(eq[0], raw)}=${renderParts(eq[1], encoded)}` : renderParts(pair, raw));
  }
  return { kept, dropped };
}

function buildUrl(template: string, ctx: TokenContext, skip: boolean): string {
  const parts = splitTemplate(template);
  const v = resolveAll(parts, ctx);
  const raw = (p: { index: number }) => v[p.index].text;
  const q = splitFirst(parts, '?');
  if (!q) return renderParts(parts, raw);
  const hash = splitFirst(q[1], '#');
  const [query, fragment] = hash ?? [q[1], null];
  const { kept, dropped } = pairsOf(query, v, skip);
  // Every parameter left out: no "?" either.
  const qs = kept.length === 0 && dropped > 0 ? '' : `?${kept.join('&')}`;
  return renderParts(q[0], raw) + qs + (fragment ? `#${renderParts(fragment, raw)}` : '');
}

type BodyKind = 'json' | 'form' | 'text';
function bodyKindOf(headers: Record<string, string> | undefined): BodyKind {
  const type = Object.entries(headers ?? {}).find(([k]) => k.trim().toLowerCase() === 'content-type')?.[1];
  if (type === undefined) return 'json'; // read as JSON when it is
  const t = String(type).toLowerCase();
  if (t.includes('application/x-www-form-urlencoded')) return 'form';
  return t.includes('json') ? 'json' : 'text';
}

function buildBody(template: string, headers: Record<string, string> | undefined, ctx: TokenContext,
  skip: boolean): string {
  const parts = splitTemplate(template);
  const v = resolveAll(parts, ctx);
  const kind = bodyKindOf(headers);
  if (kind === 'form') return pairsOf(parts, v, skip).kept.join('&');
  if (kind === 'json') {
    const json = renderJsonTemplate(parts, v.map(x => ({ text: x.text, escape: x.kind === 'column' })), skip);
    if (json !== null) return json;
  }
  return renderParts(parts, p => v[p.index].text);
}

export function buildRequest(config: HTTPRequestConfig, ctx: TokenContext): BuiltRequest {
  const skip = config.skipEmpty === true;
  const sub = (t: string) => replaceTemplateVariables(t, ctx.rowData, ctx.userId, ctx.mode, ctx.allowSavedKeys,
    ctx.runId, ctx.gone);
  const url = buildUrl(typeof config.url === 'string' ? config.url : '', ctx, skip);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    const name = sub(key);
    // A templated name can come out empty or invalid for a row; say which header
    // (its template, never the substituted text, which may hold a saved key).
    if (ctx.mode === 'live' && !HEADER_NAME.test(name)) {
      throw new Error(`Header name "${key}" is empty or not a valid header name for this row.`);
    }
    headers[name] = sub(value);
  }
  const body = typeof config.body === 'string' && config.body
    ? buildBody(config.body, config.headers, ctx, skip) : undefined;
  return { url, headers, body };
}

// Produces a copy of an HTTP request config with API-key references swapped for
// "[REDACTED:<keyName>]" tokens. Used by the runner to persist a record of what was
// sent without writing the user's plaintext Bearer token into http_results.request_config
// (where it would survive forever and leak via the /api/http/jobs/:id endpoint).
//
// Column-value substitutions (the user's own cell data) ARE applied as normal — only
// secret references are redacted.
export function redactedRequestConfig(
  config: HTTPRequestConfig,
  rowData: Record<string, string>,
  userId: string,
  allowSavedKeys = true,
  runId?: string,
): HTTPRequestConfig {
  const built = buildRequest(config, {
    rowData, userId, mode: 'redact-secrets', allowSavedKeys, runId, gone: goneColumnsOf(config),
  });
  return { method: config.method, url: built.url, headers: built.headers, body: built.body, timeout: config.timeout };
}
