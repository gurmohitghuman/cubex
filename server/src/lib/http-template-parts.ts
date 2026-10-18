// A request template split into literal text and its {{column}} / /column
// tokens (TEMPLATE_TOKEN_RE), so the request builder (http-request-build.ts) can
// put each value where it goes and split on "?", "&", "=" and "#" without
// mistaking one inside a token (a column can be named "# Revenue") or inside a
// value for structure. Literal text is never re-scanned for tokens.
import { TEMPLATE_TOKEN_RE } from './http-request-template';

export type TextPart = { kind: 'text'; text: string };
export type TokenPart = { kind: 'token'; index: number; full: string; brace?: string; slash?: string };
export type TemplatePart = TextPart | TokenPart;

// Tokens are numbered left to right; the builder resolves each one once.
export function splitTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let at = 0;
  let index = 0;
  for (const m of template.matchAll(TEMPLATE_TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > at) parts.push({ kind: 'text', text: template.slice(at, i) });
    parts.push({ kind: 'token', index: index++, full: m[0], brace: m[1], slash: m[2] });
    at = i + m[0].length;
  }
  if (at < template.length) parts.push({ kind: 'text', text: template.slice(at) });
  return parts;
}

// Split at every literal `sep` (a single character), never inside a token.
export function splitOn(parts: TemplatePart[], sep: string): TemplatePart[][] {
  const out: TemplatePart[][] = [[]];
  for (const p of parts) {
    if (p.kind === 'token') { out[out.length - 1].push(p); continue; }
    const pieces = p.text.split(sep);
    pieces.forEach((text, i) => {
      if (i > 0) out.push([]);
      if (text) out[out.length - 1].push({ kind: 'text', text });
    });
  }
  return out;
}

// Split at the first literal `sep`; null when there is none.
export function splitFirst(parts: TemplatePart[], sep: string): [TemplatePart[], TemplatePart[]] | null {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.kind !== 'text') continue;
    const at = p.text.indexOf(sep);
    if (at === -1) continue;
    const before = p.text.slice(0, at), after = p.text.slice(at + 1);
    return [
      [...parts.slice(0, i), ...(before ? [{ kind: 'text' as const, text: before }] : [])],
      [...(after ? [{ kind: 'text' as const, text: after }] : []), ...parts.slice(i + 1)],
    ];
  }
  return null;
}

export const hasToken = (parts: TemplatePart[]): boolean => parts.some(p => p.kind === 'token');

// Literal text as written; each token through `put` (its value already resolved).
export function renderParts(parts: TemplatePart[], put: (p: TokenPart) => string): string {
  let out = '';
  for (const p of parts) out += p.kind === 'text' ? p.text : put(p);
  return out;
}
