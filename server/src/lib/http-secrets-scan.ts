// Static 'secrets'-scope gate for PAT-authored HTTP runs (see the scopes in
// docs/mcp.md). replaceTemplateVariables resolves tokens column-first with a PER-ROW
// fallback to the user's saved api_keys, so "a column with this name exists" is
// NOT a sound gate — a token matching a column on most rows still falls through
// to the key lookup on a row where the column is absent. The check is therefore
// a static scan of the AUTHORED config (url + header keys/values + body): any
// token whose name matches a saved key, under the resolver's own normalization
// (case-insensitive + normalizeColumnName), forces the 'secrets' scope — even
// when a same-named column also exists.
//
// This scan alone can't close the create-the-key-later TOCTOU; the run-level
// allow_secrets policy (migration 034) does that. The two work together: scan
// rejects known references up front, policy stops future live resolution.
import { db } from './db';
import { normalizeColumnName } from './prompt';
import {
  extractTemplateTokenNames, type HTTPRequestConfig, type HTTPAPIConfig,
} from './http-request-template';

// Names of saved api_keys the authored config references, deduped. Empty array
// = no secret involvement, safe for a run-scope-only token.
export function savedKeyRefsInConfig(userId: string, config: HTTPRequestConfig): string[] {
  const keyRows = db.prepare('SELECT name FROM api_keys WHERE user_id = ?')
    .all(userId) as Array<{ name: string }>;
  if (keyRows.length === 0) return [];

  const byLower = new Map<string, string>();
  const byNorm = new Map<string, string>();
  for (const { name } of keyRows) {
    byLower.set(name.toLowerCase(), name);
    byNorm.set(normalizeColumnName(name), name);
  }

  const parts: string[] = [config.url ?? ''];
  for (const [k, v] of Object.entries(config.headers ?? {})) parts.push(k, v);
  if (config.body) parts.push(config.body);

  const matched = new Set<string>();
  for (const part of parts) {
    for (const token of extractTemplateTokenNames(part)) {
      const hit = byLower.get(token.toLowerCase()) ?? byNorm.get(normalizeColumnName(token));
      if (hit) matched.add(hit);
    }
  }
  return [...matched];
}

// True if a stored HTTP-run config contains ANY template token in its url,
// header keys/values, or body. Used by the resume path: a no-'secrets' caller
// resuming a permissive run can't be refused on currently-existing keys alone
// (the owner could create a matching key AFTER the check but BEFORE a later row
// substitutes — the create-key-later TOCTOU). If ANY token exists, resume
// freezes the run's allow_secrets so no future key can ever resolve. Column
// refs also match here, but freezing them costs nothing (a column ref never
// falls through to the key lookup anyway).
export function httpConfigHasKeyShapedToken(configJson: string | null): boolean {
  if (!configJson) return false;
  let requestConfig: HTTPRequestConfig | undefined;
  try {
    requestConfig = (JSON.parse(configJson) as HTTPAPIConfig).requestConfig;
  } catch { return false; }
  if (!requestConfig) return false;
  const parts: string[] = [requestConfig.url ?? ''];
  for (const [k, v] of Object.entries(requestConfig.headers ?? {})) parts.push(k, v);
  if (requestConfig.body) parts.push(requestConfig.body);
  return parts.some(p => extractTemplateTokenNames(p).length > 0);
}

// The OPERATING-side companion to the authoring-time scan. A run-scope PAT can
// resume/rerun an EXISTING http_runs row it didn't author (a UI/cookie run, or
// a pre-migration-034 run, all carry allow_secrets=1). If that run's stored
// config references a saved key AND its policy still permits resolution, having
// the worker run it would inject the decrypted key — so the caller must hold
// 'secrets' for that action too, not just 'run'. Returns the referenced key
// names when the caller LACKS the scope (→ 403), or [] when the action is safe
// (policy already frozen off, no key refs, or the caller has 'secrets').
//
// `storedRun` is an http_runs row: { config: string|null, allow_secrets: number }.
export function httpRunSecretRefsRequiringScope(
  userId: string,
  storedRun: { config: string | null; allow_secrets?: number | null },
  hasSecretsScope: boolean,
): string[] {
  if (hasSecretsScope) return [];               // caller is allowed to resolve keys
  if (storedRun.allow_secrets === 0) return []; // policy already forbids resolution
  if (!storedRun.config) return [];
  let requestConfig: HTTPRequestConfig | undefined;
  try {
    requestConfig = (JSON.parse(storedRun.config) as HTTPAPIConfig).requestConfig;
  } catch { return []; }                         // unparseable config can't resolve a key
  if (!requestConfig) return [];
  return savedKeyRefsInConfig(userId, requestConfig);
}
