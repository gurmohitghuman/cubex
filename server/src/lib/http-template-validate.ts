import { db } from './db';
import { normalizeColumnName } from './prompt';
import { TEMPLATE_TOKEN_RE } from './http-request-template';

// Checks an HTTP request template before anything is sent, so a typo fails the
// start (or the preview) instead of every row:
//   - a URL that starts with literal text must start with http:// or https://
//     (one that starts with {{column}} gets its scheme from the cell);
//   - every {{name}} in the URL, headers or body must be a column of the sheet
//     or a saved key, resolved by the same rule as replaceTemplateVariables.
// /name tokens aren't checked: they double as ordinary URL path segments.
export function httpTemplateError(
  rc: { url?: unknown; headers?: unknown; body?: unknown } | undefined,
  columns: string[],
  userId: string,
): string | null {
  if (!rc || typeof rc.url !== 'string' || !rc.url.trim()) return 'The request needs a URL.';
  const url = rc.url.trim();
  if (!url.startsWith('{{')) {
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(url.replace(/\{\{[^}]*\}\}/g, 'x')).protocol); } catch { ok = false; }
    if (!ok) return `The URL must start with http:// or https:// (got "${url.slice(0, 80)}").`;
  }

  const parts: string[] = [url];
  if (typeof rc.body === 'string') parts.push(rc.body);
  if (rc.headers && typeof rc.headers === 'object') {
    for (const [k, v] of Object.entries(rc.headers as Record<string, unknown>)) {
      parts.push(k);
      if (typeof v === 'string') parts.push(v);
    }
  }
  const keyNames = new Set(
    (db.prepare('SELECT name FROM api_keys WHERE user_id = ?').all(userId) as Array<{ name: string }>).map(r => r.name),
  );
  const unknown = new Set<string>();
  for (const part of parts) {
    for (const m of part.matchAll(TEMPLATE_TOKEN_RE)) {
      if (m[1] === undefined) continue;
      const name = m[1].trim();
      if (!name) continue;
      const isColumn = columns.some(c =>
        c.toLowerCase() === name.toLowerCase() || normalizeColumnName(c) === normalizeColumnName(name));
      if (!isColumn && !keyNames.has(name)) unknown.add(`{{${name}}}`);
    }
  }
  if (unknown.size === 0) return null;
  const list = [...unknown].join(', ');
  return `${list} ${unknown.size > 1 ? "don't" : "doesn't"} match a column of this sheet or a saved key.`;
}
